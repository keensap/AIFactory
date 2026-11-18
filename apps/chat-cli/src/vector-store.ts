/**
 * PostgreSQL + pgvector store for project retrieval.
 *
 * Chunks are always scoped by project_id. The embedding dimension is fixed at
 * migration time because pgvector column types and HNSW indexes require it.
 */

import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { sharedPool } from './db.ts'
import { runMigrations } from './migrations.ts'

export interface ChunkInput {
  projectId: string
  documentId?: string | null
  stageRunId?: string | null
  sourceType: string
  sourcePath: string
  content: string
  embedding: number[]
  metadata?: Record<string, unknown>
}

export interface ChunkSearchResult {
  id: string
  projectId: string
  documentId: string | null
  stageRunId: string | null
  sourceType: string
  sourcePath: string
  chunkIndex: number
  content: string
  score: number
}

export class VectorStoreError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'VectorStoreError'
    this.status = status
    this.code = code
  }
}

export class PostgresVectorStore {
  private readonly pool: Pool
  private readonly dimensions: number

  constructor(connectionString: string, dimensions: number) {
    if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 16_000) {
      throw new VectorStoreError(500, 'INVALID_EMBEDDING_DIMENSIONS', `invalid embedding dimensions: ${dimensions}`)
    }
    this.dimensions = dimensions
    this.pool = sharedPool(connectionString)
  }

  async migrate(): Promise<void> {
    await runMigrations(this.pool)
  }


  async replaceDocumentChunks(input: {
    projectId: string
    documentId: string
    stageRunId?: string | null
    sourceType: string
    sourcePath: string
    chunks: Array<{ content: string; embedding: number[]; metadata?: Record<string, unknown> }>
  }): Promise<number> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        'DELETE FROM project_chunks WHERE project_id = $1 AND document_id = $2',
        [input.projectId, input.documentId],
      )
      for (const [index, chunk] of input.chunks.entries()) {
        await client.query(
          `INSERT INTO project_chunks
             (id, project_id, document_id, stage_run_id, source_type, source_path,
              chunk_index, content, embedding, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10::jsonb)`,
          [
            randomUUID(),
            input.projectId,
            input.documentId,
            input.stageRunId ?? null,
            input.sourceType,
            input.sourcePath,
            index,
            chunk.content,
            vectorLiteral(chunk.embedding, this.dimensions),
            JSON.stringify(chunk.metadata ?? {}),
          ],
        )
      }
      await client.query('COMMIT')
      return input.chunks.length
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async search(input: {
    projectId: string
    embedding: number[]
    limit?: number
    sourceType?: string
  }): Promise<ChunkSearchResult[]> {
    const limit = Math.min(Math.max(input.limit ?? 8, 1), 50)
    const embedding = vectorLiteral(input.embedding, this.dimensions)
    const result = await this.pool.query<{
      id: string
      projectId: string
      documentId: string | null
      stageRunId: string | null
      sourceType: string
      sourcePath: string
      chunkIndex: number
      content: string
      score: number
    }>(
      `SELECT id, project_id AS "projectId", document_id AS "documentId",
              stage_run_id AS "stageRunId", source_type AS "sourceType",
              source_path AS "sourcePath", chunk_index AS "chunkIndex",
              content, 1 - (embedding <=> $1::vector) AS score
       FROM project_chunks
       WHERE project_id = $2
         AND ($3::text IS NULL OR source_type = $3)
       ORDER BY embedding <=> $1::vector
       LIMIT $4`,
      [embedding, input.projectId, input.sourceType ?? null, limit],
    )
    return result.rows.map((row) => ({ ...row, score: Number(row.score) }))
  }

  async count(projectId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM project_chunks WHERE project_id = $1',
      [projectId],
    )
    return Number(result.rows[0]?.count ?? 0)
  }

  async close(): Promise<void> {
    // The pool is shared and closed once at shutdown (db.closeSharedPools).
  }
}

export function vectorLiteral(embedding: number[], expectedDimensions: number): string {
  if (embedding.length !== expectedDimensions) {
    throw new VectorStoreError(
      502,
      'EMBEDDING_DIMENSION_MISMATCH',
      `embedding has ${embedding.length} dimensions; expected ${expectedDimensions}`,
    )
  }
  for (const value of embedding) {
    if (!Number.isFinite(value)) {
      throw new VectorStoreError(502, 'INVALID_EMBEDDING', 'embedding contains a non-finite value')
    }
  }
  return `[${embedding.join(',')}]`
}
