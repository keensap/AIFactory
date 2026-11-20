#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../src/', import.meta.url))

export function checkProcesses(sourceRoot = root) {
  const issues = []
  const runtime = readFileSync(join(sourceRoot, 'stage-runtime.ts'), 'utf8')
  for (const match of runtime.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"](\.\/processes\/[^'"]+)['"]/g)) {
    if (/\/(?:adapters|runners)\//.test(match[1])) issues.push(`Runtime imports process adapter: ${match[1]}`)
  }
  const stagePrompt = /STAGE_ROLE:|You are the (?:independent )?Planning & Feasibility|You are (?:gathering requirements|(?:writing|reviewing|revising) the requirements specification)/
  for (const [file, source] of [['stage-runtime.ts', runtime], ...readdirSync(join(sourceRoot, 'stages'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map(({ name }) => [`stages/${name}`, readFileSync(join(sourceRoot, 'stages', name), 'utf8')])]) {
    if (stagePrompt.test(source)) issues.push(`${file}: Stage prompt prose belongs in process specs`)
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
