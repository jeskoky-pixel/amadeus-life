/**
 * T-010 revision 1 regressions:
 * - uncertain/paused cancellation stays stopping/unknown and needs trusted evidence;
 * - single-runtime adapter lease, release, and stale-owner recovery;
 * - reference-only bus payloads and scoped model health;
 * - real concurrent claiming through worker threads;
 * - setup-failure cleanup of lease/store.
 *
 * Deterministic: fake clock, synthetic data, no long sleeps.
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
  LifeClosedError,
  LifeInvalidTransitionError,
  LifeRevisionConflictError,
  LifeUnauthorizedError,
  LifeValidationError,
} from '../src/model.js'

const SCOPE = 'session:test'
const BASE = '2026-01-01T00:00:00.000Z'

function makeClock(start = BASE) {
  let t = Date.parse(start)
  return { now: () => t, advance: (ms) => { t += ms }, at: (ms) => new Date(t + ms).toISOString() }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'amadeus-life-rev1-'))
}

function openCore(databasePath, clock) {
  return new LifeCore({ databasePath, clock: clock.now })
}

function createIntent(core, clock, scope = SCOPE, description = 'reconsider the article later') {
  return core.createIntent({
    description,
    reviewAt: clock.at(1000),
    contextScope: scope,
    authorizationRef: 'local:test',
  })
}

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

function runningActivity(life, scope = SCOPE, description = 'virtual external work') {
  const activity = life.recordActivity({ description, ownerScope: scope, providerId: 'virtual' })
  return life.transitionActivity(activity.id, { scope, expectedRevision: 1, to: 'running' })
}

test('uncertain cancellation stays unknown and needs trusted provider evidence', () => {
  const dir = tempDir()
  const clock = makeClock()
  const core = openCore(join(dir, 'life.sqlite'), clock)
  try {
    const activity = runningActivity(core)
    const unknown = core.transitionActivity(activity.id, {
      scope: SCOPE,
      expectedRevision: activity.revision,
      to: 'unknown',
      note: 'provider connection lost',
    })
    const requested = core.requestCancelActivity(activity.id, { scope: SCOPE, expectedRevision: unknown.revision })
    assert.equal(requested.status, 'unknown')
    assert.equal(requested.revision, unknown.revision)
    assert.throws(
      () =>
        core.transitionActivity(activity.id, {
          scope: SCOPE,
          expectedRevision: requested.revision,
          to: 'cancelled',
          evidenceRefs: ['model-claimed:stopped'],
        }),
      LifeUnauthorizedError,
    )
    assert.equal(core.getActivity(activity.id, { scope: SCOPE }).status, 'unknown')
    const cancelled = core.transitionActivity(activity.id, {
      scope: SCOPE,
      expectedRevision: requested.revision,
      to: 'cancelled',
      evidenceRefs: ['provider:stop:42'],
      trustedEvidence: true,
    })
    assert.equal(cancelled.status, 'cancelled')
  } finally {
    core.close()
  }
})

test('paused external work enters stopping, never direct cancellation', () => {
  const dir = tempDir()
  const clock = makeClock()
  const core = openCore(join(dir, 'life.sqlite'), clock)
  try {
    const activity = runningActivity(core)
    const paused = core.transitionActivity(activity.id, {
      scope: SCOPE,
      expectedRevision: activity.revision,
      to: 'paused',
    })
    assert.throws(
      () =>
        core.transitionActivity(activity.id, {
          scope: SCOPE,
          expectedRevision: paused.revision,
          to: 'cancelled',
          evidenceRefs: ['model:stop'],
        }),
      LifeInvalidTransitionError,
    )
    const stopping = core.requestCancelActivity(activity.id, { scope: SCOPE, expectedRevision: paused.revision })
    assert.equal(stopping.status, 'stopping')
    assert.throws(
      () =>
        core.transitionActivity(activity.id, {
          scope: SCOPE,
          expectedRevision: stopping.revision,
          to: 'cancelled',
          evidenceRefs: ['model:stop'],
          note: 'model says it stopped',
        }),
      LifeUnauthorizedError,
    )
  } finally {
    core.close()
  }
})

test('model tool transition cannot self-confirm cancellation or completion', async () => {
  const dir = tempDir()
  const clock = makeClock()
  const harness = fakeContext()
  apply(harness.ctx, { databasePath: join(dir, 'life.sqlite'), clock: clock.now, tickIntervalMs: 0 })
  const life = harness.provided.get('life')
  const exec = { agent: { session: { id: 'session-tool' } } }
  const activity = await harness.tools.get('life_activity_record').execute({ description: 'tool work' }, exec)
  const running = await harness.tools.get('life_activity_transition').execute(
    { id: activity.id, expectedRevision: 1, to: 'running' },
    exec,
  )
  const stopping = await harness.tools.get('life_activity_transition').execute(
    { id: activity.id, expectedRevision: running.revision, to: 'stopping' },
    exec,
  )
  await assert.rejects(
    harness.tools.get('life_activity_transition').execute(
      { id: activity.id, expectedRevision: stopping.revision, to: 'cancelled', evidenceRefs: ['tool:stopped'] },
      exec,
    ),
    /LIFE_UNAUTHORIZED/,
  )
  assert.equal(life.getActivity(activity.id, { scope: 'session:session-tool' }).status, 'stopping')
  harness.disposers[0]()
})

test('second live adapter fails closed while the first owner keeps its activities', () => {
  const dir = tempDir()
  const clock = makeClock()
  const databasePath = join(dir, 'life.sqlite')
  const first = fakeContext()
  apply(first.ctx, { databasePath, clock: clock.now, tickIntervalMs: 0 })
  const life = first.provided.get('life')
  const activity = runningActivity(life)

  const second = fakeContext()
  apply(second.ctx, { databasePath, clock: clock.now, tickIntervalMs: 0 })
  const heldHealth = second.provided.get('life').getHealth()
  assert.equal(heldHealth.state, 'degraded')
  assert.equal(heldHealth.reason, 'runtime_lease_held')
  assert.equal(second.tools.size, 0)
  assert.equal(life.getActivity(activity.id, { scope: SCOPE }).status, 'running')

  first.disposers[0]()
  assert.throws(() => life.getHealth(), LifeClosedError)

  const third = fakeContext()
  apply(third.ctx, { databasePath, clock: clock.now, tickIntervalMs: 0 })
  assert.equal(third.provided.get('life').getHealth().state, 'ok')
  assert.equal(third.provided.get('life').getActivity(activity.id, { scope: SCOPE }).status, 'unknown')
  third.disposers[0]()
})

test('stale lease is reclaimed only when the recorded PID is provably dead', () => {
  const deadPid = findDeadPid()
  if (deadPid === null) {
    test.skip('no provably dead PID observable in this environment')
    return
  }
  const dir = tempDir()
  const clock = makeClock()
  const databasePath = join(dir, 'life.sqlite')
  const first = fakeContext()
  apply(first.ctx, { databasePath, clock: clock.now, tickIntervalMs: 0 })
  const activity = runningActivity(first.provided.get('life'))

  const raw = new DatabaseSync(databasePath)
  raw.exec(`UPDATE runtime_leases SET pid = ${deadPid}`)
  raw.close()

  const second = fakeContext()
  apply(second.ctx, { databasePath, clock: clock.now, tickIntervalMs: 0 })
  assert.equal(second.provided.get('life').getHealth().state, 'ok')
  assert.equal(second.provided.get('life').getActivity(activity.id, { scope: SCOPE }).status, 'unknown')

  // The previous owner can no longer release the new owner's lease.
  first.disposers[0]()
  const third = fakeContext()
  apply(third.ctx, { databasePath, clock: clock.now, tickIntervalMs: 0 })
  assert.equal(third.provided.get('life').getHealth().state, 'degraded')
  second.disposers[0]()
})

test('setup failure releases the lease, closes storage, and leaves the host usable', () => {
  const dir = tempDir()
  const clock = makeClock()
  const databasePath = join(dir, 'life.sqlite')
  const failing = fakeContext()
  failing.ctx.tools.register = () => {
    throw new Error('synthetic tool registration failure')
  }
  assert.throws(
    () => apply(failing.ctx, { databasePath, clock: clock.now, tickIntervalMs: 0 }),
    /synthetic tool registration failure/,
  )

  const retry = fakeContext()
  apply(retry.ctx, { databasePath, clock: clock.now, tickIntervalMs: 0 })
  assert.equal(retry.provided.get('life').getHealth().state, 'ok')
  retry.disposers[0]()
})

test('bus events are reference-only and model health is scope-isolated', async () => {
  const dir = tempDir()
  const clock = makeClock()
  const emitted = []
  const harness = fakeContext({ emitted })
  apply(harness.ctx, { databasePath: join(dir, 'life.sqlite'), clock: clock.now, tickIntervalMs: 0 })
  const life = harness.provided.get('life')
  const execA = { agent: { session: { id: 'A' } } }
  const execB = { agent: { session: { id: 'B' } } }
  await harness.tools.get('life_intent_create').execute(
    { description: 'secret plan for A', reviewAt: clock.at(1000) },
    execA,
  )
  await harness.tools.get('life_intent_create').execute(
    { description: 'secret plan for B', reviewAt: clock.at(1000) },
    execB,
  )
  clock.advance(2000)
  const tick = life.tickNow()
  assert.equal(tick.produced.length, 2)
  const serialized = JSON.stringify(emitted)
  assert.equal(serialized.includes('secret plan'), false)
  for (const event of tick.produced) {
    assert.equal('description' in event.payload, false)
    assert.equal('authorizationRef' in event.payload, false)
  }

  const healthA = await harness.tools.get('life_health').execute({}, execA)
  assert.equal(healthA.counts.intents.active, 1)
  assert.equal('databasePath' in healthA, false)
  const healthASerialized = JSON.stringify(healthA)
  assert.equal(healthASerialized.includes('session:B'), false)
  assert.equal(healthASerialized.includes('secret plan for B'), false)

  const trusted = life.getHealth()
  assert.equal(trusted.counts.intents.active, 2)
  assert.equal(typeof trusted.databasePath, 'string')
  harness.disposers[0]()
})

test('parallel worker threads produce exactly one reconsideration event', async () => {
  const dir = tempDir()
  const clock = makeClock()
  const databasePath = join(dir, 'life.sqlite')
  const core = openCore(databasePath, clock)
  createIntent(core, clock, SCOPE, 'concurrent claim target')
  clock.advance(2000)
  core.close()

  const barrier = new SharedArrayBuffer(8)
  const state = new Int32Array(barrier)
  const workers = [
    new Worker(new URL('./t07-worker.js', import.meta.url), { workerData: { databasePath, barrier } }),
    new Worker(new URL('./t07-worker.js', import.meta.url), { workerData: { databasePath, barrier } }),
  ]
  let ready = 0
  const counts = await Promise.all(
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
  assert.equal(counts.reduce((sum, value) => sum + value, 0), 1)

  const check = openCore(databasePath, clock)
  try {
    assert.equal(check.listOutbox({ scope: SCOPE }).length, 1)
  } finally {
    check.close()
  }
})

test('hostile extra arguments cannot override scope or trusted evidence through tools', async () => {
  const dir = tempDir()
  const clock = makeClock()
  const harness = fakeContext()
  apply(harness.ctx, { databasePath: join(dir, 'life.sqlite'), clock: clock.now, tickIntervalMs: 0 })
  const victimExec = { agent: { session: { id: 'victim' } } }
  const attackerExec = { agent: { session: { id: 'attacker' } } }
  const life = harness.provided.get('life')
  const victim = await harness.tools
    .get('life_intent_create')
    .execute({ description: 'victim plan', reviewAt: clock.at(1000) }, victimExec)

  await assert.rejects(
    harness.tools.get('life_intent_update').execute(
      {
        id: victim.id,
        expectedRevision: victim.revision,
        description: 'pwned',
        scope: 'session:victim',
      },
      attackerExec,
    ),
    /LIFE_VALIDATION/,
  )
  const after = life.getIntent(victim.id, { scope: 'session:victim' })
  assert.equal(after.description, 'victim plan')
  assert.equal(after.revision, 1)

  await assert.rejects(
    harness.tools.get('life_intent_update').execute(
      { id: victim.id, expectedRevision: victim.revision, description: 'ok', ownerScope: 'session:victim' },
      victimExec,
    ),
    /LIFE_VALIDATION/,
  )

  const activity = await harness.tools.get('life_activity_record').execute({ description: 'work' }, victimExec)
  const running = await harness.tools.get('life_activity_transition').execute(
    { id: activity.id, expectedRevision: 1, to: 'running' },
    victimExec,
  )
  const stopping = await harness.tools.get('life_activity_transition').execute(
    { id: activity.id, expectedRevision: running.revision, to: 'stopping' },
    victimExec,
  )
  await assert.rejects(
    harness.tools.get('life_activity_transition').execute(
      {
        id: activity.id,
        expectedRevision: stopping.revision,
        to: 'cancelled',
        evidenceRefs: ['forged'],
        trustedEvidence: true,
      },
      attackerExec,
    ),
    /LIFE_VALIDATION/,
  )
  assert.equal(life.getActivity(activity.id, { scope: 'session:victim' }).status, 'stopping')
  harness.disposers[0]()
})

/** Find a PID that process.kill reports as definitively absent. */
function findDeadPid() {
  for (const pid of [999999, 1999999, 2147483647]) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error?.code === 'ESRCH') return pid
    }
  }
  return null
}
