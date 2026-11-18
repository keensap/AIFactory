/**
 * The complete route table.
 *
 * Ordering is precedence, so entries that share a segment length are grouped so
 * the literal segment is matched before a parameter could swallow it. The matcher
 * compares segment counts first, which keeps most modules independent.
 *
 * `routeTable` is what the two guard tests read: the auth inventory asserts every
 * mutating route declares a role, and OpenAPI parity asserts the documented API
 * and the served API are the same set.
 */

import { agentRoutes } from './agents.ts'
import { loggingRoutes } from './logging.ts'
import { modelRoutes } from './models.ts'
import { projectRoutes } from './projects.ts'
import { sessionRoutes } from './sessions.ts'
import { settingsRoutes } from './settings.ts'
import { stageRunRoutes } from './stage-runs.ts'
import { systemRoutes } from './system.ts'
import type { RouteDef } from './router.ts'

export const routeTable: RouteDef[] = [
  ...systemRoutes,
  ...agentRoutes,
  ...settingsRoutes,
  ...modelRoutes,
  ...loggingRoutes,
  ...stageRunRoutes,
  ...projectRoutes,
  ...sessionRoutes,
]

/** Read-only by definition: a `GET` never mutates. Used by the auth inventory. */
export function isReadOnly(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
}

export { route, compileRoutes, dispatchRoutes, matchRoute, requiredParam } from './router.ts'
export type { RouteAuth, RouteContext, RouteDef, RouteHandler } from './router.ts'