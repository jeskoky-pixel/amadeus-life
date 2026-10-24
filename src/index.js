/**
 * Cordis Host adapter for Amadeus Life.
 *
 * Minimal, dependency-free real plugin surface:
 * - `ctx.provide('life', api)` exposes the Life Service semantics.
 * - `ctx.tools.register(...)` exposes model-facing tools whose caller scope is
 *   derived from the live tool execution context, never from model arguments.
 * - one lifecycle-owned bounded tick (injected clock in the core) emits local
 *   `life/reconsideration` events; it never calls a model or sends anything.
 * - `ctx.effect(...)` clears the timer and closes SQLite on disposal.
 *
 * No import resolves outside Node builtins and this package, so the bundle has
 * no dependency graph and does not read another plugin's internals.
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { LifeCore } from './core.js'
import { WakeHost } from './wake-host.js'
import {
  LIFE_SCHEMA_VERSION,
  LifeError,
  LifeStorageError,
  LifeUnauthorizedError,
  LifeValidationError,
  assertInteger,
  isDshSessionScope,
  requireString,
} from './model.js'

/** Cordis plugin name. */
export const name = 'amadeus-life'

/** Host services required by the adapter. */
export const inject = ['tools']

const SCOPE_PREFIX = 'session:'
const UNCONSTRAINED_OBJECT = Object.freeze({ type: 'object', additionalProperties: true })
const RESERVED_ARGS = new Set([
  'scope',
  'trustedEvidence',
  'authorizationRef',
  'ownerScope',
  'contextScope',
  'personaId',
  'sceneId',
  'principalId',
])
const DEFAULT_WAKE_INTERVAL_MS = 60_000

/**
 * Validate the administrator-only wake delivery configuration. Defaults to
 * disabled; a model or peer can never change it at runtime.
 * @param {unknown} raw - row config value.
 * @returns {{enabled: boolean, allowedSessionIds: string[], intervalMs: number, maxPerDrive: number}} config.
 */
function parseWakeDelivery(raw) {
  if (raw === undefined) {
    return { enabled: false, allowedSessionIds: [], intervalMs: DEFAULT_WAKE_INTERVAL_MS, maxPerDrive: 1 }
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new LifeValidationError('wakeDelivery must be an object')
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new LifeValidationError('wakeDelivery.enabled must be a boolean')
  }
  if (raw.allowedSessionIds !== undefined && !Array.isArray(raw.allowedSessionIds)) {
    throw new LifeValidationError('wakeDelivery.allowedSessionIds must be an array')
  }
  const allowedSessionIds = []
  for (const entry of raw.allowedSessionIds ?? []) {
    const value = requireString(entry, 'wakeDelivery.allowedSessionIds[]', 200)
    if (!isDshSessionScope(`${SCOPE_PREFIX}${value}`)) {
      throw new LifeValidationError('wakeDelivery.allowedSessionIds entries must be DSH session ids')
    }
    if (!allowedSessionIds.includes(value)) allowedSessionIds.push(value)
  }
  if (allowedSessionIds.length > 100) {
    throw new LifeValidationError('wakeDelivery.allowedSessionIds accepts at most 100 entries')
  }
  const intervalMs =
    raw.intervalMs === undefined
      ? DEFAULT_WAKE_INTERVAL_MS
      : assertInteger(raw.intervalMs, 'wakeDelivery.intervalMs', { min: 1000, max: 600_000 })
  const maxPerDrive =
    raw.maxPerDrive === undefined
      ? 1
      : assertInteger(raw.maxPerDrive, 'wakeDelivery.maxPerDrive', { min: 1, max: 5 })
  return { enabled: raw.enabled === true, allowedSessionIds, intervalMs, maxPerDrive }
}

function parseIdle(raw, allowedSessionIds) {
  if (raw === undefined) return { enabled: false }
  if (typeof raw !== 'object' || raw === null) throw new LifeValidationError('idle must be an object')
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new LifeValidationError('idle.enabled must be a boolean')
  }
  const enabled = raw.enabled === true
  if (!enabled) return { enabled: false }
  const targetSessionId = requireString(raw.targetSessionId, 'idle.targetSessionId', 200)
  if (!allowedSessionIds.includes(targetSessionId)) {
    throw new LifeValidationError('idle.targetSessionId must be in wakeDelivery.allowedSessionIds')
  }
  const windowMs = raw.windowMs === undefined
    ? 30 * 60_000
    : assertInteger(raw.windowMs, 'idle.windowMs', { min: 1000, max: 86_400_000 })
  const quietAfterActivityMs = raw.quietAfterActivityMs === undefined
    ? 5 * 60_000
    : assertInteger(raw.quietAfterActivityMs, 'idle.quietAfterActivityMs', { min: 0, max: 86_400_000 })
  const quietStartHour = raw.quietStartHour === undefined
    ? undefined
    : assertInteger(raw.quietStartHour, 'idle.quietStartHour', { min: 0, max: 23 })
  const quietEndHour = raw.quietEndHour === undefined
    ? undefined
    : assertInteger(raw.quietEndHour, 'idle.quietEndHour', { min: 0, max: 23 })
  return { enabled: true, targetSessionId, windowMs, quietAfterActivityMs, quietStartHour, quietEndHour }
}

function parseFeature(raw, name) {
  if (raw === undefined) return { enabled: false }
  if (typeof raw !== 'object' || raw === null) throw new LifeValidationError(`${name} must be an object`)
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new LifeValidationError(`${name}.enabled must be a boolean`)
  }
  return { enabled: raw.enabled === true }
}

function parseWakeBudget(raw) {
  if (raw === undefined) return { enabled: false, estimatedTokens: 0 }
  if (typeof raw !== 'object' || raw === null) throw new LifeValidationError('wakeBudget must be an object')
  const enabled = raw.enabled === true
  const windowMs = raw.windowMs === undefined
    ? 86_400_000
    : assertInteger(raw.windowMs, 'wakeBudget.windowMs', { min: 1000, max: 86_400_000 * 30 })
  const wakeLimit = raw.wakeLimit === undefined
    ? 100
    : assertInteger(raw.wakeLimit, 'wakeBudget.wakeLimit', { min: 0 })
  const tokenLimit = raw.tokenLimit === undefined
    ? null
    : assertInteger(raw.tokenLimit, 'wakeBudget.tokenLimit', { min: 0 })
  const costLimit = raw.costLimit === undefined
    ? null
    : assertInteger(raw.costLimit, 'wakeBudget.costLimit', { min: 0 })
  const estimatedTokens = raw.estimatedTokens === undefined
    ? 0
    : assertInteger(raw.estimatedTokens, 'wakeBudget.estimatedTokens', { min: 0 })
  const activityLimit = raw.activityLimit === undefined
    ? null
    : assertInteger(raw.activityLimit, 'wakeBudget.activityLimit', { min: 0 })
  return { enabled, windowMs, wakeLimit, tokenLimit, costLimit, activityLimit, estimatedTokens }
}

/**
 * Read an optional Host service without turning absence into a plugin failure.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} name - service name.
 * @returns {Record<string, unknown> | undefined} service or undefined.
 */
function optionalService(ctx, name) {
  try {
    if (typeof ctx.get === 'function') return ctx.get(name) ?? undefined
    return ctx[name] ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the default durable data path. The isolated Desktop sets DSH_HOME;
 * no workspace file is touched by default.
 * @returns {string} absolute SQLite path.
 */
function defaultDatabasePath() {
  const base = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(base, 'amadeus-life', 'life.sqlite')
}

/**
 * Derive the trusted caller scope from the live tool execution context.
 * Model-supplied strings never participate in this decision.
 * @param {{agent?: {session?: {id?: unknown}}}} exec - tool execution context.
 * @returns {string} scope string.
 */
function sessionScope(exec) {
  const sessionId = exec?.agent?.session?.id
  if (sessionId === undefined || sessionId === null || String(sessionId).length === 0) {
    throw new LifeUnauthorizedError('Life tools require an agent Session')
  }
  return `${SCOPE_PREFIX}${String(sessionId)}`
}

/**
 * Register one plain tool definition. The registry projects `parameters`
 * directly onto the model-facing schema and requires `output.schema` + render.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, unknown>} definition - tool definition.
 */
function registerTool(ctx, definition) {
  const allowed = new Set(Object.keys(definition.parameters?.properties ?? {}))
  const guardedExecute = definition.execute
  ctx.tools.register({
    ...definition,
    // DSH raw tools.register does not enforce JSON Schema (only defineTool adds
    // argument validation), so the adapter enforces the boundary itself.
    execute: async (args, exec) => {
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('LIFE_VALIDATION: tool arguments must be a plain object')
      }
      for (const key of Object.keys(args)) {
        if (RESERVED_ARGS.has(key)) {
          throw new Error(`LIFE_VALIDATION: argument "${key}" is reserved and derived from the session`)
        }
        if (!allowed.has(key)) {
          throw new Error(`LIFE_VALIDATION: unexpected argument "${key}"`)
        }
      }
      return guardedExecute(args, exec)
    },
    output: {
      schema: UNCONSTRAINED_OBJECT,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
  })
}

/**
 * Wrap a tool body so explicit Life failures surface as readable tool errors
 * without hiding the stable code.
 * @param {(args: Record<string, unknown>, exec: unknown) => Promise<unknown> | unknown} handler - body.
 * @returns {(args: Record<string, unknown>, exec: unknown) => Promise<unknown>} wrapped body.
 */
function toolBody(handler) {
  return async (args, exec) => {
    try {
      return await handler(args ?? {}, exec)
    } catch (error) {
      if (error instanceof LifeError) throw new Error(`${error.code}: ${error.message}`)
      throw error
    }
  }
}

/**
 * Build a fail-closed Life service with the supplied health snapshot.
 * @param {Record<string, unknown>} health - explicit health answer.
 * @param {LifeError} error - error every failing method throws.
 * @returns {Record<string, unknown>} closed service.
 */
function failClosedLife(health, error) {
  const fail = () => {
    throw error
  }
  return {
    getHealth: () => health,
    createIntent: fail,
    getIntent: fail,
    listIntents: fail,
    updateIntent: fail,
    cancelIntent: fail,
    recordActivity: fail,
    getActivity: fail,
    listActivities: fail,
    transitionActivity: fail,
    requestCancelActivity: fail,
    tickNow: fail,
    listOutbox: fail,
    acknowledgeEvent: fail,
    requestExternalAction: fail,
    prepareDueWakes: fail,
    claimNextWake: fail,
    prepareWakeDelivery: fail,
    markWakeAdmitted: fail,
    markWakeExecuted: fail,
    markWakeUncertain: fail,
    getWake: fail,
    listWakes: fail,
    recordWakeConsumed: fail,
    recordWakeConsumedFromSnapshot: fail,
    recordWakeTurnEnd: fail,
    getWakeConsumption: fail,
    listUnreconciledWakesForSession: fail,
    noteSessionActivity: fail,
    allocateIdleWake: fail,
    consumeWakeBudget: fail,
    getBudget: fail,
    configureBudget: fail,
    recordTokenUsage: fail,
    reserveCost: fail,
    settleCost: fail,
    releaseCost: fail,
    getCostReservation: fail,
    createPersona: fail,
    getPersona: fail,
    createScene: fail,
    getScene: fail,
    grantSceneShare: fail,
    sceneVisibleTo: fail,
    bindSession: fail,
    getSessionBinding: fail,
    revokeSessionBinding: fail,
    registerActivityProvider: fail,
    listActivityProviders: fail,
    startActivity: fail,
    pauseActivity: fail,
    resumeActivity: fail,
    checkpointActivity: fail,
    cancelActivity: fail,
    reconcileActivity: fail,
    finishActivity: fail,
    getActivityStatus: fail,
    yieldActivitiesToUser: fail,
    getSharedLifeView: fail,
    recordSessionUsage: fail,
    driveDueWakesOnce: fail,
    close: () => {},
  }
}

/**
 * Degraded service used when storage cannot be opened or verified.
 * @param {Error} cause - startup failure.
 * @returns {Record<string, unknown>} degraded service.
 */
function unavailableLife(cause) {
  return failClosedLife(
    {
      state: 'unavailable',
      schemaVersion: null,
      error: cause.message,
      startedAt: null,
      lastTickAt: null,
      lastTickError: null,
      tickCount: 0,
      counts: null,
    },
    new LifeStorageError(`Life storage unavailable: ${cause.message}`, { reason: cause.message }),
  )
}

/**
 * Service used when another live adapter owns this database. It answers health
 * explicitly but performs no read, write, recovery, or tick.
 * @param {{pid?: number, heldBy?: string}} lease - lost lease outcome.
 * @returns {Record<string, unknown>} held service.
 */
function heldLife(lease) {
  return failClosedLife(
    {
      state: 'degraded',
      schemaVersion: LIFE_SCHEMA_VERSION,
      error: 'runtime ownership held by another live adapter',
      reason: 'runtime_lease_held',
      heldPid: lease.pid,
      startedAt: null,
      lastTickAt: null,
      lastTickError: null,
      tickCount: 0,
      counts: null,
    },
    new LifeUnauthorizedError(`runtime ownership held by another live adapter (pid ${String(lease.pid)})`),
  )
}

/**
 * Mount Amadeus Life.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, unknown>} [config] - row config.
 */
export function apply(ctx, config = {}) {
  if (typeof config !== 'object' || config === null) {
    throw new LifeValidationError('amadeus-life config must be an object')
  }
  const databasePath =
    config.databasePath === undefined ? defaultDatabasePath() : requireString(config.databasePath, 'databasePath', 4000)
  if (config.tickIntervalMs !== undefined) assertInteger(config.tickIntervalMs, 'tickIntervalMs', { min: 0, max: 600000 })
  const tickIntervalMs = config.tickIntervalMs === undefined ? 1000 : config.tickIntervalMs
  const maxReviewBatch = config.maxReviewBatch === undefined ? 20 : assertInteger(config.maxReviewBatch, 'maxReviewBatch', { min: 1, max: 500 })
  if (config.clock !== undefined && typeof config.clock !== 'function') {
    throw new LifeValidationError('clock must be a function when provided')
  }
  const delivery = parseWakeDelivery(config.wakeDelivery)
  const idleConfig = parseIdle(config.idle, delivery.allowedSessionIds)
  const budgetConfig = parseWakeBudget(config.wakeBudget)
  const activityTools = parseFeature(config.activityTools, 'activityTools')
  const sharedRead = parseFeature(config.sharedRead, 'sharedRead')

  let core
  try {
    core = new LifeCore({
      databasePath,
      clock: config.clock,
      maxReviewBatch,
    })
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    ctx.logger?.error?.(`amadeus-life: storage unavailable at ${databasePath}: ${failure.message}`)
    ctx.provide('life', unavailableLife(failure))
    return
  }

  const ownerId = `adapter_${randomUUID()}`
  let lease
  try {
    lease = core.acquireRuntimeLease(ownerId)
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    try {
      core.close()
    } catch {
      // Preserve the startup failure.
    }
    ctx.logger?.error?.(`amadeus-life: lease acquisition failed: ${failure.message}`)
    ctx.provide('life', unavailableLife(failure))
    return
  }
  if (!lease.acquired) {
    try {
      core.close()
    } catch {
      // Preserve the lease outcome.
    }
    ctx.logger?.error?.(
      `amadeus-life: runtime ownership held by another live adapter (pid ${String(lease.pid)}); this adapter stays closed`,
    )
    ctx.provide('life', heldLife(lease))
    return
  }
  try {
    core.markInterruptedAsUnknown()
    core.markInterruptedWakesUncertain()
    if (budgetConfig.enabled || budgetConfig.activityLimit != null) {
      for (const sessionId of delivery.allowedSessionIds) {
        core.v1.configureBudget({
          scope: `${SCOPE_PREFIX}${sessionId}`,
          windowMs: budgetConfig.windowMs,
          wakeLimit: budgetConfig.enabled ? budgetConfig.wakeLimit : null,
          tokenLimit: budgetConfig.enabled ? budgetConfig.tokenLimit : null,
          costLimit: budgetConfig.enabled ? budgetConfig.costLimit : null,
          activityLimit: budgetConfig.activityLimit,
        })
      }
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    try {
      core.releaseRuntimeLease(ownerId)
    } catch {
      // Preserve the recovery failure.
    }
    try {
      core.close()
    } catch {
      // Preserve the recovery failure.
    }
    ctx.logger?.error?.(`amadeus-life: startup recovery failed: ${failure.message}`)
    ctx.provide('life', unavailableLife(failure))
    return
  }

  const wakeHost = new WakeHost({
    core,
    ownerId,
    enabled: delivery.enabled,
    allowedSessionIds: delivery.allowedSessionIds,
    intervalMs: delivery.intervalMs,
    maxPerDrive: delivery.maxPerDrive,
    idle: idleConfig,
    budget: budgetConfig,
    clock: config.clock ?? (() => Date.now()),
    logger: ctx.logger,
  })

  /** @type {{dispose?: () => void} | (() => void) | null} */
  let injectionHandle = null
  const disposeInjection = () => {
    const handle = injectionHandle
    injectionHandle = null
    try {
      if (typeof handle === 'function') handle()
      else if (typeof handle?.dispose === 'function') handle.dispose()
    } catch {
      // Injection teardown is best-effort; wakeHost.stop already ran.
    }
  }

  /**
   * Bind delivery to services supplied by an optional Cordis injection scope.
   * Never fails Life activation: a bad binding degrades delivery only.
   * @param {Record<string, unknown>} scope - injected child context.
   */
  const bindFromScope = (scope) => {
    try {
      const registerListener =
        typeof scope?.on === 'function'
          ? (handler) => scope.on('session/event', handler, { global: true })
          : typeof ctx.on === 'function'
            ? (handler) => ctx.on('session/event', handler, { global: true })
            : undefined
      const generation = wakeHost.bindHost({
        sessionController: scope?.sessionController,
        sessions: scope?.sessions,
        registerListener,
      })
      if (typeof scope?.effect === 'function') {
        scope.effect(() => () => wakeHost.unbindHost(generation))
      }
    } catch {
      wakeHost.markMissing(['sessionController.resolveAgent', 'sessions.flush', 'ctx.on'])
    }
  }

  if (delivery.enabled) {
    if (typeof ctx.inject === 'function') {
      try {
        injectionHandle = ctx.inject(['sessionController', 'sessions'], (scope) => bindFromScope(scope))
      } catch {
        // Optional injection is a delivery capability, not a Life requirement.
        wakeHost.markMissing(['sessionController.resolveAgent', 'sessions.flush', 'ctx.on'])
      }
    } else {
      // Fallback for fake/older Hosts without ctx.inject.
      const sessionController = optionalService(ctx, 'sessionController')
      const sessions = optionalService(ctx, 'sessions')
      const missing = []
      if (typeof sessionController?.resolveAgent !== 'function') missing.push('sessionController.resolveAgent')
      if (typeof sessions?.flush !== 'function') missing.push('sessions.flush')
      if (typeof ctx.on !== 'function') missing.push('ctx.on')
      if (missing.length > 0) wakeHost.markMissing(missing)
      else {
        wakeHost.bindHost({
          sessionController,
          sessions,
          registerListener: (handler) => ctx.on('session/event', handler, { global: true }),
        })
      }
    }
  }

  /** @param {Record<string, unknown>[]} events - produced reconsideration events. */
  const publish = (events) => {
    for (const event of events) ctx.emit('life/reconsideration', event)
  }

  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    wakeHost.stop()
    disposeInjection()
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    try {
      core.releaseRuntimeLease(ownerId)
    } catch {
      // Disposal continues even when the lease write fails.
    }
    try {
      core.close()
    } catch {
      // Store close is idempotent; preserve the first disposal outcome.
    }
  }

  const api = {
    createIntent: (input) => core.createIntent(input),
    getIntent: (id, options) => core.getIntent(id, options),
    listIntents: (options) => core.listIntents(options),
    updateIntent: (id, options) => core.updateIntent(id, options),
    cancelIntent: (id, options) => core.cancelIntent(id, options),
    recordActivity: (input) => core.recordActivity(input),
    getActivity: (id, options) => core.getActivity(id, options),
    listActivities: (options) => core.listActivities(options),
    transitionActivity: (id, options) => core.transitionActivity(id, options),
    requestCancelActivity: (id, options) => core.requestCancelActivity(id, options),
    tickNow: () => {
      const result = core.tick()
      publish(result.produced)
      return result
    },
    listOutbox: (options) => core.listOutbox(options),
    acknowledgeEvent: (eventId, options) => core.acknowledgeEvent(eventId, options),
    requestExternalAction: (input) => core.requestExternalAction(input),
    prepareDueWakes: (options) => core.prepareDueWakes(options),
    claimNextWake: (options) => core.claimNextWake(options),
    prepareWakeDelivery: (id, options) => core.prepareWakeDelivery(id, options),
    markWakeAdmitted: (id, options) => core.markWakeAdmitted(id, options),
    markWakeExecuted: (id, options) => core.markWakeExecuted(id, options),
    markWakeUncertain: (id, options) => core.markWakeUncertain(id, options),
    getWake: (id) => core.getWake(id),
    listWakes: (options) => core.listWakes(options),
    recordWakeConsumed: (id, coordinates) => core.recordWakeConsumed(id, coordinates),
    recordWakeConsumedFromSnapshot: (id, coordinates) => core.recordWakeConsumedFromSnapshot(id, coordinates),
    recordWakeTurnEnd: (id, coordinates) => core.recordWakeTurnEnd(id, coordinates),
    getWakeConsumption: (id) => core.getWakeConsumption(id),
    listUnreconciledWakesForSession: (target, options) => core.listUnreconciledWakesForSession(target, options),
    noteSessionActivity: (options) => core.noteSessionActivity(options),
    allocateIdleWake: (options) => core.allocateIdleWake(options),
    consumeWakeBudget: (options) => core.consumeWakeBudget(options),
    getBudget: (scope) => core.v1.getBudget(scope),
    configureBudget: (options) => core.v1.configureBudget(options),
    recordTokenUsage: (options) => core.v1.recordTokenUsage(options),
    reserveCost: (options) => core.v1.reserveCost(options),
    settleCost: (options) => core.v1.settleCost(options),
    releaseCost: (options) => core.v1.releaseCost(options),
    getCostReservation: (id) => core.v1.getCostReservation(id),
    createPersona: (input) => core.v1.createPersona(input),
    getPersona: (id) => core.v1.getPersona(id),
    createScene: (input) => core.v1.createScene(input),
    getScene: (id) => core.v1.getScene(id),
    grantSceneShare: (input) => core.v1.grantSceneShare(input),
    sceneVisibleTo: (input) => core.v1.sceneVisibleTo(input),
    bindSession: (input) => core.v1.bindSession(input),
    getSessionBinding: (target) => core.v1.getSessionBinding(target),
    revokeSessionBinding: (input) => core.v1.revokeSessionBinding(input),
    registerActivityProvider: (provider) => core.v1.registerActivityProvider(provider),
    listActivityProviders: () => core.v1.listActivityProviders(),
    startActivity: (input) => core.v1.startActivity(input),
    pauseActivity: (activityId, scope) => core.v1.operateActivity('pause', activityId, scope),
    resumeActivity: (activityId, scope) => core.v1.operateActivity('resume', activityId, scope),
    checkpointActivity: (activityId, scope) => core.v1.operateActivity('checkpoint', activityId, scope),
    cancelActivity: (activityId, scope) => core.v1.operateActivity('cancel', activityId, scope),
    reconcileActivity: (activityId, scope) => core.v1.operateActivity('reconcile', activityId, scope),
    finishActivity: (activityId, scope, outcome) => core.v1.finishActivity(activityId, scope, outcome),
    getActivityStatus: (activityId, scope) => core.v1.getActivityStatus(activityId, scope),
    yieldActivitiesToUser: (options) => core.v1.yieldActivitiesToUser(options),
    getSharedLifeView: (options) => core.v1.getSharedLifeView(options),
    recordSessionUsage: (options) => core.v1.recordSessionUsage(options),
    driveDueWakesOnce: () => wakeHost.driveOnce(),
    getHealth: () => ({ ...core.getHealth(), delivery: wakeHost.health() }),
    getScopedHealth: (options) => core.getScopedHealth(options),
    close: () => dispose(),
  }

  // Cleanup is registered before the service and tools are published so a
  // setup failure cannot leak the lease, timer, or SQLite handle. Public
  // `api.close()` and Host disposal share this exact idempotent path.
  ctx.effect(() => dispose)

  try {
    ctx.provide('life', api)

  registerTool(ctx, {
    name: 'life_intent_create',
    description:
      'Create a durable future intent (what to reconsider later, not a prewritten message). Scope and authorization provenance are taken from this Session, not from arguments.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        description: { type: 'string', description: 'Durable intent description; never a scripted outgoing message.' },
        reviewAt: { type: 'string', description: 'ISO-8601 UTC time to reconsider this intent.' },
        relatedActivityId: { type: 'string', description: 'Optional activity id related to this intent.' },
      },
      required: ['description', 'reviewAt'],
    },
    execute: toolBody((args, exec) => {
      const scope = sessionScope(exec)
      return core.createIntent({
        description: args.description,
        reviewAt: args.reviewAt,
        contextScope: scope,
        authorizationRef: `life-tool:${scope}`,
        relatedActivityId: args.relatedActivityId,
      })
    }),
  })

  registerTool(ctx, {
    name: 'life_intent_get',
    description: 'Read one durable intent in this Session scope.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string', description: 'Intent id.' } },
      required: ['id'],
    },
    execute: toolBody((args, exec) => core.getIntent(args.id, { scope: sessionScope(exec) })),
  })

  registerTool(ctx, {
    name: 'life_intent_list',
    description: 'List durable intents in this Session scope, optionally filtered by status.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['active', 'cancelled'], description: 'Optional intent status filter.' },
      },
      required: [],
    },
    execute: toolBody((args, exec) => ({
      intents: core.listIntents({ scope: sessionScope(exec), status: args.status }),
    })),
  })

  registerTool(ctx, {
    name: 'life_intent_update',
    description:
      'Edit a durable intent with revision CAS. Retiming supersedes pending reconsideration events; immutable ownership fields cannot be changed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Intent id.' },
        expectedRevision: { type: 'integer', description: 'Exact current revision for optimistic concurrency.' },
        description: { type: 'string', description: 'New durable description.' },
        reviewAt: { type: 'string', description: 'New ISO-8601 UTC reconsideration time.' },
        relatedActivityId: { type: 'string', description: 'New related activity id.' },
      },
      required: ['id', 'expectedRevision'],
    },
    execute: toolBody((args, exec) => {
      // Explicit allowlist: never spread model args over authorization fields.
      const patch = {}
      if (args.description !== undefined) patch.description = args.description
      if (args.reviewAt !== undefined) patch.reviewAt = args.reviewAt
      if (args.relatedActivityId !== undefined) patch.relatedActivityId = args.relatedActivityId
      return core.updateIntent(args.id, {
        scope: sessionScope(exec),
        expectedRevision: args.expectedRevision,
        ...patch,
      })
    }),
  })

  registerTool(ctx, {
    name: 'life_intent_cancel',
    description: 'Cancel a durable intent; its pending reconsideration events are invalidated.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Intent id.' },
        expectedRevision: { type: 'integer', description: 'Exact current revision.' },
      },
      required: ['id', 'expectedRevision'],
    },
    execute: toolBody((args, exec) =>
      core.cancelIntent(args.id, { scope: sessionScope(exec), expectedRevision: args.expectedRevision }),
    ),
  })

  registerTool(ctx, {
    name: 'life_activity_record',
    description: 'Record a new activity in pending state for this Session scope. Life does not start or send it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        description: { type: 'string', description: 'Activity description.' },
        intentId: { type: 'string', description: 'Optional related intent id.' },
        providerId: { type: 'string', description: 'Optional virtual/external provider identifier.' },
      },
      required: ['description'],
    },
    execute: toolBody((args, exec) =>
      core.recordActivity({
        description: args.description,
        intentId: args.intentId,
        providerId: args.providerId,
        ownerScope: sessionScope(exec),
      }),
    ),
  })

  registerTool(ctx, {
    name: 'life_activity_get',
    description: 'Read one activity, including status, revision, and evidence references.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string', description: 'Activity id.' } },
      required: ['id'],
    },
    execute: toolBody((args, exec) => core.getActivity(args.id, { scope: sessionScope(exec) })),
  })

  registerTool(ctx, {
    name: 'life_activity_transition',
    description:
      'Apply one allowed activity transition. Completion requires evidenceRefs. Confirmations for stopping/unknown work require a trusted provider boundary; model-supplied evidence and notes are recorded as untrusted and cannot confirm that external work stopped. Rejected late results leave intents untouched.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Activity id.' },
        expectedRevision: { type: 'integer', description: 'Exact current activity revision.' },
        to: {
          type: 'string',
          enum: ['running', 'paused', 'stopping', 'completed', 'failed', 'cancelled', 'unknown'],
          description: 'Requested next status.',
        },
        evidenceRefs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Evidence references supplied by the model; treated as untrusted for external confirmation.',
        },
        note: { type: 'string', description: 'Optional audit note; never a trusted evidence substitute.' },
      },
      required: ['id', 'expectedRevision', 'to'],
    },
    execute: toolBody((args, exec) =>
      core.transitionActivity(args.id, {
        scope: sessionScope(exec),
        expectedRevision: args.expectedRevision,
        to: args.to,
        evidenceRefs: args.evidenceRefs,
        note: args.note,
        trustedEvidence: false,
      }),
    ),
  })

  const boundIdentity = (exec) => {
    const scope = sessionScope(exec)
    const target = scope.slice(SCOPE_PREFIX.length)
    const binding = core.v1.getSessionBinding(target)
    if (binding.active !== true) {
      throw new LifeUnauthorizedError('an active Session binding is required for this Life tool')
    }
    return { scope, target, binding }
  }

  if (activityTools.enabled) {
    registerTool(ctx, {
      name: 'life_activity_start',
      description:
        'Start a controlled local virtual activity for this Session. Owner scope, Persona, Scene, principal, and authorization are derived from the active Session binding; the model cannot select a provider or identity. Completion evidence only comes from the Provider.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string', description: 'Purpose of the activity.' },
          intentId: { type: 'string', description: 'Optional related intent id.' },
          priority: { type: 'integer', minimum: 0, maximum: 100, description: 'Optional activity priority.' },
          resource: { type: 'string', description: 'Optional resource key to acquire exclusively.' },
          deadlineAt: { type: 'string', description: 'Optional ISO-8601 deadline.' },
        },
        required: ['description'],
      },
      execute: toolBody(async (args, exec) => {
        const { scope, binding } = boundIdentity(exec)
        return core.v1.startActivity({
          description: args.description,
          ownerScope: scope,
          providerId: 'local-virtual',
          intentId: args.intentId,
          priority: args.priority ?? 0,
          personaId: binding.personaId,
          sceneId: binding.sceneId,
          resourceLease: args.resource,
          deadlineAt: args.deadlineAt,
        })
      }),
    })

    registerTool(ctx, {
      name: 'life_activity_status',
      description: 'Read a bound activity and the local Provider status; does not transition or complete it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', description: 'Activity id.' } },
        required: ['id'],
      },
      execute: toolBody(async (args, exec) => {
        const { scope } = boundIdentity(exec)
        return core.v1.getActivityStatus(args.id, scope)
      }),
    })

    for (const [name, action, label] of [
      ['life_activity_pause', 'pause', 'Pause a running bound activity through the local Provider.'],
      ['life_activity_resume', 'resume', 'Resume a paused bound activity through the local Provider.'],
      ['life_activity_cancel', 'cancel', 'Request cancellation of a bound activity through the local Provider.'],
    ]) {
      registerTool(ctx, {
        name,
        description: label,
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { id: { type: 'string', description: 'Activity id.' } },
          required: ['id'],
        },
        execute: toolBody(async (args, exec) => {
          const { scope } = boundIdentity(exec)
          return core.v1.operateActivity(action, args.id, scope)
        }),
      })
    }

    registerTool(ctx, {
      name: 'life_activity_finish',
      description:
        'Ask the local Provider to finish a bound activity as completed or failed. The model cannot supply evidence refs; only Provider evidence is recorded.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'Activity id.' },
          outcome: { type: 'string', enum: ['completed', 'failed'], description: 'Provider outcome to request.' },
        },
        required: ['id', 'outcome'],
      },
      execute: toolBody(async (args, exec) => {
        const { scope } = boundIdentity(exec)
        return core.v1.finishActivity(args.id, scope, args.outcome)
      }),
    })
  }

  if (sharedRead.enabled) {
    registerTool(ctx, {
      name: 'life_shared_read',
      description:
        'Read the minimal shared life view visible to this Session binding. Scenes are selected by the stored binding and explicit grants only; private descriptions and authorization/principal references are never returned.',
      parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      execute: toolBody((_args, exec) => {
        const { target } = boundIdentity(exec)
        return core.v1.getSharedLifeView({ targetSessionId: target })
      }),
    })
  }

  registerTool(ctx, {
    name: 'life_health',
    description: 'Report Life storage/tick health and intent, activity, and outbox counts.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    execute: toolBody((_args, exec) => core.getScopedHealth({ scope: sessionScope(exec) })),
  })

    if (tickIntervalMs > 0) {
      timer = setInterval(() => {
        try {
          publish(core.tick().produced)
        } catch (error) {
          // Health records the failure; the interval stays alive for recovery.
          ctx.logger?.warn?.(`amadeus-life: tick failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }, tickIntervalMs)
      timer.unref?.()
    }
  } catch (error) {
    dispose()
    throw error
  }
}
