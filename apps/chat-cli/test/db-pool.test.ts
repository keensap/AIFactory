import assert from 'node:assert/strict'
import test from 'node:test'
import { closeSharedPools, logSinkPool, poolCapacity, poolSnapshot, sharedPool } from '../src/db.ts'

const URL_A = 'postgres://unit-test-a@127.0.0.1:5432/aifactory_unit_a'
const URL_B = 'postgres://unit-test-b@127.0.0.1:5432/aifactory_unit_b'

test('one pool per connection string, shared by every store', () => {
  try {
    assert.equal(sharedPool(URL_A), sharedPool(URL_A), 'the same URL yields the same pool')
    assert.notEqual(sharedPool(URL_A), sharedPool(URL_B), 'different databases are not mixed')
  } finally {
    void closeSharedPools()
  }
})

test('the process holds one application pool plus one small log pool', async () => {
  // The defect was twelve pools and up to 46 connections per process (AR-12).
  try {
    sharedPool(URL_A)
    sharedPool(URL_A)
    sharedPool(URL_A)
    const capacity = poolCapacity()
    assert.equal(capacity.app, 10, 'AIFACTORY_DB_POOL_MAX default')
    assert.equal(capacity.logs, 0, 'no log pool until one is asked for')

    logSinkPool(URL_A)
    logSinkPool(URL_A)
    const withLogs = poolCapacity()
    assert.equal(withLogs.logs, 2, 'the log sink has its own small pool')
    assert.ok(withLogs.app + withLogs.logs <= 12, `expected at most 12 connections, got ${withLogs.app + withLogs.logs}`)
  } finally {
    await closeSharedPools()
  }
})

test('the log sink pool is separate from the application pool', () => {
  try {
    assert.notEqual(logSinkPool(URL_A), sharedPool(URL_A), 'a blocked log write must not take a request connection')
  } finally {
    void closeSharedPools()
  }
})

test('pool statistics are exposed for health', async () => {
  try {
    sharedPool(URL_A)
    const snapshot = poolSnapshot()
    assert.equal(snapshot.app.length, 1)
    assert.equal(typeof snapshot.app[0]?.total, 'number')
  } finally {
    await closeSharedPools()
  }
})

test('closing releases every pool and forgets them', async () => {
  sharedPool(URL_A)
  logSinkPool(URL_A)
  await closeSharedPools()
  assert.deepEqual(poolCapacity(), { app: 0, logs: 0 })
})
