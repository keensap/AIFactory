import assert from 'node:assert/strict'
import test from 'node:test'
import { RunTelemetryFolder, emptyTelemetry, percentOf, telemetryFromEvents } from '../src/telemetry.ts'

const usage = (input: number, output: number, extra: Record<string, number> = {}) => ({
  inputTokens: input, outputTokens: output, totalTokens: input + output + (extra.cacheReadTokens ?? 0), ...extra,
})

/** step_start at t, step_end at t+durationMs with usage. */
function step(folder: RunTelemetryFolder, turn: number, num: number, at: number, durationMs: number, u?: unknown): void {
  folder.add({ type: 'status', phase: 'step_start', turn, step: num }, at)
  folder.add({ type: 'status', phase: 'step_end', turn, step: num, ...(u !== undefined ? { usage: u } : {}) }, at + durationMs)
}

test('an empty folder reports zeros and nulls, never misleading zeroes for ratios', () => {
  assert.deepEqual(new RunTelemetryFolder().snapshot(), emptyTelemetry())
})

test('turns, steps and cumulative usage accumulate across turns', () => {
  const folder = new RunTelemetryFolder()
  folder.add({ type: 'status', phase: 'turn_start', turn: 1 }, 1_000)
  step(folder, 1, 1, 1_000, 1_000, usage(100, 50))
  folder.add({ type: 'status', phase: 'turn_end', turn: 1 }, 3_000)
  folder.add({ type: 'status', phase: 'turn_start', turn: 2 }, 4_000)
  step(folder, 2, 1, 4_000, 2_000, usage(200, 100))
  const snapshot = folder.snapshot()
  assert.equal(snapshot.turns, 2)
  assert.equal(snapshot.steps, 2)
  assert.deepEqual(snapshot.usage, { input: 300, output: 150, total: 450, cacheRead: 0, cacheWrite: 0 })
  assert.equal(snapshot.phase, 'step_end')
})

test('tokens per second is per step and averaged over timed steps', () => {
  const folder = new RunTelemetryFolder()
  step(folder, 1, 1, 0, 1_000, usage(10, 100))    // 100 tok/s
  assert.equal(folder.snapshot().tokensPerSecond, 100)
  step(folder, 1, 2, 2_000, 2_000, usage(10, 100)) // 50 tok/s
  const snapshot = folder.snapshot()
  assert.equal(snapshot.tokensPerSecond, 50, 'the bar shows the latest step')
  assert.equal(snapshot.averageTokensPerSecond, 66.7, 'run average across both steps')
})

test('a step with no usage is still a step but adds no tokens and no rate', () => {
  const folder = new RunTelemetryFolder()
  step(folder, 1, 1, 0, 1_000, usage(10, 20))
  step(folder, 1, 2, 2_000, 1_000) // e.g. a failed attempt the harness omitted usage for
  const snapshot = folder.snapshot()
  assert.equal(snapshot.steps, 2)
  assert.deepEqual(snapshot.usage, { input: 10, output: 20, total: 30, cacheRead: 0, cacheWrite: 0 })
  assert.equal(snapshot.tokensPerSecond, 20, 'the last step with usage still drives the bar')
})

test('cache-hit percentage counts cache reads against the prompt total', () => {
  const folder = new RunTelemetryFolder()
  step(folder, 1, 1, 0, 1_000, usage(2_000, 500, { cacheReadTokens: 8_000 }))
  // prompt = input 2000 + cacheRead 8000 = 10000, of which 8000 came from cache
  const snapshot = folder.snapshot()
  assert.equal(snapshot.cacheHitPercent, 80)
  assert.equal(snapshot.usage.total, 10_500)
})

test('cache-hit is null (not 0%) when the prompt is empty', () => {
  const folder = new RunTelemetryFolder()
  step(folder, 1, 1, 0, 1_000, usage(0, 10))
  assert.equal(folder.snapshot().cacheHitPercent, null)
})

test('context usage uses the last step prompt and the model window', () => {
  const folder = new RunTelemetryFolder({ model: { provider: 'openai', model: 'gpt-4o' }, contextWindow: 128_000 })
  step(folder, 1, 1, 0, 1_000, usage(20_000, 100, { cacheReadTokens: 12_000 }))
  const snapshot = folder.snapshot()
  assert.deepEqual(snapshot.model, { provider: 'openai', model: 'gpt-4o' })
  assert.equal(snapshot.contextUsedTokens, 32_000, 'input + cache reads')
  assert.equal(snapshot.contextWindow, 128_000)
  assert.equal(snapshot.contextUsedPercent, 25)
})

test('context percentage is null without a window, and picks the window up from events', () => {
  const folder = new RunTelemetryFolder()
  step(folder, 1, 1, 0, 1_000, usage(1_000, 10))
  assert.equal(folder.snapshot().contextUsedPercent, null, 'no window known')
  folder.add({ type: 'status', phase: 'step_end', turn: 1, step: 2, usage: usage(1_000, 10), contextWindow: 4_000 }, 3_000)
  const snapshot = folder.snapshot()
  assert.equal(snapshot.contextWindow, 4_000)
  assert.equal(snapshot.contextUsedPercent, 25)
})

test('model comes from the event stream and survives events that omit it', () => {
  const folder = new RunTelemetryFolder()
  folder.add({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: usage(5, 5), model: { provider: 'anthropic', model: 'claude' } }, 1)
  folder.add({ type: 'status', phase: 'step_start', turn: 1, step: 2 }, 2)
  assert.deepEqual(folder.snapshot().model, { provider: 'anthropic', model: 'claude' })
})

test('out-of-order and malformed events do not corrupt the totals', () => {
  const folder = new RunTelemetryFolder()
  folder.add({ type: 'status', phase: 'turn_start', turn: 3 }, 10)
  step(folder, 2, 1, 0, 500, usage(10, 10)) // an earlier turn arrives late
  folder.add({ type: 'bogus' }, 20)
  folder.add(null, 20)
  folder.add({ type: 'status', phase: 'step_end', turn: 2, step: 9, usage: { inputTokens: 'x' } }, 30)
  const snapshot = folder.snapshot()
  assert.equal(snapshot.turns, 3, 'the highest turn wins')
  assert.equal(snapshot.steps, 2, 'both step_end events counted')
  assert.equal(snapshot.usage.output, 10, 'the malformed usage contributed nothing')
})

test('a step_end without a matching step_start has no duration and no rate', () => {
  const folder = new RunTelemetryFolder()
  folder.add({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: usage(10, 100) }, 5_000)
  const snapshot = folder.snapshot()
  assert.equal(snapshot.lastStep?.durationMs, null)
  assert.equal(snapshot.lastStep?.tokensPerSecond, null)
  assert.equal(snapshot.averageTokensPerSecond, null)
  assert.equal(snapshot.usage.output, 100)
})

test('percentOf bounds its output and refuses a zero whole', () => {
  assert.equal(percentOf(1, 4), 25)
  assert.equal(percentOf(1, 3), 33.3)
  assert.equal(percentOf(5, 4), 100, 'never above 100')
  assert.equal(percentOf(-1, 4), 0)
  assert.equal(percentOf(1, 0), null)
  assert.equal(percentOf(Number.NaN, 4), null)
})

test('snapshots are copies: later events do not mutate an earlier snapshot', () => {
  const folder = new RunTelemetryFolder()
  step(folder, 1, 1, 0, 1_000, usage(10, 10))
  const before = folder.snapshot()
  step(folder, 1, 2, 2_000, 1_000, usage(10, 10))
  assert.equal(before.usage.output, 10)
  assert.equal(before.steps, 1)
  before.usage.output = 999
  assert.equal(folder.snapshot().usage.output, 20)
})

test('folding stored events uses their createdAt timestamps', () => {
  const events = [
    { createdAt: '2026-01-01T10:00:00.000Z', payload: { type: 'status', phase: 'step_start', turn: 1, step: 1 } },
    { createdAt: '2026-01-01T10:00:02.000Z', payload: { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: usage(100, 200) } },
    { createdAt: '2026-01-01T10:00:02.500Z', payload: { type: 'text', text: 'hello' } },
  ]
  const snapshot = telemetryFromEvents(events, { contextWindow: 1_000, model: { provider: 'p', model: 'm' } })
  assert.equal(snapshot.steps, 1)
  assert.equal(snapshot.tokensPerSecond, 100, '200 output tokens over 2s')
  assert.equal(snapshot.contextUsedPercent, 10)
  assert.equal(snapshot.startedAt, '2026-01-01T10:00:00.000Z')
  assert.equal(snapshot.updatedAt, '2026-01-01T10:00:02.500Z')
})

test('an unusable createdAt falls back to the current time instead of NaN', () => {
  const snapshot = telemetryFromEvents([
    { createdAt: 'not-a-date', payload: { type: 'status', phase: 'step_start', turn: 1, step: 1 } },
    { payload: { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: usage(1, 1) } },
  ])
  assert.equal(snapshot.steps, 1)
  assert.ok(snapshot.startedAt !== null && !snapshot.startedAt.includes('NaN'))
})

test('a status payload without an explicit type is still folded', () => {
  // Real stage events carry `type`, but a hand-written or older payload may not.
  const folder = new RunTelemetryFolder()
  folder.add({ phase: 'step_start', turn: 1, step: 1 }, 0)
  folder.add({ phase: 'step_end', turn: 1, step: 1, usage: usage(10, 20) }, 1_000)
  const snapshot = folder.snapshot()
  assert.equal(snapshot.steps, 1)
  assert.equal(snapshot.usage.output, 20)
  assert.equal(snapshot.tokensPerSecond, 20)
})
