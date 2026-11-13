/** Deterministic, locale-light formatting for the transcript and sidebar. */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return ''
  const delta = now - timestamp
  if (delta < 0) return 'just now'
  if (delta < MINUTE) return 'just now'
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`
  if (delta < 2 * DAY) return 'yesterday'
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)}d ago`

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(new Date(timestamp).getFullYear() === new Date(now).getFullYear()
      ? {}
      : { year: 'numeric' }),
  }).format(new Date(timestamp))
}

export function formatClockTime(iso: string): string {
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return ''
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

export function formatFullDate(iso: string): string {
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return '—'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(timestamp))
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.round(ms / 60_000)} min`
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}
