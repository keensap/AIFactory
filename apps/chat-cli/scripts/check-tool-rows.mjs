#!/usr/bin/env node
/**
 * Guard: every `tool-*` row the harness profile declares must be classified.
 *
 * An agent's tool allowlist is applied fail-closed, which depends on knowing
 * whether each row is a model-facing tool or infrastructure. A harness upgrade
 * that adds a row would otherwise be granted silently to every restricted agent,
 * so this check fails CI instead of the next run leaking a tool.
 *
 * Usage: node scripts/check-tool-rows.mjs [--command <dsh>] [--profile <name>]
 * Exits 0 when every row is classified (or when the harness cannot be read here,
 * which is reported and skipped), 1 on drift.
 *
 * This runs as a separate process, like check-model-imports.mjs, because spawning
 * the harness from inside the test runner's worker context fails on filesystem
 * writes the harness itself performs.
 */

import { existsSync } from 'node:fs'
import { readProfileToolRows } from '../src/harness.ts'
import { MODEL_FACING_TOOL_ROWS, INFRASTRUCTURE_TOOL_ROWS, classifyToolRows } from '../src/agent-patch.ts'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

const profile = option('profile', 'headless')
const candidates = [
  option('command', undefined),
  process.env.AIFACTORY_DSH_BIN,
  'dsh',
  '/fs22/deepseek-harness/apps/cli/lib/bin.js',
].filter((value) => typeof value === 'string' && value !== '')

// The harness reads its profile from DSH_HOME. Try the configured home first, then
// the checkout's, so the guard works in CI and on a developer machine alike.
const homes = [...new Set([
  process.env.DSH_HOME,
  '/data/AIFactory2/.dsh-home',
].filter((value) => typeof value === 'string' && value !== '' && existsSync(value)))]

const attempts = []
let rows

for (const dshHome of homes) {
  for (const command of [...new Set(candidates)]) {
    try {
      rows = await readProfileToolRows({
        command,
        profile,
        timeoutMs: 60_000,
        env: { DSH_HOME: dshHome },
      })
      break
    } catch (error) {
      attempts.push(`${command} (DSH_HOME=${dshHome}): ${error.message.slice(0, 140)}`)
    }
  }
  if (rows !== undefined) break
}

if (rows === undefined) {
  console.log(`tool guard: could not read the ${profile} profile; skipped`)
  for (const attempt of attempts) console.log(`  tried ${attempt}`)
  process.exit(0)
}
if (rows.length === 0) {
  console.log(`tool guard: the ${profile} profile declares no tool rows; skipped`)
  process.exit(0)
}

const classification = classifyToolRows(rows)
if (classification.unclassified.length > 0) {
  console.error(`tool guard: ${classification.unclassified.length} unclassified tool row(s) in the ${profile} profile:`)
  for (const row of classification.unclassified) console.error(`  - ${row}`)
  console.error('')
  console.error('Classify each one in apps/chat-cli/src/agent-patch.ts:')
  console.error('  MODEL_FACING_TOOL_ROWS   exposes tools the model can call (governed by agent allowlists)')
  console.error('  INFRASTRUCTURE_TOOL_ROWS plumbing that must stay enabled')
  process.exit(1)
}

console.log(
  `tool guard: ${rows.length} tool rows classified `
  + `(${classification.modelFacing.length} model-facing, ${classification.infrastructure.length} infrastructure)`,
)
void MODEL_FACING_TOOL_ROWS
void INFRASTRUCTURE_TOOL_ROWS