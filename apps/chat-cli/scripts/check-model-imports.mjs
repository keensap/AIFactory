#!/usr/bin/env node
/**
 * CI guard for the model provider ports.
 *
 * - Files directly under `src/models/` are the contract and must stay
 *   vendor-free (no provider SDKs).
 * - Adapter directories (`src/models/<adapter>/`) may import their SDK or use
 *   fetch, but must not be imported by the HTTP server or the stage runtime
 *   directly; those go through the router.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const importPattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
const vendorPattern = /(?:^|[/@])(@anthropic-ai|openai|@google|@aws-sdk|@azure|cohere-ai|groq-sdk|@mistralai|ollama|@huggingface)(?:[/.]|$)/i

function importsOf(file) {
  const source = readFileSync(file, 'utf8')
  return [...source.matchAll(importPattern)].map((match) => match[1])
}

const modelsDirectory = join(root, 'src/models')
const entries = readdirSync(modelsDirectory)

const coreFiles = entries
  .filter((name) => name.endsWith('.ts'))
  .map((name) => join(modelsDirectory, name))

const violations = []
for (const file of coreFiles) {
  for (const specifier of importsOf(file)) {
    if (vendorPattern.test(specifier)) violations.push(`${relative(root, file)} -> ${specifier}`)
  }
}

if (violations.length > 0) {
  console.error('Model ports must not import vendor SDKs:')
  for (const violation of violations) console.error(`  - ${violation}`)
  process.exit(1)
}

// Adapters may use vendor code, but the HTTP server and stage runtime must not
// import an adapter directly (they consume the neutral ports).
const adapterDirectories = entries.filter((name) => {
  try {
    return statSync(join(modelsDirectory, name)).isDirectory()
  } catch {
    return false
  }
})

const coreConsumers = ['src/server.ts', 'src/stage-runtime.ts']
  .map((path) => join(root, path))
const adapterImports = []
for (const file of coreConsumers) {
  try {
    for (const specifier of importsOf(file)) {
      if (/models\/.+/.test(specifier) && !/models\/(index|ports|fake)\.ts$/.test(specifier)) {
        adapterImports.push(`${relative(root, file)} -> ${specifier}`)
      }
    }
  } catch {
    // File may not exist yet.
  }
}

if (adapterImports.length > 0) {
  console.error('Core files must not import a model adapter directly:')
  for (const violation of adapterImports) console.error(`  - ${violation}`)
  process.exit(1)
}

console.log(`model guard: ${coreFiles.length} port files clean; ${adapterDirectories.length} adapter(s); 0 direct adapter imports`)
