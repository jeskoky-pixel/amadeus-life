/**
 * First Host wake-adapter slice (0.2.0). Fake Host only: no DSH process, no real
 * Session, no model call, no profile database.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LifeCore } from '../src/core.js'
import { apply } from '../src/index.js'
import { SNAPSHOT_SCAN_LIMIT } from '../src/wake-host.js'

const BASE = '2026-01-01T00:00:00.000Z'
const SESSION_A = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_B = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SECRET = 'SECRET_DESCRIPTION_MUST_NOT_LEAK'

function makeClock(start = BASE) {
  let t = Date.parse(start)
  return { now: () => t, advance: (ms) => { t += ms }, at: (ms) => new Date(t + ms).toISOString() }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'amadeus-life-host-'))
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function fakeHost({ flush, resolveAgent, without = [] } = {}) {
  const tools = new Map()
  const provided = new Map()
  const disposers = []
  const listeners = []
  const agents = new Map()
  const resolveCalls = []
  const listenerDisposers = { count: 0 }

  const agentFor = (sessionId) => {
    let entry = agents.get(sessionId)
    if (entry === undefined) {
      entry = { sessionId, followups: [], steers: 0, cancels: 0, snapshot: [] }
      agents.set(sessionId, entry)
    }
    return entry
  }
  const agentHandle = (sessionId) => {
    const entry = agentFor(sessionId)
    return {
      session: { id: sessionId, snapshotEvents: () => entry.snapshot },
      followup(message) {
        entry.followups.push(message)
      },
      steer() {
        entry.steers += 1
      },
      cancel() {
        entry.cancels += 1
      },
    }
  }

  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    provide: (name, value) => provided.set(name, value),
    effect: (fn) => { disposers.push(fn()) },
    emit() {},
    on(name, handler, options) {
      const entry = { name, handler, options }
      listeners.push(entry)
      return () => {
        const index = listeners.indexOf(entry)
        if (index >= 0) listeners.splice(index, 1)
        listenerDisposers.count += 1
      }
    },
    logger: { error() {}, warn() {} },
  }
  if (!without.includes('sessionController')) {
    ctx.sessionController = {
      resolveAgent:
        resolveAgent ??
        (async (sessionId) => {
          resolveCalls.push(sessionId)
          return { agent: agentHandle(sessionId) }
        }),
    }
  }
  if (!without.includes('sessions')) {
    ctx.sessions = {
      flush: flush ?? (async () => true),
    }
  }

  const emitSession = (sessionId, event) => {
    const session = { id: sessionId, snapshotEvents: () => agentFor(sessionId).snapshot }
    for (const listener of listeners) {
      if (listener.name === 'session/event') listener.handler(session, event)
    }
  }

  return { ctx, tools, provided, disposers, listeners, listenerDisposers, agents, resolveCalls, emitSession }
}

function setup({ delivery, flush, resolveAgent, without } = {}) {
  const dir = tempDir()
  const clock = makeClock()
  const fake = fakeHost({ flush, resolveAgent, without })
  apply(fake.ctx, {
    databasePath: join(dir, 'life.sqlite'),
    clock: clock.now,
    tickIntervalMs: 0,
    wakeDelivery: delivery,
  })
  return { ...fake, dir, clock, databasePath: join(dir, 'life.sqlite'), life: fake.provided.get('life') }
}

function seedDue(life, clock, sessionId = SESSION_A) {
  const scope = `session:${sessionId}`
  const intent = life.createIntent({
    description: SECRET,
    reviewAt: clock.at(0),
    contextScope: scope,
    authorizationRef: `life-tool:${scope}`,
  })
  life.tickNow()
  return intent
}

function messageFor(record) {
  assert.equal(record.followups.length, 1)
  return record.followups[0]
}

test('H1 delivery is disabled by default with zero Host calls', async () => {
  const { life, resolveCalls, agents, clock } = setup()
  seedDue(life, clock)
  const health = life.getHealth()
  assert.equal(health.delivery.state, 'disabled')
  assert.equal(typeof life.driveDueWakesOnce, 'function')
  const result = await life.driveDueWakesOnce()
  assert.equal(result.status, 'disabled')
  assert.equal(resolveCalls.length, 0)
  assert.equal(agents.size, 0)
  assert.equal(life.listWakes().length, 0)
})

test('H2 missing Host capabilities degrade delivery but keep Life tools working', async () => {
  const { life, clock } = setup({
    delivery: { enabled: true, allowedSessionIds: [SESSION_A], intervalMs: 60_000 },
    without: ['sessionController', 'sessions'],
  })
  seedDue(life, clock)
  const health = life.getHealth()
  assert.equal(health.delivery.state, 'degraded')
  assert.equal(health.delivery.reason, 'missing_capability')
  const result = await life.driveDueWakesOnce()
  assert.equal(result.status, 'unavailable')
  assert.equal(life.listIntents({ scope: `session:${SESSION_A}` }).length, 1)
})

test('H3 allowlist bounds claims, keeps other Sessions pending, and sends no secret text', async () => {
  const { life, clock, agents, resolveCalls } = setup({
    delivery: { enabled: true, allowedSessionIds: [SESSION_A], intervalMs: 60_000, maxPerDrive: 1 },
  })
  const intentA = seedDue(life, clock, SESSION_A)
  seedDue(life, clock, SESSION_B)
  const result = await life.driveDueWakesOnce()
  assert.equal(result.delivered.length, 1)
  const entryA = agents.get(SESSION_A)
  const entryB = agents.get(SESSION_B)
  assert.equal(entryA.followups.length, 1)
  assert.equal(entryA.steers, 0)
  assert.equal(entryA.cancels, 0)
  assert.equal(entryB, undefined)
  assert.deepEqual(resolveCalls, [SESSION_A])

  const message = messageFor(entryA)
  assert.equal(message.role, 'user')
  assert.equal(typeof message.id, 'string')
  assert.equal(message.source.kind, 'amadeus-life')
  const wakes = life.listWakes()
  const wakeA = wakes.find((wake) => wake.intentId === intentA.id)
  assert.equal(message.source.wakeId, wakeA.id)
  assert.match(message.content[0].text, new RegExp(intentA.id))
  assert.match(message.content[0].text, /revision 1/)
  assert.equal(JSON.stringify(message).includes(SECRET), false)
  assert.equal(wakeA.status, 'admitted')
  assert.equal(wakeA.messageId, message.id)
  assert.equal(wakes.find((wake) => wake.targetSessionId === SESSION_B).status, 'pending')

  // An admitted, unreconciled wake defers the same Session instead of piling up.
  const second = await life.driveDueWakesOnce()
  assert.equal(second.delivered.length, 0)
  assert.equal(entryA.followups.length, 1)
})

test('H4 flush false or throw becomes uncertain and is never automatically resent', async () => {
  for (const flush of [async () => false, async () => { throw new Error('flush down') }]) {
    const { life, clock, agents, resolveCalls } = setup({
      delivery: { enabled: true, allowedSessionIds: [SESSION_A], intervalMs: 60_000 },
      flush,
    })
    seedDue(life, clock)
    const first = await life.driveDueWakesOnce()
    assert.equal(first.delivered[0].status, 'uncertain')
    assert.equal(life.listWakes()[0].status, 'uncertain')
    assert.equal(agents.get(SESSION_A).followups.length, 1)
    const second = await life.driveDueWakesOnce()
    assert.equal(second.delivered.length, 0)
    assert.equal(agents.get(SESSION_A).followups.length, 1)
    assert.equal(resolveCalls.length, 1)
    // An uncertain wake blocks further wakes for the same Session until
    // evidence-based reconciliation exists; it is deferred, not superseded.
    seedDue(life, clock)
    const third = await life.driveDueWakesOnce()
    assert.equal(third.delivered.length, 0)
    assert.equal(agents.get(SESSION_A).followups.length, 1)
    assert.equal(life.listWakes({ status: 'uncertain' }).length, 1)
  }
})

test('H5 execution requires the matching completed turn and message', async () => {
  const { life, clock, agents, emitSession } = setup({
    delivery: { enabled: true, allowedSessionIds: [SESSION_A], intervalMs: 60_000 },
  })
  seedDue(life, clock)
  await life.driveDueWakesOnce()
  const entry = agents.get(SESSION_A)
  const message = messageFor(entry)
  const wake = life.listWakes()[0]

  // Unrelated completed turn and forged source must not execute the wake.
  emitSession(SESSION_A, { type: 'turn/start', seq: 1, data: { turn: 4 } })
  emitSession(SESSION_A, {
    type: 'user/message',
    seq: 2,
    data: { id: 'unrelated', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
  })
  emitSession(SESSION_A, { type: 'turn/end', seq: 3, data: { turn: 4, reason: { kind: 'completed' } } })
  emitSession(SESSION_A, { type: 'turn/start', seq: 4, data: { turn: 5 } })
  emitSession(SESSION_A, {
    type: 'user/message',
    seq: 5,
    data: { id: 'forged', role: 'user', content: message.content, source: { kind: 'amadeus-life', wakeId: 'other' } },
  })
  emitSession(SESSION_A, { type: 'turn/end', seq: 6, data: { turn: 5, reason: { kind: 'completed' } } })
  assert.equal(life.getWake(wake.id).status, 'admitted')

  // Failed turn containing the real message stays admitted.
  emitSession(SESSION_A, { type: 'turn/start', seq: 7, data: { turn: 6 } })
  emitSession(SESSION_A, {
    type: 'user/message',
    seq: 8,
    data: { id: message.id, role: 'user', content: message.content, source: message.source },
  })
  emitSession(SESSION_A, { type: 'turn/end', seq: 9, data: { turn: 6, reason: { kind: 'error' } } })
  assert.equal(life.getWake(wake.id).status, 'admitted')

  // Matching completed turn executes, recording the turn seq.
  emitSession(SESSION_A, { type: 'turn/start', seq: 10, data: { turn: 7 } })
  emitSession(SESSION_A, {
    type: 'user/message',
    seq: 11,
    data: { id: message.id, role: 'user', content: message.content, source: message.source },
  })
  emitSession(SESSION_A, { type: 'turn/end', seq: 12, data: { turn: 7, reason: { kind: 'completed' } } })
  const executed = life.getWake(wake.id)
  assert.equal(executed.status, 'executed')
  assert.equal(executed.executedTurnSeq, 7)
  assert.ok(executed.executedAt)
})

test('H6 completion observed before admission is reconciled from evidence', async () => {
  const clock = makeClock()
  const dir = tempDir()
  const fake = fakeHost({
    flush: async (session) => {
      const entry = fake.agents.get(session.id)
      const message = entry.followups.at(-1)
      const events = [
        { type: 'turn/start', seq: 1, data: { turn: 2 } },
        {
          type: 'user/message',
          seq: 2,
          data: { id: message.id, role: 'user', content: message.content, source: message.source },
        },
        { type: 'turn/end', seq: 3, data: { turn: 2, reason: { kind: 'completed' } } },
      ]
      entry.snapshot.push(...events)
      for (const event of events) fake.emitSession(session.id, event)
      return true
    },
  })
  apply(fake.ctx, {
    databasePath: join(dir, 'life.sqlite'),
    clock: clock.now,
    tickIntervalMs: 0,
    wakeDelivery: { enabled: true, allowedSessionIds: [SESSION_A], intervalMs: 60_000 },
  })
  const life = fake.provided.get('life')
  seedDue(life, clock)
  const result = await life.driveDueWakesOnce()
  assert.equal(result.delivered[0].status, 'admitted')
  const wake = life.listWakes()[0]
  assert.equal(wake.status, 'executed')
  assert.equal(wake.executedTurnSeq, 2)
})

test('H7 cancellation or local acknowledgement during resolve prevents delivery', async () => {
  for (const race of ['cancel', 'acknowledge']) {
    const gate = deferred()
    let resolveStarted
    const started = new Promise((resolve) => { resolveStarted = resolve })
    const clock = makeClock()
    const dir = tempDir()
    const fake = fakeHost({
      resolveAgent: async (sessionId) => {
        const entry = fake.agents.get(sessionId) ?? { followups: [], steers: 0, cancels: 0, snapshot: [] }
        fake.agents.set(sessionId, entry)
        resolveStarted()
        const resolved = await gate.promise
        return {
          agent: {
            session: { id: sessionId, snapshotEvents: () => [] },
            followup: (message) => entry.followups.push(message),
            steer() {},
            cancel() {},
          },
        }
      },
    })
    apply(fake.ctx, {
      databasePath: join(dir, 'life.sqlite'),
      clock: clock.now,
      tickIntervalMs: 0,
      wakeDelivery: { enabled: true, allowedSessionIds: [SESSION_A], intervalMs: 60_000 },
    })
    const life = fake.provided.get('life')
    const intent = seedDue(life, clock)
    const drive = life.driveDueWakesOnce()
    await started
    if (race === 'cancel') {
      life.cancelIntent(intent.id, { scope: `session:${SESSION_A}`, expectedRevision: 1 })
    } else {
      const [event] = life.listOutbox({ scope: `session:${SESSION_A}` })
      life.acknowledgeEvent(event.eventId, { scope: `session:${SESSION_A}` })
    }
    gate.resolve()
    const result = await drive
    assert.equal(result.delivered.length, 0, race)
    const wakes = life.listWakes()
    assert.equal(wakes.length, 1)
    assert.equal(wakes[0].status, 'superseded', race)
    assert.equal(fake.agents.get(SESSION_A)?.followups.length ?? 0, 0, race)
  }
})

test('H8 dispose stops listener and in-flight completion does not touch closed storage', async () => {
  const gate = deferred()
  let resolveStarted
  const started = new Promise((resolve) => { resolveStarted = resolve })
  const clock = makeClock()
  const dir = tempDir()
  const fake = fakeHost({
    resolveAgent: async (sessionId) => {
      const entry = fake.agents.get(sessionId) ?? { followups: [], steers: 0, cancels: 0, snapshot: [] }
      fake.agents.set(sessionId, entry)
      resolveStarted()
      await gate.promise
      return {
        agent: {
          session: { id: sessionId, snapshotEvents: () => [] },
          followup: (message) => entry.followups.push(message),
          steer() {},
          cancel() {},
        },
      }
    },
  })
  apply(fake.ctx, {
    databasePath: join(dir, 'life.sqlite'),
    clock: clock.now,
    tickIntervalMs: 0,
    wakeDelivery: { enabled: true, allowedSessionIds: [SESSION_A], intervalMs: 1000 },
  })
  const life = fake.provided.get('life')
  assert.equal(life.getHealth().delivery.timerActive, true)
  seedDue(life, clock)
  const drive = life.driveDueWakesOnce()
  await started
  for (const dispose of fake.disposers) dispose()
  assert.equal(fake.listenerDisposers.count, 1)
  gate.resolve()
  await drive
  assert.equal(fake.agents.get(SESSION_A)?.followups.length ?? 0, 0)

  const reopened = new LifeCore({ databasePath: join(dir, 'life.sqlite'), clock: clock.now })
  try {
    const wakes = reopened.listWakes()
    assert.equal(wakes.length, 1)
    assert.equal(wakes[0].status, 'claimed')
  } finally {
    reopened.close()
  }
})

test('H10 an allowlist without explicit enabled=true stays off', async () => {
  const { life, clock, resolveCalls, agents } = setup({
    delivery: { allowedSessionIds: [SESSION_A], intervalMs: 60_000 },
  })
  seedDue(life, clock)
  assert.equal(life.getHealth().delivery.state, 'disabled')
  assert.equal(life.getHealth().delivery.reason, 'not_enabled')
  const result = await life.driveDueWakesOnce()
  assert.equal(result.status, 'disabled')
  assert.equal(resolveCalls.length, 0)
  assert.equal(agents.size, 0)
  assert.equal(life.listWakes().length, 0)
})

test('H14 durable evidence scan is bounded and conservative', async () => {
  let host
  host = fakeHost({
    flush: async (session) => {
      const entry = host.agents.get(session.id)
      const message = entry.followups.at(-1)
      entry.snapshot.push(
        { type: 'turn/start', seq: 1, data: { turn: 1 } },
        { type: 'user/message', seq: 2, data: { id: message.id, source: message.source } },
        { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
        ...Array.from({ length: SNAPSHOT_SCAN_LIMIT + 50 }, (_, index) => ({
          type: 'step/start',
          seq: 10 + index,
          data: { turn: 2, step: index },
        })),
      )
      return true
    },
  })
  const clock = makeClock()
  apply(host.ctx, {
    databasePath: join(tempDir(), 'life.sqlite'),
    clock: clock.now,
    tickIntervalMs: 0,
    wakeDelivery: { enabled: true, allowedSessionIds: [SESSION_A], intervalMs: 60_000 },
  })
  const life = host.provided.get('life')
  seedDue(life, clock)
  await life.driveDueWakesOnce()
  const wake = life.listWakes()[0]
  assert.equal(wake.status, 'admitted')
  assert.equal(wake.executedAt, null)
})

test('H9 an empty wake ledger makes no Host calls', async () => {
  const { life, resolveCalls, agents } = setup({
    delivery: { enabled: true, allowedSessionIds: [SESSION_A], intervalMs: 60_000 },
  })
  const result = await life.driveDueWakesOnce()
  assert.equal(result.delivered.length, 0)
  assert.equal(resolveCalls.length, 0)
  assert.equal(agents.size, 0)
})

test('H11 pre-admission evidence from another Session cannot execute this wake', async () => {
  let host
  host = fakeHost({
    flush: async (session) => {
      const message = host.agents.get(session.id).followups.at(-1)
      host.emitSession(SESSION_B, { type: 'turn/start', data: { turn: 9 } })
      host.emitSession(SESSION_B, { type: 'user/message', data: { id: message.id, source: message.source } })
      host.emitSession(SESSION_B, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } })
      return true
    },
  })
  const clock = makeClock()
  const databasePath = join(tempDir(), 'life.sqlite')
  apply(host.ctx, {
    databasePath, clock: clock.now, tickIntervalMs: 0,
    wakeDelivery: { enabled: true, allowedSessionIds: [SESSION_A], intervalMs: 60_000 },
  })
  const life = host.provided.get('life')
  seedDue(life, clock)
  await life.driveDueWakesOnce()
  assert.equal(life.listWakes()[0].status, 'admitted')
  assert.equal(life.listWakes()[0].executedAt, null)
})

test('H12 an old executed backlog cannot hide an unreconciled wake for the same Session', async () => {
  const { life, clock, agents, databasePath } = setup({
    delivery: { enabled: true, allowedSessionIds: [SESSION_A], intervalMs: 60_000 },
  })
  seedDue(life, clock)
  await life.driveDueWakesOnce()
  assert.equal(agents.get(SESSION_A).followups.length, 1)
  assert.equal(life.listWakes({ status: 'admitted' }).length, 1)

  const db = new DatabaseSync(databasePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    const insert = db.prepare(`INSERT INTO wake_requests
      (id,kind,event_id,intent_id,intent_revision,context_scope,target_session_id,authorization_ref,
       status,claim_owner,attempts,next_attempt_at,created_at,updated_at)
      VALUES (?, 'intent_due', ?, ?, 1, ?, ?, ?, 'executed', NULL, 1, ?, ?, ?)`)
    for (let index = 0; index < 500; index += 1) {
      const id = `synthetic-old-${index}`
      insert.run(id, id, id, `session:${SESSION_A}`, SESSION_A,
        `life-tool:session:${SESSION_A}`, '1999-01-01T00:00:00.000Z',
        '1999-01-01T00:00:00.000Z', '1999-01-01T00:00:00.000Z')
    }
    db.exec('COMMIT')
  } finally {
    db.close()
  }

  seedDue(life, clock)
  await life.driveDueWakesOnce()
  assert.equal(agents.get(SESSION_A).followups.length, 1)
  assert.equal(life.listWakes({ status: 'pending' }).length, 1)
})

test('H13 missing session event listener capability degrades delivery without closing Life', async () => {
  const clock = makeClock()
  const databasePath = join(tempDir(), 'life.sqlite')
  const host = fakeHost()
  delete host.ctx.on
  apply(host.ctx, {
    databasePath, clock: clock.now, tickIntervalMs: 0,
    wakeDelivery: { enabled: true, allowedSessionIds: [SESSION_A], intervalMs: 60_000 },
  })
  const life = host.provided.get('life')
  assert.equal(life.getHealth().delivery.state, 'degraded')
  assert.equal(life.getHealth().delivery.reason, 'missing_capability')
  seedDue(life, clock)
  assert.equal((await life.driveDueWakesOnce()).status, 'unavailable')
  assert.equal(life.listIntents({ scope: `session:${SESSION_A}` }).length, 1)
  host.disposers.forEach((dispose) => dispose())
})

test('H16 delayed optional injection binds, withdraws, and rebinds without duplicates', async () => {
  const clock = makeClock()
  const databasePath = join(tempDir(), 'life.sqlite')
  const host = fakeHost()
  host.ctx.get = () => undefined
  const injections = []
  let injectionDisposals = 0
  host.ctx.inject = (names, callback) => {
    injections.push({ names, callback })
    return () => {
      injectionDisposals += 1
    }
  }
  const effectDisposers = []
  const makeScope = () => ({
    sessionController: host.ctx.sessionController,
    sessions: host.ctx.sessions,
    on: host.ctx.on.bind(host.ctx),
    effect: (fn) => {
      effectDisposers.push(fn())
    },
  })
  apply(host.ctx, {
    databasePath, clock: clock.now, tickIntervalMs: 0,
    wakeDelivery: { enabled: true, allowedSessionIds: [SESSION_A], intervalMs: 60_000 },
  })
  const life = host.provided.get('life')
  assert.deepEqual(injections[0].names, ['sessionController', 'sessions'])
  assert.equal(life.getHealth().delivery.state, 'degraded')
  assert.equal(life.getHealth().delivery.reason, 'awaiting_services')
  seedDue(life, clock)
  assert.equal((await life.driveDueWakesOnce()).status, 'unavailable')
  assert.equal(host.agents.get(SESSION_A)?.followups.length ?? 0, 0)

  injections[0].callback(makeScope())
  assert.equal(life.getHealth().delivery.state, 'active')
  assert.equal(host.listeners.filter((listener) => listener.name === 'session/event').length, 1)
  assert.equal((await life.driveDueWakesOnce()).status, 'ok')
  assert.equal(host.agents.get(SESSION_A).followups.length, 1)

  effectDisposers[0]()
  assert.equal(life.getHealth().delivery.state, 'degraded')
  assert.equal(life.getHealth().delivery.reason, 'awaiting_services')
  assert.equal(host.listeners.filter((listener) => listener.name === 'session/event').length, 0)
  assert.equal((await life.driveDueWakesOnce()).status, 'unavailable')

  injections[0].callback(makeScope())
  assert.equal(life.getHealth().delivery.state, 'active')
  assert.equal(host.listeners.filter((listener) => listener.name === 'session/event').length, 1)
  effectDisposers[0]()
  assert.equal(life.getHealth().delivery.state, 'active')
  seedDue(life, clock)
  await life.driveDueWakesOnce()
  assert.equal(host.agents.get(SESSION_A).followups.length, 1)

  effectDisposers[1]()
  assert.equal(life.getHealth().delivery.state, 'degraded')
  injections[0].callback(makeScope())
  assert.equal(life.getHealth().delivery.state, 'active')
  assert.equal(host.listeners.filter((listener) => listener.name === 'session/event').length, 1)

  host.disposers.forEach((dispose) => dispose())
  assert.equal(host.listeners.filter((listener) => listener.name === 'session/event').length, 0)
  assert.equal(injectionDisposals, 1)
})

test('H15 optional Cordis injection exposes Host services absent from plain ctx.get', async () => {
  const clock = makeClock()
  const databasePath = join(tempDir(), 'life.sqlite')
  const host = fakeHost()
  host.ctx.get = () => undefined
  host.ctx.inject = (names, callback) => {
    assert.deepEqual(names, ['sessionController', 'sessions'])
    callback({
      sessionController: host.ctx.sessionController,
      sessions: host.ctx.sessions,
      on: host.ctx.on.bind(host.ctx),
    })
  }
  apply(host.ctx, {
    databasePath, clock: clock.now, tickIntervalMs: 0,
    wakeDelivery: { enabled: true, allowedSessionIds: [SESSION_A], intervalMs: 60_000 },
  })
  const life = host.provided.get('life')
  seedDue(life, clock)
  assert.equal((await life.driveDueWakesOnce()).status, 'ok')
  assert.equal(host.agents.get(SESSION_A).followups.length, 1)
  host.disposers.forEach((dispose) => dispose())
})

test('H18 withdrawing Host services during flush never records admission or execution', async () => {
  const clock = makeClock()
  const databasePath = join(tempDir(), 'life.sqlite')
  const flushStarted = deferred()
  const flushGate = deferred()
  const host = fakeHost({
    flush: async () => {
      flushStarted.resolve()
      await flushGate.promise
      return true
    },
  })
  host.ctx.get = () => undefined
  const scopeDisposers = []
  host.ctx.inject = (_names, callback) => callback({
    sessionController: host.ctx.sessionController,
    sessions: host.ctx.sessions,
    on: host.ctx.on.bind(host.ctx),
    effect: (fn) => scopeDisposers.push(fn()),
  })
  apply(host.ctx, {
    databasePath, clock: clock.now, tickIntervalMs: 0,
    wakeDelivery: { enabled: true, allowedSessionIds: [SESSION_A], intervalMs: 60_000 },
  })
  const life = host.provided.get('life')
  seedDue(life, clock)
  const drive = life.driveDueWakesOnce()
  await flushStarted.promise
  assert.equal(host.agents.get(SESSION_A).followups.length, 1)
  scopeDisposers[0]()
  flushGate.resolve()
  await drive
  const wake = life.listWakes()[0]
  assert.notEqual(wake.status, 'admitted')
  assert.notEqual(wake.status, 'executed')
  assert.equal(wake.executedAt, null)
  assert.ok(['uncertain', 'claimed'].includes(wake.status))
  assert.equal(life.getHealth().delivery.state, 'degraded')
  host.disposers.forEach((dispose) => dispose())
})

test('H19 rebinding during resolve prevents the old Agent from delivering', async () => {
  const gate = deferred()
  const started = deferred()
  const clock = makeClock()
  const databasePath = join(tempDir(), 'life.sqlite')
  const host = fakeHost({
    resolveAgent: async (sessionId) => {
      started.resolve()
      await gate.promise
      const entry = host.agents.get(sessionId) ?? { followups: [], steers: 0, cancels: 0, snapshot: [] }
      host.agents.set(sessionId, entry)
      return {
        agent: {
          session: { id: sessionId, snapshotEvents: () => [] },
          followup: (message) => entry.followups.push(message),
          steer() {},
          cancel() {},
        },
      }
    },
  })
  host.ctx.get = () => undefined
  const injections = []
  host.ctx.inject = (_names, callback) => {
    injections.push(callback)
    return () => {}
  }
  const scopeDisposers = []
  const makeScope = () => ({
    sessionController: host.ctx.sessionController,
    sessions: host.ctx.sessions,
    on: host.ctx.on.bind(host.ctx),
    effect: (fn) => scopeDisposers.push(fn()),
  })
  apply(host.ctx, {
    databasePath, clock: clock.now, tickIntervalMs: 0,
    wakeDelivery: { enabled: true, allowedSessionIds: [SESSION_A], intervalMs: 60_000 },
  })
  const life = host.provided.get('life')
  injections[0](makeScope())
  assert.equal(life.getHealth().delivery.state, 'active')
  seedDue(life, clock)
  const drive = life.driveDueWakesOnce()
  await started.promise
  scopeDisposers[0]()
  injections[0](makeScope())
  assert.equal(life.getHealth().delivery.state, 'active')
  gate.resolve()
  await drive
  assert.equal(host.agents.get(SESSION_A)?.followups.length ?? 0, 0)
  const wake = life.listWakes()[0]
  assert.ok(['uncertain', 'claimed'].includes(wake.status))
  assert.equal(wake.executedAt, null)
  host.disposers.forEach((dispose) => dispose())
})

test('H17 withdrawing Host services during resolve prevents a late followup', async () => {
  const gate = deferred()
  const started = deferred()
  const clock = makeClock()
  const databasePath = join(tempDir(), 'life.sqlite')
  const host = fakeHost({
    resolveAgent: async (sessionId) => {
      started.resolve()
      await gate.promise
      const entry = host.agents.get(sessionId) ?? { followups: [], snapshot: [] }
      host.agents.set(sessionId, entry)
      return { agent: { session: { id: sessionId, snapshotEvents: () => [] }, followup: (message) => entry.followups.push(message) } }
    },
  })
  host.ctx.get = () => undefined
  const scopeDisposers = []
  host.ctx.inject = (_names, callback) => callback({
    sessionController: host.ctx.sessionController,
    sessions: host.ctx.sessions,
    on: host.ctx.on.bind(host.ctx),
    effect: (fn) => scopeDisposers.push(fn()),
  })
  apply(host.ctx, {
    databasePath, clock: clock.now, tickIntervalMs: 0,
    wakeDelivery: { enabled: true, allowedSessionIds: [SESSION_A], intervalMs: 60_000 },
  })
  const life = host.provided.get('life')
  seedDue(life, clock)
  const drive = life.driveDueWakesOnce()
  await started.promise
  scopeDisposers[0]()
  gate.resolve()
  await drive
  assert.equal(host.agents.get(SESSION_A)?.followups.length ?? 0, 0)
  assert.equal(life.getHealth().delivery.state, 'degraded')
  assert.equal(life.listWakes({ status: 'executed' }).length, 0)
  host.disposers.forEach((dispose) => dispose())
})
