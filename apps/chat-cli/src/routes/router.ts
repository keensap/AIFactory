/**
 * The route table: named parameters and declared policy.
 *
 * The dispatcher used to route by position — `url.pathname.split('/')` became
 * `rest`, and every handler re-derived what it needed from indices. That produced
 * real bugs (an off-by-one made two attachment routes 404) and made authorisation
 * something each handler had to remember. Here a route declares its path once and
 * its policy once:
 *
 *     route('POST', '/api/stage-runs/:runId/gate', 'operator', answerGate)
 *
 * The matcher returns named `params`, and `dispatch` enforces `auth` before the
 * handler runs, so a route cannot be added without deciding who may call it.
 *
 * No framework: the pattern language is `:name` segments and nothing else.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ChatApiOptions } from '../api-options.ts'
import { HttpError, requireAdmin, requireToken } from '../http.ts'

/**
 * Who may call a route.
 *
 * - `public`   — no credential (health, docs).
 * - `operator` — the operator credential: run the factory.
 * - `admin`    — the admin credential: reconfigure the factory.
 */
export type RouteAuth = 'public' | 'operator' | 'admin'

export interface RouteContext {
  request: IncomingMessage
  response: ServerResponse
  url: URL
  options: ChatApiOptions
  /** Named path parameters, already percent-decoded. */
  params: Readonly<Record<string, string>>
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void

export interface RouteDef {
  method: string
  pattern: string
  auth: RouteAuth
  handler: RouteHandler
  /** Shown in `/api` and compared against `openapi.yaml`. */
  operationId?: string
}

/** Declare one route. */
export function route(
  method: string,
  pattern: string,
  auth: RouteAuth,
  handler: RouteHandler,
  operationId?: string,
): RouteDef {
  if (!pattern.startsWith('/')) throw new Error(`route pattern must start with "/": ${pattern}`)
  return { method: method.toUpperCase(), pattern, auth, handler, ...(operationId !== undefined ? { operationId } : {}) }
}

interface CompiledRoute extends RouteDef {
  segments: string[]
}

/**
 * Compile a pattern once. A `:name` segment captures one value; everything else
 * must match literally.
 */
export function compilePattern(pattern: string): string[] {
  return pattern.split('/').filter((segment) => segment !== '')
}

export function compileRoutes(routes: readonly RouteDef[]): CompiledRoute[] {
  const seen = new Map<string, string>()
  return routes.map((def) => {
    const key = `${def.method} ${def.pattern}`
    const previous = seen.get(key)
    if (previous !== undefined) throw new Error(`duplicate route: ${key}`)
    seen.set(key, def.pattern)
    return { ...def, segments: compilePattern(def.pattern) }
  })
}

export interface RouteMatch {
  def: RouteDef
  params: Record<string, string>
}

/**
 * Find the first route that matches. Registration order is precedence, so
 * literal segments must be registered before a catch-all parameter at the same
 * position.
 */
export function matchRoute(
  routes: readonly (RouteDef | CompiledRoute)[],
  method: string,
  pathname: string,
): RouteMatch | null {
  const upper = method.toUpperCase()
  const parts = pathname.split('/').filter((segment) => segment !== '')
  for (const entry of routes) {
    if (entry.method !== upper) continue
    const segments = 'segments' in entry ? entry.segments : compilePattern(entry.pattern)
    if (segments.length !== parts.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!
      const part = parts[index]!
      if (segment.startsWith(':')) {
        if (part === '') { ok = false; break }
        params[segment.slice(1)] = safeDecode(part)
        continue
      }
      if (segment !== safeDecode(part)) { ok = false; break }
    }
    if (ok) return { def: entry, params }
  }
  return null
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    // A malformed escape is a bad request, not a matcher failure: keep the raw
    // text so the handler's own validation reports it.
    return value
  }
}

/**
 * Enforce a route's declared policy.
 *
 * `operator` is already guaranteed by the API-wide token gate, so only `admin`
 * adds a check here; declaring it keeps the policy visible and is what the auth
 * inventory reads.
 */
export function assertAuthorised(auth: RouteAuth, request: IncomingMessage, options: ChatApiOptions): void {
  if (auth === 'public') return
  if (auth === 'operator') {
    requireToken(request, options)
    return
  }
  requireAdmin(request, options)
}

export interface DispatchResult {
  matched: boolean
  def?: RouteDef
}

/**
 * Match and run. Returns `matched: false` when no route claims the request, so a
 * caller can fall back (used while the positional dispatcher was being retired)
 * or answer 404.
 */
export async function dispatchRoutes(
  routes: readonly (RouteDef | CompiledRoute)[],
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: ChatApiOptions,
): Promise<DispatchResult> {
  const match = matchRoute(routes, request.method ?? 'GET', url.pathname)
  if (match === null) return { matched: false }
  assertAuthorised(match.def.auth, request, options)
  await match.def.handler({ request, response, url, options, params: match.params })
  return { matched: true, def: match.def }
}

/** A required path parameter, with a clear error when the route is misregistered. */
export function requiredParam(params: Readonly<Record<string, string>>, name: string): string {
  const value = params[name]
  if (value === undefined || value === '') {
    throw new HttpError(400, `missing path parameter "${name}"`, 'INVALID_PATH_PARAMETER')
  }
  return value
}