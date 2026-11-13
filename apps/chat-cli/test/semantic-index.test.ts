import assert from 'node:assert/strict'
import test from 'node:test'
import { EmbeddingClient, EmbeddingError } from '../src/embeddings.ts'
import { chunkText, isTextDocument } from '../src/semantic-index.ts'
import { vectorLiteral } from '../src/vector-store.ts'

test('chunks long text with bounded overlap', () => {
  const paragraph = 'x'.repeat(2_500)
  const chunks = chunkText(paragraph, 1_000, 100)
  assert.ok(chunks.length >= 3)
  for (const chunk of chunks) assert.ok(chunk.length <= 1_000)
  assert.ok(chunks[0]!.length >= 900)
})

test('groups short paragraphs up to the chunk size', () => {
  const text = ['# Heading', 'one', 'two', 'three'].join('\n\n')
  assert.deepEqual(chunkText(text, 100), ['# Heading\n\none\n\ntwo\n\nthree'])
  assert.deepEqual(chunkText('', 100), [])
})

test('detects indexable text documents', () => {
  assert.equal(isTextDocument({ mimeType: 'text/markdown', storagePath: '.aifactory/telos.md' }), true)
  assert.equal(isTextDocument({ mimeType: 'application/pdf', storagePath: 'requirements.pdf' }), true)
  assert.equal(isTextDocument({ mimeType: 'application/octet-stream', storagePath: 'archive.zip' }), false)
})

test('calls an OpenAI-compatible embedding endpoint and validates dimensions', async () => {
  let requested: unknown
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    requested = JSON.parse(String(init?.body))
    const inputs = (requested as { input: string[] }).input
    return new Response(JSON.stringify({
      data: inputs.map((_, index) => ({
        index,
        embedding: index === 0 ? [0.1, 0.2, 0.3] : [0.4, 0.5, 0.6],
      })),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const client = new EmbeddingClient({
    baseUrl: 'http://embedding.local/v1',
    model: 'test-model',
    dimensions: 3,
    fetch: fetchImpl,
  })
  const vectors = await client.embed(['one', 'two'])
  assert.deepEqual(vectors, [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]])
  assert.deepEqual(requested, { model: 'test-model', input: ['one', 'two'] })

  const mismatch = new EmbeddingClient({
    baseUrl: 'http://embedding.local/v1',
    model: 'test-model',
    dimensions: 4,
    fetch: fetchImpl,
  })
  await assert.rejects(() => mismatch.embed(['one']), /dimensions/)
  assert.throws(() => vectorLiteral([1, 2], 3), /dimensions/)
})

test('reports embedding HTTP failures', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 500 })) as typeof fetch
  const client = new EmbeddingClient({
    baseUrl: 'http://embedding.local/v1',
    model: 'test-model',
    dimensions: 3,
    fetch: fetchImpl,
  })
  await assert.rejects(() => client.embedOne('x'), (error: unknown) => error instanceof EmbeddingError && error.code === 'EMBEDDING_HTTP_ERROR')
})
