/** Locally generated ids for placeholder projects. */
export function newId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `${prefix}-${random}`
}
