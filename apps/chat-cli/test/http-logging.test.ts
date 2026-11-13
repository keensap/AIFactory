import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DshHarness } from '../src/harness.ts'
import { createLogging, type LogEvent, type LogSink } from '../src/logging/index.ts'
import { createChatServer, serverPort } from '../src/server.ts'
import { SessionStore } from '../src/store.ts'

class MemorySink implements LogSink {
  readonly name = 'memory'
  readonly events: LogEvent[] = []
  write(batch: readonly LogEvent[]): void { this.events.push(...batch) }
}

async function withServer(run: (base: string, sink: MemorySink, flush: () => Promise<void>) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'aifactory-httplog-'))
  const sink = new MemorySink()
  const logging = createLogging({ service: 'test', level: 'debug', sinks: [sink] })
  const server = createChatServer({
    harnessFactory: () => new DshHarness({ command: process.execPath, commandArgs: ['-e', ''] }),
    store: new SessionStore({ dataDir }),
    version: 'test',
    logger: logging.logger,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    await run(`http://127.0.0.1:${serverPort(server)}`, sink, async () => { await logging.flush() })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await logging.shutdown()
    rmSync(dataDir, { recursive: true, force: true })
  }
}

test('assigns a request id, returns it, and logs a structured access event', async () => {
  await withServer(async (base, sink, flush) => {
    const response = await fetch(`${base}/api/health`)
    const requestId = response.headers.get('x-request-id')
    assert.ok(requestId && requestId.length >= 8)
    await flush()
    const access = sink.events.map((e) => e.record).find((r) => r.event === 'http.request')
    assert.ok(access)
    assert.equal(access.requestId, requestId)
    assert.equal(access.component, 'http')
    assert.equal(access.status, 200)
    assert.equal(access.path, '/api/health')
    assert.equal(access.level, 'debug')
    assert.equal(typeof access.durationMs, 'number')
  })
})

test('accepts a valid caller request id and rejects malformed ones', async () => {
  await withServer(async (base, sink, flush) => {
    const good = await fetch(`${base}/api/health`, { headers: { 'x-request-id': 'client-req-12345' } })
    assert.equal(good.headers.get('x-request-id'), 'client-req-12345')
    const bad = await fetch(`${base}/api/health`, { headers: { 'x-request-id': 'x y\n' } })
    assert.notEqual(bad.headers.get('x-request-id'), 'x y\n')
    await flush()
    assert.ok(sink.events.length >= 2)
  })
})

test('logs client errors at warn level with the same request id', async () => {
  await withServer(async (base, sink, flush) => {
    const response = await fetch(`${base}/api/nope`)
    assert.equal(response.status, 404)
    await flush()
    const access = sink.events.map((e) => e.record).find((r) => r.event === 'http.request' && r.path === '/api/nope')
    assert.equal(access?.level, 'warn')
    assert.equal(access?.requestId, response.headers.get('x-request-id'))
  })
})
