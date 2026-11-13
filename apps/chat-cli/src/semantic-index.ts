/**
 * Project-scoped semantic indexing and retrieval.
 *
 * Documents are chunked, embedded through the configured provider, and stored
 * in pgvector. Search always filters by project_id; no cross-project query is
 * possible through this service.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Project, ProjectService } from './projects.ts'
import { extractPdfText } from './pdf.ts'
import type { EmbeddingClient } from './embeddings.ts'
import type { PostgresProjectWorkspace, ProjectDocument, ProjectWorkspaceSnapshot } from './workspace.ts'
import type { ChunkSearchResult, PostgresVectorStore } from './vector-store.ts'
import { VectorStoreError } from './vector-store.ts'

const MAX_CHUNK_CHARS = 1_200
const CHUNK_OVERLAP = 200

export class SemanticIndexError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'SemanticIndexError'
    this.status = status
    this.code = code
  }
}

export interface IndexedDocument {
  documentId: string
  title: string
  chunks: number
}

export interface IndexProjectResult {
  indexed: IndexedDocument[]
  skipped: Array<{ documentId: string; title: string; reason: string }>
  chunks: number
}

export class SemanticIndexService {
  private readonly projects: ProjectService
  private readonly workspace: PostgresProjectWorkspace
  private readonly embeddings: EmbeddingClient
  private readonly vectors: PostgresVectorStore

  constructor(deps: {
    projects: ProjectService
    workspace: PostgresProjectWorkspace
    embeddings: EmbeddingClient
    vectors: PostgresVectorStore
  }) {
    this.projects = deps.projects
    this.workspace = deps.workspace
    this.embeddings = deps.embeddings
    this.vectors = deps.vectors
  }

  async indexProject(projectId: string): Promise<IndexProjectResult> {
    const project = await this.projects.get(projectId)
    await this.workspace.getSnapshot(project.id)
    const documents = await this.workspace.listDocuments(project.id)
    const indexed: IndexedDocument[] = []
    const skipped: IndexProjectResult['skipped'] = []
    let chunks = 0
    for (const document of documents) {
      try {
        const result = await this.indexDocument(project, document)
        if (result === undefined) {
          skipped.push({ documentId: document.id, title: document.title, reason: 'unsupported MIME type' })
          continue
        }
        indexed.push(result)
        chunks += result.chunks
      } catch (error) {
        skipped.push({
          documentId: document.id,
          title: document.title,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { indexed, skipped, chunks }
  }

  async indexDocument(project: Project, document: ProjectDocument): Promise<IndexedDocument | undefined> {
    const text = await readDocumentText(project, document)
    if (text === undefined) return undefined
    const chunks = chunkText(text)
    if (chunks.length === 0) return { documentId: document.id, title: document.title, chunks: 0 }
    const vectors = await this.embeddings.embed(chunks)
    const count = await this.vectors.replaceDocumentChunks({
      projectId: project.id,
      documentId: document.id,
      stageRunId: null,
      sourceType: 'document',
      sourcePath: document.storagePath,
      chunks: chunks.map((content, index) => ({
        content,
        embedding: vectors[index]!,
        metadata: {
          title: document.title,
          kind: document.kind,
          stage: document.stage,
          mimeType: document.mimeType,
        },
      })),
    })
    return { documentId: document.id, title: document.title, chunks: count }
  }

  async search(input: {
    projectId: string
    query: string
    limit?: number
    sourceType?: string
  }): Promise<{ query: string; results: ChunkSearchResult[] }> {
    const query = input.query.trim()
    if (query === '') throw new SemanticIndexError(400, 'QUERY_REQUIRED', 'query must not be empty')
    await this.projects.get(input.projectId)
    const embedding = await this.embeddings.embedOne(query)
    const results = await this.vectors.search({
      projectId: input.projectId,
      embedding,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.sourceType !== undefined ? { sourceType: input.sourceType } : {}),
    })
    return { query, results }
  }

  async count(projectId: string): Promise<number> {
    await this.projects.get(projectId)
    return this.vectors.count(projectId)
  }
}

export async function readDocumentText(project: Project, document: ProjectDocument): Promise<string | undefined> {
  const root = resolve(project.rootPath)
  const absolute = resolve(root, document.storagePath)
  if (!absolute.startsWith(`${root}/`)) {
    throw new SemanticIndexError(400, 'INVALID_DOCUMENT_PATH', 'document path escapes the project root')
  }
  if (!isTextDocument(document)) return undefined
  const buffer = await readFile(absolute)
  if (document.mimeType.toLowerCase() === 'application/pdf' || document.storagePath.toLowerCase().endsWith('.pdf')) {
    return (await extractPdfText(buffer)).text
  }
  return buffer.toString('utf8')
}

export function isTextDocument(document: Pick<ProjectDocument, 'mimeType' | 'storagePath'>): boolean {
  const mime = document.mimeType.toLowerCase()
  const path = document.storagePath.toLowerCase()
  if (mime === 'application/pdf' || path.endsWith('.pdf')) return true
  if (mime.startsWith('text/')) return true
  if (mime === 'application/json' || mime.endsWith('+json')) return true
  if (mime === 'application/x-yaml' || mime === 'application/yaml') return true
  return ['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.csv', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.sql', '.sh']
    .some((extension) => path.endsWith(extension))
}

export function chunkText(text: string, maxChars = MAX_CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (normalized === '') return []
  const paragraphs = normalized.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
  const chunks: string[] = []
  let current = ''
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      if (current !== '') {
        chunks.push(current)
        current = ''
      }
      for (let start = 0; start < paragraph.length; start += Math.max(maxChars - overlap, 1)) {
        chunks.push(paragraph.slice(start, start + maxChars))
      }
      continue
    }
    const candidate = current === '' ? paragraph : `${current}\n\n${paragraph}`
    if (candidate.length > maxChars) {
      if (current !== '') chunks.push(current)
      current = paragraph
    } else {
      current = candidate
    }
  }
  if (current !== '') chunks.push(current)
  return chunks.filter((chunk) => chunk.trim() !== '')
}

/** Kept for callers that need the project snapshot type without importing it directly. */
export type SemanticProjectSnapshot = ProjectWorkspaceSnapshot
