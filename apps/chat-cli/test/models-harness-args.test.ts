import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DshHarness } from '../src/harness.ts'

/** A harness stand-in that reports its own argv as the final text. */
function argvHarness(dir: string, extra: Record<string, unknown> = {}): DshHarness {
  const script = join(dir, 'argv-dsh.mjs')
  writeFileSync(script, `
    let input = ''
    for await (const chunk of process.stdin) input += chunk
    const argv = process.argv.slice(2)
    process.stdout.write(JSON.stringify({ type: 'session', sessionId: 's1', cwd: process.cwd() }) + '\\n')
    process.stdout.write(JSON.stringify({ type: 'final', sessionId: 's1', reason: { kind: 'completed' }, text: JSON.stringify({ argv, env: { openai: process.env.OPENAI_API_KEY ?? null, anthropic: process.env.ANTHROPIC_API_KEY ?? null } }) }) + '\\n')
  `)
  return new DshHarness({
    command: process.execPath,
    commandArgs: [script],
    profile: 'headless',
    ...extra,
  })
}

test('patch paths are passed to the harness as --patch before app flags', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aifactory-argv-'))
  try {
    const harness = argvHarness(dir, { patches: ['/tmp/a.yml', '/tmp/b.yml'] })
    const result = await harness.run('hi')
    const parsed = JSON.parse(result.text) as { argv: string[] }
    assert.deepEqual(parsed.argv.slice(0, 6), ['--profile', 'headless', '--patch', '/tmp/a.yml', '--patch', '/tmp/b.yml'])
    assert.equal(parsed.argv.at(-1), '--json')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a harness without patches keeps the plain profile invocation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aifactory-argv-'))
  try {
    const result = await argvHarness(dir).run('hi')
    const parsed = JSON.parse(result.text) as { argv: string[] }
    assert.deepEqual(parsed.argv, ['--profile', 'headless', '--json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('envDelete removes managed keys from the child environment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aifactory-argv-'))
  try {
    const harness = argvHarness(dir, {
      env: { OPENAI_API_KEY: 'sk-openai', ANTHROPIC_API_KEY: 'sk-anthropic' },
      envDelete: ['ANTHROPIC_API_KEY'],
    })
    const result = await harness.run('hi')
    const parsed = JSON.parse(result.text) as { env: { openai: string | null; anthropic: string | null } }
    assert.equal(parsed.env.openai, 'sk-openai')
    assert.equal(parsed.env.anthropic, null, 'the unselected provider key must not reach the child')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
