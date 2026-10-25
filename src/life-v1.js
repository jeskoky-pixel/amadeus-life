/**
 * Amadeus Life v1.0 service layer: identity binding, idle opportunities, unified
 * budget, and a controlled local virtual activity provider.
 *
 * All methods are trusted Host service calls. None are exposed as model tools;
 * model text can never select a persona, scene, session, budget, or provider.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  LifeInvalidTransitionError,
  LifeNotFoundError,
  LifeUnauthorizedError,
  LifeValidationError,
  assertInteger,
  isDshSessionScope,
  normalizeTimestamp,
  requireString,
} from './model.js'

const PROVIDER_METHODS = ['describe', 'start', 'status', 'cancel']
const SCENE_PRIVACY = new Set(['private', 'shared'])

/** Deterministic, dependency-free local Provider for lifecycle tests. */
export class LocalVirtualProvider {
  /**
   * @param {{id?: string, clock?: () => number}} [options] - provider options.
   */
  constructor({ id = 'local-virtual', clock = () => Date.now() } = {}) {
    this.id = id
    this.clock = clock
    this.activities = new Map()
    this.failNext = false
  }

  /** @returns {Record<string, unknown>} provider description. */
  describe() {
    return {
      providerId: this.id,
      version: 1,
      capabilities: ['describe', 'start', 'status', 'cancel', 'pause', 'resume', 'checkpoint', 'reconcile'],
      external: false,
    }
  }

  /** @param {{activityId: string, purposeRef: string, deadlineAt?: string}} request - start request. */
  start({ activityId, purposeRef, deadlineAt }) {
    if (this.failNext) {
      this.failNext = false
      throw new Error('local-virtual: start failed')
    }
    if (typeof activityId !== 'string' || typeof purposeRef !== 'string') {
      throw new Error('local-virtual: activityId and purposeRef are required')
    }
    if (deadlineAt !== undefined && Date.parse(deadlineAt) <= this.clock()) {
      throw new Error('local-virtual: deadline already elapsed')
    }
    this.activities.set(activityId, { status: 'running', startedAt: this.clock() })
    return {
      status: 'running',
      evidenceRefs: [`local:start:${activityId}`],
      checkpointRef: `local:checkpoint:${activityId}:0`,
    }
  }

  /** @param {{activityId: string}} request - status request. */
  status({ activityId }) {
    const entry = this.activities.get(activityId)
    return entry === undefined
      ? { status: 'unknown', evidenceRefs: [`local:missing:${activityId}`] }
      : { status: entry.status, evidenceRefs: [`local:status:${activityId}:${entry.status}`] }
  }

  /** @param {{activityId: string}} request - pause request. */
  pause({ activityId }) {
    const entry = this.activities.get(activityId)
    if (entry === undefined) return { status: 'unknown', evidenceRefs: [`local:missing:${activityId}`] }
    if (entry.status !== 'running') throw new Error(`local-virtual: cannot pause ${entry.status}`)
    entry.status = 'paused'
    return { status: 'paused', evidenceRefs: [`local:pause:${activityId}`] }
  }

  /** @param {{activityId: string}} request - resume request. */
  resume({ activityId }) {
    const entry = this.activities.get(activityId)
    if (entry === undefined) return { status: 'unknown', evidenceRefs: [`local:missing:${activityId}`] }
    if (entry.status !== 'paused') throw new Error(`local-virtual: cannot resume ${entry.status}`)
    entry.status = 'running'
    return { status: 'running', evidenceRefs: [`local:resume:${activityId}`] }
  }

  /** @param {{activityId: string}} request - checkpoint request. */
  checkpoint({ activityId }) {
    const entry = this.activities.get(activityId)
    if (entry === undefined) return { status: 'unknown', evidenceRefs: [`local:missing:${activityId}`] }
    const checkpointRef = `local:checkpoint:${activityId}:${entry.status}`
    return { status: entry.status, checkpointRef, evidenceRefs: [`local:checkpoint:${activityId}`] }
  }

  /** @param {{activityId: string}} request - cancel request. */
  cancel({ activityId }) {
    const entry = this.activities.get(activityId)
    if (entry === undefined) return { status: 'unknown', evidenceRefs: [`local:missing:${activityId}`] }
    entry.status = 'cancelled'
    return { status: 'cancelled', evidenceRefs: [`local:cancel:${activityId}`] }
  }

  /** @param {{activityId: string}} request - provider-evidenced completion. */
  complete({ activityId }) {
    const entry = this.activities.get(activityId)
    if (entry === undefined) return { status: 'unknown', evidenceRefs: [`local:missing:${activityId}`] }
    if (entry.status !== 'running' && entry.status !== 'paused') {
      throw new Error(`local-virtual: cannot complete ${entry.status}`)
    }
    entry.status = 'completed'
    return { status: 'completed', evidenceRefs: [`local:complete:${activityId}`] }
  }

  /** @param {{activityId: string}} request - provider-evidenced failure. */
  fail({ activityId }) {
    const entry = this.activities.get(activityId)
    if (entry === undefined) return { status: 'unknown', evidenceRefs: [`local:missing:${activityId}`] }
    if (entry.status !== 'running' && entry.status !== 'paused') {
      throw new Error(`local-virtual: cannot fail ${entry.status}`)
    }
    entry.status = 'failed'
    return { status: 'failed', evidenceRefs: [`local:fail:${activityId}`] }
  }

  /** @param {{activityId: string}} request - reconcile request. */
  reconcile({ activityId }) {
    return this.status({ activityId })
  }

  /** Simulate an unavailable/uncertain external result. */
  simulateCrash() {
    this.failNext = true
    return 'simulated'
  }
}

/**
 * Trusted service layer over LifeStore for v1.0 capabilities.
 */
export class LifeV1 {
  /** @param {import('./core.js').LifeCore} core - owning core. */
  constructor(core) {
    this.core = core
    this.store = core.store
    this.providers = new Map()
    const provider = new LocalVirtualProvider()
    this.providers.set(provider.id, provider)
  }

  /** @param {() => number} clock - inject clock for provider timing. */
  setClock(clock) {
    for (const provider of this.providers.values()) {
      if (provider instanceof LocalVirtualProvider) provider.clock = clock
    }
  }

  // Identity -----------------------------------------------------------------
  /**
   * Explicit local bootstrap: one stable Persona, one private Scene per
   * allowlisted Session, one binding per Session. Idempotent for the same
   * config; refuses to rebind an existing different identity or overwrite a
   * Scene. No Scene is shared.
   * @param {{targetSessionIds: string[], personaName?: string}} input
   * @returns {Record<string, unknown>} bootstrap result.
   */
  bootstrapLocalIdentity({ targetSessionIds, personaName = 'Amadeus' } = {}) {
    if (!Array.isArray(targetSessionIds) || targetSessionIds.length === 0) {
      throw new LifeValidationError('bootstrap requires at least one allowlisted Session')
    }
    const name = requireString(personaName, 'bootstrap.personaName', 200)
    const targets = [...new Set(targetSessionIds.map((id) => requireString(id, 'Session id', 200)))]
    for (const target of targets) {
      if (!isDshSessionScope(`session:${target}`)) {
        throw new LifeValidationError('bootstrap target must be a DSH Session id', { targetSessionId: target })
      }
    }
    const personaId = 'life_bootstrap_persona'
    const now = this.core.iso()
    return this.store.writeTransaction(() => {
      let createdPersona = false
      let createdScenes = 0
      let createdBindings = 0
      const persona = this.store.get('SELECT * FROM personas WHERE id = ?', personaId)
      if (persona === undefined) {
        this.store.run(
          'INSERT INTO personas (id, name, revision, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
          personaId,
          name,
          now,
          now,
        )
        createdPersona = true
      } else if (persona.name !== name) {
        throw new LifeUnauthorizedError(
          'bootstrap Persona id already exists with a different name; refusing to overwrite history',
          { personaId },
        )
      }
      const sessions = []
      for (const target of targets) {
        const scope = `session:${target}`
        const sceneId = `life_bootstrap_scene_${createHash('sha256').update(target).digest('hex').slice(0, 16)}`
        const scene = this.store.get('SELECT * FROM scenes WHERE id = ?', sceneId)
        if (scene === undefined) {
          this.store.run(
            `INSERT INTO scenes (id, persona_id, context_scope, privacy, revision, created_at, updated_at)
             VALUES (?, ?, ?, 'private', 1, ?, ?)`,
            sceneId,
            personaId,
            scope,
            now,
            now,
          )
          createdScenes += 1
        } else if (
          scene.persona_id !== personaId ||
          scene.context_scope !== scope ||
          scene.privacy !== 'private'
        ) {
          throw new LifeUnauthorizedError(
            'bootstrap Scene id collides with a different private Scene; refusing to overwrite history',
            { sceneId, targetSessionId: target },
          )
        }
        const binding = this.store.get('SELECT * FROM session_bindings WHERE target_session_id = ?', target)
        if (binding === undefined) {
          this.store.run(
            `INSERT INTO session_bindings
              (target_session_id, persona_id, scene_id, principal_id, authorization_ref, active, revision, created_at, updated_at)
             VALUES (?, ?, ?, 'life-bootstrap', 'life-bootstrap:local', 1, 1, ?, ?)`,
            target,
            personaId,
            sceneId,
            now,
            now,
          )
          createdBindings += 1
        } else if (binding.persona_id !== personaId || binding.scene_id !== sceneId) {
          throw new LifeUnauthorizedError(
            'Session already has a different Persona/Scene binding; bootstrap will not rebind history. Use a new Session or keep the existing binding.',
            { targetSessionId: target, personaId: binding.persona_id, sceneId: binding.scene_id },
          )
        } else if (binding.active !== 1) {
          throw new LifeUnauthorizedError(
            'Session binding was revoked; bootstrap will not reactivate it. Use a new Session or an explicit trusted administrator decision.',
            { targetSessionId: target },
          )
        }
        const current = this.store.get('SELECT * FROM session_bindings WHERE target_session_id = ?', target)
        sessions.push({
          targetSessionId: target,
          sceneId,
          personaId,
          bindingRevision: current.revision,
          bindingActive: current.active === 1,
        })
      }
      return {
        enabled: true,
        state: 'ready',
        personaId,
        personaName: name,
        sessions,
        created: { persona: createdPersona, scenes: createdScenes, bindings: createdBindings },
      }
    })
  }

  /**
   * @param {{id?: string, name: string}} input - persona.
   * @returns {Record<string, unknown>} persona view.
   */
  createPersona({ id, name } = {}) {
    const now = this.core.iso()
    const personaId = id === undefined ? `persona_${randomUUID()}` : requireString(id, 'id', 200)
    const label = requireString(name, 'name', 200)
    this.store.run(
      'INSERT INTO personas (id, name, revision, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
      personaId,
      label,
      now,
      now,
    )
    return this.getPersona(personaId)
  }

  /** @param {string} id */
  getPersona(id) {
    const row = this.store.get('SELECT * FROM personas WHERE id = ?', requireString(id, 'id', 200))
    if (row === undefined) throw new LifeNotFoundError(`persona "${String(id)}" was not found`, { id })
    return { id: row.id, name: row.name, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at }
  }

  /**
   * @param {{id?: string, personaId: string, contextScope: string, privacy?: 'private'|'shared'}} input - scene.
   * @returns {Record<string, unknown>} scene view.
   */
  createScene({ id, personaId, contextScope, privacy = 'private' } = {}) {
    this.getPersona(personaId)
    if (!SCENE_PRIVACY.has(privacy)) throw new LifeValidationError('scene privacy must be private or shared')
    const sceneId = id === undefined ? `scene_${randomUUID()}` : requireString(id, 'id', 200)
    const scope = requireString(contextScope, 'contextScope', 200)
    const now = this.core.iso()
    this.store.run(
      `INSERT INTO scenes (id, persona_id, context_scope, privacy, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      sceneId,
      personaId,
      scope,
      privacy,
      now,
      now,
    )
    return this.getScene(sceneId)
  }

  /** @param {string} id */
  getScene(id) {
    const row = this.store.get('SELECT * FROM scenes WHERE id = ?', requireString(id, 'id', 200))
    if (row === undefined) throw new LifeNotFoundError(`scene "${String(id)}" was not found`, { id })
    return {
      id: row.id,
      personaId: row.persona_id,
      contextScope: row.context_scope,
      privacy: row.privacy,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /**
   * Explicitly grant one external data scope access to a shared scene.
   * @param {{sceneId: string, dataScope: string}} input - grant.
   * @returns {Record<string, unknown>} scene view.
   */
  grantSceneShare({ sceneId, dataScope } = {}) {
    const scene = this.getScene(sceneId)
    if (scene.privacy !== 'shared') {
      throw new LifeValidationError('private scenes cannot be shared')
    }
    this.store.run(
      'INSERT OR IGNORE INTO scene_shares (scene_id, data_scope, granted_at) VALUES (?, ?, ?)',
      scene.id,
      requireString(dataScope, 'dataScope', 200),
      this.core.iso(),
    )
    return this.getScene(scene.id)
  }

  /**
   * @param {{sceneId: string, dataScope: string}} request - visibility check.
   * @returns {boolean} whether the scene is visible to that data scope.
   */
  sceneVisibleTo({ sceneId, dataScope } = {}) {
    const scene = this.getScene(sceneId)
    const scope = requireString(dataScope, 'dataScope', 200)
    if (scene.contextScope === scope) return true
    if (scene.privacy !== 'shared') return false
    return this.store.get(
      'SELECT 1 AS found FROM scene_shares WHERE scene_id = ? AND data_scope = ?',
      scene.id,
      scope,
    ) !== undefined
  }

  /**
   * Trusted administrator binding of one DSH Session to persona/scene.
   * @param {{targetSessionId: string, personaId: string, sceneId: string, principalId: string, authorizationRef: string}} input - binding.
   * @returns {Record<string, unknown>} binding view.
   */
  bindSession({ targetSessionId, personaId, sceneId, principalId, authorizationRef } = {}) {
    const target = requireString(targetSessionId, 'targetSessionId', 200)
    if (!isDshSessionScope(`session:${target}`)) throw new LifeValidationError('targetSessionId must be a DSH session id')
    this.getPersona(personaId)
    const scene = this.getScene(sceneId)
    if (scene.personaId !== personaId) throw new LifeValidationError('scene does not belong to persona')
    const principal = requireString(principalId, 'principalId', 200)
    const auth = requireString(authorizationRef, 'authorizationRef', 500)
    const now = this.core.iso()
    return this.store.writeTransaction(() => {
      const existing = this.store.get('SELECT * FROM session_bindings WHERE target_session_id = ?', target)
      if (existing === undefined) {
        this.store.run(
          `INSERT INTO session_bindings
            (target_session_id, persona_id, scene_id, principal_id, authorization_ref, active, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`,
          target, personaId, sceneId, principal, auth, now, now,
        )
      } else {
        if (existing.persona_id !== personaId || existing.scene_id !== sceneId) {
          throw new LifeUnauthorizedError(
            'a DSH Session cannot switch Persona or Scene in place; use a new Session',
            { targetSessionId: target },
          )
        }
        this.store.run(
          `UPDATE session_bindings SET principal_id = ?, authorization_ref = ?,
             active = 1, revision = revision + 1, updated_at = ?
           WHERE target_session_id = ?`,
          principal, auth, now, target,
        )
      }
      return this.getSessionBinding(target)
    })
  }

  /** @param {string} targetSessionId */
  getSessionBinding(targetSessionId) {
    const row = this.store.get(
      'SELECT * FROM session_bindings WHERE target_session_id = ?',
      requireString(targetSessionId, 'targetSessionId', 200),
    )
    if (row === undefined) throw new LifeNotFoundError('session binding was not found', { targetSessionId })
    return {
      targetSessionId: row.target_session_id,
      personaId: row.persona_id,
      sceneId: row.scene_id,
      principalId: row.principal_id,
      authorizationRef: row.authorization_ref,
      active: row.active === 1,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /**
   * Revoke a binding and invalidate old wakes/activity results.
   * @param {{targetSessionId: string}} input - target Session.
   * @returns {Record<string, unknown>} revoked binding.
   */
  revokeSessionBinding({ targetSessionId } = {}) {
    const target = requireString(targetSessionId, 'targetSessionId', 200)
    const binding = this.getSessionBinding(target)
    const now = this.core.iso()
    return this.store.writeTransaction(() => {
      this.store.run(
        'UPDATE session_bindings SET active = 0, revision = revision + 1, updated_at = ? WHERE target_session_id = ?',
        now,
        target,
      )
      this.store.run(
        `UPDATE wake_requests SET status = 'superseded', last_error = 'session binding revoked', updated_at = ?
         WHERE target_session_id = ? AND status IN ('pending', 'claimed', 'admitted', 'uncertain')`,
        now,
        target,
      )
      this.store.run(
        `UPDATE activities SET status = 'unknown', revision = revision + 1, updated_at = ?
         WHERE owner_scope = ?
           AND status IN ('pending', 'running', 'paused', 'stopping')`,
        now,
        `session:${target}`,
      )
      return this.getSessionBinding(target)
    })
  }

  // Idle opportunities -------------------------------------------------------
  /**
   * Record trusted Session activity for idle quiet-window checks.
   * @param {{targetSessionId: string, at?: string}} input - activity mark.
   */
  noteSessionActivity({ targetSessionId, at } = {}) {
    const target = requireString(targetSessionId, 'targetSessionId', 200)
    const now = at === undefined ? this.core.iso() : normalizeTimestamp(at, 'at')
    this.store.run(
      `INSERT INTO idle_state (target_session_id, last_event_at, last_idle_at, updated_at)
       VALUES (?, ?, NULL, ?)
       ON CONFLICT(target_session_id) DO UPDATE SET last_event_at = excluded.last_event_at, updated_at = excluded.updated_at`,
      target,
      now,
      now,
    )
  }

  /**
   * Atomically create at most one idle opportunity for a bound Session.
   * @param {{targetSessionId: string, windowMs: number, quietAfterActivityMs: number, now?: string}} input - idle request.
   * @returns {{created: boolean, reason?: string, wake?: Record<string, unknown>}} result.
   */
  allocateIdleWake({ targetSessionId, windowMs, quietAfterActivityMs, now } = {}) {
    const target = requireString(targetSessionId, 'targetSessionId', 200)
    if (!isDshSessionScope(`session:${target}`)) throw new LifeValidationError('targetSessionId must be a DSH session id')
    const window = assertInteger(windowMs, 'windowMs', { min: 1000, max: 86_400_000 })
    const quietAfter = assertInteger(quietAfterActivityMs, 'quietAfterActivityMs', { min: 0, max: 86_400_000 })
    const nowIso = now === undefined ? this.core.iso() : normalizeTimestamp(now, 'now')
    const nowMs = Date.parse(nowIso)
    return this.store.writeTransaction(() => {
      const binding = this.store.get('SELECT * FROM session_bindings WHERE target_session_id = ?', target)
      if (binding === undefined || binding.active !== 1) return { created: false, reason: 'no_active_binding' }
      const busy = this.store.get(
        `SELECT 1 AS found FROM wake_requests WHERE target_session_id = ?
         AND status IN ('pending', 'claimed', 'admitted', 'uncertain') LIMIT 1`,
        target,
      )
      if (busy !== undefined) return { created: false, reason: 'unreconciled_wake' }
      const state = this.store.get('SELECT * FROM idle_state WHERE target_session_id = ?', target)
      if (state !== undefined && state.last_event_at !== null && nowMs - Date.parse(state.last_event_at) < quietAfter) {
        return { created: false, reason: 'recent_activity' }
      }
      if (state !== undefined && state.last_idle_at !== null && nowMs - Date.parse(state.last_idle_at) < window) {
        return { created: false, reason: 'frequency_budget' }
      }
      const idleKey = `idle:${target}:${Math.floor(nowMs / window)}`
      const wakeId = `wake:${idleKey}`
      const scope = `session:${target}`
      try {
        this.store.run(
          `INSERT INTO wake_requests
            (id, kind, event_id, intent_id, intent_revision, context_scope, target_session_id,
             authorization_ref, status, claim_owner, attempts, next_attempt_at, created_at, updated_at,
             origin, idle_key, persona_id, scene_id)
           VALUES (?, 'intent_due', ?, ?, ?, ?, ?, ?, 'pending', NULL, 0, ?, ?, ?, 'idle', ?, ?, ?)`,
          wakeId,
          `idle-event:${idleKey}`,
          `idle:${binding.scene_id}`,
          binding.revision,
          scope,
          target,
          binding.authorization_ref,
          nowIso,
          nowIso,
          nowIso,
          idleKey,
          binding.persona_id,
          binding.scene_id,
        )
      } catch {
        return { created: false, reason: 'duplicate_idle_window' }
      }
      this.store.run(
        `INSERT INTO idle_state (target_session_id, last_event_at, last_idle_at, updated_at)
         VALUES (?, NULL, ?, ?)
         ON CONFLICT(target_session_id) DO UPDATE SET last_idle_at = excluded.last_idle_at, updated_at = excluded.updated_at`,
        target,
        nowIso,
        nowIso,
      )
      return { created: true, wake: this.core.getWake(wakeId) }
    })
  }

  /** @param {Record<string, unknown>} wake @param {number} nowMs @returns {string|null} */
  idleWakeInvalidReason(wake, nowMs) {
    const binding = this.store.get(
      'SELECT * FROM session_bindings WHERE target_session_id = ?',
      wake.target_session_id,
    )
    if (binding === undefined || binding.active !== 1) return 'session binding inactive'
    if (Number(binding.revision) !== Number(wake.intent_revision)) return 'binding revision changed'
    if (binding.persona_id !== wake.persona_id || binding.scene_id !== wake.scene_id) {
      return 'binding identity changed'
    }
    if (binding.authorization_ref !== wake.authorization_ref) return 'binding authorization changed'
    if (wake.expires_at !== null && Date.parse(String(wake.expires_at)) <= nowMs) return 'wake expired'
    return null
  }

  // Budget -------------------------------------------------------------------
  /**
   * Configure one persistent budget scope; existing counters are preserved
   * within the current window and reset after rollover.
   * @param {{scope: string, windowMs: number, wakeLimit?: number|null, tokenLimit?: number|null, costLimit?: number|null}} input - budget config.
   * @returns {Record<string, unknown>} budget view.
   */
  configureBudget({ scope, windowMs, wakeLimit = null, tokenLimit = null, costLimit = null, activityLimit = null } = {}) {
    const key = requireString(scope, 'scope', 200)
    const window = assertInteger(windowMs, 'windowMs', { min: 1000, max: 86_400_000 * 30 })
    const limit = (value, field) => (value === null || value === undefined ? null : assertInteger(value, field, { min: 0 }))
    const wake = limit(wakeLimit, 'wakeLimit')
    const tokens = limit(tokenLimit, 'tokenLimit')
    const cost = limit(costLimit, 'costLimit')
    const activity = limit(activityLimit, 'activityLimit')
    const now = this.core.iso()
    this.store.writeTransaction(() => {
      const existing = this.store.get('SELECT * FROM budget_scopes WHERE scope = ?', key)
      if (existing === undefined) {
        this.store.run(
          `INSERT INTO budget_scopes
            (scope, window_ms, wake_limit, token_limit, cost_limit, activity_limit, window_start,
             wake_calls, tokens_used, cost_used, cost_reserved, revision, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 1, ?)`,
          key, window, wake, tokens, cost, activity, now, now,
        )
      } else {
        this.store.run(
          `UPDATE budget_scopes SET window_ms = ?, wake_limit = ?, token_limit = ?, cost_limit = ?,
             activity_limit = ?, revision = revision + 1, updated_at = ?
           WHERE scope = ?`,
          window, wake, tokens, cost, activity, now, key,
        )
      }
    })
    return this.getBudget(key)
  }

  /** @param {string} scope */
  getBudget(scope) {
    const key = requireString(scope, 'scope', 200)
    const row = this.store.get('SELECT * FROM budget_scopes WHERE scope = ?', key)
    if (row === undefined) throw new LifeNotFoundError('budget scope was not found', { scope: key })
    return {
      scope: row.scope,
      windowMs: row.window_ms,
      wakeLimit: row.wake_limit,
      tokenLimit: row.token_limit,
      costLimit: row.cost_limit,
      activityLimit: row.activity_limit ?? null,
      windowStart: row.window_start,
      wakeCalls: row.wake_calls,
      tokensUsed: row.tokens_used,
      tokensReserved: row.tokens_reserved ?? 0,
      costUsed: row.cost_used,
      costReserved: row.cost_reserved ?? 0,
      revision: row.revision,
    }
  }

  /**
   * Record observed model-token usage after a call. Reserved estimates are
   * already counted by `consumeWakeBudget`; this adds actual usage deltas.
   * @param {{scope: string, tokens: number, cost?: number}} input - usage.
   * @returns {Record<string, unknown>} budget view.
   */
  recordTokenUsage({ scope, tokens, cost = 0 } = {}) {
    const key = requireString(scope, 'scope', 200)
    const delta = assertInteger(tokens, 'tokens', { min: 0 })
    const costUnits = assertInteger(cost, 'cost', { min: 0 })
    return this.store.writeTransaction(() => {
      const row = this.store.get('SELECT * FROM budget_scopes WHERE scope = ?', key)
      if (row === undefined) throw new LifeNotFoundError('budget scope was not found', { scope: key })
      this.store.run(
        `UPDATE budget_scopes SET tokens_used = tokens_used + ?, cost_used = cost_used + ?,
           revision = revision + 1, updated_at = ?
         WHERE scope = ?`,
        delta,
        costUnits,
        this.core.iso(),
        key,
      )
      return this.getBudget(key)
    })
  }

  /**
   * Determine the effective budget scopes for a Session: its Session scope plus
   * any configured Persona scope for the active binding and global scope.
   * @param {string} sessionScope
   * @returns {string[]} effective scopes.
   */
  #effectiveTokenScopes(sessionScope) {
    const scopes = []
    if (this.store.get('SELECT 1 AS found FROM budget_scopes WHERE scope = ?', sessionScope) !== undefined) {
      scopes.push(sessionScope)
    }
    if (String(sessionScope).startsWith('session:')) {
      const target = String(sessionScope).slice('session:'.length)
      const binding = this.store.get('SELECT * FROM session_bindings WHERE target_session_id = ?', target)
      if (binding !== undefined && binding.active === 1) {
        const personaScope = `persona:${binding.persona_id}`
        if (this.store.get('SELECT 1 AS found FROM budget_scopes WHERE scope = ?', personaScope) !== undefined) {
          scopes.push(personaScope)
        }
      }
    }
    if (this.store.get("SELECT 1 AS found FROM budget_scopes WHERE scope = 'global'") !== undefined) {
      scopes.push('global')
    }
    return [...new Set(scopes)]
  }

  /**
   * Atomically reserve one autonomous wake across Session/Persona/global
   * budgets. Estimated tokens are held in `tokens_reserved` until official usage
   * settles them; missing usage retains the reservation.
   * @param {{scope: string, estimatedTokens?: number, cost?: number, wakeId?: string}} input
   * @returns {{allowed: boolean, reason?: string, unconfigured?: boolean, reservationId?: string}} result.
   */
  consumeWakeBudget({ scope, estimatedTokens = 0, cost = 0, wakeId = null } = {}) {
    const key = requireString(scope, 'scope', 200)
    const tokens = assertInteger(estimatedTokens, 'estimatedTokens', { min: 0 })
    const costUnits = assertInteger(cost, 'cost', { min: 0 })
    const wake = wakeId === null || wakeId === undefined ? null : requireString(wakeId, 'wakeId', 200)
    const nowMs = this.core.nowMs()
    const nowIso = this.core.iso(nowMs)
    return this.store.writeTransaction(() => {
      if (wake !== null) {
        const existing = this.store.get('SELECT * FROM token_reservations WHERE wake_id = ?', wake)
        if (existing !== undefined) {
          if (existing.session_scope !== key || Number(existing.total_amount) !== tokens) {
            throw new LifeValidationError('wake id is already reserved with different scope or amount', {
              wakeId: wake,
              reservationId: existing.id,
            })
          }
          return {
            allowed: true,
            reservationId: existing.id,
            idempotent: true,
            scopes: this.store.all(
              'SELECT scope FROM token_reservation_scopes WHERE reservation_id = ? ORDER BY scope',
              existing.id,
            ).map((row) => row.scope),
          }
        }
      }
      const scopes = this.#effectiveTokenScopes(key)
      if (scopes.length === 0) return { allowed: true, unconfigured: true }
      const plans = []
      for (const scopeKey of scopes) {
        const row = this.store.get('SELECT * FROM budget_scopes WHERE scope = ?', scopeKey)
        if (row === undefined) continue
        const inWindow = nowMs - Date.parse(row.window_start) < Number(row.window_ms)
        const wakeCalls = inWindow ? Number(row.wake_calls) : 0
        const tokensUsed = inWindow ? Number(row.tokens_used) : 0
        const costUsed = inWindow ? Number(row.cost_used) : 0
        const tokensReserved = Number(row.tokens_reserved ?? 0)
        const costReserved = Number(row.cost_reserved ?? 0)
        const windowStart = inWindow ? row.window_start : nowIso
        if (row.wake_limit !== null && wakeCalls + 1 > Number(row.wake_limit)) {
          return { allowed: false, reason: 'wake_limit', scope: scopeKey }
        }
        if (row.token_limit !== null && tokensUsed + tokensReserved + tokens > Number(row.token_limit)) {
          return { allowed: false, reason: 'token_limit', scope: scopeKey }
        }
        if (row.cost_limit !== null && costUsed + costReserved + costUnits > Number(row.cost_limit)) {
          return { allowed: false, reason: 'cost_limit', scope: scopeKey }
        }
        plans.push({ scope: scopeKey, row, wakeCalls, tokensUsed, costUsed, windowStart })
      }
      for (const plan of plans) {
        this.store.run(
          `UPDATE budget_scopes SET window_start = ?, wake_calls = ?, tokens_used = ?, cost_used = ?,
             tokens_reserved = tokens_reserved + ?, revision = revision + 1, updated_at = ?
           WHERE scope = ?`,
          plan.windowStart,
          plan.wakeCalls + 1,
          plan.tokensUsed,
          plan.costUsed + costUnits,
          tokens,
          nowIso,
          plan.scope,
        )
      }
      const reservationId = `tokens_${randomUUID()}`
      this.store.run(
        `INSERT INTO token_reservations
          (id, session_scope, wake_id, total_amount, status, settled_tokens, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, 'reserved', NULL, ?, ?, 1)`,
        reservationId,
        key,
        wake,
        tokens,
        nowIso,
        nowIso,
      )
      for (const plan of plans) {
        this.store.run(
          `INSERT INTO token_reservation_scopes
            (reservation_id, scope, reserved_tokens, settled_tokens, status)
           VALUES (?, ?, ?, NULL, 'reserved')`,
          reservationId,
          plan.scope,
          tokens,
        )
      }
      return { allowed: true, reservationId, scopes: plans.map((plan) => plan.scope) }
    })
  }

  /**
   * Check all configured effective concurrency limits for a new activity. Must
   * run in the same BEGIN IMMEDIATE transaction as the activity INSERT so two
   * processes cannot both observe an available slot.
   * @param {{ownerScope: string, personaId: string|null}} input
   */
  #assertActivityCapacity({ ownerScope, personaId }) {
    const active = "('pending', 'running', 'paused', 'stopping', 'unknown')"
    const checks = []
    if (String(ownerScope).startsWith('session:')) {
      const row = this.store.get('SELECT activity_limit FROM budget_scopes WHERE scope = ?', ownerScope)
      if (row !== undefined && row.activity_limit !== null) {
        checks.push({
          scope: ownerScope,
          limit: Number(row.activity_limit),
          count: () => this.store.get(
            `SELECT COUNT(*) AS n FROM activities WHERE owner_scope = ? AND status IN ${active}`,
            ownerScope,
          ).n,
        })
      }
    }
    if (personaId !== null && personaId !== undefined) {
      const personaScope = `persona:${personaId}`
      const row = this.store.get('SELECT activity_limit FROM budget_scopes WHERE scope = ?', personaScope)
      if (row !== undefined && row.activity_limit !== null) {
        checks.push({
          scope: personaScope,
          limit: Number(row.activity_limit),
          count: () => this.store.get(
            `SELECT COUNT(*) AS n FROM activities WHERE persona_id = ? AND status IN ${active}`,
            personaId,
          ).n,
        })
      }
    }
    const global = this.store.get("SELECT activity_limit FROM budget_scopes WHERE scope = 'global'")
    if (global !== undefined && global.activity_limit !== null) {
      checks.push({
        scope: 'global',
        limit: Number(global.activity_limit),
        count: () => this.store.get(
          `SELECT COUNT(*) AS n FROM activities WHERE status IN ${active}`,
        ).n,
      })
    }
    for (const check of checks) {
      if (Number(check.count()) >= check.limit) {
        throw new LifeValidationError('activity concurrency limit reached', {
          reason: 'activity_limit',
          scope: check.scope,
          limit: check.limit,
        })
      }
    }
  }

  /**
   * Trusted paid-capability cost reservation. No payment is performed.
   * @param {{scope: string, amount: number, idempotencyKey?: string}} input
   * @returns {Record<string, unknown>} reservation view.
   */
  reserveCost({ scope, amount, idempotencyKey = null } = {}) {
    const key = requireString(scope, 'scope', 200)
    const value = assertInteger(amount, 'amount', { min: 0 })
    const idempotency = idempotencyKey === null || idempotencyKey === undefined
      ? null
      : requireString(idempotencyKey, 'idempotencyKey', 200)
    return this.store.writeTransaction(() => {
      if (idempotency !== null) {
        const existing = this.store.get('SELECT * FROM cost_reservations WHERE idempotency_key = ?', idempotency)
        if (existing !== undefined) {
          if (existing.scope !== key || Number(existing.amount) !== value) {
            throw new LifeValidationError('idempotency key is bound to a different reservation', { idempotencyKey: idempotency })
          }
          return this.#costReservationView(existing)
        }
      }
      const budget = this.store.get('SELECT * FROM budget_scopes WHERE scope = ?', key)
      if (budget === undefined || budget.cost_limit === null) {
        throw new LifeValidationError('cost budget is not configured for this scope', {
          reason: 'cost_budget_unconfigured',
          scope: key,
        })
      }
      const available = Number(budget.cost_limit) - Number(budget.cost_used) - Number(budget.cost_reserved ?? 0)
      if (value > available) {
        throw new LifeValidationError('cost budget exhausted', {
          reason: 'cost_limit',
          scope: key,
          available,
        })
      }
      const id = `cost_${randomUUID()}`
      const now = this.core.iso()
      const result = this.store.run(
        `INSERT INTO cost_reservations
          (id, scope, amount, status, idempotency_key, created_at, updated_at, settled_at, released_at, revision)
         VALUES (?, ?, ?, 'reserved', ?, ?, ?, NULL, NULL, 1)`,
        id,
        key,
        value,
        idempotency,
        now,
        now,
      )
      if (Number(result.changes) !== 1) {
        throw new LifeValidationError('cost reservation failed')
      }
      this.store.run(
        `UPDATE budget_scopes SET cost_reserved = cost_reserved + ?, revision = revision + 1, updated_at = ?
         WHERE scope = ?`,
        value,
        now,
        key,
      )
      return this.#costReservationView(this.store.get('SELECT * FROM cost_reservations WHERE id = ?', id))
    })
  }

  /**
   * Settle a reserved cost with an actual amount no greater than the reservation.
   * @param {{reservationId: string, actualCost: number}} input
   * @returns {Record<string, unknown>} reservation view.
   */
  settleCost({ reservationId, actualCost = 0 } = {}) {
    const id = requireString(reservationId, 'reservationId', 200)
    const actual = assertInteger(actualCost, 'actualCost', { min: 0 })
    return this.store.writeTransaction(() => {
      const reservation = this.store.get('SELECT * FROM cost_reservations WHERE id = ?', id)
      if (reservation === undefined) throw new LifeNotFoundError('cost reservation was not found', { reservationId: id })
      if (reservation.status !== 'reserved') {
        throw new LifeInvalidTransitionError('only a reserved cost can be settled', { status: reservation.status })
      }
      const amount = Number(reservation.amount)
      if (actual > amount) {
        throw new LifeValidationError('actual cost exceeds the reserved amount', { amount, actualCost: actual })
      }
      const now = this.core.iso()
      this.store.run(
        'UPDATE cost_reservations SET status = ?, settled_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND status = ?',
        'settled',
        now,
        now,
        id,
        'reserved',
      )
      const updated = this.store.run(
        `UPDATE budget_scopes SET cost_reserved = cost_reserved - ?, cost_used = cost_used + ?,
           revision = revision + 1, updated_at = ?
         WHERE scope = ? AND cost_reserved >= ?`,
        amount,
        actual,
        now,
        reservation.scope,
        amount,
      )
      if (Number(updated.changes) !== 1) {
        throw new LifeInvalidTransitionError('cost reservation accounting changed', { reservationId: id })
      }
      return this.#costReservationView(this.store.get('SELECT * FROM cost_reservations WHERE id = ?', id))
    })
  }

  /**
   * Release a reservation because the paid action was explicitly not executed.
   * Unknown outcomes must stay reserved.
   * @param {{reservationId: string, reason?: string}} input
   * @returns {Record<string, unknown>} reservation view.
   */
  releaseCost({ reservationId, reason } = {}) {
    const id = requireString(reservationId, 'reservationId', 200)
    return this.store.writeTransaction(() => {
      const reservation = this.store.get('SELECT * FROM cost_reservations WHERE id = ?', id)
      if (reservation === undefined) throw new LifeNotFoundError('cost reservation was not found', { reservationId: id })
      if (reservation.status !== 'reserved') {
        throw new LifeInvalidTransitionError('only a reserved cost can be released', { status: reservation.status })
      }
      const amount = Number(reservation.amount)
      const now = this.core.iso()
      this.store.run(
        'UPDATE cost_reservations SET status = ?, released_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND status = ?',
        'released',
        now,
        now,
        id,
        'reserved',
      )
      const updated = this.store.run(
        `UPDATE budget_scopes SET cost_reserved = cost_reserved - ?, revision = revision + 1, updated_at = ?
         WHERE scope = ? AND cost_reserved >= ?`,
        amount,
        now,
        reservation.scope,
        amount,
      )
      if (Number(updated.changes) !== 1) {
        throw new LifeInvalidTransitionError('cost reservation accounting changed', { reservationId: id })
      }
      return this.#costReservationView(this.store.get('SELECT * FROM cost_reservations WHERE id = ?', id))
    })
  }

  /** @param {string} reservationId */
  getCostReservation(reservationId) {
    const id = requireString(reservationId, 'reservationId', 200)
    const row = this.store.get('SELECT * FROM cost_reservations WHERE id = ?', id)
    if (row === undefined) throw new LifeNotFoundError('cost reservation was not found', { reservationId: id })
    return this.#costReservationView(row)
  }

  /** @param {Record<string, unknown>} row */
  #costReservationView(row) {
    return {
      id: row.id,
      scope: row.scope,
      amount: Number(row.amount),
      status: row.status,
      idempotencyKey: row.idempotency_key,
      revision: row.revision,
      createdAt: row.created_at,
      settledAt: row.settled_at,
      releasedAt: row.released_at,
    }
  }

  // Admin read/control surface for the native settings page -------------------
  /** @returns {Record<string, unknown>[]} safe Session binding views. */
  adminListBindings() {
    return this.store.all(
      `SELECT b.*, s.privacy AS scene_privacy, p.name AS persona_name
       FROM session_bindings b
       LEFT JOIN scenes s ON s.id = b.scene_id
       LEFT JOIN personas p ON p.id = b.persona_id
       ORDER BY b.target_session_id ASC`,
    ).map((row) => ({
      targetSessionId: row.target_session_id,
      personaId: row.persona_id,
      personaName: row.persona_name ?? null,
      sceneId: row.scene_id,
      privacy: row.scene_privacy ?? 'unknown',
      active: row.active === 1,
      revision: row.revision,
      updatedAt: row.updated_at,
    }))
  }

  /**
   * @param {{limit?: number, offset?: number}} [options]
   * @returns {{total: number, items: Record<string, unknown>[]}} bounded intents.
   */
  adminListIntents({ limit = 50, offset = 0 } = {}) {
    const take = assertInteger(limit, 'limit', { min: 1, max: 200 })
    const skip = assertInteger(offset, 'offset', { min: 0, max: 1_000_000 })
    const total = Number(this.store.get('SELECT COUNT(*) AS n FROM intents').n)
    const items = this.store.all(
      `SELECT id, revision, status, description, context_scope, related_activity_id,
              created_at, updated_at, review_at
       FROM intents ORDER BY review_at ASC, id ASC LIMIT ? OFFSET ?`,
      take,
      skip,
    ).map((row) => ({
      id: row.id,
      revision: row.revision,
      status: row.status,
      description: row.description,
      contextScope: row.context_scope,
      relatedActivityId: row.related_activity_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      reviewAt: row.review_at,
    }))
    return { total, items }
  }

  /**
   * @param {{limit?: number, offset?: number}} [options]
   * @returns {{total: number, items: Record<string, unknown>[]}} bounded activities.
   */
  adminListActivities({ limit = 50, offset = 0 } = {}) {
    const take = assertInteger(limit, 'limit', { min: 1, max: 200 })
    const skip = assertInteger(offset, 'offset', { min: 0, max: 1_000_000 })
    const total = Number(this.store.get('SELECT COUNT(*) AS n FROM activities').n)
    const items = this.store.all(
      'SELECT id, owner_scope FROM activities ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?',
      take,
      skip,
    ).map((row) => this.core.getActivity(row.id, { scope: row.owner_scope }))
    return { total, items }
  }

  /**
   * @param {{limit?: number}} [options]
   * @returns {Record<string, unknown>[]} recent wake summaries.
   */
  adminListWakes({ limit = 20 } = {}) {
    const take = assertInteger(limit, 'limit', { min: 1, max: 100 })
    return this.store.all(
      `SELECT id, origin, status, target_session_id, created_at, updated_at, executed_at,
              last_error, prepared_message_id, message_id
       FROM wake_requests ORDER BY created_at DESC, id ASC LIMIT ?`,
      take,
    ).map((row) => ({
      id: row.id,
      origin: row.origin ?? 'intent',
      status: row.status,
      targetSessionId: row.target_session_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      executedAt: row.executed_at,
      lastError: row.last_error,
      preparedMessageId: row.prepared_message_id,
      messageId: row.message_id,
    }))
  }

  /** @returns {Record<string, unknown>[]} configured budget views. */
  adminListBudgets() {
    return this.store.all('SELECT scope FROM budget_scopes ORDER BY scope ASC').map((row) => this.getBudget(row.scope))
  }

  /**
   * @param {string} intentId @param {number} expectedRevision
   * @returns {Record<string, unknown>} cancelled intent.
   */
  adminCancelIntent(intentId, expectedRevision) {
    const row = this.store.get('SELECT id, context_scope FROM intents WHERE id = ?', requireString(intentId, 'intentId', 200))
    if (row === undefined) throw new LifeNotFoundError('intent was not found', { intentId })
    return this.core.cancelIntent(row.id, { scope: row.context_scope, expectedRevision })
  }

  /**
   * @param {'pause'|'resume'|'cancel'} action @param {string} activityId
   * @returns {Promise<Record<string, unknown>>} updated activity.
   */
  async adminActivityAction(action, activityId) {
    if (!['pause', 'resume', 'cancel'].includes(action)) {
      throw new LifeValidationError('action must be pause, resume, or cancel')
    }
    const row = this.store.get('SELECT id, owner_scope FROM activities WHERE id = ?', requireString(activityId, 'activityId', 200))
    if (row === undefined) throw new LifeNotFoundError('activity was not found', { activityId })
    return this.operateActivity(action, row.id, row.owner_scope)
  }

  /**
   * @param {{targetSessionIds: string[], personaName?: string}} input
   * @returns {Record<string, unknown>} bootstrap result.
   */
  adminBootstrap(input) {
    return this.bootstrapLocalIdentity(input)
  }

  /**
   * @param {{targetSessionId: string, description: string, reviewAt: string}} input
   * @returns {Record<string, unknown>} created intent view.
   */
  adminCreateIntent({ targetSessionId, description, reviewAt } = {}) {
    const target = requireString(targetSessionId, 'targetSessionId', 200)
    if (!isDshSessionScope(`session:${target}`)) throw new LifeValidationError('targetSessionId must be a DSH Session id')
    const binding = this.getSessionBinding(target)
    if (!binding.active) throw new LifeUnauthorizedError('Session binding is inactive', { targetSessionId: target })
    const scope = `session:${target}`
    const intent = this.core.createIntent({
      description,
      reviewAt,
      contextScope: scope,
      authorizationRef: `admin:settings:${binding.revision}`,
    })
    return this.core.getIntent(intent.id, { scope })
  }

  /**
   * Start the local virtual Provider activity for an active Session binding.
   * @param {{targetSessionId: string, description: string, intentId?: string}} input
   */
  async adminStartActivity({ targetSessionId, description, intentId } = {}) {
    const target = requireString(targetSessionId, 'targetSessionId', 200)
    if (!isDshSessionScope(`session:${target}`)) throw new LifeValidationError('targetSessionId must be a DSH Session id')
    const binding = this.getSessionBinding(target)
    if (!binding.active) throw new LifeUnauthorizedError('Session binding is inactive', { targetSessionId: target })
    return this.startActivity({
      description,
      ownerScope: `session:${target}`,
      providerId: 'local-virtual',
      ...(intentId === undefined ? {} : { intentId }),
      personaId: binding.personaId,
      sceneId: binding.sceneId,
    })
  }

  /**
   * Give a real user turn priority over this Session's long activities.
   * @param {{targetSessionId: string}} input
   */
  async adminYieldActivities({ targetSessionId } = {}) {
    const target = requireString(targetSessionId, 'targetSessionId', 200)
    if (!isDshSessionScope(`session:${target}`)) throw new LifeValidationError('targetSessionId must be a DSH Session id')
    const binding = this.getSessionBinding(target)
    if (!binding.active) throw new LifeUnauthorizedError('Session binding is inactive', { targetSessionId: target })
    return this.yieldActivitiesToUser({ targetSessionId: target })
  }

  /**
   * @param {{targetSessionId: string}} input
   * @returns {Record<string, unknown>} revoked binding.
   */
  adminRevokeBinding({ targetSessionId } = {}) {
    return this.revokeSessionBinding({ targetSessionId })
  }

  // Attention, shared read, and usage accounting ----------------------------
  /**
   * Give a real user turn priority over same-Session long activities. Pause and
   * checkpoint when the Provider supports it; otherwise leave a conservative
   * unknown/coordinating state. Never completes, cancels, or resends an activity.
   * @param {{targetSessionId: string}} input - user Session.
   * @returns {Promise<Record<string, unknown>[]>} outcomes.
   */
  async yieldActivitiesToUser({ targetSessionId } = {}) {
    const target = requireString(targetSessionId, 'targetSessionId', 200)
    const scope = `session:${target}`
    const rows = this.store.all(
      `SELECT id FROM activities WHERE owner_scope = ? AND status IN ('running', 'paused') ORDER BY priority DESC, created_at ASC`,
      scope,
    )
    const outcomes = []
    for (const row of rows) {
      const activity = this.core.getActivity(row.id, { scope })
      const provider = this.providers.get(activity.providerId)
      if (provider === undefined) {
        outcomes.push({ activityId: activity.id, outcome: 'provider_missing' })
        continue
      }
      if (activity.status === 'paused') {
        outcomes.push({ activityId: activity.id, outcome: 'already_paused', checkpointRef: activity.checkpointRef })
        continue
      }
      if (typeof provider.pause !== 'function') {
        await this.#markUnknownForAttention(activity, scope)
        outcomes.push({ activityId: activity.id, outcome: 'unknown_pause_unsupported' })
        continue
      }
      try {
        const paused = await provider.pause({ activityId: activity.id })
        if (paused?.status !== 'paused') throw new Error('provider did not pause')
        const view = this.core.transitionActivity(activity.id, {
          scope,
          expectedRevision: activity.revision,
          to: 'paused',
          trustedEvidence: true,
          note: 'user turn priority',
        })
        let checkpointRef = view.checkpointRef
        if (typeof provider.checkpoint === 'function') {
          try {
            const checkpoint = await provider.checkpoint({ activityId: activity.id })
            if (typeof checkpoint.checkpointRef === 'string') {
              checkpointRef = checkpoint.checkpointRef
              this.store.run(
                `UPDATE activities SET checkpoint_ref = ?, revision = revision + 1, updated_at = ?
                 WHERE id = ? AND revision = ?`,
                checkpointRef,
                this.core.iso(),
                activity.id,
                view.revision,
              )
            }
          } catch {
            // Pause succeeded; checkpoint failure stays visible on the activity.
          }
        }
        outcomes.push({ activityId: activity.id, outcome: 'paused', checkpointRef })
      } catch {
        await this.#markUnknownForAttention(activity, scope)
        outcomes.push({ activityId: activity.id, outcome: 'unknown_pause_failed' })
      }
    }
    return outcomes
  }

  /** @param {Record<string, unknown>} activity @param {string} scope */
  async #markUnknownForAttention(activity, scope) {
    try {
      this.core.transitionActivity(activity.id, {
        scope,
        expectedRevision: activity.revision,
        to: 'unknown',
        note: 'user turn priority; provider pause unavailable',
      })
    } catch {
      // Preserve conservative state; never guess completion.
    }
  }

  /**
   * Explicitly revoke one cross-scope Scene grant. Reads are uncached, so the
   * next shared view immediately loses the scene's records.
   * @param {{sceneId: string, dataScope: string}} input
   * @returns {{revoked: boolean}} result.
   */
  revokeSceneShare({ sceneId, dataScope } = {}) {
    const scene = this.getScene(sceneId)
    const scope = requireString(dataScope, 'dataScope', 200)
    const result = this.store.run(
      'DELETE FROM scene_shares WHERE scene_id = ? AND data_scope = ?',
      scene.id,
      scope,
    )
    return { revoked: Number(result.changes) === 1 }
  }

  /**
   * Minimal read-only shared view derived from the caller's active binding.
   * Cross-scene records require an explicit shared scene + grant; private
   * descriptions and all authorization/principal fields are never returned.
   * @param {{targetSessionId: string}} input - caller Session.
   * @returns {Record<string, unknown>} shared view.
   */
  getSharedLifeView({ targetSessionId } = {}) {
    const target = requireString(targetSessionId, 'targetSessionId', 200)
    const callerScope = `session:${target}`
    const binding = this.store.get('SELECT * FROM session_bindings WHERE target_session_id = ?', target)
    if (binding === undefined || binding.active !== 1) {
      throw new LifeUnauthorizedError('an active Session binding is required for shared reads')
    }
    const scenes = this.store.all('SELECT * FROM scenes WHERE persona_id = ?', binding.persona_id)
    const visible = []
    for (const scene of scenes) {
      const own = scene.id === binding.scene_id
      let allowed = own
      if (!allowed && scene.privacy === 'shared') {
        allowed = this.store.get(
          'SELECT 1 AS found FROM scene_shares WHERE scene_id = ? AND data_scope = ?',
          scene.id,
          callerScope,
        ) !== undefined
      }
      if (!allowed) continue
      const intents = this.store.all(
        `SELECT id, status, revision, updated_at, review_at, description
         FROM intents
         WHERE scene_id = ?
         ORDER BY updated_at DESC, id ASC LIMIT 50`,
        scene.id,
      )
      const activities = this.store.all(
        `SELECT id, status, revision, updated_at, description, priority, checkpoint_ref
         FROM activities
         WHERE scene_id = ?
         ORDER BY priority DESC, updated_at DESC, id ASC LIMIT 50`,
        scene.id,
      )
      visible.push({
        id: scene.id,
        ...(own ? { personaId: scene.persona_id, dataScope: scene.context_scope } : {}),
        privacy: scene.privacy,
        owner: own,
        intents: intents.map((row) => (own
          ? {
              id: row.id,
              status: row.status,
              revision: row.revision,
              updatedAt: row.updated_at,
              reviewAt: row.review_at,
              description: row.description,
            }
          : {
              id: row.id,
              status: row.status,
              revision: row.revision,
              updatedAt: row.updated_at,
            })),
        activities: activities.map((row) => (own
          ? {
              id: row.id,
              status: row.status,
              revision: row.revision,
              updatedAt: row.updated_at,
              priority: row.priority,
              checkpointRef: row.checkpoint_ref,
              description: row.description,
            }
          : {
              id: row.id,
              status: row.status,
              revision: row.revision,
              updatedAt: row.updated_at,
              priority: row.priority,
            })),
      })
    }
    return {
      caller: {
        personaId: binding.persona_id,
        sceneId: binding.scene_id,
        bindingRevision: binding.revision,
        dataScope: callerScope,
      },
      scenes: visible,
    }
  }

  /**
   * Provider-evidenced finish. The model/tool only chooses the desired outcome;
   * completion/failure references come exclusively from the trusted Provider.
   * @param {string} activityId @param {string} scope @param {'completed'|'failed'} outcome
   * @returns {Promise<Record<string, unknown>>} activity view.
   */
  async finishActivity(activityId, scope, outcome = 'completed') {
    if (outcome !== 'completed' && outcome !== 'failed') {
      throw new LifeValidationError('outcome must be completed or failed')
    }
    const activity = this.core.getActivity(activityId, { scope })
    const provider = this.providers.get(activity.providerId)
    if (provider === undefined) throw new LifeNotFoundError('activity provider was not registered', { providerId: activity.providerId })
    const method = outcome === 'completed' ? provider.complete : provider.fail
    if (typeof method !== 'function') throw new LifeValidationError(`provider does not support ${outcome}`)
    const authRevision = this.#activityAuthRevision(activity)
    if (!this.#bindingStillValid(activity, authRevision)) {
      return this.#markUnknownIfActive(activityId, scope)
    }
    const result = await method.call(provider, { activityId })
    if (!this.#bindingStillValid(activity, authRevision)) {
      return this.#markUnknownIfActive(activityId, scope)
    }
    if (result?.status !== outcome) {
      throw new LifeInvalidTransitionError('provider did not confirm the requested outcome')
    }
    return this.core.transitionActivity(activityId, {
      scope,
      expectedRevision: activity.revision,
      to: outcome,
      evidenceRefs: result.evidenceRefs ?? [],
      trustedEvidence: true,
      note: `provider confirmed ${outcome}`,
    })
  }

  /**
   * Read one activity plus the Provider's current status without transitioning.
   * @param {string} activityId @param {string} scope
   * @returns {Promise<Record<string, unknown>>} activity and provider status.
   */
  async getActivityStatus(activityId, scope) {
    const activity = this.core.getActivity(activityId, { scope })
    const provider = this.providers.get(activity.providerId)
    const authRevision = this.#activityAuthRevision(activity)
    if (!this.#bindingStillValid(activity, authRevision)) {
      const current = await this.#markUnknownIfActive(activityId, scope)
      return { activity: current, providerStatus: 'unknown', evidenceRefs: [], revoked: true }
    }
    if (provider === undefined) {
      return { activity, providerStatus: 'missing', evidenceRefs: [] }
    }
    try {
      const status = await provider.status({ activityId: activity.id })
      if (!this.#bindingStillValid(activity, authRevision)) {
        const current = await this.#markUnknownIfActive(activityId, scope)
        return { activity: current, providerStatus: 'unknown', evidenceRefs: [], revoked: true }
      }
      return {
        activity,
        providerId: activity.providerId,
        providerStatus: status?.status ?? 'unknown',
        evidenceRefs: status?.evidenceRefs ?? [],
      }
    } catch {
      return { activity, providerId: activity.providerId, providerStatus: 'unknown', evidenceRefs: [] }
    }
  }

  /**
   * Idempotently record official `assistant/message.usage` for an autonomous
   * turn and add actual tokens/cost to the Session budget scope. Duplicate seq
   * is ignored; absent usage remains `usage unknown` at the caller.
   * @param {{targetSessionId: string, seq: number, usage: {inputTokens?: number, outputTokens?: number, totalTokens?: number, cost?: number}}} input - usage.
   * @returns {Record<string, unknown>} accounting result.
   */
  recordSessionUsage({ targetSessionId, seq, usage, wakeId = null } = {}) {
    const target = requireString(targetSessionId, 'targetSessionId', 200)
    const sequence = assertInteger(seq, 'seq', { min: 1 })
    if (usage === null || typeof usage !== 'object') {
      throw new LifeValidationError('usage must be an object')
    }
    const inputTokens = usage.inputTokens === undefined ? 0 : assertInteger(usage.inputTokens, 'usage.inputTokens', { min: 0 })
    const outputTokens = usage.outputTokens === undefined ? 0 : assertInteger(usage.outputTokens, 'usage.outputTokens', { min: 0 })
    const totalTokens = usage.totalTokens === undefined
      ? inputTokens + outputTokens
      : assertInteger(usage.totalTokens, 'usage.totalTokens', { min: 0 })
    const cost = usage.cost === undefined ? 0 : assertInteger(usage.cost, 'usage.cost', { min: 0 })
    const wake = wakeId === null || wakeId === undefined ? null : requireString(wakeId, 'wakeId', 200)
    const scope = `session:${target}`
    const nowMs = this.core.nowMs()
    const nowIso = this.core.iso(nowMs)
    return this.store.writeTransaction(() => {
      const result = this.store.run(
        `INSERT OR IGNORE INTO usage_events
          (target_session_id, seq, input_tokens, output_tokens, total_tokens, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        target,
        sequence,
        inputTokens,
        outputTokens,
        totalTokens,
        nowIso,
      )
      if (Number(result.changes) !== 1) {
        return { recorded: false, duplicate: true, totalTokens, scope }
      }
      const reservation = wake !== null
        ? this.store.get(
          "SELECT * FROM token_reservations WHERE wake_id = ? AND status = 'reserved' ORDER BY created_at DESC LIMIT 1",
          wake,
        )
        : this.store.get(
          "SELECT * FROM token_reservations WHERE session_scope = ? AND status = 'reserved' ORDER BY created_at ASC LIMIT 1",
          scope,
        )
      if (reservation === undefined) {
        // No reservation to settle (legacy/unconfigured). Record actual usage
        // conservatively on every currently effective configured scope.
        for (const scopeKey of this.#effectiveTokenScopes(scope)) {
          const budget = this.store.get('SELECT * FROM budget_scopes WHERE scope = ?', scopeKey)
          if (budget === undefined) continue
          const inWindow = nowMs - Date.parse(budget.window_start) < Number(budget.window_ms)
          const used = inWindow ? Number(budget.tokens_used) : 0
          this.store.run(
            `UPDATE budget_scopes SET window_start = ?, tokens_used = ?, cost_used = ?,
               revision = revision + 1, updated_at = ?
             WHERE scope = ?`,
            inWindow ? budget.window_start : nowIso,
            used + totalTokens,
            Number(budget.cost_used) + (scopeKey === scope ? cost : 0),
            nowIso,
            scopeKey,
          )
        }
        return { recorded: true, duplicate: false, totalTokens, scope, settled: null }
      }
      const reservedScopes = this.store.all(
        'SELECT * FROM token_reservation_scopes WHERE reservation_id = ? AND status = ?',
        reservation.id,
        'reserved',
      )
      for (const reserved of reservedScopes) {
        const budget = this.store.get('SELECT * FROM budget_scopes WHERE scope = ?', reserved.scope)
        if (budget === undefined) continue
        const inWindow = nowMs - Date.parse(budget.window_start) < Number(budget.window_ms)
        const used = inWindow ? Number(budget.tokens_used) : 0
        this.store.run(
          `UPDATE budget_scopes SET window_start = ?, tokens_used = ?,
             tokens_reserved = MAX(0, tokens_reserved - ?), cost_used = cost_used + ?,
             revision = revision + 1, updated_at = ?
           WHERE scope = ?`,
          inWindow ? budget.window_start : nowIso,
          used + totalTokens,
          Number(reserved.reserved_tokens),
          reserved.scope === scope ? cost : 0,
          nowIso,
          reserved.scope,
        )
        this.store.run(
          "UPDATE token_reservation_scopes SET status = 'settled', settled_tokens = ? WHERE reservation_id = ? AND scope = ?",
          totalTokens,
          reservation.id,
          reserved.scope,
        )
      }
      this.store.run(
        `UPDATE token_reservations SET status = 'settled', settled_tokens = ?,
           revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'reserved'`,
        totalTokens,
        nowIso,
        reservation.id,
      )
      return {
        recorded: true,
        duplicate: false,
        totalTokens,
        scope,
        settled: reservation.id,
        scopes: reservedScopes.map((row) => row.scope),
      }
    })
  }

  // Activity provider --------------------------------------------------------
  /** @param {object} provider - provider contract. */
  registerActivityProvider(provider) {
    for (const method of PROVIDER_METHODS) {
      if (typeof provider?.[method] !== 'function') {
        throw new LifeValidationError(`provider must implement ${method}()`)
      }
    }
    const id = requireString(provider.describe().providerId, 'providerId', 200)
    this.providers.set(id, provider)
    return id
  }

  /** @returns {Record<string, unknown>[]} provider descriptions. */
  listActivityProviders() {
    return [...this.providers.values()].map((provider) => provider.describe())
  }

  /**
   * Validate a new activity's intent link using the same invariants as
   * LifeCore.recordActivity. Must run inside the activity-insert transaction.
   * @param {string|null} intentId
   * @param {string} ownerScope
   */
  #assertIntentLink(intentId, ownerScope) {
    if (intentId === null || intentId === undefined) return
    const intent = this.store.get(
      'SELECT id, status, context_scope, related_activity_id FROM intents WHERE id = ?',
      intentId,
    )
    if (intent === undefined) {
      throw new LifeNotFoundError(`intent "${String(intentId)}" was not found`, { intentId })
    }
    if (intent.context_scope !== ownerScope) {
      throw new LifeUnauthorizedError('intent belongs to a different scope', { intentId })
    }
    if (intent.status === 'cancelled') {
      throw new LifeInvalidTransitionError('cannot link a new activity to a cancelled intent', { intentId })
    }
    if (intent.related_activity_id !== null) {
      const focus = this.store.get(
        'SELECT id, owner_scope, intent_id FROM activities WHERE id = ?',
        intent.related_activity_id,
      )
      if (focus === undefined) {
        throw new LifeValidationError(
          'intent focused activity no longer exists; refusing to start an inconsistent activity',
          { intentId, relatedActivityId: intent.related_activity_id },
        )
      }
      if (focus.owner_scope !== intent.context_scope) {
        throw new LifeUnauthorizedError(
          'intent focused activity belongs to a different scope; refusing to start an activity',
          { intentId, relatedActivityId: intent.related_activity_id },
        )
      }
      if (focus.intent_id !== null && focus.intent_id !== intent.id) {
        throw new LifeValidationError(
          'intent focused activity is bound to another intent; refusing to start an activity',
          { intentId, relatedActivityId: intent.related_activity_id },
        )
      }
    }
  }

  /**
   * @param {string} ownerScope
   * @param {string|null} personaId
   * @param {string|null} sceneId
   * @returns {{revision: number, active: boolean}|null} binding snapshot, or null when no identity is attached.
   */
  #bindingSnapshot(ownerScope, personaId, sceneId) {
    if (personaId === null || personaId === undefined) return null
    const target = String(ownerScope).startsWith('session:') ? String(ownerScope).slice('session:'.length) : null
    if (target === null) return null
    const row = this.store.get('SELECT * FROM session_bindings WHERE target_session_id = ?', target)
    if (row === undefined) return null
    return {
      revision: Number(row.revision),
      active: row.active === 1,
      personaId: row.persona_id,
      sceneId: row.scene_id,
    }
  }

  /**
   * @param {Record<string, unknown>} activity
   * @param {number|null} bindingRevision - null means no binding-derived identity.
   * @returns {boolean} whether the binding is still the exact active revision.
   */
  #bindingStillValid(activity, bindingRevision) {
    if (bindingRevision === null) return true
    const snapshot = this.#bindingSnapshot(activity.ownerScope, activity.personaId, activity.sceneId)
    return snapshot !== null && snapshot.active && snapshot.revision === bindingRevision
  }

  /**
   * Do not let a late Provider result revive work after revocation/rebind.
   * @param {string} activityId @param {string} scope
   * @returns {Promise<Record<string, unknown>>} refreshed activity.
   */
  async #markUnknownIfActive(activityId, scope) {
    const current = this.core.getActivity(activityId, { scope })
    if (['pending', 'running', 'paused', 'stopping'].includes(current.status)) {
      try {
        return this.core.transitionActivity(activityId, {
          scope,
          expectedRevision: current.revision,
          to: 'unknown',
          note: 'binding revoked or changed during Provider operation',
        })
      } catch {
        // A racing revocation already moved it; preserve conservative state.
      }
    }
    return this.core.getActivity(activityId, { scope })
  }

  /**
   * @param {Record<string, unknown>} activity
   * @returns {number|null} binding revision required for this activity, or null.
   */
  #activityAuthRevision(activity) {
    if (activity.personaId === null || activity.personaId === undefined) return null
    const snapshot = this.#bindingSnapshot(activity.ownerScope, activity.personaId, activity.sceneId)
    return snapshot !== null && snapshot.active ? snapshot.revision : -1
  }

  /**
   * Start one trusted activity through a registered provider.
   * @param {{description: string, ownerScope: string, providerId?: string, intentId?: string, priority?: number, personaId?: string, sceneId?: string, deadlineAt?: string, resourceLease?: string}} input - activity.
   * @returns {Promise<Record<string, unknown>>} activity view.
   */
  async startActivity({
    description,
    ownerScope,
    providerId = 'local-virtual',
    intentId,
    priority = 0,
    personaId,
    sceneId,
    deadlineAt,
    resourceLease,
  } = {}) {
    const provider = this.providers.get(requireString(providerId, 'providerId', 200))
    if (provider === undefined) throw new LifeNotFoundError('activity provider was not registered', { providerId })
    const owner = requireString(ownerScope, 'ownerScope', 200)
    const activityId = `activity_${randomUUID()}`
    const now = this.core.iso()
    const descriptionValue = requireString(description, 'description', 4000)
    const priorityValue = assertInteger(priority, 'priority', { min: 0, max: 100 })
    const deadlineValue = deadlineAt === undefined ? null : normalizeTimestamp(deadlineAt, 'deadlineAt')
    const identityBinding = this.#bindingSnapshot(owner, personaId ?? null, sceneId ?? null)
    if (personaId !== undefined && personaId !== null && (identityBinding === null || !identityBinding.active)) {
      throw new LifeUnauthorizedError('an active Session binding is required to start an identity-bound activity')
    }
    try {
      this.store.writeTransaction(() => {
        this.#assertIntentLink(intentId ?? null, owner)
        if (personaId !== undefined && personaId !== null) {
          const current = this.#bindingSnapshot(owner, personaId, sceneId ?? null)
          if (
            current === null ||
            !current.active ||
            current.revision !== identityBinding.revision
          ) {
            throw new LifeUnauthorizedError('Session binding changed during activity start')
          }
        }
        this.#assertActivityCapacity({ ownerScope: owner, personaId: personaId ?? null })
        this.store.run(
          `INSERT INTO activities
            (id, revision, status, description, provider_id, intent_id, owner_scope, evidence_json,
             created_at, updated_at, persona_id, scene_id, priority, checkpoint_ref, resource_lease, deadline_at,
             provider_managed)
           VALUES (?, 1, 'pending', ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, NULL, ?, ?, 1)`,
          activityId,
          descriptionValue,
          providerId,
          intentId ?? null,
          owner,
          now,
          now,
          personaId ?? null,
          sceneId ?? null,
          priorityValue,
          resourceLease ?? null,
          deadlineValue,
        )
      })
    } catch (error) {
      if (resourceLease !== undefined && /UNIQUE|constraint/i.test(String(error?.message))) {
        throw new LifeValidationError('resource lease is already held by another active activity', { resourceLease })
      }
      throw error
    }
    const inserted = this.core.getActivity(activityId, { scope: owner })
    const bindingRevision = identityBinding === null ? null : identityBinding.revision
    if (!this.#bindingStillValid(inserted, bindingRevision)) {
      return this.#markUnknownIfActive(activityId, owner)
    }
    try {
      const started = await provider.start({
        activityId,
        purposeRef: intentId ?? activityId,
        deadlineAt: deadlineAt ?? undefined,
      })
      if (!this.#bindingStillValid(inserted, bindingRevision)) {
        return this.#markUnknownIfActive(activityId, owner)
      }
      if (started?.status === 'running') {
        this.store.run(
          `UPDATE activities SET revision = 2, status = 'running', evidence_json = ?, checkpoint_ref = ?, updated_at = ?
           WHERE id = ? AND revision = 1 AND status = 'pending'`,
          JSON.stringify(started.evidenceRefs ?? []),
          started.checkpointRef ?? null,
          this.core.iso(),
          activityId,
        )
      } else if (started?.status === 'failed') {
        this.store.run(
          `UPDATE activities SET revision = 2, status = 'failed', evidence_json = ?, updated_at = ?
           WHERE id = ? AND revision = 1 AND status = 'pending'`,
          JSON.stringify(started.evidenceRefs ?? []),
          this.core.iso(),
          activityId,
        )
      } else {
        return this.#markUnknownIfActive(activityId, owner)
      }
    } catch {
      // Provider crash is uncertain, never failed/completed by guess. A revoked
      // binding keeps the pending/unknown activity and its lease for reconcile.
      this.store.run(
        `UPDATE activities SET revision = 2, status = 'unknown', updated_at = ?
         WHERE id = ? AND revision = 1 AND status = 'pending'`,
        this.core.iso(),
        activityId,
      )
    }
    return this.core.getActivity(activityId, { scope: owner })
  }

  /**
   * Pause, resume, checkpoint, cancel, or reconcile an activity via its provider.
   * @param {'pause'|'resume'|'checkpoint'|'cancel'|'reconcile'} action - operation.
   * @param {string} activityId - activity id.
   * @param {string} scope - owner scope.
   * @returns {Promise<Record<string, unknown>>} activity view.
   */
  async operateActivity(action, activityId, scope) {
    const activity = this.core.getActivity(activityId, { scope })
    const provider = this.providers.get(activity.providerId)
    if (provider === undefined) throw new LifeNotFoundError('activity provider was not registered', { providerId: activity.providerId })
    const call = provider[action]
    if (typeof call !== 'function') throw new LifeValidationError(`provider does not support ${action}`)
    const authRevision = this.#activityAuthRevision(activity)
    if (!this.#bindingStillValid(activity, authRevision)) {
      return this.#markUnknownIfActive(activityId, scope)
    }
    if (action === 'pause') {
      if (activity.status !== 'running') throw new LifeInvalidTransitionError('only running activities can pause')
      const result = await call.call(provider, { activityId })
      if (!this.#bindingStillValid(activity, authRevision)) {
        return this.#markUnknownIfActive(activityId, scope)
      }
      if (result.status === 'paused') {
        return this.core.transitionActivity(activityId, {
          scope,
          expectedRevision: activity.revision,
          to: 'paused',
          trustedEvidence: true,
        })
      }
      throw new LifeInvalidTransitionError('provider did not pause the activity')
    }
    if (action === 'resume') {
      if (activity.status !== 'paused') throw new LifeInvalidTransitionError('only paused activities can resume')
      const result = await call.call(provider, { activityId })
      if (!this.#bindingStillValid(activity, authRevision)) {
        return this.#markUnknownIfActive(activityId, scope)
      }
      if (result.status === 'running') {
        return this.core.transitionActivity(activityId, {
          scope,
          expectedRevision: activity.revision,
          to: 'running',
          trustedEvidence: true,
        })
      }
      throw new LifeInvalidTransitionError('provider did not resume the activity')
    }
    if (action === 'checkpoint') {
      const result = await call.call(provider, { activityId })
      if (!this.#bindingStillValid(activity, authRevision)) {
        return this.#markUnknownIfActive(activityId, scope)
      }
      if (typeof result.checkpointRef !== 'string') throw new LifeValidationError('provider did not return a checkpoint')
      this.store.run(
        `UPDATE activities SET revision = revision + 1, checkpoint_ref = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
        result.checkpointRef,
        this.core.iso(),
        activityId,
        activity.revision,
      )
      return this.core.getActivity(activityId, { scope })
    }
    if (action === 'cancel') {
      let current = activity
      if (current.status === 'running' || current.status === 'paused') {
        current = this.core.requestCancelActivity(activityId, { scope, expectedRevision: current.revision })
      }
      try {
        const result = await call.call(provider, { activityId })
        if (!this.#bindingStillValid(activity, authRevision)) {
          return this.#markUnknownIfActive(activityId, scope)
        }
        if (result.status === 'cancelled') {
          return this.core.transitionActivity(activityId, {
            scope,
            expectedRevision: current.revision,
            to: 'cancelled',
            evidenceRefs: result.evidenceRefs ?? [],
            trustedEvidence: true,
            note: 'provider confirmed cancellation',
          })
        }
        if (result.status === 'unknown') {
          return this.core.transitionActivity(activityId, {
            scope,
            expectedRevision: current.revision,
            to: 'unknown',
            note: 'provider returned unknown cancellation state',
          })
        }
      } catch {
        if (current.status === 'stopping') {
          return this.core.transitionActivity(activityId, {
            scope,
            expectedRevision: current.revision,
            to: 'unknown',
            note: 'provider did not confirm cancellation',
          })
        }
      }
      return this.core.getActivity(activityId, { scope })
    }
    if (action === 'reconcile') {
      const result = await call.call(provider, { activityId })
      if (!this.#bindingStillValid(activity, authRevision)) {
        return this.#markUnknownIfActive(activityId, scope)
      }
      if (result.status === 'completed' && activity.status === 'unknown') {
        return this.core.transitionActivity(activityId, {
          scope,
          expectedRevision: activity.revision,
          to: 'completed',
          evidenceRefs: result.evidenceRefs ?? [],
          trustedEvidence: true,
          note: 'provider reconciliation',
        })
      }
      if (result.status === 'failed' && activity.status === 'unknown') {
        return this.core.transitionActivity(activityId, {
          scope,
          expectedRevision: activity.revision,
          to: 'failed',
          evidenceRefs: result.evidenceRefs ?? [],
          trustedEvidence: true,
          note: 'provider reconciliation',
        })
      }
      if (result.status === 'cancelled' && activity.status === 'unknown') {
        return this.core.transitionActivity(activityId, {
          scope,
          expectedRevision: activity.revision,
          to: 'cancelled',
          evidenceRefs: result.evidenceRefs ?? [],
          trustedEvidence: true,
          note: 'provider reconciliation',
        })
      }
      return this.core.getActivity(activityId, { scope })
    }
    throw new LifeValidationError(`unsupported activity operation ${String(action)}`)
  }
}
