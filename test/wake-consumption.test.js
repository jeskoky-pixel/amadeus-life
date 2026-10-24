/**
 * 0.2.0 v4 wake-consumption evidence: SQLite v3 -> v4 migration and trusted
 * consumption/turn-end recording. Synthetic temp SQLite only; no real DSH.
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
  LifeRevisionConflictError,
  LifeStaleResultError,
  LifeStorageError,
  LifeUnauthorizedError,
  LifeValidationError,
} from '../src/model.js'

const BASE = '2026-01-01T00:00:00.000Z'
const SESSION_A = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_B = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SCOPE = `session:${SESSION_A}`
const AUTH = `life-tool:${SCOPE}`
const SECRET = 'SECRET_INTENT_DESCRIPTION'

function makeClock(start = BASE) {
  let t = Date.parse(start)
  return { now: () => t, advance: (ms) => { t += ms }, at: (ms) => new Date(t + ms).toISOString() }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'amadeus-life-consumption-'))
}

function openCore(databasePath, clock) {
  return new LifeCore({ databasePath, clock: clock.now })
}

function seedIntent(core, clock, scope = SCOPE, auth = AUTH) {
  return core.createIntent({
    description: SECRET,
    reviewAt: clock.at(0),
    contextScope: scope,
    authorizationRef: auth,
  })
}

function admittedWake(core, clock, { sessionId = SESSION_A, messageId = 'msg-wake-1' } = {}) {
  const scope = `session:${sessionId}`
  const intent = seedIntent(core, clock, scope, `life-tool:${scope}`)
  core.tick()
  core.prepareDueWakes()
  const claimed = core.claimNextWake({ ownerId: 'owner-1', targetSessionId: sessionId })
  assert.ok(claimed)
  core.markWakeAdmitted(claimed.id, { ownerId: 'owner-1', messageId })
  return { intent, wake: claimed, messageId }
}

function v3Schema(db, { conflictIndex = false } = {}) {
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
    CREATE TABLE wake_requests (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('intent_due')), event_id TEXT NOT NULL UNIQUE,
      intent_id TEXT NOT NULL, intent_revision INTEGER NOT NULL CHECK (intent_revision >= 1),
      context_scope TEXT NOT NULL, target_session_id TEXT NOT NULL, authorization_ref TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'admitted', 'executed', 'uncertain', 'superseded', 'failed')),
      claim_owner TEXT, attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0), next_attempt_at TEXT NOT NULL,
      expires_at TEXT, message_id TEXT, admitted_at TEXT, executed_at TEXT, executed_turn_seq INTEGER,
      last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_wake_status ON wake_requests (status, next_attempt_at);
    CREATE INDEX idx_wake_scope ON wake_requests (context_scope, status);
    CREATE INDEX idx_wake_intent ON wake_requests (intent_id, intent_revision);
  `)
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '3')
  db.prepare(
    `INSERT INTO intents (id, revision, status, description, context_scope, authorization_ref,
      related_activity_id, created_at, updated_at, review_at)
     VALUES ('intent_v3_keep', 2, 'active', 'v3 survivor', ?, ?, NULL, ?, ?, ?)`,
  ).run(SCOPE, AUTH, BASE, BASE, BASE)
  db.prepare(
    `INSERT INTO intent_events (id, intent_id, intent_revision, type, status, created_at, acknowledged_at, payload_json)
     VALUES ('reconsider:intent_v3_keep:2', 'intent_v3_keep', 2, 'reconsideration', 'pending', ?, NULL, '{}')`,
  ).run(BASE)
  db.prepare(
    `INSERT INTO activities (id, revision, status, description, provider_id, intent_id, owner_scope,
      evidence_json, created_at, updated_at)
     VALUES ('activity_v3_keep', 3, 'running', 'v3 work', NULL, NULL, ?, '["v3:evidence"]', ?, ?)`,
  ).run(SCOPE, BASE, BASE)
  db.prepare("INSERT INTO runtime_leases (key, owner_id, pid, acquired_at) VALUES ('adapter', 'v3-owner', 1, ?)").run(BASE)
  const insertWake = db.prepare(
    `INSERT INTO wake_requests (id, kind, event_id, intent_id, intent_revision, context_scope, target_session_id,
      authorization_ref, status, claim_owner, attempts, next_attempt_at, expires_at, message_id, admitted_at,
      executed_at, executed_turn_seq, last_error, created_at, updated_at)
     VALUES (?, 'intent_due', ?, 'intent_v3_keep', 2, ?, ?, ?, ?, 'v3-owner', 1, ?, NULL, ?, ?, NULL, NULL, ?, ?, ?)`,
  )
  insertWake.run('wake-medium-admitted', 'event-admitted', SCOPE, SESSION_A, AUTH, 'admitted',
    BASE, 'msg-v3-admitted', BASE, null, BASE, BASE)
  insertWake.run('wake-medium-superseded', 'event-superseded', SCOPE, SESSION_A, AUTH, 'superseded',
    BASE, 'msg-v3-superseded', BASE, 'intent changed', BASE, BASE)
  if (conflictIndex) db.exec('CREATE TABLE idx_wake_consumption_turn (x TEXT)')
}

function v4Fixture(db, { partialPrepared = false } = {}) {
  v3Schema(db)
  db.exec(`
    CREATE TABLE wake_consumption (
      wake_id TEXT NOT NULL, target_session_id TEXT NOT NULL, message_id TEXT NOT NULL,
      turn_seq INTEGER NOT NULL CHECK (turn_seq >= 1), user_message_seq INTEGER NOT NULL CHECK (user_message_seq >= 1),
      valid_at_consumption INTEGER NOT NULL CHECK (valid_at_consumption IN (0, 1)),
      consumed_at TEXT NOT NULL, turn_end_seq INTEGER, turn_reason TEXT, completed_at TEXT,
      updated_at TEXT NOT NULL, PRIMARY KEY (wake_id, message_id)
    );
    CREATE INDEX idx_wake_consumption_turn ON wake_consumption (target_session_id, turn_seq);
  `)
  db.prepare("UPDATE meta SET value = '4' WHERE key = 'schema_version'").run()
  db.prepare(
    `INSERT INTO wake_consumption
      (wake_id, target_session_id, message_id, turn_seq, user_message_seq,
       valid_at_consumption, consumed_at, turn_end_seq, turn_reason, completed_at, updated_at)
     VALUES ('wake-medium-admitted', ?, 'msg-v3-admitted', 2, 11, 1, ?, 20, 'completed', ?, ?)`,
  ).run(SESSION_A, BASE, BASE, BASE)
  if (partialPrepared) db.exec('ALTER TABLE wake_requests ADD COLUMN prepared_message_id TEXT')
}

function v2Fixture(db) {
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE intents (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, status TEXT NOT NULL, description TEXT NOT NULL,
      context_scope TEXT NOT NULL, authorization_ref TEXT NOT NULL, related_activity_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, review_at TEXT NOT NULL
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
      provider_id TEXT, intent_id TEXT, owner_scope TEXT NOT NULL, evidence_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_activities_owner ON activities (owner_scope, status);
    CREATE TABLE runtime_leases (key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, pid INTEGER NOT NULL, acquired_at TEXT NOT NULL);
  `)
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '2')
  db.prepare(
    `INSERT INTO intents (id, revision, status, description, context_scope, authorization_ref,
      related_activity_id, created_at, updated_at, review_at)
     VALUES ('intent_v2_keep', 2, 'active', 'v2 survivor', ?, ?, NULL, ?, ?, ?)`,
  ).run(SCOPE, AUTH, BASE, BASE, BASE)
  db.prepare(
    `INSERT INTO intent_events (id, intent_id, intent_revision, type, status, created_at, acknowledged_at, payload_json)
     VALUES ('reconsider:intent_v2_keep:2', 'intent_v2_keep', 2, 'reconsideration', 'pending', ?, NULL, '{}')`,
  ).run(BASE)
  db.prepare("INSERT INTO activities (id, revision, status, description, owner_scope, evidence_json, created_at, updated_at) VALUES ('activity_v2_keep', 1, 'pending', 'v2 work', ?, '[]', ?, ?)").run(SCOPE, BASE, BASE)
  db.prepare("INSERT INTO runtime_leases (key, owner_id, pid, acquired_at) VALUES ('adapter', 'v2-owner', 1, ?)").run(BASE)
}

function rawRow(databasePath, sql, ...params) {
  const db = new DatabaseSync(databasePath)
  try {
    return db.prepare(sql).get(...params)
  } finally {
    db.close()
  }
}

// A. Migration ---------------------------------------------------------------
test('A1 v3 store migrates to v4 preserving wakes, rows, revision and lease', () => {
  const dir = tempDir()
  const databasePath = join(dir, 'life.sqlite')
  const fixture = new DatabaseSync(databasePath)
  try {
    v3Schema(fixture)
    fixture.close()
  } catch (error) {
    fixture.close()
    throw error
  }
  const clock = makeClock()
  const core = openCore(databasePath, clock)
  try {
    assert.equal(core.getHealth().schemaVersion, '5')
    assert.equal(core.getIntent('intent_v3_keep', { scope: SCOPE }).revision, 2)
    assert.equal(core.getActivity('activity_v3_keep', { scope: SCOPE }).status, 'running')
    const wakes = core.listWakes()
    assert.equal(wakes.length, 2)
    assert.equal(wakes.find((wake) => wake.id === 'wake-medium-admitted').status, 'admitted')
    assert.equal(wakes.find((wake) => wake.id === 'wake-medium-admitted').messageId, 'msg-v3-admitted')
    assert.equal(wakes.find((wake) => wake.id === 'wake-medium-superseded').status, 'superseded')
    assert.equal(core.getWakeConsumption('wake-medium-admitted'), null)
  } finally {
    core.close()
  }
  const raw = new DatabaseSync(databasePath)
  try {
    assert.equal(raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '5')
    assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wake_consumption'").get())
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM intents').get().n, 1)
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM wake_requests').get().n, 2)
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM runtime_leases').get().n, 1)
  } finally {
    raw.close()
  }
  const reopened = openCore(databasePath, clock)
  try {
    assert.equal(reopened.getHealth().schemaVersion, '5')
    assert.equal(reopened.listWakes().length, 2)
  } finally {
    reopened.close()
  }
})

test('A2 v2 store migrates atomically to v4 with all tables and rows', () => {
  const dir = tempDir()
  const databasePath = join(dir, 'life.sqlite')
  const fixture = new DatabaseSync(databasePath)
  try {
    v2Fixture(fixture)
  } finally {
    fixture.close()
  }
  const core = openCore(databasePath, makeClock())
  try {
    assert.equal(core.getHealth().schemaVersion, '5')
    assert.equal(core.getIntent('intent_v2_keep', { scope: SCOPE }).revision, 2)
    assert.deepEqual(core.listWakes(), [])
  } finally {
    core.close()
  }
  const raw = new DatabaseSync(databasePath)
  try {
    assert.equal(raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '5')
    assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE name='wake_requests'").get())
    assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE name='wake_consumption'").get())
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM intents').get().n, 1)
  } finally {
    raw.close()
  }
})

test('A3 failed v4 migration rolls back and leaves the v3 store intact', () => {
  const dir = tempDir()
  const databasePath = join(dir, 'life.sqlite')
  const fixture = new DatabaseSync(databasePath)
  try {
    v3Schema(fixture, { conflictIndex: true })
  } finally {
    fixture.close()
  }
  assert.throws(() => openCore(databasePath, makeClock()), (error) => error instanceof LifeStorageError)
  const raw = new DatabaseSync(databasePath)
  try {
    assert.equal(raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '3')
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM wake_requests').get().n, 2)
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='wake_consumption'").get().n, 0)
  } finally {
    raw.close()
  }
})

test('A4 concurrent openers migrate a healthy v3 store exactly once', async () => {
  const dir = tempDir()
  const databasePath = join(dir, 'life.sqlite')
  const fixture = new DatabaseSync(databasePath)
  try {
    v3Schema(fixture)
  } finally {
    fixture.close()
  }
  const barrier = new SharedArrayBuffer(8)
  const state = new Int32Array(barrier)
  const workers = [1, 2].map(
    () => new Worker(new URL('./t07-worker.js', import.meta.url), { workerData: { databasePath, barrier, mode: 'open' } }),
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
  assert.equal(rawRow(databasePath, "SELECT value FROM meta WHERE key='schema_version'").value, '5')
  assert.ok(rawRow(databasePath, "SELECT name FROM sqlite_master WHERE name='wake_consumption'"))
})

test('A5 v4 store migrates to v5 preserving wakes and existing evidence', () => {
  const dir = tempDir()
  const databasePath = join(dir, 'life.sqlite')
  const fixture = new DatabaseSync(databasePath)
  try {
    v4Fixture(fixture)
  } finally {
    fixture.close()
  }
  const clock = makeClock()
  const core = openCore(databasePath, clock)
  try {
    assert.equal(core.getHealth().schemaVersion, '5')
    assert.equal(core.listWakes().length, 2)
    assert.equal(core.getWake('wake-medium-admitted').status, 'admitted')
    assert.equal(core.getWake('wake-medium-admitted').preparedMessageId, null)
    const evidence = core.getWakeConsumption('wake-medium-admitted')
    assert.equal(evidence.validAtConsumption, 1)
    assert.equal(evidence.validityKnown, 1)
    assert.equal(evidence.turnReason, 'completed')
  } finally {
    core.close()
  }
  const raw = new DatabaseSync(databasePath)
  try {
    assert.equal(raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '5')
    const wakeColumns = raw.prepare("PRAGMA table_info('wake_requests')").all().map((column) => column.name)
    assert.ok(wakeColumns.includes('prepared_message_id'))
    assert.ok(wakeColumns.includes('prepared_at'))
    const evidenceColumns = raw.prepare("PRAGMA table_info('wake_consumption')").all().map((column) => column.name)
    assert.ok(evidenceColumns.includes('validity_known'))
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM wake_requests').get().n, 2)
  } finally {
    raw.close()
  }
})

test('A6 failed v4 migration rolls back without adding v5 columns', () => {
  const dir = tempDir()
  const databasePath = join(dir, 'life.sqlite')
  const fixture = new DatabaseSync(databasePath)
  try {
    v4Fixture(fixture, { partialPrepared: true })
  } finally {
    fixture.close()
  }
  assert.throws(() => openCore(databasePath, makeClock()), (error) => error instanceof LifeStorageError)
  const raw = new DatabaseSync(databasePath)
  try {
    assert.equal(raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '4')
    const columns = raw.prepare("PRAGMA table_info('wake_consumption')").all().map((column) => column.name)
    assert.equal(columns.includes('validity_known'), false)
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM wake_consumption').get().n, 1)
  } finally {
    raw.close()
  }
})

// B. Consumption evidence ----------------------------------------------------
test('B1 valid consumption survives same-turn cancellation and records executed turn', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const { intent, wake, messageId } = admittedWake(core, clock)
    const consumed = core.recordWakeConsumed(wake.id, {
      targetSessionId: SESSION_A,
      messageId,
      turnSeq: 2,
      userMessageSeq: 11,
    })
    assert.equal(consumed.validAtConsumption, 1)
    assert.equal(consumed.turnEndSeq, null)
    assert.equal(core.getWake(wake.id).status, 'admitted')
    core.cancelIntent(intent.id, { scope: SCOPE, expectedRevision: 1 })
    const ended = core.recordWakeTurnEnd(wake.id, {
      targetSessionId: SESSION_A,
      messageId,
      turnSeq: 2,
      turnEndSeq: 20,
      reason: 'completed',
    })
    assert.equal(ended.turnReason, 'completed')
    const executed = core.getWake(wake.id)
    assert.equal(executed.status, 'executed')
    assert.equal(executed.executedTurnSeq, 2)
    assert.ok(executed.executedAt)
    assert.equal(core.getIntent(intent.id, { scope: SCOPE }).status, 'cancelled')
    assert.equal(core.getWakeConsumption(wake.id).validAtConsumption, 1)
  } finally {
    core.close()
  }
})

test('B1b valid consumption survives same-turn retiming', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const { intent, wake, messageId } = admittedWake(core, clock)
    core.recordWakeConsumed(wake.id, {
      targetSessionId: SESSION_A,
      messageId,
      turnSeq: 2,
      userMessageSeq: 11,
    })
    core.updateIntent(intent.id, { scope: SCOPE, expectedRevision: 1, reviewAt: clock.at(60_000) })
    core.recordWakeTurnEnd(wake.id, {
      targetSessionId: SESSION_A,
      messageId,
      turnSeq: 2,
      turnEndSeq: 20,
      reason: 'completed',
    })
    assert.equal(core.getWake(wake.id).status, 'executed')
    assert.equal(core.getWake(wake.id).executedTurnSeq, 2)
    assert.equal(core.getIntent(intent.id, { scope: SCOPE }).revision, 2)
  } finally {
    core.close()
  }
})

test('B2 cancellation before consumption never executes the wake', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const { intent, wake, messageId } = admittedWake(core, clock)
    core.cancelIntent(intent.id, { scope: SCOPE, expectedRevision: 1 })
    const consumed = core.recordWakeConsumed(wake.id, {
      targetSessionId: SESSION_A,
      messageId,
      turnSeq: 2,
      userMessageSeq: 11,
    })
    assert.equal(consumed.validAtConsumption, 0)
    assert.equal(core.getWake(wake.id).status, 'superseded')
    core.recordWakeTurnEnd(wake.id, {
      targetSessionId: SESSION_A,
      messageId,
      turnSeq: 2,
      turnEndSeq: 20,
      reason: 'completed',
    })
    const wakeAfter = core.getWake(wake.id)
    assert.notEqual(wakeAfter.status, 'executed')
    assert.equal(wakeAfter.executedAt, null)
    assert.equal(core.getWakeConsumption(wake.id).turnReason, 'completed')
  } finally {
    core.close()
  }
})

test('B3 completed turn without consumption evidence is rejected', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const { wake, messageId } = admittedWake(core, clock)
    assert.throws(
      () => core.recordWakeTurnEnd(wake.id, {
        targetSessionId: SESSION_A,
        messageId,
        turnSeq: 2,
        turnEndSeq: 20,
        reason: 'completed',
      }),
      (error) => error.code === 'LIFE_VALIDATION' || error.code === 'LIFE_NOT_FOUND',
    )
    assert.equal(core.getWake(wake.id).status, 'admitted')
  } finally {
    core.close()
  }
})

test('B4 coordinate consistency, idempotency, and conflict rejection', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const { wake, messageId } = admittedWake(core, clock)
    const consumed = core.recordWakeConsumed(wake.id, {
      targetSessionId: SESSION_A,
      messageId,
      turnSeq: 2,
      userMessageSeq: 11,
    })
    assert.deepEqual(core.recordWakeConsumed(wake.id, {
      targetSessionId: SESSION_A,
      messageId,
      turnSeq: 2,
      userMessageSeq: 11,
    }), consumed)
    assert.throws(
      () => core.recordWakeConsumed(wake.id, { targetSessionId: SESSION_A, messageId, turnSeq: 3, userMessageSeq: 11 }),
      (error) => error instanceof LifeRevisionConflictError,
    )
    assert.throws(
      () => core.recordWakeConsumed(wake.id, { targetSessionId: SESSION_B, messageId, turnSeq: 2, userMessageSeq: 11 }),
      (error) => error instanceof LifeUnauthorizedError,
    )
    assert.throws(
      () => core.recordWakeConsumed(wake.id, { targetSessionId: SESSION_A, messageId: 'other', turnSeq: 2, userMessageSeq: 11 }),
      (error) => error instanceof LifeValidationError,
    )
    assert.throws(
      () => core.recordWakeConsumed(wake.id, { targetSessionId: SESSION_A, messageId, turnSeq: 0, userMessageSeq: 11 }),
      (error) => error instanceof LifeValidationError,
    )
    assert.throws(
      () => core.recordWakeTurnEnd(wake.id, { targetSessionId: SESSION_A, messageId, turnSeq: 2, turnEndSeq: 10, reason: 'completed' }),
      (error) => error instanceof LifeValidationError,
    )
    assert.throws(
      () => core.recordWakeTurnEnd(wake.id, { targetSessionId: SESSION_A, messageId, turnSeq: 3, turnEndSeq: 30, reason: 'completed' }),
      (error) => error instanceof LifeRevisionConflictError,
    )
    const ended = core.recordWakeTurnEnd(wake.id, { targetSessionId: SESSION_A, messageId, turnSeq: 2, turnEndSeq: 20, reason: 'completed' })
    assert.equal(core.recordWakeTurnEnd(wake.id, { targetSessionId: SESSION_A, messageId, turnSeq: 2, turnEndSeq: 20, reason: 'completed' }).completedAt, ended.completedAt)
    assert.throws(
      () => core.recordWakeTurnEnd(wake.id, { targetSessionId: SESSION_A, messageId, turnSeq: 2, turnEndSeq: 21, reason: 'completed' }),
      (error) => error instanceof LifeRevisionConflictError,
    )
  } finally {
    core.close()
  }
})

test('B5 consumption requires an admitted wake', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const intent = seedIntent(core, clock)
    core.tick()
    core.prepareDueWakes()
    const claimed = core.claimNextWake({ ownerId: 'owner-1', targetSessionId: SESSION_A })
    assert.ok(claimed)
    assert.throws(
      () => core.recordWakeConsumed(claimed.id, {
        targetSessionId: SESSION_A,
        messageId: 'msg-wake-1',
        turnSeq: 2,
        userMessageSeq: 11,
      }),
      (error) =>
        error instanceof LifeInvalidTransitionError || error instanceof LifeValidationError,
    )
    assert.equal(core.getIntent(intent.id, { scope: SCOPE }).status, 'active')
  } finally {
    core.close()
  }
})

test('B5b prepared claimed wake can record pre-admission consumption and completion', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const intent = seedIntent(core, clock)
    core.tick()
    core.prepareDueWakes()
    const claimed = core.claimNextWake({ ownerId: 'owner-1', targetSessionId: SESSION_A })
    const messageId = 'msg-prepared'
    core.prepareWakeDelivery(claimed.id, { ownerId: 'owner-1', messageId })
    const consumed = core.recordWakeConsumed(claimed.id, {
      targetSessionId: SESSION_A,
      messageId,
      turnSeq: 2,
      userMessageSeq: 11,
    })
    assert.equal(consumed.validAtConsumption, 1)
    assert.equal(consumed.validityKnown, 1)
    assert.equal(core.getWake(claimed.id).status, 'claimed')
    core.recordWakeTurnEnd(claimed.id, {
      targetSessionId: SESSION_A,
      messageId,
      turnSeq: 2,
      turnEndSeq: 20,
      reason: 'completed',
    })
    assert.equal(core.getWake(claimed.id).status, 'executed')
    assert.equal(core.getWake(claimed.id).executedTurnSeq, 2)
    assert.equal(core.getIntent(intent.id, { scope: SCOPE }).status, 'active')
  } finally {
    core.close()
  }
})

test('B6 error turn never executes and stays conservative', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const { wake, messageId } = admittedWake(core, clock)
    core.recordWakeConsumed(wake.id, { targetSessionId: SESSION_A, messageId, turnSeq: 2, userMessageSeq: 11 })
    core.recordWakeTurnEnd(wake.id, {
      targetSessionId: SESSION_A,
      messageId,
      turnSeq: 2,
      turnEndSeq: 20,
      reason: 'error',
    })
    const after = core.getWake(wake.id)
    assert.notEqual(after.status, 'executed')
    assert.equal(after.executedAt, null)
    assert.equal(core.getWakeConsumption(wake.id).turnReason, 'error')
  } finally {
    core.close()
  }
})

test('B7 v3 stale-execution path remains superseded without consumption evidence', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const { intent, wake, messageId } = admittedWake(core, clock)
    core.cancelIntent(intent.id, { scope: SCOPE, expectedRevision: 1 })
    assert.throws(
      () => core.markWakeExecuted(wake.id, { messageId, turnSeq: 2 }),
      (error) => error instanceof LifeStaleResultError,
    )
    assert.equal(core.getWake(wake.id).status, 'superseded')
    assert.equal(core.getWakeConsumption(wake.id), null)
  } finally {
    core.close()
  }
})

test('B8 snapshot consumption with unknown validity can complete but never claims validity', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const { wake, messageId } = admittedWake(core, clock)
    core.recordWakeConsumedFromSnapshot(wake.id, {
      targetSessionId: SESSION_A,
      messageId,
      turnSeq: 2,
      userMessageSeq: 11,
    })
    const evidence = core.getWakeConsumption(wake.id)
    assert.equal(evidence.validAtConsumption, 0)
    assert.equal(evidence.validityKnown, 0)
    core.recordWakeTurnEnd(wake.id, {
      targetSessionId: SESSION_A,
      messageId,
      turnSeq: 2,
      turnEndSeq: 20,
      reason: 'completed',
    })
    assert.equal(core.getWake(wake.id).status, 'executed')
    assert.equal(core.getWakeConsumption(wake.id).validityKnown, 0)
  } finally {
    core.close()
  }
})

// C. Trusted surface ---------------------------------------------------------
test('C1 trusted service exposes evidence methods and keeps exactly 9 model tools', () => {
  const tools = new Map()
  const provided = new Map()
  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    provide: (name, value) => provided.set(name, value),
    effect: (fn) => { fn() },
    emit() {},
    logger: { error() {}, warn() {} },
  }
  const dir = tempDir()
  apply(ctx, { databasePath: join(dir, 'life.sqlite'), clock: makeClock().now, tickIntervalMs: 0 })
  const life = provided.get('life')
  assert.equal(tools.size, 9)
  assert.equal([...tools.keys()].some((name) => name.includes('consum')), false)
  for (const method of ['recordWakeConsumed', 'recordWakeTurnEnd', 'getWakeConsumption']) {
    assert.equal(typeof life[method], 'function', method)
  }
  assert.equal(life.getHealth().schemaVersion, '5')
})

test('C2 evidence stores no prompt text, intent description, or session content', () => {
  const clock = makeClock()
  const dir = tempDir()
  const databasePath = join(dir, 'life.sqlite')
  const core = openCore(databasePath, clock)
  try {
    const { wake, messageId } = admittedWake(core, clock)
    core.recordWakeConsumed(wake.id, { targetSessionId: SESSION_A, messageId, turnSeq: 2, userMessageSeq: 11 })
    const raw = new DatabaseSync(databasePath)
    try {
      const columns = raw.prepare("PRAGMA table_info('wake_consumption')").all().map((column) => column.name)
      for (const forbidden of ['description', 'prompt', 'content', 'text', 'authorization_ref']) {
        assert.equal(columns.includes(forbidden), false, forbidden)
      }
    } finally {
      raw.close()
    }
    const serialized = JSON.stringify(core.getWakeConsumption(wake.id))
    assert.equal(serialized.includes(SECRET), false)
  } finally {
    core.close()
  }
})

test('C3 model-facing scoped health does not expose wake evidence', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const { wake, messageId } = admittedWake(core, clock)
    core.recordWakeConsumed(wake.id, { targetSessionId: SESSION_A, messageId, turnSeq: 2, userMessageSeq: 11 })
    const scoped = core.getScopedHealth({ scope: SCOPE })
    const serialized = JSON.stringify(scoped)
    assert.equal(serialized.includes(messageId), false)
    assert.equal(serialized.includes(wake.id), false)
    assert.equal('consumption' in scoped, false)
  } finally {
    core.close()
  }
})
