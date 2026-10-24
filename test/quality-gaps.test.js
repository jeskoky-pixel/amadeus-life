/**
 * T-010 0.1.0 quality-gap regressions (expected to FAIL on the reviewed source).
 *
 * Four gaps:
 * A. completion trust: running->completed needs trusted provider evidence; model
 *    tools must not self-confirm or escalate trustedEvidence.
 * B. association integrity: create/update/record must verify related objects
 *    exist in the same scope and keep the two-way link consistent.
 * C. public close(): must release timer + lease + store, be idempotent, and let
 *    the same process re-apply twice more without lease_held.
 * D. timestamp strictness + ADR schema-version consistency.
 *
 * Only temp synthetic SQLite data; no profile database, no child agents.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LifeCore } from '../src/core.js'
import { apply } from '../src/index.js'
import { LifeUnauthorizedError, normalizeTimestamp } from '../src/model.js'

const SCOPE = 'session:owner'
const BASE = '2026-01-01T00:00:00.000Z'

function makeClock(start = BASE) {
  let t = Date.parse(start)
  return { now: () => t, advance: (ms) => { t += ms }, at: (ms) => new Date(t + ms).toISOString() }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'amadeus-life-gap-'))
}

function openCore(databasePath, clock) {
  return new LifeCore({ databasePath, clock: clock.now })
}

function createIntent(core, clock, scope = SCOPE, input = {}) {
  return core.createIntent({
    description: 'reconsider later',
    reviewAt: clock.at(10_000),
    contextScope: scope,
    authorizationRef: 'local:test',
    ...input,
  })
}

function runningActivity(core, scope = SCOPE, intentId) {
  const activity = core.recordActivity({ description: 'virtual work', ownerScope: scope, intentId })
  return core.transitionActivity(activity.id, { scope, expectedRevision: 1, to: 'running' })
}

function fakeContext({ emitted = [] } = {}) {
  const tools = new Map()
  const provided = new Map()
  const disposers = []
  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    provide: (serviceName, value) => provided.set(serviceName, value),
    effect: (fn) => { disposers.push(fn()) },
    emit: (eventName, payload) => emitted.push({ eventName, payload }),
    logger: { error() {}, warn() {} },
  }
  return { ctx, tools, provided, disposers }
}

function isLifeCode(code) {
  return (error) => error?.code === code
}

// A1 -------------------------------------------------------------------------
test('A1 core running->completed rejects untrusted evidence atomically', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const activity = runningActivity(core)
    assert.throws(
      () =>
        core.transitionActivity(activity.id, {
          scope: SCOPE,
          expectedRevision: activity.revision,
          to: 'completed',
          evidenceRefs: ['untrusted:reference'],
          trustedEvidence: false,
        }),
      isLifeCode('LIFE_UNAUTHORIZED'),
    )
    const unchanged = core.getActivity(activity.id, { scope: SCOPE })
    assert.equal(unchanged.status, 'running')
    assert.equal(unchanged.revision, activity.revision)
    assert.deepEqual(unchanged.evidenceRefs, [])
  } finally {
    core.close()
  }
})

test('A1 positive: trusted provider evidence completes running work', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const activity = runningActivity(core)
    const completed = core.transitionActivity(activity.id, {
      scope: SCOPE,
      expectedRevision: activity.revision,
      to: 'completed',
      evidenceRefs: ['provider:receipt:1'],
      trustedEvidence: true,
    })
    assert.equal(completed.status, 'completed')
    assert.deepEqual(completed.evidenceRefs, ['provider:receipt:1'])
  } finally {
    core.close()
  }
})

// A2 -------------------------------------------------------------------------
test('A2 model tool cannot complete running work with forged references', async () => {
  const clock = makeClock()
  const harness = fakeContext()
  apply(harness.ctx, { databasePath: join(tempDir(), 'life.sqlite'), clock: clock.now, tickIntervalMs: 0 })
  const exec = { agent: { session: { id: 'tool-session' } } }
  const life = harness.provided.get('life')
  const activity = await harness.tools.get('life_activity_record').execute({ description: 'tool work' }, exec)
  const running = await harness.tools
    .get('life_activity_transition')
    .execute({ id: activity.id, expectedRevision: 1, to: 'running' }, exec)
  await assert.rejects(
    harness.tools.get('life_activity_transition').execute(
      { id: activity.id, expectedRevision: running.revision, to: 'completed', evidenceRefs: ['forged:model'] },
      exec,
    ),
    /LIFE_UNAUTHORIZED/,
  )
  assert.equal(life.getActivity(activity.id, { scope: 'session:tool-session' }).status, 'running')
  harness.disposers[0]()
})

test('A3 model tool cannot escalate trustedEvidence through an extra argument', async () => {
  const clock = makeClock()
  const harness = fakeContext()
  apply(harness.ctx, { databasePath: join(tempDir(), 'life.sqlite'), clock: clock.now, tickIntervalMs: 0 })
  const exec = { agent: { session: { id: 'tool-session' } } }
  const activity = await harness.tools.get('life_activity_record').execute({ description: 'tool work' }, exec)
  const running = await harness.tools
    .get('life_activity_transition')
    .execute({ id: activity.id, expectedRevision: 1, to: 'running' }, exec)
  await assert.rejects(
    harness.tools.get('life_activity_transition').execute(
      {
        id: activity.id,
        expectedRevision: running.revision,
        to: 'completed',
        evidenceRefs: ['forged:model'],
        trustedEvidence: true,
      },
      exec,
    ),
    /LIFE_VALIDATION/,
  )
  assert.equal(
    harness.provided.get('life').getActivity(activity.id, { scope: 'session:tool-session' }).status,
    'running',
  )
  harness.disposers[0]()
})

// B -------------------------------------------------------------------------
test('B1 createIntent rejects a missing related activity', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    assert.throws(
      () => createIntent(core, clock, SCOPE, { relatedActivityId: 'activity_missing' }),
      isLifeCode('LIFE_NOT_FOUND'),
    )
    assert.equal(core.listIntents({ scope: SCOPE }).length, 0)
  } finally {
    core.close()
  }
})

test('B2 createIntent rejects a foreign-scope related activity', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const foreign = core.recordActivity({ description: 'foreign work', ownerScope: 'session:foreign' })
    assert.throws(
      () => createIntent(core, clock, SCOPE, { relatedActivityId: foreign.id }),
      isLifeCode('LIFE_UNAUTHORIZED'),
    )
    assert.equal(core.listIntents({ scope: SCOPE }).length, 0)
  } finally {
    core.close()
  }
})

test('B3 updateIntent rejects missing/foreign related activity without mutation', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const intent = createIntent(core, clock)
    const foreign = core.recordActivity({ description: 'foreign work', ownerScope: 'session:foreign' })
    for (const relatedActivityId of ['activity_missing', foreign.id]) {
      assert.throws(
        () => core.updateIntent(intent.id, { scope: SCOPE, expectedRevision: 1, relatedActivityId }),
        (error) => error?.code === 'LIFE_NOT_FOUND' || error?.code === 'LIFE_UNAUTHORIZED',
      )
    }
    const after = core.getIntent(intent.id, { scope: SCOPE })
    assert.equal(after.revision, 1)
    assert.equal(after.relatedActivityId, null)
  } finally {
    core.close()
  }
})

test('B4 recordActivity rejects missing/foreign intents without writing', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const foreignIntent = createIntent(core, clock, 'session:foreign')
    assert.throws(
      () => core.recordActivity({ description: 'work', ownerScope: SCOPE, intentId: 'intent_missing' }),
      isLifeCode('LIFE_NOT_FOUND'),
    )
    assert.throws(
      () => core.recordActivity({ description: 'work', ownerScope: SCOPE, intentId: foreignIntent.id }),
      isLifeCode('LIFE_UNAUTHORIZED'),
    )
    assert.equal(core.listActivities({ scope: SCOPE }).length, 0)
  } finally {
    core.close()
  }
})

test('B5 valid same-scope association can be explicitly linked in both directions', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const intent = createIntent(core, clock)
    const activity = core.recordActivity({
      description: 'linked work',
      ownerScope: SCOPE,
      intentId: intent.id,
    })
    const linked = core.updateIntent(intent.id, {
      scope: SCOPE,
      expectedRevision: intent.revision,
      relatedActivityId: activity.id,
    })
    assert.equal(activity.intentId, intent.id)
    assert.equal(linked.relatedActivityId, activity.id)
    assert.equal(core.getActivity(activity.id, { scope: SCOPE }).intentId, intent.id)
  } finally {
    core.close()
  }
})

test('B5 conflicting reverse association is rejected without mutation', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const first = createIntent(core, clock)
    const second = createIntent(core, clock)
    const activity = core.recordActivity({ description: 'first intent work', ownerScope: SCOPE, intentId: first.id })
    assert.throws(
      () => core.updateIntent(second.id, { scope: SCOPE, expectedRevision: second.revision, relatedActivityId: activity.id }),
      (error) => typeof error?.code === 'string' && error.code.startsWith('LIFE_'),
    )
    assert.equal(core.getIntent(second.id, { scope: SCOPE }).revision, second.revision)
    assert.equal(core.getIntent(second.id, { scope: SCOPE }).relatedActivityId, null)
    assert.equal(core.getActivity(activity.id, { scope: SCOPE }).intentId, first.id)
  } finally {
    core.close()
  }
})

test('B6 linking a cancelled intent fails explicitly and does not leak across scopes', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const cancelled = createIntent(core, clock)
    core.cancelIntent(cancelled.id, { scope: SCOPE, expectedRevision: 1 })
    assert.throws(
      () => core.recordActivity({ description: 'late work', ownerScope: SCOPE, intentId: cancelled.id }),
      (error) => typeof error?.code === 'string' && error.code.startsWith('LIFE_'),
    )
    // A cancelled intent in one scope must not block plain work in another.
    const other = core.recordActivity({ description: 'own work', ownerScope: 'session:other' })
    assert.equal(core.getActivity(other.id, { scope: 'session:other' }).status, 'pending')
  } finally {
    core.close()
  }
})

// C -------------------------------------------------------------------------
test('C1 public close + host disposer releases lease/store and allows re-apply twice', () => {
  const dir = tempDir()
  const clock = makeClock()
  const databasePath = join(dir, 'life.sqlite')

  const first = fakeContext()
  apply(first.ctx, { databasePath, clock: clock.now, tickIntervalMs: 10 })
  first.provided.get('life').close()
  first.provided.get('life').close()
  first.disposers[0]()
  first.provided.get('life').close()

  const second = fakeContext()
  apply(second.ctx, { databasePath, clock: clock.now, tickIntervalMs: 10 })
  assert.notEqual(second.provided.get('life').getHealth().reason, 'runtime_lease_held')
  assert.equal(second.provided.get('life').getHealth().state, 'ok')
  second.provided.get('life').close()
  second.disposers[0]()

  const third = fakeContext()
  apply(third.ctx, { databasePath, clock: clock.now, tickIntervalMs: 10 })
  assert.equal(third.provided.get('life').getHealth().state, 'ok')
  assert.notEqual(third.provided.get('life').getHealth().reason, 'runtime_lease_held')
  third.provided.get('life').close()
  third.disposers[0]()
})

// D -------------------------------------------------------------------------
test('D1 normalizeTimestamp rejects Date.parse rollovers', () => {
  for (const invalid of [
    '2026-02-30T00:00:00.000Z',
    '2026-13-01T00:00:00.000Z',
    '2027-02-29T00:00:00.000Z',
    '2026-04-31T00:00:00.000Z',
    '2026-01-01T24:00:00.000Z',
  ]) {
    assert.throws(() => normalizeTimestamp(invalid, 'reviewAt'), isLifeCode('LIFE_VALIDATION'), invalid)
  }
  assert.equal(normalizeTimestamp('2028-02-29T00:00:00.000Z', 'reviewAt'), '2028-02-29T00:00:00.000Z')
  assert.equal(normalizeTimestamp('2026-01-01T00:00:00.000Z', 'reviewAt'), '2026-01-01T00:00:00.000Z')
})

test('D2 ADR documents schema_version = 2 and no stale schema_version = 1', () => {
  const adr = readFileSync(new URL('../docs/adr/0001-life-runtime.md', import.meta.url), 'utf8')
  assert.match(adr, /schema_version = 2/)
  assert.doesNotMatch(adr, /schema_version = 1/)
})
