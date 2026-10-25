/**
 * Deterministic tests for the Amadeus Life core.
 *
 * Requirements coverage: T01-T14 from docs/tasks/LIFE_CORE_REQUIREMENTS.md,
 * plus transition-table, scope-isolation, and storage-failure coverage.
 * All time is a fake clock; no real sleeps, no DSH, no external modules.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LifeCore } from '../src/core.js'
import { apply } from '../src/index.js'
import {
  ACTIVITY_TRANSITIONS,
  LifeClosedError,
  LifeInvalidTransitionError,
  LifeNotFoundError,
  LifeRevisionConflictError,
  LifeStaleResultError,
  LifeStorageError,
  LifeUnauthorizedError,
  LifeValidationError,
} from '../src/model.js'

const BASE = '2026-01-01T00:00:00.000Z'

/** A deterministic manual clock. */
function makeClock(start = BASE) {
  let t = Date.parse(start)
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
    },
    at: (ms) => new Date(t + ms).toISOString(),
  }
}

/** Fresh directory per test. */
function tempDir() {
  return mkdtempSync(join(tmpdir(), 'amadeus-life-'))
}

/**
 * Open a core in a temp directory.
 * @param {string} dir - test directory.
 * @param {ReturnType<typeof makeClock>} clock - fake clock.
 * @param {{fileName?: string, maxReviewBatch?: number, externalAuthorizer?: unknown}} [extra] - overrides.
 * @returns {LifeCore} core.
 */
function openCore(dir, clock, { fileName = 'life.sqlite', maxReviewBatch, externalAuthorizer } = {}) {
  return new LifeCore({
    databasePath: join(dir, fileName),
    clock: clock.now,
    maxReviewBatch,
    externalAuthorizer,
  })
}

/**
 * Create an active intent owned by the test scope.
 * @param {LifeCore} core - core.
 * @param {ReturnType<typeof makeClock>} clock - fake clock.
 * @param {Record<string, unknown>} [input] - overrides.
 * @returns {Record<string, unknown>} intent.
 */
function createIntent(core, clock, input = {}) {
  return core.createIntent({
    description: 'reconsider the article later',
    reviewAt: clock.at(1000),
    contextScope: 'session:test',
    authorizationRef: 'local:test',
    ...input,
  })
}

const SCOPE = 'session:test'

test('T01 create intent persists and returns an id', () => {
  const dir = tempDir()
  const clock = makeClock()
  const core = openCore(dir, clock)
  try {
    const intent = createIntent(core, clock)
    assert.match(String(intent.id), /^intent_/)
    assert.equal(intent.revision, 1)
    assert.equal(intent.status, 'active')
    assert.equal(intent.reviewAt, clock.at(1000))
    assert.equal(intent.createdAt, BASE)
    assert.ok(existsSync(join(dir, 'life.sqlite')))

    core.close()
    const reopened = openCore(dir, clock)
    try {
      assert.deepEqual(reopened.getIntent(intent.id, { scope: SCOPE }), intent)
      assert.equal(reopened.getHealth().counts.intents.active, 1)
    } finally {
      reopened.close()
    }
  } finally {
    core.close()
  }
})

test('T02 update intent increments revision and rejects stale revisions', () => {
  const dir = tempDir()
  const clock = makeClock()
  const core = openCore(dir, clock)
  try {
    const intent = createIntent(core, clock)
    const updated = core.updateIntent(intent.id, {
      scope: SCOPE,
      expectedRevision: 1,
      description: 'reconsider with new evidence',
    })
    assert.equal(updated.revision, 2)
    assert.equal(updated.description, 'reconsider with new evidence')
    assert.throws(
      () => core.updateIntent(intent.id, { scope: SCOPE, expectedRevision: 1, description: 'stale write' }),
      LifeRevisionConflictError,
    )
    assert.equal(core.getIntent(intent.id, { scope: SCOPE }).revision, 2)
  } finally {
    core.close()
  }
})

test('T03 cancelled intent produces no later activity', () => {
  const dir = tempDir()
  const clock = makeClock()
  const core = openCore(dir, clock)
  try {
    const intent = createIntent(core, clock)
    const cancelled = core.cancelIntent(intent.id, { scope: SCOPE, expectedRevision: 1 })
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.revision, 2)

    clock.advance(5000)
    const tick = core.tick()
    assert.equal(tick.produced.length, 0)
    assert.deepEqual(core.listOutbox({ scope: SCOPE }), [])
    assert.equal(core.getHealth().counts.intents.cancelled, 1)
  } finally {
    core.close()
  }
})

test('T04 retiming supersedes the old schedule', () => {
  const dir = tempDir()
  const clock = makeClock()
  const core = openCore(dir, clock)
  try {
    const intent = createIntent(core, clock)
    core.updateIntent(intent.id, { scope: SCOPE, expectedRevision: 1, reviewAt: clock.at(10_000) })

    clock.advance(5000)
    assert.equal(core.tick().produced.length, 0)

    clock.advance(6000)
    const tick = core.tick()
    assert.equal(tick.produced.length, 1)
    assert.equal(tick.produced[0].intentRevision, 2)
    assert.equal(tick.produced[0].payload.intentRevision, 2)
    assert.equal(core.listOutbox({ scope: SCOPE }).length, 1)
    assert.equal(core.listOutbox({ scope: SCOPE, status: 'superseded' }).length, 0)
  } finally {
    core.close()
  }
})

test('T05 due intent emits a reconsideration event instead of a message', () => {
  const dir = tempDir()
  const clock = makeClock()
  const core = openCore(dir, clock)
  try {
    const intent = createIntent(core, clock)
    clock.advance(1000)
    const tick = core.tick()
    assert.equal(tick.produced.length, 1)
    const event = tick.produced[0]
    assert.equal(event.type, 'reconsideration')
    assert.equal(event.status, 'pending')
    assert.equal(event.intentId, intent.id)
    assert.equal(event.intentRevision, 1)
    assert.equal(event.payload.delivery, 'local-only')
    assert.equal(event.payload.contextScope, SCOPE)
    assert.equal('description' in event.payload, false)
    assert.equal('authorizationRef' in event.payload, false)
    const payloadKeys = Object.keys(event.payload)
    for (const forbidden of ['text', 'message', 'content', 'body', 'sendTo', 'description']) {
      assert.equal(payloadKeys.includes(forbidden), false)
    }
    // The authorized read path still returns the durable description.
    assert.equal(core.getIntent(intent.id, { scope: SCOPE }).description, intent.description)
  } finally {
    core.close()
  }
})

test('T06 duplicate ticks and acknowledgements do not duplicate work', () => {
  const dir = tempDir()
  const clock = makeClock()
  const core = openCore(dir, clock)
  try {
    createIntent(core, clock)
    clock.advance(1000)
    assert.equal(core.tick().produced.length, 1)
    assert.equal(core.tick().produced.length, 0)

    const [event] = core.listOutbox({ scope: SCOPE })
    const acknowledged = core.acknowledgeEvent(event.eventId, { scope: SCOPE })
    assert.equal(acknowledged.status, 'acknowledged')
    assert.ok(acknowledged.acknowledgedAt)

    assert.equal(core.tick().produced.length, 0)
    assert.equal(core.listOutbox({ scope: SCOPE, status: 'pending' }).length, 0)
    assert.equal(core.listOutbox({ scope: SCOPE, status: 'acknowledged' }).length, 1)
  } finally {
    core.close()
  }
})

test('T07 independent stores never claim the same due intent twice', () => {
  const dir = tempDir()
  const clock = makeClock()
  const first = openCore(dir, clock)
  const second = openCore(dir, clock)
  try {
    createIntent(first, clock)
    clock.advance(1000)
    assert.equal(first.tick().produced.length, 1)
    assert.equal(second.tick().produced.length, 0)

    createIntent(first, clock, { description: 'a second, still due intent', reviewAt: clock.at(0) })
    const a = first.tick()
    const b = second.tick()
    assert.equal(a.produced.length + b.produced.length, 1)
    assert.equal(second.listOutbox({ scope: SCOPE }).length, 2)
  } finally {
    first.close()
    second.close()
  }
})

test('T08 restart recovers unfinished intents without marking them done', () => {
  const dir = tempDir()
  const clock = makeClock()
  const first = openCore(dir, clock)
  const intent = createIntent(first, clock)
  first.close()

  const second = openCore(dir, clock)
  try {
    assert.equal(second.getIntent(intent.id, { scope: SCOPE }).status, 'active')
    clock.advance(1000)
    const tick = second.tick()
    assert.equal(tick.produced.length, 1)
    assert.equal(second.getIntent(intent.id, { scope: SCOPE }).status, 'active')
  } finally {
    second.close()
  }
})

test('T09 activity failure is recorded as failed, never completed', () => {
  const dir = tempDir()
  const clock = makeClock()
  const core = openCore(dir, clock)
  try {
    const intent = createIntent(core, clock)
    const activity = core.recordActivity({
      description: 'virtual article read',
      ownerScope: SCOPE,
      intentId: intent.id,
      providerId: 'virtual-reader',
    })
    const running = core.transitionActivity(activity.id, {
      scope: SCOPE,
      expectedRevision: 1,
      to: 'running',
    })
    assert.equal(running.status, 'running')
    const failed = core.transitionActivity(activity.id, {
      scope: SCOPE,
      expectedRevision: 2,
      to: 'failed',
      note: 'virtual provider reported an error',
    })
    assert.equal(failed.status, 'failed')
    assert.equal(failed.evidenceRefs.length, 0)
    assert.equal(core.getIntent(intent.id, { scope: SCOPE }).status, 'active')
    assert.equal(core.getHealth().counts.activities.failed, 1)
    assert.equal(core.getHealth().counts.activities.completed, 0)
  } finally {
    core.close()
  }
})

test('T10 core runs with no QQ module present', () => {
  const dir = tempDir()
  const clock = makeClock()
  const core = openCore(dir, clock)
  try {
    const intent = createIntent(core, clock)
    assert.equal(core.listIntents({ scope: SCOPE }).length, 1)
    assert.equal(core.getHealth().state, 'ok')
    assert.equal(intent.id.length > 0, true)
  } finally {
    core.close()
  }
  assertNoForeignImports()
})

test('T11 core runs with no Memory or State module present', () => {
  const dir = tempDir()
  const clock = makeClock()
  const core = openCore(dir, clock)
  try {
    clock.advance(1000)
    createIntent(core, clock, { reviewAt: clock.at(0) })
    assert.equal(core.tick().produced.length, 1)
    assert.equal(core.listOutbox({ scope: SCOPE }).length, 1)
  } finally {
    core.close()
  }
  assertNoForeignImports()
})

test('T12 protected external actions are refused without trusted authorization', async () => {
  const dir = tempDir()
  const clock = makeClock()
  const core = openCore(dir, clock)
  try {
    const intent = createIntent(core, clock)
    await assert.rejects(
      core.requestExternalAction({ intentId: intent.id, scope: SCOPE, actionRef: 'qq.send:scene-1' }),
      LifeUnauthorizedError,
    )
    assert.deepEqual(core.listOutbox({ scope: SCOPE }), [])
    assert.equal(core.getHealth().counts.intents.active, 1)
  } finally {
    core.close()
  }
})

test('T13 a late result after cancellation cannot revive the intent', () => {
  const dir = tempDir()
  const clock = makeClock()
  const core = openCore(dir, clock)
  try {
    const intent = createIntent(core, clock)
    const activity = core.recordActivity({
      description: 'virtual article read',
      ownerScope: SCOPE,
      intentId: intent.id,
      providerId: 'virtual-reader',
    })
    core.transitionActivity(activity.id, { scope: SCOPE, expectedRevision: 1, to: 'running' })
    core.cancelIntent(intent.id, { scope: SCOPE, expectedRevision: 1 })

    assert.throws(
      () =>
        core.transitionActivity(activity.id, {
          scope: SCOPE,
          expectedRevision: 2,
          to: 'completed',
          evidenceRefs: ['late-result:1'],
        }),
      LifeStaleResultError,
    )
    assert.equal(core.getActivity(activity.id, { scope: SCOPE }).status, 'running')
    assert.equal(core.getIntent(intent.id, { scope: SCOPE }).status, 'cancelled')
    assert.equal(core.getIntent(intent.id, { scope: SCOPE }).revision, 2)

    clock.advance(5000)
    assert.equal(core.tick().produced.length, 0)
    assert.deepEqual(core.listOutbox({ scope: SCOPE }), [])
  } finally {
    core.close()
  }
})

test('T14 corrupt, unknown-schema, and schema-less stores fail explicitly without data loss', () => {
  const dir = tempDir()
  const clock = makeClock()

  const garbage = join(dir, 'garbage.sqlite')
  writeFileSync(garbage, 'this is not a sqlite database at all')
  const before = readFileSync(garbage)
  assert.throws(() => openCore(dir, clock, { fileName: 'garbage.sqlite' }), LifeStorageError)
  assert.deepEqual(readFileSync(garbage), before)

  const valid = join(dir, 'valid.sqlite')
  const core = openCore(dir, clock, { fileName: 'valid.sqlite' })
  const intent = createIntent(core, clock)
  core.close()
  const raw = new DatabaseSync(valid)
  raw.exec("UPDATE meta SET value = '999' WHERE key = 'schema_version'")
  raw.close()
  assert.throws(() => openCore(dir, clock, { fileName: 'valid.sqlite' }), LifeStorageError)
  const raw2 = new DatabaseSync(valid)
  try {
    const row = raw2.prepare('SELECT COUNT(*) AS n FROM intents').get()
    assert.equal(row.n, 1)
    assert.equal(raw2.prepare('SELECT id FROM intents').get().id, intent.id)
  } finally {
    raw2.close()
  }

  const empty = join(dir, 'empty.sqlite')
  new DatabaseSync(empty).close()
  assert.throws(() => openCore(dir, clock, { fileName: 'empty.sqlite' }), LifeStorageError)
})

test('transition table rejects invalid transitions and confirmation bypasses', () => {
  const dir = tempDir()
  const clock = makeClock()
  const core = openCore(dir, clock)
  try {
    const activity = core.recordActivity({ description: 'virtual work', ownerScope: SCOPE })
    assert.throws(
      () => core.transitionActivity(activity.id, { scope: SCOPE, expectedRevision: 1, to: 'completed', evidenceRefs: ['e'] }),
      LifeInvalidTransitionError,
    )

    const running = core.transitionActivity(activity.id, { scope: SCOPE, expectedRevision: 1, to: 'running' })
    assert.throws(
      () => core.transitionActivity(activity.id, { scope: SCOPE, expectedRevision: running.revision, to: 'completed' }),
      LifeUnauthorizedError,
    )

    const stopping = core.requestCancelActivity(activity.id, { scope: SCOPE, expectedRevision: running.revision })
    assert.equal(stopping.status, 'stopping')
    assert.throws(
      () => core.requestCancelActivity(activity.id, { scope: SCOPE, expectedRevision: stopping.revision }),
      LifeInvalidTransitionError,
    )
    assert.throws(
      () =>
        core.transitionActivity(activity.id, {
          scope: SCOPE,
          expectedRevision: stopping.revision,
          to: 'cancelled',
          evidenceRefs: ['model-claimed:stopped'],
        }),
      LifeUnauthorizedError,
    )
    const cancelled = core.transitionActivity(activity.id, {
      scope: SCOPE,
      expectedRevision: stopping.revision,
      to: 'cancelled',
      evidenceRefs: ['provider:stop:1'],
      trustedEvidence: true,
      note: 'provider confirmed stop',
    })
    assert.equal(cancelled.status, 'cancelled')
    assert.throws(
      () => core.transitionActivity(activity.id, { scope: SCOPE, expectedRevision: cancelled.revision, to: 'running' }),
      LifeInvalidTransitionError,
    )
    assert.deepEqual(ACTIVITY_TRANSITIONS.completed, [])
  } finally {
    core.close()
  }
})

test('scope isolation hides and refuses another scope\'s intents', () => {
  const dir = tempDir()
  const clock = makeClock()
  const core = openCore(dir, clock)
  try {
    const intent = createIntent(core, clock)
    assert.throws(() => core.getIntent(intent.id, { scope: 'session:other' }), LifeUnauthorizedError)
    assert.deepEqual(core.listIntents({ scope: 'session:other' }), [])
    assert.throws(
      () => core.cancelIntent(intent.id, { scope: 'session:other', expectedRevision: 1 }),
      LifeUnauthorizedError,
    )
    assert.throws(() => core.getIntent('intent_missing', { scope: SCOPE }), LifeNotFoundError)
  } finally {
    core.close()
  }
})

test('restart recovery turns interrupted running work into unknown, never completed', () => {
  const dir = tempDir()
  const clock = makeClock()
  const first = openCore(dir, clock)
  const activity = first.recordActivity({ description: 'interrupted virtual work', ownerScope: SCOPE })
  first.transitionActivity(activity.id, { scope: SCOPE, expectedRevision: 1, to: 'running' })
  first.close()

  const second = openCore(dir, clock)
  try {
    assert.equal(second.markInterruptedAsUnknown(), 1)
    const recovered = second.getActivity(activity.id, { scope: SCOPE })
    assert.equal(recovered.status, 'unknown')
    assert.equal(recovered.revision, 3)
    assert.throws(
      () =>
        second.transitionActivity(activity.id, {
          scope: SCOPE,
          expectedRevision: recovered.revision,
          to: 'completed',
        }),
      LifeUnauthorizedError,
    )
    assert.equal(second.getActivity(activity.id, { scope: SCOPE }).status, 'unknown')
    const reconciled = second.transitionActivity(activity.id, {
      scope: SCOPE,
      expectedRevision: recovered.revision,
      to: 'completed',
      evidenceRefs: ['reconcile:1'],
      trustedEvidence: true,
    })
    assert.equal(reconciled.status, 'completed')
    assert.deepEqual(reconciled.evidenceRefs, ['reconcile:1'])
  } finally {
    second.close()
  }
})

test('a bounded tick handles no more than maxReviewBatch intents per call', () => {
  const dir = tempDir()
  const clock = makeClock()
  const core = openCore(dir, clock, { maxReviewBatch: 2 })
  try {
    for (let index = 0; index < 3; index += 1) {
      createIntent(core, clock, { description: `intent ${index}`, reviewAt: clock.at(0) })
    }
    assert.equal(core.tick().produced.length, 2)
    assert.equal(core.tick().produced.length, 1)
    assert.equal(core.tick().produced.length, 0)
  } finally {
    core.close()
  }
})

/**
 * Build a minimal fake Cordis context for adapter tests. This is not a DSH
 * load test; it proves the adapter uses only the inspected APIs.
 * @param {{emitted?: Record<string, unknown>[]}} [options] - collectors.
 * @returns {{ctx: Record<string, unknown>, tools: Map<string, Record<string, unknown>>, provided: Map<string, unknown>, disposers: (() => void)[]}} harness.
 */
function fakeContext({ emitted = [] } = {}) {
  const tools = new Map()
  const provided = new Map()
  const disposers = []
  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    provide: (serviceName, value) => provided.set(serviceName, value),
    effect: (fn) => {
      disposers.push(fn())
    },
    emit: (eventName, payload) => emitted.push({ eventName, payload }),
    logger: { error() {}, warn() {} },
  }
  return { ctx, tools, provided, disposers }
}

test('adapter exposes the life service and tools with session-derived scope', async () => {
  const dir = tempDir()
  const clock = makeClock()
  const emitted = []
  const { ctx, tools, provided, disposers } = fakeContext({ emitted })
  apply(ctx, { databasePath: join(dir, 'adapter.sqlite'), clock: clock.now, tickIntervalMs: 0 })
  assert.equal(provided.has('life'), true)
  assert.equal(tools.size, 9)
  for (const definition of tools.values()) {
    assert.equal(typeof definition.description, 'string')
    assert.equal(definition.output.schema.type, 'object')
    assert.equal(typeof definition.output.render, 'function')
  }

  const exec = { agent: { session: { id: 'session-adapter' } } }
  const created = await tools.get('life_intent_create').execute(
    { description: 'adapter intent', reviewAt: clock.at(1000) },
    exec,
  )
  assert.equal(created.contextScope, 'session:session-adapter')
  assert.equal(created.authorizationRef, 'life-tool:session:session-adapter')

  const health = await tools.get('life_health').execute({}, exec)
  assert.equal(health.state, 'ok')
  assert.equal(health.counts.intents.active, 1)

  clock.advance(2000)
  const tick = provided.get('life').tickNow()
  assert.equal(tick.produced.length, 1)
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].eventName, 'life/reconsideration')
  assert.equal(emitted[0].payload.intentId, created.id)

  for (const dispose of disposers) dispose()
  assert.throws(() => provided.get('life').getHealth(), LifeClosedError)
})

test('adapter degrades explicitly when storage cannot be opened', () => {
  const dir = tempDir()
  const file = join(dir, 'broken.sqlite')
  writeFileSync(file, 'corrupt')
  const { ctx, tools, provided } = fakeContext()
  apply(ctx, { databasePath: file, tickIntervalMs: 0 })
  assert.equal(tools.size, 0)
  const health = provided.get('life').getHealth()
  assert.equal(health.state, 'unavailable')
  assert.match(health.error, /Life store/)
  assert.throws(() => provided.get('life').createIntent({}), LifeStorageError)
})

/** Assert every source import is a Node builtin or a relative module. */
function assertNoForeignImports() {
  const files = ['../src/model.js', '../src/store.js', '../src/core.js', '../src/index.js']
  for (const file of files) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8')
    const specifiers = [...text.matchAll(/import\s+(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/g)].map((match) => match[1])
    for (const specifier of specifiers) {
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('.'),
        `${file} imports non-local module "${specifier}"`,
      )
    }
  }
}
