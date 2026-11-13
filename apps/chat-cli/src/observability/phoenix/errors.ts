/** Provider-scoped error raised by the Phoenix adapter. */
export class PhoenixError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'PhoenixError'
    this.status = status
    this.code = code
  }
}
