/**
 * Minimal multipart reader for one PDF upload plus a `message` field.
 *
 * The API accepts `multipart/form-data` because a browser can send a File
 * directly. Files are held in memory only for the duration of the request; the
 * PDF is never written into the user's project.
 */

import { basename } from 'node:path'
import Busboy from 'busboy'
import type { IncomingMessage } from 'node:http'
import { MAX_PDF_BYTES } from './pdf.ts'

const MAX_FIELD_BYTES = 20_000

export class UploadError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'UploadError'
    this.status = status
    this.code = code
  }
}

export interface DocumentUpload {
  buffer: Buffer
  filename: string
  mimeType: string
  fields: Record<string, string>
}

export async function readMultipart(request: IncomingMessage): Promise<DocumentUpload> {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    const succeed = (upload: DocumentUpload): void => {
      if (settled) return
      settled = true
      resolve(upload)
    }

    let busboy
    try {
      busboy = Busboy({
        headers: request.headers,
        limits: { files: 1, fileSize: MAX_PDF_BYTES, fields: 5, fieldSize: MAX_FIELD_BYTES },
      })
    } catch (error) {
      fail(new UploadError(400, 'INVALID_MULTIPART', messageOf(error)))
      return
    }

    let fileBuffer: Buffer | undefined
    let filename = 'document.pdf'
    let mimeType = 'application/pdf'
    let tooLarge = false
    const fields: Record<string, string> = {}

    busboy.on('file', (field, stream, info) => {
      if (field !== 'file' || fileBuffer !== undefined) {
        stream.resume()
        return
      }
      filename = safeFilename(info.filename ?? 'document.pdf')
      mimeType = info.mimeType || 'application/octet-stream'
      const chunks: Buffer[] = []
      let size = 0
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_PDF_BYTES) {
          tooLarge = true
          return
        }
        chunks.push(chunk)
      })
      stream.on('limit', () => {
        tooLarge = true
      })
      stream.on('end', () => {
        if (!tooLarge) fileBuffer = Buffer.concat(chunks)
      })
      stream.on('error', (error) => fail(new UploadError(400, 'INVALID_UPLOAD', messageOf(error))))
    })

    busboy.on('field', (field, value) => {
      fields[field] = value
    })

    busboy.on('filesLimit', () => {
      fail(new UploadError(400, 'TOO_MANY_FILES', 'only one PDF may be uploaded per request'))
    })
    busboy.on('fieldsLimit', () => {
      fail(new UploadError(400, 'TOO_MANY_FIELDS', 'too many multipart fields'))
    })
    busboy.on('error', (error) => {
      fail(new UploadError(400, 'INVALID_MULTIPART', messageOf(error)))
    })
    busboy.on('close', () => {
      if (tooLarge) {
        fail(new UploadError(413, 'PDF_TOO_LARGE', `PDF exceeds ${MAX_PDF_BYTES} bytes`))
        return
      }
      if (fileBuffer === undefined || fileBuffer.length === 0) {
        fail(new UploadError(400, 'PDF_REQUIRED', 'a PDF file is required in the "file" field'))
        return
      }
      succeed({
        buffer: fileBuffer,
        filename,
        mimeType,
        fields,
      })
    })

    request.on('aborted', () => fail(new UploadError(400, 'UPLOAD_ABORTED', 'upload was aborted')))
    request.pipe(busboy)
  })
}

function safeFilename(value: string): string {
  const name = basename(value).trim()
  return name === '' || name === '.' || name === '..' ? 'document.pdf' : name
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'invalid upload'
}

export interface MultipartFile {
  field: string
  buffer: Buffer
  filename: string
  mimeType: string
}

export interface MultipartUpload {
  files: MultipartFile[]
  fields: Record<string, string>
}

export interface ReadFilesOptions {
  /** Accepted form-field name for files; every other file field is ignored. */
  field?: string
  maxFiles?: number
  maxFileBytes?: number
}

/**
 * Read several files from one multipart request.
 *
 * Unlike `readMultipart` (one PDF for the review flow), stage inputs can arrive
 * as a batch: the browser sends every selected file in a single request, so the
 * user gets one result and one error instead of N round trips.
 */
export async function readMultipartFiles(request: IncomingMessage, options: ReadFilesOptions = {}): Promise<MultipartUpload> {
  const field = options.field ?? 'files'
  const maxFiles = options.maxFiles ?? 10
  const maxFileBytes = options.maxFileBytes ?? MAX_PDF_BYTES

  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    const succeed = (upload: MultipartUpload): void => {
      if (settled) return
      settled = true
      resolve(upload)
    }

    let busboy
    try {
      busboy = Busboy({
        headers: request.headers,
        limits: { files: maxFiles, fileSize: maxFileBytes, fields: 10, fieldSize: MAX_FIELD_BYTES },
      })
    } catch (error) {
      fail(new UploadError(400, 'INVALID_MULTIPART', messageOf(error)))
      return
    }

    const files: MultipartFile[] = []
    const fields: Record<string, string> = {}
    let tooLarge: string | undefined
    let tooMany = false

    busboy.on('file', (name, stream, info) => {
      const filename = safeFilename(info.filename ?? 'file')
      const mimeType = info.mimeType || 'application/octet-stream'
      if (name !== field) {
        stream.resume()
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      let skipped = false
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxFileBytes) {
          tooLarge ??= filename
          skipped = true
          return
        }
        chunks.push(chunk)
      })
      stream.on('limit', () => {
        tooLarge ??= filename
        skipped = true
      })
      stream.on('end', () => {
        if (!skipped) files.push({ field: name, buffer: Buffer.concat(chunks), filename, mimeType })
      })
      stream.on('error', (error) => fail(new UploadError(400, 'INVALID_UPLOAD', messageOf(error))))
    })

    busboy.on('field', (name, value) => {
      fields[name] = value
    })
    busboy.on('filesLimit', () => {
      tooMany = true
    })
    busboy.on('fieldsLimit', () => {
      fail(new UploadError(400, 'TOO_MANY_FIELDS', 'too many multipart fields'))
    })
    busboy.on('error', (error) => {
      fail(new UploadError(400, 'INVALID_MULTIPART', messageOf(error)))
    })
    busboy.on('close', () => {
      if (tooMany) {
        fail(new UploadError(400, 'TOO_MANY_FILES', `at most ${maxFiles} files may be uploaded per request`))
        return
      }
      if (tooLarge !== undefined) {
        fail(new UploadError(413, 'ATTACHMENT_TOO_LARGE', `"${tooLarge}" exceeds ${Math.round(maxFileBytes / 1024 / 1024)} MB`))
        return
      }
      if (files.length === 0) {
        fail(new UploadError(400, 'FILES_REQUIRED', `at least one file is required in the "${field}" field`))
        return
      }
      succeed({ files, fields })
    })

    request.on('aborted', () => fail(new UploadError(400, 'UPLOAD_ABORTED', 'upload was aborted')))
    request.pipe(busboy)
  })
}
