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
import {
  LIFE_SCHEMA_VERSION,
  LifeError,
  LifeStorageError,
  LifeUnauthorizedError,
  LifeValidationError,
  assertInteger,
  requireString,
} from './model.js'

/** Cordis plugin name. */
export const name = 'amadeus-life'

/** Host services required by the adapter. */
export const inject = ['tools']

const SCOPE_PREFIX = 'session:'
const UNCONSTRAINED_OBJECT = Object.freeze({ type: 'object', additionalProperties: true })
const RESERVED_ARGS = new Set(['scope', 'trustedEvidence', 'authorizationRef', 'ownerScope', 'contextScope'])

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
    markWakeAdmitted: fail,
    markWakeExecuted: fail,
    markWakeUncertain: fail,
    getWake: fail,
    listWakes: fail,
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
    markWakeAdmitted: (id, options) => core.markWakeAdmitted(id, options),
    markWakeExecuted: (id, options) => core.markWakeExecuted(id, options),
    markWakeUncertain: (id, options) => core.markWakeUncertain(id, options),
    getWake: (id) => core.getWake(id),
    listWakes: (options) => core.listWakes(options),
    getHealth: () => core.getHealth(),
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
