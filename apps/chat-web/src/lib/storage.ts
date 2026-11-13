/**
 * Small localStorage façade. The UI works without storage (for example in a
 * locked-down browser or a private window); reads fall back and writes are
 * best effort.
 */

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function readJson<T>(storage: StorageLike, key: string, fallback: T): T {
  try {
    const raw = storage.getItem(key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeJson(storage: StorageLike, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch {
    // Quota or privacy mode: keep the in-memory state usable.
  }
}

export function readString(storage: StorageLike, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

export function writeString(storage: StorageLike, key: string, value: string): void {
  try {
    storage.setItem(key, value)
  } catch {
    // Ignore unavailable storage.
  }
}

/** A memory-backed StorageLike, used by tests and as a browser fallback. */
export function createMemoryStorage(initial: Record<string, string> = {}): StorageLike {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}

export function browserStorage(): StorageLike {
  try {
    const probe = '__aifactory_probe__'
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return window.localStorage
  } catch {
    return createMemoryStorage()
  }
}
