/**
 * OpenAI-compatible embeddings client.
 *
 * The local llama.cpp embedding server and hosted OpenAI-compatible endpoints
 * share the `/v1/embeddings` shape. The client validates dimensions before
 * returning vectors so a model/config mismatch cannot corrupt pgvector rows.
 */

export interface EmbeddingClientOptions {
  baseUrl: string
  model: string
  apiKey?: string
  dimensions: number
  timeoutMs?: number
  batchSize?: number
  fetch?: typeof fetch
}

export class EmbeddingError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'EmbeddingError'
    this.status = status
    this.code = code
  }
}

export class EmbeddingClient {
  private readonly baseUrl: string
  private readonly model: string
  private readonly apiKey?: string
  private readonly dimensions: number
  private readonly timeoutMs: number
  private readonly batchSize: number
  private readonly fetchImpl: typeof fetch

  constructor(options: EmbeddingClientOptions) {
    if (options.baseUrl.trim() === '') throw new EmbeddingError(500, 'EMBEDDING_URL_MISSING', 'embedding URL is empty')
    if (options.model.trim() === '') throw new EmbeddingError(500, 'EMBEDDING_MODEL_MISSING', 'embedding model is empty')
    if (!Number.isSafeInteger(options.dimensions) || options.dimensions < 1) {
      throw new EmbeddingError(500, 'EMBEDDING_DIMENSIONS_INVALID', 'embedding dimensions must be positive')
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.model = options.model
    if (options.apiKey !== undefined && options.apiKey !== '') this.apiKey = options.apiKey
    this.dimensions = options.dimensions
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.batchSize = Math.max(options.batchSize ?? 32, 1)
    this.fetchImpl = options.fetch ?? fetch
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const vectors: number[][] = []
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const batch = texts.slice(start, start + this.batchSize)
      const result = await this.embedBatch(batch)
      vectors.push(...result)
    }
    return vectors
  }

  async embedOne(text: string): Promise<number[]> {
    const [vector] = await this.embed([text])
    if (vector === undefined) throw new EmbeddingError(502, 'EMPTY_EMBEDDING', 'embedding service returned no vector')
    return vector
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    timer.unref()
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey !== undefined ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new EmbeddingError(
          502,
          'EMBEDDING_HTTP_ERROR',
          `embedding service returned ${response.status}${detail === '' ? '' : `: ${detail.slice(0, 300)}`}`,
        )
      }
      const body: unknown = await response.json()
      if (body === null || typeof body !== 'object' || !Array.isArray((body as { data?: unknown }).data)) {
        throw new EmbeddingError(502, 'EMBEDDING_RESPONSE_INVALID', 'embedding response has no data array')
      }
      const data = (body as { data: Array<{ embedding?: unknown; index?: unknown }> }).data
      const ordered = [...data].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
      if (ordered.length !== texts.length) {
        throw new EmbeddingError(502, 'EMBEDDING_RESPONSE_INVALID', 'embedding response count does not match input count')
      }
      return ordered.map((item) => {
        if (!Array.isArray(item.embedding) || item.embedding.some((value) => typeof value !== 'number')) {
          throw new EmbeddingError(502, 'EMBEDDING_RESPONSE_INVALID', 'embedding vector is missing or invalid')
        }
        const vector = item.embedding as number[]
        if (vector.length !== this.dimensions) {
          throw new EmbeddingError(
            502,
            'EMBEDDING_DIMENSION_MISMATCH',
            `embedding has ${vector.length} dimensions; expected ${this.dimensions}`,
          )
        }
        return vector
      })
    } catch (error) {
      if (error instanceof EmbeddingError) throw error
      if ((error as Error).name === 'AbortError') {
        throw new EmbeddingError(504, 'EMBEDDING_TIMEOUT', `embedding request timed out after ${this.timeoutMs}ms`)
      }
      throw new EmbeddingError(502, 'EMBEDDING_UNAVAILABLE', (error as Error).message)
    } finally {
      clearTimeout(timer)
    }
  }
}
