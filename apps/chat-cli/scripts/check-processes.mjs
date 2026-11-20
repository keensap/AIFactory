#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../src/', import.meta.url))

export function checkProcesses(sourceRoot = root) {
  const issues = []
  const runtime = readFileSync(join(sourceRoot, 'stage-runtime.ts'), 'utf8')
  for (const match of runtime.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.\/processes\/[^'"]+)['"]/g)) {
    if (/\/(?:adapters|runners)\//.test(match[1])) issues.push(`Runtime imports process adapter: ${match[1]}`)
  }
  if (/STAGE_ROLE:|You are the (?:independent )?Planning & Feasibility/.test(runtime)) {
    issues.push('Stage prompt prose belongs in process specs, not the runtime')
  }
  for (const file of readdirSync(join(sourceRoot, 'processes/stages')).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(join(sourceRoot, 'processes/stages', file), 'utf8')
    for (const match of source.matchAll(/\bconst\s+(\w+)\s*:\s*PromptRoleSpec<[^>]+>\s*=\s*\{([\s\S]*?)(?=^\}|$(?![\s\S]))/gm)) {
      if (!/\bversion:\s*['"]\d+\.\d+\.\d+['"]/.test(match[2])) issues.push(`${file}: ${match[1]} lacks a semantic version`)
    }
  }
  return issues
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const issues = checkProcesses()
  if (issues.length) {
    console.error(issues.join('\n'))
    process.exitCode = 1
  } else console.log('Process architecture guard passed')
}
