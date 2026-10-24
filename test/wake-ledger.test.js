/**
 * 0.2.0 segment 1: SQLite v2 -> v3 migration and the durable intent-due wake
 * ledger. No DSH calls, no model wake, no idle wakes, no model tools.
 *
 * All data is temporary synthetic SQLite; no profile database is touched.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { LifeCore } from '../src/core.js'
import { apply } from '../src/index.js'
import {
  LifeInvalidTransitionError,
  LifeStorageError,
  LifeUnauthorizedError,
  LifeValidationError,
} from '../src/model.js'

const BASE = '2026-01-01T00:00:00.000Z'
const SESSION_ID = 'session-11111111-1111-4111-8111-111111111111'
const DSH_SCOPE = `session:${SESSION_ID}`
const AUTH = `life-tool:${DSH_SCOPE}`

function makeClock(start = BASE) {
  let t = Date.parse(start)
  return { now: () => t, advance: (ms) => { t += ms }, at: (ms) => new Date(t + ms).toISOString() }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'amadeus-life-wake-'))
}

function openCore(databasePath, clock) {
  return new LifeCore({ databasePath, clock: clock.now })
}

function fakeContext() {
  const tools = new Map()
  const provided = new Map()
  const disposers = []
  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    provide: (serviceName, value) => provided.set(serviceName, value),
    effect: (fn) => { disposers.push(fn()) },
    emit() {},
    logger: { error() {}, warn() {} },
  }
  return { ctx, tools, provided, disposers }
}

function createDueIntent(core, clock, scope = DSH_SCOPE, auth = AUTH) {
  const intent = core.createIntent({
    description: 'wake on this intent',
    reviewAt: clock.at(0),
    contextScope: scope,
    authorizationRef: auth,
  })
  core.tick()
  return intent
}

/** Build a synthetic, healthy v2 store with rows to preserve. */
function createV2Fixture(databasePath, { conflictIndex = false } = {}) {
  const db = new DatabaseSync(databasePath)
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE intents (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision >= 1), status TEXT NOT NULL,
      description TEXT NOT NULL, context_scope TEXT NOT NULL, authorization_ref TEXT NOT NULL,
      related_activity_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, review_at TEXT NOT NULL
    );
    CREATE INDEX idx_intents_due ON intents (status, review_at);
    CREATE TABLE intent_events (
      id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, intent_revision INTEGER NOT NULL, type TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, acknowledged_at TEXT, payload_json TEXT NOT NULL,
      UNIQUE (intent_id, intent_revision, type)
    );
    CREATE INDEX idx_intent_events_status ON intent_events (status);
    CREATE TABLE activities (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, status TEXT NOT NULL, description TEXT NOT NULL,
      provider_id TEXT, intent_id TEXT, owner_scope TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_activities_owner ON activities (owner_scope, status);
    CREATE TABLE runtime_leases (key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, pid INTEGER NOT NULL, acquired_at TEXT NOT NULL);
  `)
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '2')
  db.prepare(
    `INSERT INTO intents (id, revision, status, description, context_scope, authorization_ref,
      related_activity_id, created_at, updated_at, review_at)
     VALUES (?, 2, 'active', 'v2 survivor', ?, ?, NULL, ?, ?, ?)`,
  ).run('intent_v2_keep', DSH_SCOPE, AUTH, BASE, BASE, BASE)
  db.prepare(
    `INSERT INTO intent_events (id, intent_id, intent_revision, type, status, created_at, acknowledged_at, payload_json)
     VALUES (?, ?, 2, 'reconsideration', 'pending', ?, NULL, '{}')`,
  ).run(`reconsider:intent_v2_keep:2`, 'intent_v2_keep', BASE)
  db.prepare(
    `INSERT INTO activities (id, revision, status, description, provider_id, intent_id, owner_scope,
      evidence_json, created_at, updated_at)
     VALUES ('activity_v2_keep', 3, 'running', 'v2 work', NULL, NULL, ?, '["v2:evidence"]', ?, ?)`,
  ).run(DSH_SCOPE, BASE, BASE)
  db.prepare(
    "INSERT INTO runtime_leases (key, owner_id, pid, acquired_at) VALUES ('adapter', 'v2-owner', 1, ?)",
  ).run(BASE)
  if (conflictIndex) db.exec("CREATE TABLE idx_wake_status (x TEXT)")
  db.close()
}

// A. Migration ---------------------------------------------------------------
test('A1 v2 store migrates to v4 preserving rows and reopens idempotently', () => {
  const dir = tempDir()
  const databasePath = join(dir, 'life.sqlite')
  createV2Fixture(databasePath)
  const clock = makeClock()
  const core = openCore(databasePath, clock)
  try {
    assert.equal(core.getHealth().schemaVersion, '5')
    assert.equal(core.getIntent('intent_v2_keep', { scope: DSH_SCOPE }).description, 'v2 survivor')
    assert.equal(core.getIntent('intent_v2_keep', { scope: DSH_SCOPE }).revision, 2)
    assert.equal(core.listOutbox({ scope: DSH_SCOPE }).length, 1)
    assert.equal(core.getActivity('activity_v2_keep', { scope: DSH_SCOPE }).status, 'running')
    assert.deepEqual(core.getActivity('activity_v2_keep', { scope: DSH_SCOPE }).evidenceRefs, ['v2:evidence'])
    assert.deepEqual(core.listWakes(), [])
  } finally {
    core.close()
  }

  const raw = new DatabaseSync(databasePath)
  try {
    assert.equal(raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '5')
    assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wake_requests'").get())
    assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wake_consumption'").get())
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM intents").get().n, 1)
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM runtime_leases").get().n, 1)
  } finally {
    raw.close()
  }

  const reopened = openCore(databasePath, clock)
  try {
    assert.equal(reopened.getHealth().schemaVersion, '5')
    assert.equal(reopened.getIntent('intent_v2_keep', { scope: DSH_SCOPE }).revision, 2)
    assert.equal(reopened.listOutbox({ scope: DSH_SCOPE }).length, 1)
  } finally {
    reopened.close()
  }
})

test('A2 failed v2 migration rolls back and leaves the v2 store intact', () => {
  const dir = tempDir()
  const databasePath = join(dir, 'life.sqlite')
  createV2Fixture(databasePath, { conflictIndex: true })
  const clock = makeClock()
  assert.throws(() => openCore(databasePath, clock), (error) => error instanceof LifeStorageError)
  const raw = new DatabaseSync(databasePath)
  try {
    assert.equal(raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '2')
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM intents').get().n, 1)
    assert.equal(
      raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'wake_requests'").get().n,
      0,
    )
  } finally {
    raw.close()
  }
})

test('A4 concurrent openers migrate a healthy v2 store exactly once', async () => {
  const dir = tempDir()
  const databasePath = join(dir, 'life.sqlite')
  createV2Fixture(databasePath)
  const barrier = new SharedArrayBuffer(8)
  const state = new Int32Array(barrier)
  const workers = [1, 2].map(
    () =>
      new Worker(new URL('./t07-worker.js', import.meta.url), {
        workerData: { databasePath, barrier, mode: 'open' },
      }),
  )
  let ready = 0
  const versions = await Promise.all(
    workers.map(
      (worker) =>
        new Promise((resolve, reject) => {
          worker.on('message', (message) => {
            if (message.type === 'ready') {
              ready += 1
              if (ready === 2) {
                Atomics.store(state, 1, 1)
                Atomics.notify(state, 1)
              }
              return
            }
            if (message.type === 'done') resolve(message.version)
            else reject(new Error(`worker failed: ${message.type}`))
          })
          worker.on('error', reject)
        }),
    ),
  )
  await Promise.all(workers.map((worker) => worker.terminate()))
  assert.deepEqual(versions.slice().sort(), ['5', '5'])
  const raw = new DatabaseSync(databasePath)
  try {
    assert.equal(raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '5')
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM intents').get().n, 1)
    assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wake_requests'").get())
  } finally {
    raw.close()
  }
})

test('A3 unknown schema versions still fail closed', () => {
  const dir = tempDir()
  const databasePath = join(dir, 'life.sqlite')
  createV2Fixture(databasePath)
  const raw = new DatabaseSync(databasePath)
  raw.exec("UPDATE meta SET value = '99' WHERE key = 'schema_version'")
  raw.close()
  assert.throws(() => openCore(databasePath, makeClock()), (error) => error instanceof LifeStorageError)
})

// B. prepareDueWakes ---------------------------------------------------------
test('B1 prepareDueWakes is bounded, deduplicated, and produces no idle wakes', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    for (let index = 0; index < 3; index += 1) {
      createDueIntent(core, clock, DSH_SCOPE, AUTH)
    }
    const first = core.prepareDueWakes({ limit: 2 })
    assert.equal(first.created.length, 2)
    const second = core.prepareDueWakes({ limit: 10 })
    assert.equal(second.created.length, 1)
    assert.equal(core.prepareDueWakes({ limit: 10 }).created.length, 0)
    const wakes = core.listWakes()
    assert.equal(wakes.length, 3)
    assert.equal(new Set(wakes.map((wake) => wake.eventId)).size, 3)
    assert.ok(wakes.every((wake) => wake.kind === 'intent_due'))
    assert.ok(wakes.every((wake) => wake.status === 'pending'))
    assert.ok(wakes.every((wake) => wake.id === `wake:${wake.eventId}`))
    assert.equal('description' in wakes[0], false)
  } finally {
    core.close()
  }
})

test('B2 non-session scopes and mismatched authorization stay local-only', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    createDueIntent(core, clock, 'session:not-a-dsh-session', 'life-tool:session:not-a-dsh-session')
    createDueIntent(core, clock, DSH_SCOPE, 'forged:authorization')
    assert.equal(core.prepareDueWakes({ limit: 10 }).created.length, 0)
    assert.deepEqual(core.listWakes(), [])
    assert.equal(core.listOutbox({ scope: DSH_SCOPE }).length, 1)
  } finally {
    core.close()
  }
})

test('B3 cancelled and retimed intents produce no wake', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const cancelled = createDueIntent(core, clock)
    core.cancelIntent(cancelled.id, { scope: DSH_SCOPE, expectedRevision: 1 })
    assert.equal(core.prepareDueWakes({ limit: 10 }).created.length, 0)

    const retimed = createDueIntent(core, clock)
    core.updateIntent(retimed.id, { scope: DSH_SCOPE, expectedRevision: 1, reviewAt: clock.at(60_000) })
    assert.equal(core.prepareDueWakes({ limit: 10 }).created.length, 0)
    assert.deepEqual(core.listWakes(), [])
  } finally {
    core.close()
  }
})

test('B4 intent update/cancel invalidates prepared and claimed wakes', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const intent = createDueIntent(core, clock)
    core.prepareDueWakes({ limit: 10 })
    const claimed = core.claimNextWake({ ownerId: 'owner-a' })
    assert.ok(claimed)
    core.cancelIntent(intent.id, { scope: DSH_SCOPE, expectedRevision: 1 })
    assert.equal(core.getWake(claimed.id).status, 'superseded')
    assert.throws(
      () => core.markWakeAdmitted(claimed.id, { ownerId: 'owner-a', messageId: 'msg-1' }),
      (error) => typeof error?.code === 'string' && error.code.startsWith('LIFE_'),
    )

    const second = createDueIntent(core, clock)
    core.prepareDueWakes({ limit: 10 })
    core.updateIntent(second.id, { scope: DSH_SCOPE, expectedRevision: 1, description: 'retimed intent', reviewAt: clock.at(60_000) })
    assert.equal(core.listWakes({ status: 'superseded' }).length >= 1, true)
    assert.equal(core.claimNextWake({ ownerId: 'owner-b' }), null)
  } finally {
    core.close()
  }
})

// C. claim / state machine ---------------------------------------------------
test('C1 independent connections claim a wake at most once', () => {
  const clock = makeClock()
  const dir = tempDir()
  const databasePath = join(dir, 'life.sqlite')
  const first = openCore(databasePath, clock)
  const second = openCore(databasePath, clock)
  try {
    createDueIntent(first, clock)
    first.prepareDueWakes({ limit: 10 })
    const claimed = first.claimNextWake({ ownerId: 'owner-a' })
    assert.ok(claimed)
    assert.equal(claimed.status, 'claimed')
    assert.equal(claimed.attempts, 1)
    assert.equal(second.claimNextWake({ ownerId: 'owner-b' }), null)
    assert.equal(first.getWake(claimed.id).claimOwner, 'owner-a')
  } finally {
    first.close()
    second.close()
  }
})

test('C2 worker threads claim exactly once', async () => {
  const clock = makeClock()
  const dir = tempDir()
  const databasePath = join(dir, 'life.sqlite')
  const core = openCore(databasePath, clock)
  createDueIntent(core, clock)
  core.prepareDueWakes({ limit: 10 })
  core.close()

  const barrier = new SharedArrayBuffer(8)
  const state = new Int32Array(barrier)
  const workers = ['w1', 'w2'].map(
    (ownerId) =>
      new Worker(new URL('./t07-worker.js', import.meta.url), {
        workerData: { databasePath, barrier, mode: 'claim', ownerId },
      }),
  )
  let ready = 0
  const results = await Promise.all(
    workers.map(
      (worker) =>
        new Promise((resolve, reject) => {
          worker.on('message', (message) => {
            if (message.type === 'ready') {
              ready += 1
              if (ready === 2) {
                Atomics.store(state, 1, 1)
                Atomics.notify(state, 1)
              }
              return
            }
            if (message.type === 'done') resolve(message.produced)
            else reject(new Error(`worker failed: ${message.type}`))
          })
          worker.on('error', reject)
        }),
    ),
  )
  await Promise.all(workers.map((worker) => worker.terminate()))
  assert.equal(results.reduce((sum, value) => sum + value, 0), 1)

  const check = openCore(databasePath, clock)
  try {
    const [wake] = check.listWakes()
    assert.equal(wake.status, 'claimed')
    assert.equal(wake.attempts, 1)
  } finally {
    check.close()
  }
})

test('C3 owner mismatch, admission, execution evidence, and uncertainty', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const intent = createDueIntent(core, clock)
    core.prepareDueWakes({ limit: 10 })
    const claimed = core.claimNextWake({ ownerId: 'owner-a' })
    assert.ok(claimed)

    assert.throws(
      () => core.markWakeAdmitted(claimed.id, { ownerId: 'owner-b', messageId: 'msg-1' }),
      (error) => error instanceof LifeUnauthorizedError,
    )
    assert.throws(
      () => core.markWakeExecuted(claimed.id, { messageId: 'msg-1', turnSeq: 1 }),
      (error) => typeof error?.code === 'string' && error.code.startsWith('LIFE_'),
    )
    const admitted = core.markWakeAdmitted(claimed.id, { ownerId: 'owner-a', messageId: 'msg-1' })
    assert.equal(admitted.status, 'admitted')
    assert.equal(admitted.executedAt, null)
    assert.equal(core.claimNextWake({ ownerId: 'owner-a' }), null)

    assert.throws(
      () => core.markWakeExecuted(claimed.id, { messageId: 'different-message', turnSeq: 1 }),
      (error) => typeof error?.code === 'string' && error.code.startsWith('LIFE_'),
    )
    assert.equal(core.getWake(claimed.id).status, 'admitted')

    core.cancelIntent(intent.id, { scope: DSH_SCOPE, expectedRevision: 1 })
    assert.throws(
      () => core.markWakeExecuted(claimed.id, { messageId: 'msg-1', turnSeq: 1 }),
      (error) => typeof error?.code === 'string' && error.code.startsWith('LIFE_'),
    )
    assert.notEqual(core.getWake(claimed.id).status, 'executed')

    const second = createDueIntent(core, clock)
    core.prepareDueWakes({ limit: 10 })
    const claimedSecond = core.claimNextWake({ ownerId: 'owner-x' })
    assert.ok(claimedSecond)
    const uncertain = core.markWakeUncertain(claimedSecond.id, { ownerId: 'owner-x', reason: 'flush unknown' })
    assert.equal(uncertain.status, 'uncertain')
    assert.equal(uncertain.lastError, 'flush unknown')
    assert.equal(core.claimNextWake({ ownerId: 'owner-y' }), null)
    assert.equal(core.getIntent(second.id, { scope: DSH_SCOPE }).status, 'active')
  } finally {
    core.close()
  }
})

test('C4 adapter restart turns claimed wakes uncertain without redelivery', () => {
  const clock = makeClock()
  const dir = tempDir()
  const databasePath = join(dir, 'life.sqlite')
  const first = fakeContext()
  apply(first.ctx, { databasePath, clock: clock.now, tickIntervalMs: 0 })
  const life = first.provided.get('life')
  life.createIntent({ description: 'restart wake', reviewAt: clock.at(0), contextScope: DSH_SCOPE, authorizationRef: AUTH })
  life.tickNow()
  assert.equal(life.prepareDueWakes({ limit: 10 }).created.length, 1)
  const claimed = life.claimNextWake({ ownerId: 'adapter-first' })
  assert.equal(claimed.status, 'claimed')
  first.disposers[0]()

  const second = fakeContext()
  apply(second.ctx, { databasePath, clock: clock.now, tickIntervalMs: 0 })
  const life2 = second.provided.get('life')
  assert.equal(life2.getWake(claimed.id).status, 'uncertain')
  assert.equal(life2.claimNextWake({ ownerId: 'adapter-second' }), null)
  assert.equal(life2.getWake(claimed.id).attempts, 1)
  assert.equal(second.tools.size, 9)
  assert.equal([...second.tools.keys()].some((name) => name.startsWith('life_wake')), false)
  second.disposers[0]()
})

test('C5 health counts wakes globally and by scope without leaking', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    createDueIntent(core, clock)
    core.prepareDueWakes({ limit: 10 })
    const health = core.getHealth()
    assert.equal(health.schemaVersion, '5')
    assert.equal(health.counts.wakes.pending, 1)
    assert.equal(core.getScopedHealth({ scope: DSH_SCOPE }).counts.wakes.pending, 1)
    assert.equal(core.getScopedHealth({ scope: 'session:other' }).counts.wakes.pending, 0)
  } finally {
    core.close()
  }
})

test('C7 execution requires admitted state and matching evidence', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    createDueIntent(core, clock)
    core.prepareDueWakes({ limit: 10 })
    const claimed = core.claimNextWake({ ownerId: 'owner-exec' })
    assert.ok(claimed)
    const admitted = core.markWakeAdmitted(claimed.id, { ownerId: 'owner-exec', messageId: 'msg-exec' })
    assert.equal(admitted.status, 'admitted')
    const executed = core.markWakeExecuted(claimed.id, { messageId: 'msg-exec', turnSeq: 7 })
    assert.equal(executed.status, 'executed')
    assert.equal(executed.executedTurnSeq, 7)
    assert.ok(executed.executedAt)
    assert.equal(core.claimNextWake({ ownerId: 'owner-exec' }), null)
  } finally {
    core.close()
  }
})

test('C10 local acknowledgement before admission supersedes a claimed wake', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    createDueIntent(core, clock)
    const [event] = core.listOutbox({ scope: DSH_SCOPE })
    core.prepareDueWakes()
    const claimed = core.claimNextWake({ ownerId: 'owner-race' })
    assert.ok(claimed)
    core.acknowledgeEvent(event.eventId, { scope: DSH_SCOPE })
    assert.throws(
      () => core.markWakeAdmitted(claimed.id, { ownerId: 'owner-race', messageId: 'msg-race' }),
      (error) => error.code === 'LIFE_STALE_RESULT',
    )
    assert.equal(core.getWake(claimed.id).status, 'superseded')
    assert.equal(core.getWake(claimed.id).executedAt, null)
  } finally {
    core.close()
  }
})

test('C6 prepareDueWakes validates its bound', () => {
  const core = openCore(join(tempDir(), 'life.sqlite'), makeClock())
  try {
    assert.throws(() => core.prepareDueWakes({ limit: 0 }), (error) => error instanceof LifeValidationError)
    assert.throws(() => core.prepareDueWakes({ limit: 10_000 }), (error) => error instanceof LifeValidationError)
  } finally {
    core.close()
  }
})

test('C8 stale admitted wake stays superseded after execution evidence is rejected', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const intent = createDueIntent(core, clock)
    core.prepareDueWakes()
    const claimed = core.claimNextWake({ ownerId: 'owner-stale' })
    core.markWakeAdmitted(claimed.id, { ownerId: 'owner-stale', messageId: 'msg-stale' })
    core.updateIntent(intent.id, { scope: DSH_SCOPE, expectedRevision: 1, reviewAt: clock.at(60_000) })
    assert.throws(() => core.markWakeExecuted(claimed.id, { messageId: 'msg-stale', turnSeq: 1 }),
      (error) => error.code === 'LIFE_STALE_RESULT')
    assert.equal(core.getWake(claimed.id).status, 'superseded')
    assert.equal(core.getWake(claimed.id).executedAt, null)
  } finally {
    core.close()
  }
})

test('B5 malformed session-shaped scopes cannot starve valid due events', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const malformed = 'session:session-gggggggg-gggg-gggg-gggg-gggggggggggg'
    for (let i = 0; i < 3; i += 1) {
      createDueIntent(core, clock, malformed, `life-tool:${malformed}`)
      clock.advance(1)
    }
    const valid = createDueIntent(core, clock)
    const result = core.prepareDueWakes({ limit: 2 })
    assert.equal(result.created.length, 1)
    assert.equal(result.created[0].intentId, valid.id)
    assert.equal(result.examined <= 2, true)
  } finally {
    core.close()
  }
})

test('C9 acknowledged local event cannot subsequently be claimed as a wake', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    createDueIntent(core, clock)
    const [event] = core.listOutbox({ scope: DSH_SCOPE })
    core.prepareDueWakes()
    core.acknowledgeEvent(event.eventId, { scope: DSH_SCOPE })
    assert.equal(core.claimNextWake({ ownerId: 'owner-ack' }), null)
    assert.equal(core.listWakes()[0].status, 'superseded')
  } finally {
    core.close()
  }
})
