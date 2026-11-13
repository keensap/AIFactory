import { useCallback, useEffect, useState } from 'react'
import {
  loadTheme,
  resolveTheme,
  saveTheme,
  type ThemePreference,
} from '../data/settings.ts'
import type { StorageLike } from '../lib/storage.ts'

export interface ThemeController {
  preference: ThemePreference
  resolved: 'light' | 'dark'
  setPreference: (preference: ThemePreference) => void
  toggle: () => void
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function useTheme(storage: StorageLike): ThemeController {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => loadTheme(storage))
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent): void => {
      setPrefersDark(event.matches)
    }
    setPrefersDark(query.matches)
    query.addEventListener('change', onChange)
    return () => {
      query.removeEventListener('change', onChange)
    }
  }, [])

  const resolved = resolveTheme(preference, prefersDark)

  useEffect(() => {
    document.documentElement.dataset.theme = resolved
    document.documentElement.style.colorScheme = resolved
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta !== null) {
      meta.setAttribute('content', resolved === 'dark' ? '#151517' : '#ffffff')
    }
  }, [resolved])

  const setPreference = useCallback(
    (next: ThemePreference) => {
      setPreferenceState(next)
      saveTheme(storage, next)
    },
    [storage],
  )

  const toggle = useCallback(() => {
    setPreference(resolved === 'dark' ? 'light' : 'dark')
  }, [resolved, setPreference])

  return { preference, resolved, setPreference, toggle }
}
