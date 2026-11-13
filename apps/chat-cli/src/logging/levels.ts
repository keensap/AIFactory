/**
 * Log levels and the runtime level controller.
 *
 * Mirrors Serilog's `MinimumLevel` + `Override` + `LoggingLevelSwitch`: a global
 * minimum, per-component overrides (hierarchical on `.`), and a runtime switch
 * that can auto-revert after a TTL so debug logging is never left on by accident.
 */

export const LEVEL_NAMES = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
export type Level = (typeof LEVEL_NAMES)[number]

/** Numeric values match pino so records and queue priorities share one scale. */
export const LEVEL_VALUE: Record<Level, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}

export function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && (LEVEL_NAMES as readonly string[]).includes(value)
}

export function levelFromValue(value: number): Level {
  let result: Level = 'trace'
  for (const name of LEVEL_NAMES) {
    if (LEVEL_VALUE[name] <= value) result = name
  }
  return result
}

export interface LevelSnapshot {
  level: Level
  baseLevel: Level
  override: Record<string, Level>
  revertAt: string | null
}

export class LevelController {
  private base: Level
  private active: Level
  private overrides = new Map<string, Level>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private revertAt: number | undefined

  constructor(level: Level = 'info', override: Record<string, Level> = {}) {
    this.base = level
    this.active = level
    for (const [component, value] of Object.entries(override)) {
      if (isLevel(value)) this.overrides.set(component, value)
    }
  }

  /** Effective minimum numeric level for a component (walks `a.b.c` → `a.b` → `a`). */
  levelFor(component?: string): number {
    if (component !== undefined && this.overrides.size > 0) {
      let key = component
      for (;;) {
        const found = this.overrides.get(key)
        if (found !== undefined) return LEVEL_VALUE[found]
        const dot = key.lastIndexOf('.')
        if (dot < 0) break
        key = key.slice(0, dot)
      }
    }
    return LEVEL_VALUE[this.active]
  }

  isEnabled(level: Level, component?: string): boolean {
    return LEVEL_VALUE[level] >= this.levelFor(component)
  }

  /**
   * Change the global level. With `ttlMs` the previous base level returns
   * automatically, which is the safe way to switch on `debug` temporarily.
   */
  setLevel(level: Level, options: { ttlMs?: number } = {}): void {
    this.clearTimer()
    this.active = level
    if (options.ttlMs !== undefined && options.ttlMs > 0) {
      this.revertAt = Date.now() + options.ttlMs
      this.timer = setTimeout(() => {
        this.active = this.base
        this.revertAt = undefined
        this.timer = undefined
      }, options.ttlMs)
      this.timer.unref?.()
    } else {
      this.base = level
      this.revertAt = undefined
    }
  }

  setOverride(component: string, level: Level | undefined): void {
    if (level === undefined) this.overrides.delete(component)
    else this.overrides.set(component, level)
  }

  snapshot(): LevelSnapshot {
    return {
      level: this.active,
      baseLevel: this.base,
      override: Object.fromEntries(this.overrides),
      revertAt: this.revertAt === undefined ? null : new Date(this.revertAt).toISOString(),
    }
  }

  dispose(): void {
    this.clearTimer()
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.revertAt = undefined
  }
}
