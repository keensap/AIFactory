#!/usr/bin/env node
/**
 * CI guard for the observability ports.
 *
 * - The ports/no-op module must never import a vendor SDK or the Phoenix adapter.
 * - Core files are reported while Phase 1 is in progress; `--strict` makes them
 *   fail the build once the refactor is complete.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const strict = process.argv.includes('--strict')
const importPattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
const forbiddenPattern = /(?:^|[/@])(?:phoenix|@opentelemetry|opentelemetry|arize)(?:[/.]|$)/i

function importsOf(file) {
  const source = readFileSync(file, 'utf8')
  return [...source.matchAll(importPattern)].map((match) => match[1])
}

function violations(files) {
  return files.flatMap((file) => importsOf(file)
    .filter((specifier) => forbiddenPattern.test(specifier))
    .map((specifier) => `${relative(root, file)} -> ${specifier}`))
}

// Only the top-level port modules are vendor-free. Adapter directories
// (src/observability/phoenix/ and future adapters) are allowed to import SDKs.
const observabilityFiles = readdirSync(join(root, 'src/observability'))
  .filter((name) => name.endsWith('.ts'))
  .map((name) => join(root, 'src/observability', name))
const observabilityViolations = violations(observabilityFiles)
if (observabilityViolations.length > 0) {
  console.error('Observability ports must not import vendor code:')
  for (const violation of observabilityViolations) console.error(`  - ${violation}`)
  process.exit(1)
}

const coreFiles = [
  'src/stage-runtime.ts',
  'src/server.ts',
  'src/logging/context.ts',
  'src/logging/logging.ts',
].map((path) => join(root, path)).filter((path) => {
  try { return statSync(path).isFile() } catch { return false }
})
const coreViolations = violations(coreFiles)
if (coreViolations.length > 0) {
  const label = strict ? 'Core files still import vendor code (Phase 1 blocker):' : 'Legacy vendor imports remain in core (Phase 1 will remove them):'
  ;(strict ? console.error : console.warn)(label)
  for (const violation of coreViolations) (strict ? console.error : console.warn)(`  - ${violation}`)
  if (strict) process.exit(1)
}

console.log(`observability guard: ${observabilityFiles.length} port files clean; ${coreViolations.length} legacy core imports`)
