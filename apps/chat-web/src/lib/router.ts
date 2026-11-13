/**
 * Tiny hash router. Hash routes keep `dist/` deployable on any static host
 * without server-side rewrites.
 *
 *   #/                                  landing (project list)
 *   #/projects/new                      create project
 *   #/projects/:projectId                         project home (redirects)
 *   #/projects/:projectId/stages/:stage           stage workspace
 *   #/projects/:projectId/stages/:stage/runs/:id  stage run
 *   #/projects/:projectId/logs[?filters]          project log viewer
 *   #/projects/:projectId/chats                   project chat, new chat
 *   #/projects/:projectId/chats/:id               project chat, existing chat
 */

import { useEffect, useState } from 'react'

export type Route =
  | { name: 'home' }
  | { name: 'create-project' }
  /** Project entry point: the app redirects to the current stage (or chat). */
  | { name: 'project-home'; projectId: string }
  /** Project chat. */
  | { name: 'project'; projectId: string; sessionId: string | null }
  | { name: 'stage'; projectId: string; stage: string; runId: string | null }
  /** Project log viewer. `search` is the raw query string (filters), without `?`. */
  | { name: 'logs'; projectId: string; search: string }

/** Routes that belong to one project. */
export function routeProjectId(route: Route): string | null {
  return route.name === 'project' || route.name === 'project-home' || route.name === 'stage' || route.name === 'logs'
    ? route.projectId
    : null
}

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '')
  const queryAt = raw.indexOf('?')
  const search = queryAt === -1 ? '' : raw.slice(queryAt + 1)
  const path = (queryAt === -1 ? raw : raw.slice(0, queryAt)).replace(/\/+$/, '')
  const parts = path.split('/').filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part)
    } catch {
      return part
    }
  })
  if (parts[0] !== 'projects' || parts.length === 1) return { name: 'home' }
  if (parts.length === 2 && parts[1] === 'new') return { name: 'create-project' }
  const projectId = parts[1]!
  if (parts.length === 2) return { name: 'project-home', projectId }
  if (parts[2] === 'logs' && parts.length === 3) return { name: 'logs', projectId, search }
  if (parts[2] === 'chats' && parts.length === 3) return { name: 'project', projectId, sessionId: null }
  if (parts[2] === 'chats' && parts.length === 4) return { name: 'project', projectId, sessionId: parts[3]! }
  if (parts[2] === 'stages' && parts.length === 4) return { name: 'stage', projectId, stage: parts[3]!, runId: null }
  if (parts[2] === 'stages' && parts.length === 6 && parts[4] === 'runs') {
    return { name: 'stage', projectId, stage: parts[3]!, runId: parts[5]! }
  }
  return { name: 'home' }
}

export function routeHref(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/'
    case 'create-project':
      return '#/projects/new'
    case 'project-home':
      return `#/projects/${encodeURIComponent(route.projectId)}`
    case 'project': {
      const base = `#/projects/${encodeURIComponent(route.projectId)}/chats`
      return route.sessionId === null ? base : `${base}/${encodeURIComponent(route.sessionId)}`
    }
    case 'logs': {
      const base = `#/projects/${encodeURIComponent(route.projectId)}/logs`
      return route.search === '' ? base : `${base}?${route.search}`
    }
    case 'stage': {
      const base = `#/projects/${encodeURIComponent(route.projectId)}/stages/${encodeURIComponent(route.stage)}`
      return route.runId === null ? base : `${base}/runs/${encodeURIComponent(route.runId)}`
    }
  }
}

/** Navigate. `replace` swaps the current history entry instead of pushing. */
export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  const href = routeHref(route)
  if (window.location.hash === href) return
  if (options.replace === true) {
    window.history.replaceState(null, '', href)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  } else {
    window.location.hash = href
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash))
  useEffect(() => {
    const onChange = (): void => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}
