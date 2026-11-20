import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

const script = new URL('../scripts/check-processes.mjs', import.meta.url).href

test('process guard accepts the production tree and rejects boundary violations', () => {
  const root = mkdtempSync(join(tmpdir(), 'process-guard-'))
  try {
    const check = (directory?: string): string[] => JSON.parse(execFileSync(process.execPath, [
      '--input-type=module', '-e', `import { checkProcesses } from ${JSON.stringify(script)}; console.log(JSON.stringify(checkProcesses(process.argv[1])))`,
      ...(directory ? [directory] : []),
    ], { encoding: 'utf8' }))
    assert.deepEqual(check(), [])
    mkdirSync(join(root, 'processes/stages'), { recursive: true })
    writeFileSync(join(root, 'stage-runtime.ts'), "import { X } from './processes/adapters/example.ts'\nconst prompt = 'STAGE_ROLE: author'\n")
    writeFileSync(join(root, 'processes/stages/example.ts'), "const example: PromptRoleSpec<Input> = {\n  id: 'example',\n}\n")
    mkdirSync(join(root, 'stages'))
    writeFileSync(join(root, 'stages/requirements.ts'), "const prompt = 'You are gathering requirements'\n")
    const issues = check(root)
    assert.equal(issues.length, 4)
    assert.ok(issues.some((issue) => issue.startsWith('stages/requirements.ts:')))
    assert.ok(issues.some((issue) => issue.includes('lacks a semantic version')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
