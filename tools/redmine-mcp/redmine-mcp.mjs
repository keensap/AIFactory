#!/usr/bin/env node
/**
 * Launcher shim for `mcp-server-redmine` 0.8.1.
 *
 * The package validates upload filenames and file paths with `/^[^\0]+$/`.
 * Its published JSON Schema emits `^[^\0]+$` verbatim, and strict schema
 * validators reject `\0` as an invalid regular expression — one bad tool
 * schema fails the entire model request.
 *
 * Rewriting the escape to `\u0000` keeps the null-byte check while producing a
 * portable pattern. The installed package is left untouched; the rewrite
 * happens in memory at launch, so upgrading the package keeps working.
 *
 * Point the DSH MCP entry at this file:
 *   command: /absolute/path/to/node
 *   args: ['/absolute/path/to/tools/redmine-mcp/redmine-mcp.mjs']
 *
 * The package entry is resolved from REDMINE_MCP_ENTRY, else from the global
 * npm root (`npm root -g`), so no machine-specific path is baked in.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PACKAGE_ENTRY = join('mcp-server-redmine', 'dist', 'index.mjs')

/** REDMINE_MCP_ENTRY, else the package inside the global npm root. */
function resolveEntry() {
  const configured = process.env.REDMINE_MCP_ENTRY
  if (configured !== undefined && configured !== '') return configured
  let root = ''
  try {
    root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    root = ''
  }
  if (root !== '') return join(root, PACKAGE_ENTRY)
  throw new Error('redmine-mcp shim: cannot resolve the global npm root; set REDMINE_MCP_ENTRY to the package entry (dist/index.mjs)')
}

const entry = resolveEntry()
if (!existsSync(entry)) {
  throw new Error(`redmine-mcp shim: package entry not found at ${entry}; install mcp-server-redmine@0.8.1 or set REDMINE_MCP_ENTRY`)
}
const FROM = String.raw`[^\0]`
const TO = String.raw`[^\u0000]`

const original = readFileSync(entry, 'utf8')
const occurrences = original.split(FROM).length - 1
if (occurrences === 0) {
  console.error(`redmine-mcp shim: no ${FROM} in ${entry} — running unpatched (upstream may have fixed it)`)
}

const source = original.split(FROM).join(TO)

// The bundle has no relative imports, so a data: URL module resolves cleanly.
await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`)
