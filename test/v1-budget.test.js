import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
import { LifeCore } from '../src/core.js'

const SESSION_A = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_B = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SCOPE_A = `session:${SESSION_A}`
const SCOPE_B = `session:${SESSION_B}`

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'amadeus-life-budget-'))
}

function makeClock() {
  let now = Date.parse('2026-10-25T00:00:00.000Z')
  return { now: () => now, advance(ms) { now += ms } }
}

function openCore(databasePath, clock) {
  return new LifeCore({ databasePath, clock: clock.now, maxReviewBatch: 20 })
}

function identity(core, sessionId) {
  const persona = core.v1.createPersona({ name: 'Budget Persona' })
  const scene = core.v1.createScene({
    personaId: persona.id,
    contextScope: `session:${sessionId}`,
    privacy: 'private',
  })
  core.v1.bindSession({
    targetSessionId: sessionId,
    personaId: persona.id,
    sceneId: scene.id,
    principalId: 'principal-budget',
    authorizationRef: 'admin:budget',
  })
  return { persona, scene }
}

test('BUD1 activity concurrency is atomic and cannot be bypassed without a resource', async () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    core.v1.configureBudget({ scope: SCOPE_A, windowMs: 60_000, activityLimit: 1 })
    const first = await core.v1.startActivity({ description: 'first no resource', ownerScope: SCOPE_A })
    assert.equal(first.status, 'running')
    await assert.rejects(
      () => core.v1.startActivity({ description: 'second no resource', ownerScope: SCOPE_A }),
      /activity concurrency limit/,
    )
    assert.equal(core.listActivities({ scope: SCOPE_A }).length, 1)

    const unknown = core.transitionActivity(first.id, {
      scope: SCOPE_A,
      expectedRevision: first.revision,
      to: 'unknown',
      note: 'provider result unknown',
    })
    assert.equal(unknown.status, 'unknown')
    await assert.rejects(
      () => core.v1.startActivity({ description: 'unknown still occupies', ownerScope: SCOPE_A }),
      /activity concurrency limit/,
    )
    const cancelled = await core.v1.operateActivity('cancel', first.id, SCOPE_A)
    assert.equal(cancelled.status, 'cancelled')
    const released = await core.v1.startActivity({ description: 'after terminal release', ownerScope: SCOPE_A })
    assert.equal(released.status, 'running')
    await core.v1.operateActivity('cancel', released.id, SCOPE_A)
  } finally {
    core.close()
  }
})

test('BUD2 session, persona, and global effective limits are independent and enforced', async () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const { persona, scene } = identity(core, SESSION_A)
    core.v1.configureBudget({ scope: `persona:${persona.id}`, windowMs: 60_000, activityLimit: 1 })
    const personaFirst = await core.v1.startActivity({
      description: 'persona activity',
      ownerScope: SCOPE_A,
      personaId: persona.id,
      sceneId: scene.id,
    })
    assert.equal(personaFirst.status, 'running')
    await assert.rejects(
      () => core.v1.startActivity({
        description: 'second persona activity',
        ownerScope: SCOPE_A,
        personaId: persona.id,
        sceneId: scene.id,
      }),
      /activity concurrency limit/,
    )
    // A non-persona activity is not subject to the persona limit.
    const unbound = await core.v1.startActivity({ description: 'session activity', ownerScope: SCOPE_A })
    assert.equal(unbound.status, 'running')

    core.v1.configureBudget({ scope: 'global', windowMs: 60_000, activityLimit: 1 })
    await assert.rejects(
      () => core.v1.startActivity({ description: 'blocked by global', ownerScope: SCOPE_B }),
      /activity concurrency limit/,
    )
    await core.v1.operateActivity('cancel', personaFirst.id, SCOPE_A)
    await core.v1.operateActivity('cancel', unbound.id, SCOPE_A)
  } finally {
    core.close()
  }
})

test('BUD3 paid cost reservation is atomic, idempotent, and conservatively held when unknown', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    core.v1.configureBudget({ scope: SCOPE_A, windowMs: 60_000, costLimit: 10 })
    const reservation = core.v1.reserveCost({ scope: SCOPE_A, amount: 6, idempotencyKey: 'paid-1' })
    assert.equal(reservation.status, 'reserved')
    assert.equal(reservation.amount, 6)
    const duplicate = core.v1.reserveCost({ scope: SCOPE_A, amount: 6, idempotencyKey: 'paid-1' })
    assert.equal(duplicate.id, reservation.id)
    assert.equal(core.v1.getBudget(SCOPE_A).costReserved, 6)
    assert.throws(
      () => core.v1.reserveCost({ scope: SCOPE_A, amount: 5, idempotencyKey: 'paid-2' }),
      /cost budget exhausted/,
    )
    assert.equal(core.v1.getBudget(SCOPE_A).costReserved, 6)

    const settled = core.v1.settleCost({ reservationId: reservation.id, actualCost: 4 })
    assert.equal(settled.status, 'settled')
    assert.equal(core.v1.getBudget(SCOPE_A).costReserved, 0)
    assert.equal(core.v1.getBudget(SCOPE_A).costUsed, 4)
    assert.throws(
      () => core.v1.settleCost({ reservationId: reservation.id, actualCost: 4 }),
      /only a reserved cost/,
    )
    assert.throws(
      () => core.v1.releaseCost({ reservationId: reservation.id }),
      /only a reserved cost/,
    )

    const unknown = core.v1.reserveCost({ scope: SCOPE_A, amount: 3, idempotencyKey: 'paid-unknown' })
    assert.equal(core.v1.getBudget(SCOPE_A).costReserved, 3)
    assert.equal(core.v1.getCostReservation(unknown.id).status, 'reserved')
    assert.throws(
      () => core.v1.reserveCost({ scope: SCOPE_A, amount: 4, idempotencyKey: 'paid-unknown-2' }),
      /cost budget exhausted/,
    )
    assert.throws(
      () => core.v1.reserveCost({ scope: SCOPE_A, amount: -1 }),
      /amount/,
    )
    const released = core.v1.releaseCost({ reservationId: unknown.id, reason: 'explicitly not executed' })
    assert.equal(released.status, 'released')
    assert.equal(core.v1.getBudget(SCOPE_A).costReserved, 0)
    assert.throws(
      () => core.v1.settleCost({ reservationId: unknown.id, actualCost: 1 }),
      /only a reserved cost/,
    )

    // A different scope has its own permission/limit and is not charged by A.
    assert.throws(
      () => core.v1.reserveCost({ scope: SCOPE_B, amount: 1 }),
      /cost budget is not configured/,
    )
    core.v1.configureBudget({ scope: SCOPE_B, windowMs: 60_000, costLimit: 5 })
    const other = core.v1.reserveCost({ scope: SCOPE_B, amount: 5 })
    assert.equal(other.status, 'reserved')
    assert.equal(core.v1.getBudget(SCOPE_B).costReserved, 5)
    assert.equal(core.v1.getBudget(SCOPE_A).costReserved, 0)
    assert.equal(core.v1.getBudget(SCOPE_A).costUsed, 4)
    core.v1.releaseCost({ reservationId: other.id })
  } finally {
    core.close()
  }
})

test('BUD5 token reservation survives restart/window/config and settles actual usage once', () => {
  const clock = makeClock()
  const dir = tempDir()
  const databasePath = join(dir, 'life.sqlite')
  let core = openCore(databasePath, clock)
  const { persona } = identity(core, SESSION_A)
  for (const scope of [SCOPE_A, `persona:${persona.id}`, 'global']) {
    core.v1.configureBudget({ scope, windowMs: 60_000, tokenLimit: 100, wakeLimit: 10 })
  }
  const reservation = core.consumeWakeBudget({ scope: SCOPE_A, estimatedTokens: 100 })
  assert.equal(reservation.allowed, true)
  assert.equal(core.v1.getBudget(SCOPE_A).tokensReserved, 100)
  core.v1.configureBudget({ scope: SCOPE_A, windowMs: 60_000, tokenLimit: 200, wakeLimit: 10 })
  assert.equal(core.v1.getBudget(SCOPE_A).tokensReserved, 100)
  core.close()

  core = openCore(databasePath, clock)
  try {
    assert.equal(core.v1.getBudget(SCOPE_A).tokensReserved, 100)
    clock.advance(61_000)
    assert.equal(core.v1.getBudget(SCOPE_A).tokensReserved, 100)
    assert.equal(core.v1.recordSessionUsage({
      targetSessionId: SESSION_A,
      seq: 10,
      usage: { totalTokens: 70 },
    }).recorded, true)
    assert.equal(core.v1.getBudget(SCOPE_A).tokensUsed, 70)
    assert.equal(core.v1.getBudget(`persona:${persona.id}`).tokensUsed, 70)
    assert.equal(core.v1.getBudget('global').tokensUsed, 70)
    assert.equal(core.v1.getBudget(SCOPE_A).tokensReserved, 0)
    core.v1.recordSessionUsage({ targetSessionId: SESSION_A, seq: 10, usage: { totalTokens: 70 } })
    assert.equal(core.v1.getBudget(SCOPE_A).tokensUsed, 70)
  } finally {
    core.close()
  }
})

test('BUD6 actual usage over reservation is conservative and blocks new autonomous work', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const { persona } = identity(core, SESSION_A)
    for (const scope of [SCOPE_A, `persona:${persona.id}`, 'global']) {
      core.v1.configureBudget({ scope, windowMs: 60_000, tokenLimit: 100 })
    }
    assert.equal(core.consumeWakeBudget({ scope: SCOPE_A, estimatedTokens: 100 }).allowed, true)
    core.v1.recordSessionUsage({ targetSessionId: SESSION_A, seq: 20, usage: { totalTokens: 150 } })
    assert.equal(core.v1.getBudget(SCOPE_A).tokensUsed, 150)
    assert.equal(core.v1.getBudget(SCOPE_A).tokensReserved, 0)
    assert.equal(core.consumeWakeBudget({ scope: SCOPE_A, estimatedTokens: 1 }).allowed, false)
    clock.advance(60_001)
    assert.equal(core.consumeWakeBudget({ scope: SCOPE_A, estimatedTokens: 1 }).allowed, true)
  } finally {
    core.close()
  }
})

test('BUD7 shared Persona/global token limits are not exceeded across two workers', async () => {
  const databasePath = join(tempDir(), 'life.sqlite')
  const clock = makeClock()
  const seed = openCore(databasePath, clock)
  const persona = seed.v1.createPersona({ name: 'shared budget persona' })
  for (const [session, scope] of [[SESSION_A, SCOPE_A], [SESSION_B, SCOPE_B]]) {
    const scene = seed.v1.createScene({ personaId: persona.id, contextScope: scope })
    seed.v1.bindSession({
      targetSessionId: session,
      personaId: persona.id,
      sceneId: scene.id,
      principalId: `principal:${session}`,
      authorizationRef: 'admin:budget',
    })
  }
  for (const scope of [SCOPE_A, SCOPE_B]) {
    seed.v1.configureBudget({ scope, windowMs: 60_000, tokenLimit: 1000, wakeLimit: 10 })
  }
  seed.v1.configureBudget({ scope: `persona:${persona.id}`, windowMs: 60_000, tokenLimit: 100, wakeLimit: 1 })
  seed.v1.configureBudget({ scope: 'global', windowMs: 60_000, tokenLimit: 100, wakeLimit: 1 })
  seed.close()

  const workers = [SCOPE_A, SCOPE_B].map((scope) => new Worker(new URL('./v8-worker.js', import.meta.url), {
    workerData: { databasePath, scope, mode: 'wake' },
  }))
  const results = []
  try {
    await Promise.all(workers.map((worker) => new Promise((resolve, reject) => {
      worker.on('message', (message) => {
        if (message.type === 'ready') {
          worker.postMessage('go')
          return
        }
        if (message.type === 'done') {
          results.push(message)
          resolve()
          return
        }
        reject(new Error(`unexpected worker message: ${message.type}`))
      })
      worker.on('error', reject)
    })))
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()))
  }
  assert.equal(results.length, 2)
  assert.equal(results.filter((result) => result.ok === true).length, 1)
  const winner = results.find((result) => result.ok === true)
  const check = openCore(databasePath, clock)
  try {
    assert.equal(check.v1.getBudget(`persona:${persona.id}`).wakeCalls, 1)
    assert.equal(check.v1.getBudget('global').wakeCalls, 1)
    assert.equal(check.v1.getBudget(`persona:${persona.id}`).tokensReserved, 60)
    assert.equal(check.v1.getBudget(winner.scope).tokensReserved, 60)
  } finally {
    check.close()
  }
})

test('BUD8 a wakeId reservation is idempotent across restart and conflicts fail closed', () => {
  const clock = makeClock()
  const dir = tempDir()
  const databasePath = join(dir, 'life.sqlite')
  let core = openCore(databasePath, clock)
  core.v1.configureBudget({ scope: SCOPE_A, windowMs: 60_000, wakeLimit: 2, tokenLimit: 200 })
  const first = core.consumeWakeBudget({ scope: SCOPE_A, estimatedTokens: 100, wakeId: 'wake_repeat' })
  assert.equal(first.allowed, true)
  core.close()

  core = openCore(databasePath, clock)
  try {
    const second = core.consumeWakeBudget({ scope: SCOPE_A, estimatedTokens: 100, wakeId: 'wake_repeat' })
    assert.equal(second.allowed, true)
    assert.equal(second.reservationId, first.reservationId)
    assert.equal(core.v1.getBudget(SCOPE_A).wakeCalls, 1)
    assert.equal(core.v1.getBudget(SCOPE_A).tokensReserved, 100)
    assert.throws(
      () => core.consumeWakeBudget({ scope: SCOPE_A, estimatedTokens: 50, wakeId: 'wake_repeat' }),
      /different scope or amount/,
    )
    const unbound = core.consumeWakeBudget({ scope: SCOPE_A, estimatedTokens: 1, wakeId: null })
    assert.equal(unbound.allowed, true)
    assert.notEqual(unbound.reservationId, first.reservationId)
    assert.equal(core.v1.getBudget(SCOPE_A).wakeCalls, 2)
  } finally {
    core.close()
  }
})

test('BUD9 two workers using the same wakeId reserve once', async () => {
  const databasePath = join(tempDir(), 'life.sqlite')
  const clock = makeClock()
  const seed = openCore(databasePath, clock)
  seed.v1.configureBudget({ scope: SCOPE_A, windowMs: 60_000, wakeLimit: 1, tokenLimit: 100 })
  seed.close()

  const workers = [1, 2].map(() => new Worker(new URL('./v8-worker.js', import.meta.url), {
    workerData: { databasePath, scope: SCOPE_A, mode: 'wake', wakeId: 'wake_worker_same' },
  }))
  const results = []
  try {
    await Promise.all(workers.map((worker) => new Promise((resolve, reject) => {
      worker.on('message', (message) => {
        if (message.type === 'ready') {
          worker.postMessage('go')
          return
        }
        if (message.type === 'done') {
          results.push(message)
          resolve()
          return
        }
        reject(new Error(`unexpected worker message: ${message.type}`))
      })
      worker.on('error', reject)
    })))
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()))
  }
  assert.equal(results.length, 2)
  assert.equal(results.every((result) => result.ok === true), true)
  assert.equal(results[0].id, results[1].id)
  const check = openCore(databasePath, clock)
  try {
    assert.equal(check.v1.getBudget(SCOPE_A).wakeCalls, 1)
    assert.equal(check.v1.getBudget(SCOPE_A).tokensReserved, 60)
  } finally {
    check.close()
  }
})

test('BUD4 two independent workers cannot both exceed the activity limit', async () => {
  const databasePath = join(tempDir(), 'life.sqlite')
  const clock = makeClock()
  const seed = openCore(databasePath, clock)
  seed.v1.configureBudget({ scope: SCOPE_A, windowMs: 60_000, activityLimit: 1 })
  seed.close()

  const workers = [1, 2].map(() => new Worker(new URL('./v8-worker.js', import.meta.url), {
    workerData: { databasePath, scope: SCOPE_A },
  }))
  const results = []
  try {
    await Promise.all(workers.map((worker) => new Promise((resolve, reject) => {
      worker.on('message', (message) => {
        if (message.type === 'ready') {
          worker.postMessage('go')
          return
        }
        if (message.type === 'done') {
          results.push(message)
          resolve()
          return
        }
        reject(new Error(`unexpected worker message: ${message.type}`))
      })
      worker.on('error', reject)
    })))
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()))
  }
  assert.equal(results.length, 2)
  assert.equal(results.filter((result) => result.ok === true).length, 1)
  const failed = results.find((result) => result.ok === false)
  assert.match(failed.error, /activity concurrency limit/)
  const check = openCore(databasePath, clock)
  try {
    const active = check.listActivities({ scope: SCOPE_A })
      .filter((activity) => ['pending', 'running', 'paused', 'stopping', 'unknown'].includes(activity.status))
    assert.equal(active.length, 1)
  } finally {
    check.close()
  }
})
