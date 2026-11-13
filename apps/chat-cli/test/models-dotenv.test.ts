import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveDotEnvPath } from '../src/config.ts'

function tree(): string {
  return mkdtempSync(join(tmpdir(), 'aifactory-dotenv-'))
}

test('prefers the working directory .env', () => {
  const root = tree()
  writeFileSync(join(root, '.env'), 'A=1\n')
  const nested = join(root, 'apps', 'chat-cli')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(nested, '.env'), 'B=2\n')
  assert.equal(resolveDotEnvPath(nested, {}), join(nested, '.env'))
  rmSync(root, { recursive: true, force: true })
})

test('walks up to the workspace root .env', () => {
  const root = tree()
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, '.env'), 'A=1\n')
  const nested = join(root, 'apps', 'chat-cli')
  mkdirSync(nested, { recursive: true })
  assert.equal(resolveDotEnvPath(nested, {}), join(root, '.env'))
  rmSync(root, { recursive: true, force: true })
})

test('never loads a .env above the workspace root', () => {
  const outer = tree()
  writeFileSync(join(outer, '.env'), 'OUTER=1\n')
  const root = join(outer, 'repo')
  mkdirSync(join(root, '.git'), { recursive: true })
  const nested = join(root, 'apps')
  mkdirSync(nested, { recursive: true })
  assert.equal(resolveDotEnvPath(nested, {}), undefined)
  rmSync(outer, { recursive: true, force: true })
})

test('returns undefined when no .env exists', () => {
  const root = tree()
  mkdirSync(join(root, '.git'))
  assert.equal(resolveDotEnvPath(root, {}), undefined)
  rmSync(root, { recursive: true, force: true })
})

test('an explicit AIFACTORY_DOTENV wins and may be relative', () => {
  const root = tree()
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, '.env'), 'A=1\n')
  writeFileSync(join(root, 'custom.env'), 'B=2\n')
  assert.equal(resolveDotEnvPath(root, { AIFACTORY_DOTENV: 'custom.env' }), join(root, 'custom.env'))
  assert.equal(resolveDotEnvPath(root, { AIFACTORY_DOTENV: '/does/not/exist' }), undefined)
  rmSync(root, { recursive: true, force: true })
})
