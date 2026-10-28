import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LifeCore } from '../src/core.js'
import { CONFIG_DEFAULTS } from '../src/config-fields.js'
import { normalizeLifeConfig } from '../src/config.js'
import { apply } from '../src/index.js'
import { WakeHost } from '../src/wake-host.js'
import { WorkspacePolicy } from '../src/workspace.js'

const A = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const C = 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const OUTSIDE = 'session-dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function registry(initial = [A, B]) {
  let sessions = [...initial]
  let archived = []
  return {
    list() {
      return [{ id: 'ws_life', title: 'Life Workspace', sessionIds: [...sessions] }]
    },
    get(id) {
      if (id !== 'ws_life') return undefined
      return { id, title: 'Life Workspace', sessionIds: [...sessions] }
    },
    get archivedSessionIds() { return [...archived] },
    set(next) { sessions = [...next] },
    setArchived(next) { archived = [...next] },
  }
}

function policyFor(core, reg, legacy = []) {
  return new WorkspacePolicy({
    store: core.store,
    core,
    v1: core.v1,
    getRegistry: () => reg,
    legacyAllowed: () => legacy,
    budgetConfig: () => ({ enabled: true, windowMs: 86_400_000, wakeLimit: 20, tokenLimit: 10_000, activityLimit: 2 }),
  })
}

test('WORKSPACE1 legacy allowlist is not widened by binding; activation is explicit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-workspace-'))
  const core = new LifeCore({ databasePath: join(dir, 'life.sqlite') })
  try {
    const reg = registry([A, B])
    const policy = policyFor(core, reg, [A, OUTSIDE])
    assert.deepEqual(policy.wakeTargets().sort(), [A, OUTSIDE])
    const binding = policy.bind({ workspaceId: 'ws_life' })
    assert.equal(binding.activated, false)
    assert.deepEqual(policy.wakeTargets(), [A], 'binding must not wake outside-workspace legacy Sessions or grant B')
    assert.throws(() => policy.activate({ acknowledgeLegacy: false }), /acknowledgement/)
    const activated = policy.activate({ acknowledgeLegacy: true })
    assert.equal(activated.activated, true)
    assert.deepEqual(policy.wakeTargets().sort(), [A, B])
    assert.equal(policy.resolve(A).mode, 'inherit')
    assert.equal(policy.resolve(B).mode, 'inherit')
  } finally {
    core.close()
  }
})

test('WORKSPACE2 late members are included, removed members/outside members are denied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-workspace-'))
  const core = new LifeCore({ databasePath: join(dir, 'life.sqlite') })
  try {
    const reg = registry([A])
    const policy = policyFor(core, reg)
    policy.bind({ workspaceId: 'ws_life' })
    policy.activate({ acknowledgeLegacy: true })
    assert.deepEqual(policy.wakeTargets(), [A])
    reg.set([A, B])
    assert.deepEqual(policy.wakeTargets().sort(), [A, B])
    assert.equal(policy.resolve(B).mode, 'inherit')
    reg.set([A])
    assert.deepEqual(policy.wakeTargets(), [A])
    assert.equal(policy.resolve(B).mode, 'outside')
    assert.throws(() => policy.setRule({ sessionId: B, mode: 'inherit' }), /current member/)
    assert.throws(() => policy.assertTool(OUTSIDE), /workspace rule|not enabled/)
  } finally {
    core.close()
  }
})

test('WORKSPACE13 late members receive identity before autonomous wake activation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-workspace-late-identity-'))
  const core = new LifeCore({ databasePath: join(dir, 'life.sqlite') })
  try {
    const reg = registry([A])
    const policy = policyFor(core, reg)
    const bound = policy.bind({ workspaceId: 'ws_life', personaName: 'Custom Life' })
    assert.equal(bound.activated, false)
    reg.set([A, B])
    assert.throws(() => core.v1.getSessionBinding(B), /not found/i)
    assert.deepEqual(policy.sessions().map((session) => session.sessionId), [A, B])
    assert.equal(core.v1.getSessionBinding(B).personaId, bound.personaId)
    assert.equal(core.store.get('SELECT name FROM personas WHERE id = ?', bound.personaId).name, 'Custom Life')
    assert.deepEqual(policy.wakeTargets(), [], 'identity must not expand wake eligibility')
    reg.set([A, B, C])
    assert.equal(policy.assertTool(C).mode, 'inherit')
    assert.equal(core.v1.getSessionBinding(C).personaId, bound.personaId)
    assert.throws(() => core.v1.getSessionBinding(OUTSIDE), /not found/i)
  } finally { core.close() }
})

test('WORKSPACE3 modes are durable and passive/disabled never receive autonomous wake', () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-workspace-'))
  const databasePath = join(dir, 'life.sqlite')
  let core = new LifeCore({ databasePath })
  let policy
  try {
    const reg = registry([A, B, C])
    policy = policyFor(core, reg)
    policy.bind({ workspaceId: 'ws_life' })
    policy.activate({ acknowledgeLegacy: true })
    policy.setRule({ sessionId: B, mode: 'passive' })
    policy.setRule({ sessionId: C, mode: 'independent', wakeLimit: 1000, tokenLimit: 50, activityLimit: 1 })
    assert.deepEqual(policy.wakeTargets().sort(), [A, C])
    assert.equal(policy.resolve(B).mode, 'passive')
    assert.equal(policy.resolve(C).mode, 'independent')
    assert.equal(policy.resolve(C).rule.wakeLimit, 20, 'independent wake limit is clamped to global')
    assert.throws(() => policy.assertActivityStart(B), /passive/)
    policy.setRule({ sessionId: C, mode: 'disabled' })
    assert.deepEqual(policy.wakeTargets(), [A])
    assert.throws(() => policy.assertTool(C), /not enabled/)
    assert.throws(() => policy.assertActivityStart(C), /not enabled/)
  } finally {
    core.close()
  }

  core = new LifeCore({ databasePath })
  try {
    const policyAfterRestart = policyFor(core, registry([A, B, C]))
    assert.equal(policyAfterRestart.resolve(B).mode, 'passive')
    assert.equal(policyAfterRestart.resolve(C).mode, 'disabled')
    assert.equal(policyAfterRestart.binding().workspaceId, 'ws_life')
  } finally {
    core.close()
  }
})

test('WORKSPACE4 binding a different workspace fails closed without overwriting identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-workspace-'))
  const core = new LifeCore({ databasePath: join(dir, 'life.sqlite') })
  try {
    const reg = registry([A])
    const policy = policyFor(core, reg)
    policy.bind({ workspaceId: 'ws_life' })
    const other = {
      list: () => [{ id: 'ws_other', title: 'Other', sessionIds: [B] }],
      get: (id) => (id === 'ws_other' ? { id, title: 'Other', sessionIds: [B] } : undefined),
    }
    const conflicting = new WorkspacePolicy({
      store: core.store,
      core,
      v1: core.v1,
      getRegistry: () => other,
      legacyAllowed: () => [],
      budgetConfig: () => ({ enabled: false, windowMs: 86_400_000, wakeLimit: 0, tokenLimit: 0, activityLimit: 0 }),
    })
    assert.throws(() => conflicting.bind({ workspaceId: 'ws_other' }), /different workspace/)
    assert.equal(policy.binding().workspaceId, 'ws_life')
  } finally {
    core.close()
  }
})

test('WORKSPACE5 Host model tools honor disabled/passive modes and outside membership', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-workspace-host-'))
  const reg = registry([A])
  const tools = new Map()
  let provided
  const ctx = {
    get: (name) => (name === 'workspaceRegistry' ? reg : undefined),
    provide: (_name, value) => { provided = value },
    tools: { register: (definition) => tools.set(definition.name, definition) },
    effect: (callback) => { callback(); return () => {} },
    logger: { info() {}, warn() {}, error() {} },
  }
  apply(ctx, {
    databasePath: join(dir, 'life.sqlite'),
    tickIntervalMs: 0,
    activityTools: { enabled: true },
  })
  const exec = { agent: { session: { id: A } } }
  try {
    provided.bindWorkspace({ workspaceId: 'ws_life' })
    provided.activateWorkspace({ acknowledgeLegacy: true })
    const created = await tools.get('life_intent_create').execute({
      description: 'workspace tool intent',
      reviewAt: '2099-01-01T00:00:00.000Z',
    }, exec)
    assert.equal(created.description, 'workspace tool intent')
    provided.setSessionRule({ sessionId: A, mode: 'passive' })
    await assert.rejects(
      tools.get('life_activity_start').execute({ description: 'must not start' }, exec),
      /passive/,
    )
    provided.setSessionRule({ sessionId: A, mode: 'disabled' })
    await assert.rejects(
      tools.get('life_intent_create').execute({ description: 'denied', reviewAt: '2099-01-01T00:00:00.000Z' }, exec),
      /not enabled/,
    )
    assert.throws(() => provided.setSessionRule({ sessionId: OUTSIDE, mode: 'inherit' }), /current member/)
  } finally {
    provided.close()
  }
})

function hostContext(reg, injections = []) {
  const tools = new Map()
  let provided
  const ctx = {
    get: (name) => (name === 'workspaceRegistry' ? reg : undefined),
    provide: (_name, value) => { provided = value },
    tools: { register: (definition) => tools.set(definition.name, definition) },
    effect: (callback) => { callback(); return () => {} },
    inject: (names, callback) => {
      injections.push({ names, callback })
      return () => {}
    },
    logger: { info() {}, warn() {}, error() {} },
  }
  return { ctx, tools, get life() { return provided } }
}

test('WORKSPACE6 fresh workspace wakes without a legacy allowlist and late members are budgeted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-workspace-fresh-'))
  const normalized = normalizeLifeConfig({
    ...CONFIG_DEFAULTS,
    wakeDeliveryEnabled: true,
    allowedSessionIds: [],
    externalMessageSessionIds: [],
  })
  assert.equal(normalized.wakeDelivery.enabled, true)
  assert.deepEqual(normalized.wakeDelivery.allowedSessionIds, [])
  const reg = registry([A])
  const host = hostContext(reg)
  apply(host.ctx, {
    ...normalized,
    databasePath: join(dir, 'life.sqlite'),
    tickIntervalMs: 0,
    wakeBudget: { enabled: true, windowMs: 60_000, wakeLimit: 5, tokenLimit: 100, activityLimit: 1 },
  })
  try {
    host.life.bindWorkspace({ workspaceId: 'ws_life' })
    host.life.activateWorkspace({ acknowledgeLegacy: true })
    host.life.getHealth()
    assert.equal(host.life.getHealth().delivery.enabled, true)
    assert.equal(host.life.getWorkspaceView().sessions[0].eligibleWake, true)
    assert.equal(host.life.getBudget('global').wakeLimit, 5)
    assert.equal(host.life.getBudget(`session:${A}`).wakeLimit, 5)
    const personaScope = `persona:${host.life.getWorkspaceView().binding.personaId}`
    assert.equal(host.life.getBudget(personaScope).wakeLimit, 5)
    const revision = host.life.getBudget('global').revision
    host.life.getHealth()
    host.life.getHealth()
    assert.equal(host.life.getBudget('global').revision, revision, 'repeated health reads must not rewrite budgets')

    reg.set([A, B])
    host.life.getHealth()
    assert.ok(host.life.getBudget('global').revision > revision, 'late member initializes budgets')
    const afterJoin = host.life.getBudget(`session:${B}`).revision
    host.life.getHealth()
    assert.equal(host.life.getBudget(`session:${B}`).revision, afterJoin)
    host.life.setSessionRule({ sessionId: B, mode: 'independent', wakeLimit: 100, tokenLimit: 100, activityLimit: 100 })
    assert.ok(host.life.getBudget(`session:${B}`).revision > afterJoin, 'rule change re-applies budgets')
    assert.equal(host.life.getBudget(`session:${B}`).wakeLimit, 5, 'independent is clamped by global')
    assert.equal(host.life.getBudget(`session:${B}`).activityLimit, 1)
  } finally {
    host.life.close()
  }
})

test('WORKSPACE7 archived members are excluded from rules/wake and outside/archived tools deny', () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-workspace-archive-'))
  const core = new LifeCore({ databasePath: join(dir, 'life.sqlite') })
  try {
    const reg = registry([A, B])
    reg.setArchived([B])
    const policy = policyFor(core, reg)
    policy.bind({ workspaceId: 'ws_life' })
    policy.activate({ acknowledgeLegacy: true })
    assert.deepEqual(policy.wakeTargets(), [A])
    assert.equal(policy.resolve(B).mode, 'archived')
    assert.equal(policy.sessions().some((session) => session.sessionId === B), false)
    assert.throws(() => policy.setRule({ sessionId: B, mode: 'inherit' }), /current member/)
    assert.throws(() => policy.assertTool(B), /not enabled/)
  } finally {
    core.close()
  }
})

test('WORKSPACE8 explicit 0, absent global limits, quiet hours, and invalid values', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-workspace-limits-'))
  const core = new LifeCore({ databasePath: join(dir, 'life.sqlite') })
  try {
    const reg = registry([A, B, C])
    const policy = policyFor(core, reg)
    policy.bind({ workspaceId: 'ws_life' })
    policy.activate({ acknowledgeLegacy: true })
    policy.setRule({ sessionId: C, mode: 'independent', wakeLimit: 0, tokenLimit: 0, activityLimit: 0, quietStartHour: 23, quietEndHour: 0 })
    assert.equal(policy.resolve(C).rule.wakeLimit, 0)
    assert.deepEqual(policy.quietHoursFor(C), [23, 0])
    assert.throws(() => policy.setRule({ sessionId: C, mode: 'independent', wakeLimit: -1 }), /wakeLimit/)
    assert.throws(() => policy.setRule({ sessionId: C, mode: 'independent', wakeLimit: Number.NaN }), /wakeLimit/)
    assert.throws(() => policy.setRule({ sessionId: C, mode: 'independent', quietStartHour: 9 }), /quiet hours/)
    assert.throws(() => policy.setRule({ sessionId: C, mode: 'independent', quietEndHour: 9 }), /quiet hours/)
    const originalYield = policy.v1.yieldActivitiesToUser
    policy.v1.yieldActivitiesToUser = async () => { throw new Error('provider pause unavailable') }
    const degraded = await policy.setRuleAsync({ sessionId: C, mode: 'passive' })
    assert.equal(degraded.mode, 'passive')
    assert.equal(degraded.activityYield.status, 'degraded')
    assert.match(degraded.activityYield.error, /provider pause unavailable/)
    policy.v1.yieldActivitiesToUser = originalYield
  } finally {
    core.close()
  }
  const unlimitedDir = mkdtempSync(join(tmpdir(), 'life-workspace-unlimited-'))
  const unlimitedCore = new LifeCore({ databasePath: join(unlimitedDir, 'life.sqlite') })
  try {
    const reg = registry([A])
    const policy = new WorkspacePolicy({
      store: unlimitedCore.store,
      core: unlimitedCore,
      v1: unlimitedCore.v1,
      getRegistry: () => reg,
      legacyAllowed: () => [],
      budgetConfig: () => ({ enabled: false, windowMs: 60_000, wakeLimit: null, tokenLimit: null, activityLimit: null }),
    })
    policy.bind({ workspaceId: 'ws_life' })
    policy.activate({ acknowledgeLegacy: true })
    policy.setRule({ sessionId: A, mode: 'independent', wakeLimit: 7 })
    assert.equal(policy.resolve(A).rule.wakeLimit, 7)
  } finally {
    unlimitedCore.close()
  }
})

test('WORKSPACE9 conflicting Persona/Scene fails binding closed and leaves no coverage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-workspace-conflict-'))
  const core = new LifeCore({ databasePath: join(dir, 'life.sqlite') })
  try {
    core.v1.bootstrapLocalIdentity({ targetSessionIds: [A], personaName: 'Different Persona' })
    const policy = policyFor(core, registry([A]))
    assert.throws(() => policy.bind({ workspaceId: 'ws_life' }), /Persona|binding|conflict/)
    assert.equal(policy.binding(), null)
  } finally {
    core.close()
  }
})

test('WORKSPACE10 delayed workspaceRegistry injection becomes available and withdraws safely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-workspace-inject-'))
  const reg = registry([A])
  const injections = []
  const host = hostContext(reg, injections)
  host.ctx.get = () => undefined
  apply(host.ctx, { databasePath: join(dir, 'life.sqlite'), tickIntervalMs: 0 })
  try {
    assert.equal(host.life.listWorkspaces().length, 0)
    const workspaceInjection = injections.find((entry) => entry.names[0] === 'workspaceRegistry')
    assert.ok(workspaceInjection)
    let cleanup
    workspaceInjection.callback({
      workspaceRegistry: reg,
      effect: (fn) => { cleanup = fn() },
    })
    assert.equal(host.life.listWorkspaces()[0].id, 'ws_life')
    cleanup()
    assert.equal(host.life.listWorkspaces().length, 0, 'withdrawn scope fails closed')
    const next = registry([B])
    let nextCleanup
    workspaceInjection.callback({ workspaceRegistry: next, effect: (fn) => { nextCleanup = fn() } })
    assert.equal(host.life.listWorkspaces()[0].sessionIds[0], B, 'rebind uses the new service generation')
    cleanup()
    assert.equal(host.life.listWorkspaces()[0].sessionIds[0], B, 'old cleanup must not clear newer service')
    nextCleanup()
    assert.equal(host.life.listWorkspaces().length, 0)
    host.life.close()
  } finally {
    try { host.life.close() } catch {}
  }
})

test('WORKSPACE12 owner passive/disabled transition awaits a real activity yield without falsifying completion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-workspace-yield-'))
  const core = new LifeCore({ databasePath: join(dir, 'life.sqlite') })
  try {
    core.v1.bootstrapLocalIdentity({ targetSessionIds: [A] })
    const activity = await core.v1.adminStartActivity({ targetSessionId: A, description: 'real local work' })
    assert.equal(activity.status, 'running')
    const policy = policyFor(core, registry([A]))
    policy.bind({ workspaceId: 'ws_life' })
    policy.activate({ acknowledgeLegacy: true })
    const result = await policy.setRuleAsync({ sessionId: A, mode: 'passive' })
    assert.equal(result.mode, 'passive')
    assert.equal(result.activityYield.status, 'ok')
    const after = core.getActivity(activity.id, { scope: `session:${A}` })
    assert.notEqual(after.status, 'completed')
    assert.notEqual(after.status, 'cancelled')
  } finally {
    core.close()
  }
})

test('WORKSPACE11 legacy allowed member keeps wake before activation; new/passive/archive denied', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-workspace-legacy-'))
  const core = new LifeCore({ databasePath: join(dir, 'life.sqlite') })
  try {
    const reg = registry([A, B])
    const policy = policyFor(core, reg, [A])
    policy.bind({ workspaceId: 'ws_life' })
    assert.deepEqual(policy.wakeTargets(), [A])
    assert.equal(policy.isDeliverable(A), true)
    assert.equal(policy.isDeliverable(B), false)
    const followups = []
    const wakeHost = new WakeHost({
      core: {
        getIntent: () => ({ status: 'active', authorizationRef: 'admin:test' }),
        recheckClaimedWake: () => ({ valid: true }),
        prepareWakeDelivery() {},
        markWakeAdmitted: () => ({ status: 'admitted' }),
      },
      ownerId: 'legacy-test',
      enabled: true,
      allowedSessionIds: [A],
      getAllowedSessionIds: () => policy.wakeTargets(),
      isSessionDeliverable: (sessionId) => policy.isDeliverable(sessionId),
      externalMessageSessionIds: [],
      intervalMs: 60_000,
      maxPerDrive: 1,
    })
    wakeHost.bound = true
    wakeHost.bindingGeneration = 1
    wakeHost.sessionController = {
      resolveAgent: async (sessionId) => ({
        agent: { session: { id: sessionId }, followup: (message) => followups.push(message) },
      }),
    }
    wakeHost.flushSession = async () => true
    const wake = {
      id: 'wake-legacy-a',
      origin: 'intent',
      targetSessionId: A,
      intentId: 'intent-legacy-a',
      intentRevision: 1,
      contextScope: `session:${A}`,
      authorizationRef: 'admin:test',
    }
    const admitted = await wakeHost.deliver(wake, wakeHost.bindingGeneration)
    assert.equal(admitted.status, 'admitted')
    assert.equal(followups.length, 1)
    policy.setRule({ sessionId: A, mode: 'passive' })
    assert.equal(policy.isDeliverable(A), false)
    assert.deepEqual(policy.wakeTargets(), [])
    policy.setRule({ sessionId: A, mode: 'inherit' })
    reg.setArchived([A])
    assert.equal(policy.isDeliverable(A), false)
    assert.deepEqual(policy.wakeTargets(), [])
    reg.setArchived([])
    reg.set([B])
    assert.equal(policy.isDeliverable(A), false)
    assert.deepEqual(policy.wakeTargets(), [])
  } finally {
    core.close()
  }
})
