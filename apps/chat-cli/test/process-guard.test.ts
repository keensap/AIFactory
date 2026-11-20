import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { checkProcesses } from '../scripts/check-processes.mjs'

test('process guard accepts the production tree', () => {
  assert.deepEqual(checkProcesses(), [])
})

test('process guard checks prompt location, engine imports, spec versions and role findings', () => {
  const root = mkdtempSync(join(tmpdir(), 'process-guard-'))
  try {
    const files = {
      'stage-runtime.ts': `import type { X } from './processes/adapters/example.ts'
const load = () => import('./processes/stages/runners/example.ts')
const repair = 'Return only a <revision-plan>'
function revise(findings: unknown[]): void {}
interface StoredReview { findings: unknown[] }`,
      'stage-definition.ts': 'interface Prompts { revise(findings: readonly unknown[]): string }',
      'workspace.ts': 'interface StoredReview { findings: unknown[] }',
      'stages/nested/requirements.ts': "const prompt = 'You are gathering requirements'",
      'processes/stages/nested/example.ts': `interface RevisionInput { findings: Array<unknown> }
export const missing: PromptRoleSpec<Input> = {
  id: 'missing',
  nested: {
    version: '1.0.0',
  },
}
export const nonliteral = {
  version: currentVersion,
} satisfies PromptRoleSpec<Input>
export const valid: PromptRoleSpec<Input> = {
  version: '1.0.0',
  sections: () => [{ body: 'STAGE_ROLE: author' }],
}
export const alsoValid = {
  version: '2.0.0',
} satisfies PromptRoleSpec<Input>`,
    }
    for (const [file, content] of Object.entries(files)) {
      const path = join(root, file)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }
    assert.deepEqual(checkProcesses(root).sort(), [
      'stage-runtime.ts: Runtime imports process adapter or runner: ./processes/adapters/example.ts',
      'stage-runtime.ts: Runtime imports process adapter or runner: ./processes/stages/runners/example.ts',
      'stage-runtime.ts: Stage prompt prose belongs in process specs',
      'stage-runtime.ts: Role findings must use a typed finding array',
      'stage-definition.ts: Role findings must use a typed finding array',
      'stages/nested/requirements.ts: Stage prompt prose belongs in process specs',
      'processes/stages/nested/example.ts: Role findings must use a typed finding array',
      'processes/stages/nested/example.ts: missing lacks a literal semantic version',
      'processes/stages/nested/example.ts: nonliteral lacks a literal semantic version',
    ].sort())
  } finally {
    // root is the absolute directory just created by mkdtempSync.
    rmSync(root, { recursive: true, force: true })
  }
})
