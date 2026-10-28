import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { LifeCore } from '../src/core.js'
import { LocalVirtualProvider } from '../src/life-v1.js'
import { apply } from '../src/index.js'

const SESSION_A = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_B = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SCOPE_A = `session:${SESSION_A}`
const SCOPE_B = `session:${SESSION_B}`

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'amadeus-life-v1-'))
}

function makeClock(start = Date.parse('2026-10-25T00:00:00.000Z')) {
  let now = start
  return {
    now: () => now,
    advance(ms) {
      now += ms
    },
  }
}

function openCore(databasePath, clock) {
  return new LifeCore({ databasePath, clock: clock.now, maxReviewBatch: 20 })
}

function identity(core, sessionId = SESSION_A, scope = SCOPE_A) {
  const ops = core.v1 ?? core
  const persona = ops.createPersona({ name: 'Amadeus' })
  const scene = ops.createScene({ personaId: persona.id, contextScope: scope, privacy: 'private' })
  ops.bindSession({
    targetSessionId: sessionId,
    personaId: persona.id,
    sceneId: scene.id,
    principalId: 'principal-admin',
    authorizationRef: 'admin:test',
  })
  return { persona, scene }
}

function fakeHost() {
  const listeners = []
  const agents = new Map()
  const tools = new Map()
  const sessions = {
    flush: async () => true,
  }
  const sessionController = {
    resolveAgent: async (sessionId) => {
      let entry = agents.get(sessionId)
      if (entry === undefined) {
        const session = { id: sessionId }
        entry = {
          session,
          followups: [],
          agent: {
            session,
            followup(message) {
              entry.followups.push(message)
            },
          },
        }
        agents.set(sessionId, entry)
      }
      return { agent: entry.agent }
    },
  }
  const ctx = {
    logger: { error() {}, warn() {}, info() {} },
    get(name) {
      if (name === 'sessionController') return sessionController
      if (name === 'sessions') return sessions
      return undefined
    },
    on(name, handler) {
      if (name === 'session/event') listeners.push(handler)
      return () => {
        const index = listeners.indexOf(handler)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    provide(name, value) {
      this.provided.set(name, value)
    },
    effect() {},
    tools: { register(definition) { tools.set(definition.name, definition) } },
    provided: new Map(),
  }
  return {
    ctx,
    agents,
    listeners,
    tools,
    emit(sessionId, event) {
      for (const listener of [...listeners]) listener({ id: sessionId }, event)
    },
  }
}

test('E1 v6 schema and identity isolation with revocation invalidation', async () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    assert.equal(core.getHealth().schemaVersion, '10')
    const db = new DatabaseSync(core.databasePath)
    try {
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name))
      for (const table of ['personas', 'scenes', 'scene_shares', 'session_bindings', 'idle_state', 'budget_scopes', 'usage_events', 'cost_reservations']) {
        assert.ok(tables.has(table), table)
      }
      const wakeColumns = db.prepare("PRAGMA table_info('wake_requests')").all().map((row) => row.name)
      for (const column of ['origin', 'idle_key', 'persona_id', 'scene_id']) assert.ok(wakeColumns.includes(column))
    } finally {
      db.close()
    }

    const persona = core.v1.createPersona({ name: 'Amadeus' })
    const privateScene = core.v1.createScene({ personaId: persona.id, contextScope: SCOPE_A, privacy: 'private' })
    const sharedScene = core.v1.createScene({ personaId: persona.id, contextScope: SCOPE_A, privacy: 'shared' })
    assert.equal(core.v1.sceneVisibleTo({ sceneId: privateScene.id, dataScope: SCOPE_A }), true)
    assert.equal(core.v1.sceneVisibleTo({ sceneId: privateScene.id, dataScope: SCOPE_B }), false)
    assert.equal(core.v1.sceneVisibleTo({ sceneId: sharedScene.id, dataScope: SCOPE_B }), false)
    core.v1.grantSceneShare({ sceneId: sharedScene.id, dataScope: SCOPE_B })
    assert.equal(core.v1.sceneVisibleTo({ sceneId: sharedScene.id, dataScope: SCOPE_B }), true)
    assert.throws(
      () => core.v1.grantSceneShare({ sceneId: privateScene.id, dataScope: SCOPE_B }),
      /private scenes cannot be shared/,
    )

    core.v1.bindSession({
      targetSessionId: SESSION_A,
      personaId: persona.id,
      sceneId: privateScene.id,
      principalId: 'principal-admin',
      authorizationRef: 'admin:test',
    })
    assert.equal(core.v1.getSessionBinding(SESSION_A).active, true)
    const activity = await core.v1.startActivity({
      description: 'revoked-scope activity',
      ownerScope: SCOPE_A,
      personaId: persona.id,
      sceneId: privateScene.id,
    })
    assert.equal(activity.status, 'running')
    const idle = core.allocateIdleWake({
      targetSessionId: SESSION_A, windowMs: 60_000, quietAfterActivityMs: 0, now: new Date(clock.now()).toISOString(),
    })
    assert.equal(idle.created, true)
    core.v1.revokeSessionBinding({ targetSessionId: SESSION_A })
    assert.equal(core.v1.getSessionBinding(SESSION_A).active, false)
    assert.equal(core.getWake(idle.wake.id).status, 'superseded')
    assert.equal(core.getActivity(activity.id, { scope: SCOPE_A }).status, 'unknown')
  } finally {
    core.close()
  }
})

test('E2 idle wake is quiet, frequency-bounded, and delivered without user input', async () => {
  const clock = makeClock()
  const dir = tempDir()
  const host = fakeHost()
  apply(host.ctx, {
    databasePath: join(dir, 'life.sqlite'),
    clock: clock.now,
    tickIntervalMs: 0,
    wakeDelivery: { enabled: true, allowedSessionIds: [SESSION_A], intervalMs: 60_000 },
    idle: {
      enabled: true,
      targetSessionId: SESSION_A,
      windowMs: 60_000,
      quietAfterActivityMs: 5_000,
    },
  })
  const life = host.ctx.provided.get('life')
  identity(life, SESSION_A, SCOPE_A)
  life.noteSessionActivity({ targetSessionId: SESSION_A, at: new Date(clock.now()).toISOString() })
  clock.advance(5_001)

  const first = await life.driveDueWakesOnce()
  assert.equal(first.status, 'ok', JSON.stringify(first))
  assert.equal(first.delivered.length, 1)
  assert.equal(first.delivered[0].status, 'admitted', JSON.stringify(first))
  const followup = host.agents.get(SESSION_A).followups[0]
  assert.match(followup.content[0].text, /Life idle opportunity/)
  const idleWakes = life.listWakes().filter((wake) => wake.origin === 'idle')
  assert.equal(idleWakes.length, 1)
  assert.equal(idleWakes[0].status, 'admitted')

  // No model wake again in the same window, even on another drive.
  await life.driveDueWakesOnce()
  assert.equal(host.agents.get(SESSION_A).followups.length, 1)

  host.emit(SESSION_A, { type: 'turn/start', seq: 10, data: { turn: 2 } })
  host.emit(SESSION_A, {
    type: 'user/message',
    seq: 11,
    data: { id: followup.id, role: 'user', content: followup.content, source: followup.source },
  })
  host.emit(SESSION_A, { type: 'turn/end', seq: 20, data: { turn: 2, reason: { kind: 'completed' } } })
  assert.equal(life.getWake(idleWakes[0].id).status, 'executed')
})

test('E3 local virtual Provider completes the trusted lifecycle and crash path', async () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const provider = new LocalVirtualProvider({ clock: clock.now })
    core.v1.registerActivityProvider(provider)
    const started = await core.v1.startActivity({
      description: 'prepare a local draft',
      ownerScope: SCOPE_A,
      providerId: 'local-virtual',
      priority: 5,
      resourceLease: 'lease:local',
    })
    assert.equal(started.status, 'running')
    assert.deepEqual(started.evidenceRefs, [`local:start:${started.id}`])
    assert.equal(started.priority, 5)
    assert.equal(started.resourceLease, 'lease:local')

    const paused = await core.v1.operateActivity('pause', started.id, SCOPE_A)
    assert.equal(paused.status, 'paused')
    const resumed = await core.v1.operateActivity('resume', started.id, SCOPE_A)
    assert.equal(resumed.status, 'running')
    const checkpointed = await core.v1.operateActivity('checkpoint', started.id, SCOPE_A)
    assert.match(checkpointed.checkpointRef, /^local:checkpoint:/)
    const cancelled = await core.v1.operateActivity('cancel', started.id, SCOPE_A)
    assert.equal(cancelled.status, 'cancelled')
    assert.ok(cancelled.evidenceRefs.includes(`local:cancel:${started.id}`))

    provider.simulateCrash()
    const crashed = await core.v1.startActivity({ description: 'crash', ownerScope: SCOPE_A })
    assert.equal(crashed.status, 'unknown')
    assert.equal(crashed.executedAt, undefined)
    const reconciled = await core.v1.operateActivity('reconcile', crashed.id, SCOPE_A)
    assert.equal(reconciled.status, 'unknown')
  } finally {
    core.close()
  }
})

test('E4 unified budget defers autonomous work without blocking normal intent creation', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    core.v1.configureBudget({ scope: SCOPE_A, windowMs: 60_000, wakeLimit: 1, tokenLimit: 10 })
    const firstReservation = core.consumeWakeBudget({ scope: SCOPE_A, estimatedTokens: 4 })
    assert.equal(firstReservation.allowed, true)
    assert.ok(firstReservation.reservationId)
    assert.equal(core.consumeWakeBudget({ scope: SCOPE_A, estimatedTokens: 1 }).allowed, false)
    assert.equal(core.v1.getBudget(SCOPE_A).wakeCalls, 1)
    assert.equal(core.v1.getBudget(SCOPE_A).tokensUsed, 0)
    assert.equal(core.v1.getBudget(SCOPE_A).tokensReserved, 4)
    assert.equal(core.v1.recordTokenUsage({ scope: SCOPE_A, tokens: 2 }).tokensUsed, 2)
    const intent = core.createIntent({
      description: 'ordinary user intent',
      contextScope: SCOPE_A,
      authorizationRef: 'life-tool:session',
      reviewAt: new Date(clock.now() + 60_000).toISOString(),
    })
    assert.equal(intent.status, 'active')
    clock.advance(60_001)
    assert.equal(core.consumeWakeBudget({ scope: SCOPE_A, estimatedTokens: 1 }).allowed, true)
  } finally {
    core.close()
  }
})

test('E6 host budget exhaustion defers autonomous wake without blocking chat', async () => {
  const clock = makeClock()
  const dir = tempDir()
  const host = fakeHost()
  apply(host.ctx, {
    databasePath: join(dir, 'life.sqlite'),
    clock: clock.now,
    tickIntervalMs: 0,
    wakeDelivery: { enabled: true, allowedSessionIds: [SESSION_A], intervalMs: 60_000 },
    wakeBudget: { enabled: true, wakeLimit: 1, windowMs: 60_000 },
  })
  const life = host.ctx.provided.get('life')
  for (const description of ['first due', 'second due']) {
    life.createIntent({
      description,
      contextScope: SCOPE_A,
      authorizationRef: `life-tool:${SCOPE_A}`,
      reviewAt: new Date(clock.now() - 1000).toISOString(),
    })
  }
  const first = await life.driveDueWakesOnce()
  assert.equal(first.status, 'ok')
  assert.equal(first.delivered.length, 1)
  assert.equal(host.agents.get(SESSION_A).followups.length, 1)
  const firstMessage = host.agents.get(SESSION_A).followups[0]
  host.emit(SESSION_A, { type: 'turn/start', seq: 10, data: { turn: 2 } })
  host.emit(SESSION_A, {
    type: 'user/message',
    seq: 11,
    data: { id: firstMessage.id, role: 'user', content: firstMessage.content, source: firstMessage.source },
  })
  host.emit(SESSION_A, { type: 'turn/end', seq: 20, data: { turn: 2, reason: { kind: 'completed' } } })
  assert.equal(life.listWakes().some((wake) => wake.status === 'executed'), true)
  clock.advance(1000)
  const second = await life.driveDueWakesOnce()
  assert.equal(second.delivered.length, 0)
  assert.equal(host.agents.get(SESSION_A).followups.length, 1)
  assert.match(life.getHealth().delivery.budget.lastError, /budget deferred/)
  const pending = life.listWakes().filter((wake) => wake.status === 'pending')
  assert.equal(pending.length, 1)
  assert.match(pending[0].lastError, /budget deferred/)
  // Ordinary intent creation still works while autonomous delivery is deferred.
  assert.equal(
    life.createIntent({
      description: 'ordinary chat intent',
      contextScope: SCOPE_A,
      authorizationRef: `life-tool:${SCOPE_A}`,
      reviewAt: new Date(clock.now() + 60_000).toISOString(),
    }).status,
    'active',
  )
})

test('E7 enabled activity tools derive identity and run the Provider lifecycle', async () => {
  const clock = makeClock()
  const host = fakeHost()
  apply(host.ctx, {
    databasePath: join(tempDir(), 'life.sqlite'),
    clock: clock.now,
    tickIntervalMs: 0,
    wakeDelivery: { enabled: true, allowedSessionIds: [SESSION_A], intervalMs: 60_000 },
    activityTools: { enabled: true },
    sharedRead: { enabled: true },
  })
  const life = host.ctx.provided.get('life')
  identity(life)
  assert.equal(host.tools.size, 16)
  const exec = { agent: { session: { id: SESSION_A } } }
  const start = await host.tools.get('life_activity_start').execute(
    { description: 'model chooses a local activity', priority: 4, resource: 'tool-resource' },
    exec,
  )
  assert.equal(start.status, 'running')
  assert.ok(start.personaId)
  assert.ok(start.sceneId)
  life.configureBudget({ scope: SCOPE_A, windowMs: 60_000, activityLimit: 1 })
  await assert.rejects(
    () => host.tools.get('life_activity_start').execute({ description: 'model over limit' }, exec),
    /activity concurrency limit/,
  )
  const status = await host.tools.get('life_activity_status').execute({ id: start.id }, exec)
  assert.equal(status.providerStatus, 'running')
  assert.equal((await host.tools.get('life_activity_pause').execute({ id: start.id }, exec)).status, 'paused')
  assert.equal((await host.tools.get('life_activity_resume').execute({ id: start.id }, exec)).status, 'running')
  const finished = await host.tools.get('life_activity_finish').execute({ id: start.id, outcome: 'completed' }, exec)
  assert.equal(finished.status, 'completed')
  assert.ok(finished.evidenceRefs.includes(`local:complete:${start.id}`))
  await assert.rejects(
    () => host.tools.get('life_activity_finish').execute({ id: start.id, outcome: 'completed', evidenceRefs: ['forged'] }, exec),
    /unexpected argument/i,
  )
  const cancellable = await host.tools.get('life_activity_start').execute(
    { description: 'cancellable local activity' },
    exec,
  )
  assert.equal((await host.tools.get('life_activity_cancel').execute({ id: cancellable.id }, exec)).status, 'cancelled')
  assert.ok((await host.tools.get('life_shared_read').execute({}, exec)).scenes.length >= 1)

  await assert.rejects(
    () => host.tools.get('life_activity_start').execute({ description: 'x', scope: SCOPE_B }, exec),
    /reserved/i,
  )
  await assert.rejects(
    () => host.tools.get('life_activity_start').execute({ description: 'x', providerId: 'external' }, exec),
    /unexpected argument/i,
  )
  await assert.rejects(
    () => host.tools.get('life_activity_start').execute(
      { description: 'x' },
      { agent: { session: { id: SESSION_B } } },
    ),
    /binding/i,
  )
})

test('E8 resource lease is atomically exclusive and released on terminal state', async () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const first = await core.v1.startActivity({
      description: 'first holder',
      ownerScope: SCOPE_A,
      resourceLease: 'shared-resource',
    })
    await assert.rejects(
      () => core.v1.startActivity({
        description: 'second contender',
        ownerScope: SCOPE_A,
        resourceLease: 'shared-resource',
      }),
      /resource lease is already held/,
    )
    await core.v1.operateActivity('cancel', first.id, SCOPE_A)
    const third = await core.v1.startActivity({
      description: 'after release',
      ownerScope: SCOPE_A,
      resourceLease: 'shared-resource',
    })
    assert.equal(third.status, 'running')
    await core.v1.operateActivity('cancel', third.id, SCOPE_A)
  } finally {
    core.close()
  }
})

test('E12 Provider start refuses missing and foreign-scope intent links', async () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const foreign = core.createIntent({
      description: 'private B plan',
      reviewAt: '2026-10-26T00:00:00.000Z',
      contextScope: SCOPE_B,
      authorizationRef: `life-tool:${SCOPE_B}`,
    })
    for (const intentId of ['missing-intent', foreign.id]) {
      await assert.rejects(
        () => core.v1.startActivity({ description: 'linked activity', ownerScope: SCOPE_A, intentId }),
        /intent|scope|unauthorized/i,
      )
    }
    assert.equal(core.listActivities({ scope: SCOPE_A }).length, 0)
  } finally {
    core.close()
  }
})

test('E13 permission revocation during Provider start cannot leave activity running', async () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const { persona, scene } = identity(core)
    let releaseStart
    let started
    const entered = new Promise((resolve) => { started = resolve })
    const gate = new Promise((resolve) => { releaseStart = resolve })
    core.v1.registerActivityProvider({
      id: 'delayed-local',
      describe: () => ({ providerId: 'delayed-local', external: false }),
      start: async () => { started(); await gate; return { status: 'running', evidenceRefs: ['delayed:start'] } },
      status: () => ({ status: 'running' }),
      cancel: () => ({ status: 'cancelled', evidenceRefs: ['delayed:cancel'] }),
    })
    const operation = core.v1.startActivity({
      description: 'pending during revocation', ownerScope: SCOPE_A,
      providerId: 'delayed-local', personaId: persona.id, sceneId: scene.id,
    })
    await entered
    core.v1.revokeSessionBinding({ targetSessionId: SESSION_A })
    releaseStart()
    const result = await operation
    assert.notEqual(result.status, 'running')
  } finally {
    core.close()
  }
})

test('E14 late Provider completion after revocation cannot complete the activity', async () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const { persona, scene } = identity(core)
    let releaseComplete
    let entered
    const started = new Promise((resolve) => { entered = resolve })
    const gate = new Promise((resolve) => { releaseComplete = resolve })
    core.v1.registerActivityProvider({
      id: 'delayed-complete',
      describe: () => ({ providerId: 'delayed-complete', external: false }),
      start: () => ({ status: 'running', evidenceRefs: ['delayed:start'] }),
      status: () => ({ status: 'running' }),
      cancel: () => ({ status: 'cancelled' }),
      complete: async () => {
        entered()
        await gate
        return { status: 'completed', evidenceRefs: ['delayed:late-complete'] }
      },
    })
    const activity = await core.v1.startActivity({
      description: 'revoked while finishing', ownerScope: SCOPE_A,
      providerId: 'delayed-complete', personaId: persona.id, sceneId: scene.id,
      resourceLease: 'revoked-resource',
    })
    const finishing = core.v1.finishActivity(activity.id, SCOPE_A, 'completed')
    await started
    core.v1.revokeSessionBinding({ targetSessionId: SESSION_A })
    releaseComplete()
    const result = await finishing
    assert.notEqual(result.status, 'completed')
    assert.equal(result.status, 'unknown')
    assert.equal(result.resourceLease, 'revoked-resource')
    assert.equal(result.evidenceRefs.includes('delayed:late-complete'), false)
    const status = await core.v1.getActivityStatus(activity.id, SCOPE_A)
    assert.equal(status.revoked, true)
    assert.equal(status.activity.status, 'unknown')
  } finally {
    core.close()
  }
})

test('E9 real Session user event pauses and checkpoints a long activity', async () => {
  const clock = makeClock()
  const host = fakeHost()
  apply(host.ctx, {
    databasePath: join(tempDir(), 'life.sqlite'),
    clock: clock.now,
    tickIntervalMs: 0,
    wakeDelivery: { enabled: true, allowedSessionIds: [SESSION_A], intervalMs: 60_000 },
    activityTools: { enabled: true },
  })
  const life = host.ctx.provided.get('life')
  identity(life)
  const binding = life.getSessionBinding(SESSION_A)
  const activity = await life.startActivity({
    description: 'long local activity',
    ownerScope: SCOPE_A,
    providerId: 'local-virtual',
    personaId: binding.personaId,
    sceneId: binding.sceneId,
    resourceLease: 'attention-resource',
  })
  host.emit(SESSION_A, {
    type: 'user/message',
    seq: 1,
    data: { id: 'real-user', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
  })
  await new Promise((resolve) => setImmediate(resolve))
  const paused = life.getActivity(activity.id, { scope: SCOPE_A })
  assert.equal(paused.status, 'paused')
  assert.match(paused.checkpointRef, /checkpoint/)
  assert.equal(paused.resourceLease, 'attention-resource')
  await assert.rejects(
    () => life.startActivity({ description: 'lease contender', ownerScope: SCOPE_A, resourceLease: 'attention-resource' }),
    /resource lease is already held/,
  )
  assert.equal((await life.resumeActivity(activity.id, SCOPE_A)).status, 'running')
  assert.equal((await life.cancelActivity(activity.id, SCOPE_A)).status, 'cancelled')
})

test('E9b Provider without pause leaves a conservative unknown activity and holds its lease', async () => {
  const clock = makeClock()
  const host = fakeHost()
  apply(host.ctx, {
    databasePath: join(tempDir(), 'life.sqlite'),
    clock: clock.now,
    tickIntervalMs: 0,
    wakeDelivery: { enabled: true, allowedSessionIds: [SESSION_A], intervalMs: 60_000 },
  })
  const life = host.ctx.provided.get('life')
  const provider = {
    describe: () => ({ providerId: 'no-pause', version: 1 }),
    start: () => ({ status: 'running', evidenceRefs: ['no-pause:start'] }),
    status: () => ({ status: 'running', evidenceRefs: ['no-pause:status'] }),
    cancel: () => ({ status: 'cancelled', evidenceRefs: ['no-pause:cancel'] }),
  }
  life.registerActivityProvider(provider)
  const activity = await life.startActivity({
    description: 'provider without pause',
    ownerScope: SCOPE_A,
    providerId: 'no-pause',
    resourceLease: 'no-pause-resource',
  })
  host.emit(SESSION_A, {
    type: 'user/message',
    seq: 1,
    data: { id: 'real-user-2', role: 'user', content: [], source: { kind: 'user' } },
  })
  await new Promise((resolve) => setImmediate(resolve))
  const after = life.getActivity(activity.id, { scope: SCOPE_A })
  assert.equal(after.status, 'unknown')
  assert.equal(after.resourceLease, 'no-pause-resource')
  await assert.rejects(
    () => life.startActivity({ description: 'lease contender', ownerScope: SCOPE_A, resourceLease: 'no-pause-resource' }),
    /resource lease is already held/,
  )
  assert.equal((await life.cancelActivity(activity.id, SCOPE_A)).status, 'cancelled')
})

test('E10 shared view is binding-derived, two-authorized-scene safe, and third Session denied', async () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    const persona = core.v1.createPersona({ name: 'Amadeus' })
    const sharedA = core.v1.createScene({ personaId: persona.id, contextScope: SCOPE_A, privacy: 'shared' })
    const privateB = core.v1.createScene({ personaId: persona.id, contextScope: SCOPE_B, privacy: 'private' })
    core.v1.bindSession({ targetSessionId: SESSION_A, personaId: persona.id, sceneId: sharedA.id, principalId: 'p-a', authorizationRef: 'admin:a' })
    core.v1.bindSession({ targetSessionId: SESSION_B, personaId: persona.id, sceneId: privateB.id, principalId: 'p-b', authorizationRef: 'admin:b' })
    core.v1.grantSceneShare({ sceneId: sharedA.id, dataScope: SCOPE_B })
    const sharedActivity = await core.v1.startActivity({
      description: 'shared description for B',
      ownerScope: SCOPE_A,
      personaId: persona.id,
      sceneId: sharedA.id,
    })
    const ownA = core.v1.getSharedLifeView({ targetSessionId: SESSION_A })
    assert.equal(ownA.scenes.find((scene) => scene.id === sharedA.id).owner, true)
    assert.match(
      JSON.stringify(ownA.scenes.find((scene) => scene.id === sharedA.id).activities),
      /shared description for B/,
    )
    const viewB = core.v1.getSharedLifeView({ targetSessionId: SESSION_B })
    const cross = viewB.scenes.find((scene) => scene.id === sharedA.id)
    assert.ok(cross)
    assert.equal(cross.owner, false)
    const sharedRecord = cross.activities.find((record) => record.id === sharedActivity.id)
    assert.ok(sharedRecord)
    assert.equal(sharedRecord.description, undefined)
    assert.equal(viewB.scenes.some((scene) => scene.id === sharedA.id && scene.description !== undefined), false)
    assert.equal(JSON.stringify(viewB).includes('authorizationRef'), false)
    assert.equal(JSON.stringify(viewB).includes('principal'), false)
    assert.equal(core.v1.getSharedLifeView({ targetSessionId: SESSION_A }).scenes.some((scene) => scene.id === privateB.id), false)
    assert.throws(
      () => core.v1.getSharedLifeView({ targetSessionId: 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
      /active Session binding/,
    )
    core.v1.revokeSessionBinding({ targetSessionId: SESSION_B })
    assert.throws(() => core.v1.getSharedLifeView({ targetSessionId: SESSION_B }), /active Session binding/)
  } finally {
    core.close()
  }
})

test('E11 autonomous turn token usage is idempotently accounted from assistant/message', async () => {
  const clock = makeClock()
  const host = fakeHost()
  apply(host.ctx, {
    databasePath: join(tempDir(), 'life.sqlite'),
    clock: clock.now,
    tickIntervalMs: 0,
    wakeDelivery: { enabled: true, allowedSessionIds: [SESSION_A], intervalMs: 60_000 },
    wakeBudget: { enabled: true, wakeLimit: 10, tokenLimit: 100, windowMs: 60_000 },
  })
  const life = host.ctx.provided.get('life')
  life.createIntent({
    description: 'due autonomous turn',
    contextScope: SCOPE_A,
    authorizationRef: `life-tool:${SCOPE_A}`,
    reviewAt: new Date(clock.now() - 1000).toISOString(),
  })
  await life.driveDueWakesOnce()
  const message = host.agents.get(SESSION_A).followups[0]
  host.emit(SESSION_A, { type: 'turn/start', seq: 10, data: { turn: 2 } })
  host.emit(SESSION_A, {
    type: 'user/message',
    seq: 11,
    data: { id: message.id, role: 'user', content: message.content, source: message.source },
  })
  const usageEvent = {
    type: 'assistant/message',
    seq: 12,
    data: { turn: 2, usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } },
  }
  host.emit(SESSION_A, usageEvent)
  host.emit(SESSION_A, usageEvent)
  host.emit(SESSION_A, { type: 'turn/end', seq: 20, data: { turn: 2, reason: { kind: 'completed' } } })
  assert.equal(life.getHealth().delivery.usage.status, 'recorded')
  assert.equal(life.getBudget(SCOPE_A).tokensUsed, 7)
  assert.equal(life.listWakes().some((wake) => wake.status === 'executed'), true)
  assert.equal(life.getBudget(SCOPE_A).wakeCalls, 1)
  // Duplicate seq is idempotent, not double-counted.
  life.recordSessionUsage({ targetSessionId: SESSION_A, seq: 12, usage: { totalTokens: 7 } })
  assert.equal(life.getBudget(SCOPE_A).tokensUsed, 7)
})

test('E5 idle allocation respects quiet activity and one-window frequency', () => {
  const clock = makeClock()
  const core = openCore(join(tempDir(), 'life.sqlite'), clock)
  try {
    identity(core)
    const now = clock.now()
    core.noteSessionActivity({ targetSessionId: SESSION_A, at: new Date(now).toISOString() })
    assert.equal(
      core.allocateIdleWake({ targetSessionId: SESSION_A, windowMs: 60_000, quietAfterActivityMs: 10_000, now: new Date(now).toISOString() }).reason,
      'recent_activity',
    )
    clock.advance(10_001)
    const created = core.allocateIdleWake({ targetSessionId: SESSION_A, windowMs: 60_000, quietAfterActivityMs: 10_000, now: new Date(clock.now()).toISOString() })
    assert.equal(created.created, true)
    assert.equal(created.wake.origin, 'idle')
    const duplicate = core.allocateIdleWake({ targetSessionId: SESSION_A, windowMs: 60_000, quietAfterActivityMs: 0, now: new Date(clock.now()).toISOString() })
    assert.equal(duplicate.created, false)
    assert.ok(['unreconciled_wake', 'frequency_budget'].includes(duplicate.reason))
  } finally {
    core.close()
  }
})
