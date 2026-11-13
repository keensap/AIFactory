#!/usr/bin/env node
/**
 * Scripted stand-in for `dsh --json` used by the attribution tests.
 *
 * - emits one `step_end` status event with usage per role (USAGE env, JSON);
 * - appends its argv (one JSON line) to ARGV_LOG so tests can see which patch a
 *   role was started with;
 * - FAIL_ROLE=<role> makes that role fail;
 * - GATE_FILE=<path> makes the *analyzer* wait until the file exists, so a test
 *   can change the model target while a run is in flight.
 */
import { appendFileSync, existsSync } from 'node:fs'

let input = ''
for await (const chunk of process.stdin) input += chunk
const role = /STAGE_ROLE: (\w+)/.exec(input)?.[1] ?? 'unknown'

if (process.env.ARGV_LOG) appendFileSync(process.env.ARGV_LOG, `${JSON.stringify({ role, argv: process.argv.slice(2) })}\n`)

if (role === 'analyzer' && process.env.GATE_FILE) {
  while (!existsSync(process.env.GATE_FILE)) await new Promise((resolve) => setTimeout(resolve, 10))
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)
emit({ type: 'session', sessionId: `s-${role}`, cwd: process.cwd() })

if (process.env.FAIL_ROLE === role) {
  emit({ type: 'error', message: `synthetic ${role} failure`, code: 'FAKE_ERROR' })
  process.exit(1)
}

const usage = JSON.parse(process.env.USAGE ?? '{"inputTokens":1000,"outputTokens":500,"totalTokens":1500,"cacheReadTokens":0,"cacheWriteTokens":0}')
const text = role === 'reviewer'
  ? JSON.stringify({ decision: 'approved', findings: [] })
  : role === 'author'
    ? '# TELOS Feasibility Report\n\n## 10. Recommendation\n\nDecision: **Go**\n'
    : '# Planning analysis\n\n- Business idea: portal.\n'
emit({ type: 'status', phase: 'step_start', turn: 1, step: 1 })
emit({ type: 'text', text })
emit({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage })
emit({ type: 'final', sessionId: `s-${role}`, reason: { kind: 'completed' }, text })
