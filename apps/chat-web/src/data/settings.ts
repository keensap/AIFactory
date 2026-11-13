/** Runtime connection and appearance settings, persisted in the browser. */

import { readJson, readString, writeJson, writeString, type StorageLike } from '../lib/storage.ts'

export type ThemePreference = 'system' | 'light' | 'dark'

export const THEME_KEY = 'aifactory.chat-web.theme.v1'
export const SETTINGS_KEY = 'aifactory.chat-web.settings.v1'

export const DEFAULT_API_BASE = 'http://127.0.0.1:8787'

export interface AppSettings {
  apiBaseUrl: string
  apiToken: string
}

export interface StoredSettings {
  apiBaseUrl?: unknown
  apiToken?: unknown
}

export function normalizeBaseUrl(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('/')) {
    return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : '/'
  }
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const path = url.pathname.replace(/\/+$/, '')
    return `${url.origin}${path}${url.search}`
  } catch {
    return null
  }
}

export function envApiBase(): string {
  const raw = import.meta.env.VITE_API_BASE_URL as string | undefined
  if (raw === undefined || raw.trim() === '') return DEFAULT_API_BASE
  return normalizeBaseUrl(raw) ?? DEFAULT_API_BASE
}

export function envApiToken(): string {
  const raw = import.meta.env.VITE_API_TOKEN as string | undefined
  return typeof raw === 'string' ? raw.trim() : ''
}

export function loadSettings(storage: StorageLike): AppSettings {
  const parsed = readJson<StoredSettings>(storage, SETTINGS_KEY, {})
  const base = typeof parsed.apiBaseUrl === 'string'
    ? normalizeBaseUrl(parsed.apiBaseUrl)
    : null
  const token = typeof parsed.apiToken === 'string' ? parsed.apiToken.trim() : ''
  return {
    apiBaseUrl: base ?? envApiBase(),
    apiToken: token === '' ? envApiToken() : token,
  }
}

export function saveSettings(storage: StorageLike, settings: AppSettings): void {
  writeJson(storage, SETTINGS_KEY, {
    apiBaseUrl: settings.apiBaseUrl,
    apiToken: settings.apiToken,
  })
}

export function loadTheme(storage: StorageLike): ThemePreference {
  const raw = readString(storage, THEME_KEY)
  let value = raw
  try {
    const parsed = JSON.parse(raw ?? 'null') as unknown
    if (typeof parsed === 'string') value = parsed
  } catch {
    // Values written before the format settled were raw strings.
  }
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

export function saveTheme(storage: StorageLike, theme: ThemePreference): void {
  writeString(storage, THEME_KEY, theme)
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): 'light' | 'dark' {
  if (preference === 'system') return prefersDark ? 'dark' : 'light'
  return preference
}
