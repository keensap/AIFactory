#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../src/', import.meta.url))
const stageSpecs = 'processes/stages/'
const promptMarkers = /STAGE_ROLE:|You are the (?:independent )?Planning & Feasibility|You are (?:gathering requirements|(?:writing|reviewing|revising) the requirements specification)|Return only a <revision-plan>|Return a complete valid review/
const importPaths = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\(\s*)['"](\.[^'"\n]+)['"]/g
const untypedFindings = /\bfindings\??\s*:\s*(?:readonly\s+)?(?:unknown\s*\[\s*\]|(?:Readonly)?Array\s*<\s*unknown\s*>)/
const annotatedSpecs = /^([\t ]*)(?:export\s+)?(?:const|let)\s+(\w+)\s*:\s*PromptRoleSpec\s*<[^\n]+?>\s*=\s*/gm
const satisfiedSpecs = /^([\t ]*)(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*\{((?:(?!^\1\})[\s\S])*?)^\1\}\s+satisfies\s+PromptRoleSpec\s*</gm
const version = /^\s*version\s*:\s*(['"])(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\1\s*,?\s*$/m

function* sources(sourceRoot, directory = '') {
  for (const entry of readdirSync(join(sourceRoot, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = `${directory}${entry.name}`
    if (entry.isDirectory()) yield* sources(sourceRoot, `${file}/`)
    else if (entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file)) {
      yield [file, readFileSync(join(sourceRoot, file), 'utf8')]
    }
  }
}

export function checkProcesses(sourceRoot = root) {
  const issues = []
  for (const [file, source] of sources(sourceRoot)) {
    if (file === 'stage-runtime.ts') {
      for (const [, specifier] of source.matchAll(importPaths)) {
        if (/\/processes\/(?:[^/]+\/)*(?:adapters?|runners?)(?:\/|\.|$)/.test(specifier)) {
          issues.push(`${file}: Runtime imports process adapter or runner: ${specifier}`)
        }
      }
    }
    if (!file.startsWith(stageSpecs) && promptMarkers.test(source)) {
      issues.push(`${file}: Stage prompt prose belongs in process specs`)
    }
    const roleSource = file === 'stage-runtime.ts'
      ? [...source.matchAll(/\b(?:async\s+)?\w+\s*\(([^()]*\bfindings\s*:\s*[^()]*)\)\s*:/g)].map((match) => match[1]).join('\n')
      : file === 'stage-definition.ts' || file.startsWith(stageSpecs) ? source : ''
    if (untypedFindings.test(roleSource)) issues.push(`${file}: Role findings must use a typed finding array`)

    if (!file.startsWith(stageSpecs)) continue
    // Role specs are declared as named, multiline object literals. Do not count
    // versions inside methods or nested objects as the role's own version.
    const checkVersion = (indent, name, body) => {
      const topLevel = body.split('\n').filter((line) => /^\s*\S/.test(line) && line.match(/^[\t ]*/)[0].length === indent.length + 2).join('\n')
      if (!version.test(topLevel)) issues.push(`${file}: ${name} lacks a literal semantic version`)
    }
    for (const match of source.matchAll(annotatedSpecs)) {
      const [, indent, name] = match
      const initializer = source.slice(match.index + match[0].length)
      const body = new RegExp(`^\\{([\\s\\S]*?)^${indent}\\}`, 'm').exec(initializer)
      checkVersion(indent, name, body?.index === 0 ? body[1] : '')
    }
    for (const [, indent, name, body] of source.matchAll(satisfiedSpecs)) checkVersion(indent, name, body)
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
