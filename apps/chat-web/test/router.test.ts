import { describe, expect, it } from 'vitest'
import { parseRoute, routeHref, type Route } from '../src/lib/router.ts'

describe('router', () => {
  it('parses the landing, create and project routes', () => {
    expect(parseRoute('')).toEqual({ name: 'home' })
    expect(parseRoute('#/')).toEqual({ name: 'home' })
    expect(parseRoute('#/projects/new')).toEqual({ name: 'create-project' })
    expect(parseRoute('#/projects/abc')).toEqual({ name: 'project-home', projectId: 'abc' })
    expect(parseRoute('#/projects/abc/chats')).toEqual({ name: 'project', projectId: 'abc', sessionId: null })
    expect(parseRoute('#/projects/abc/chats/s-1/')).toEqual({ name: 'project', projectId: 'abc', sessionId: 's-1' })
  })

  it('parses stage and run routes', () => {
    expect(parseRoute('#/projects/abc/stages/planning')).toEqual({ name: 'stage', projectId: 'abc', stage: 'planning', runId: null })
    expect(parseRoute('#/projects/abc/stages/planning/runs/r-1')).toEqual({ name: 'stage', projectId: 'abc', stage: 'planning', runId: 'r-1' })
    expect(parseRoute('#/projects/abc/stages/planning/other/r-1')).toEqual({ name: 'home' })
  })

  it('falls back to home for unknown paths', () => {
    expect(parseRoute('#/nope')).toEqual({ name: 'home' })
    expect(parseRoute('#/projects/abc/other/x')).toEqual({ name: 'home' })
  })

  it('round-trips encoded ids', () => {
    const routes: Route[] = [
      { name: 'home' },
      { name: 'create-project' },
      { name: 'project', projectId: 'a b/c', sessionId: null },
      { name: 'project', projectId: 'p', sessionId: 'session-1?x' },
      { name: 'project-home', projectId: 'p' },
      { name: 'stage', projectId: 'p', stage: 'planning', runId: null },
      { name: 'stage', projectId: 'p', stage: 'planning', runId: 'r/1' },
    ]
    for (const route of routes) expect(parseRoute(routeHref(route))).toEqual(route)
  })
})
