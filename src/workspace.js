/**
 * Workspace-level Life policy.
 *
 * The official `ctx.workspaceRegistry` is the only membership authority. Entity
 * ids/titles are for display; authorization always re-reads `entity.sessionIds`,
 * which the registry filters by persisted canonical Session cwd. Display names
 * and paths are never used for authorization.
 *
 * Legacy Life 1.0 allowlists remain in force until an administrator explicitly
 * activates workspace coverage. Binding a workspace does not widen wake rights.
 */

import { randomUUID } from 'node:crypto'
import {
  LifeNotFoundError,
  LifeRevisionConflictError as LifeConflictError,
  LifeUnauthorizedError,
  LifeValidationError,
  assertInteger,
  isDshSessionScope,
  requireString,
} from './model.js'

export const SESSION_MODES = Object.freeze(['inherit', 'passive', 'independent', 'disabled'])
const SCOPE_PREFIX = 'session:'

function assertSessionId(sessionId) {
  const value = requireString(sessionId, 'targetSessionId', 200)
  if (!isDshSessionScope(`${SCOPE_PREFIX}${value}`)) throw new LifeValidationError('targetSessionId must be a DSH Session id')
  return value
}

function optionalLimit(value, name, max) {
  if (value === undefined || value === null) return null
  return assertInteger(value, name, { min: 0, max })
}

export class WorkspacePolicy {
  /**
   * @param {object} options
   * @param {import('./store.js').LifeStore} options.store
   * @param {import('./life-v1.js').LifeV1} options.v1
   * @param {() => Record<string, any>|undefined} options.getRegistry
   * @param {() => string[]} options.legacyAllowed
   * @param {() => Record<string, any>} options.budgetConfig
   * @param {import('./core.js').LifeCore} options.core
   */
  constructor({ store, v1, core, getRegistry, legacyAllowed, budgetConfig, logger } = {}) {
    this.store = store
    this.v1 = v1
    this.core = core
    this.getRegistry = getRegistry
    this.legacyAllowed = legacyAllowed
    this.budgetConfig = budgetConfig
    this.logger = logger
    this.lastError = null
    this.budgetSignature = null
  }

  #registry() {
    const registry = typeof this.getRegistry === 'function' ? this.getRegistry() : undefined
    return registry && typeof registry.get === 'function' && typeof registry.list === 'function' ? registry : undefined
  }

  #bindingRow() {
    return this.store.get('SELECT * FROM life_workspace WHERE singleton = 1')
  }

  /** @returns {Record<string, unknown>|null} */
  binding() {
    const row = this.#bindingRow()
    if (row === undefined) return null
    return {
      workspaceId: row.workspace_id,
      title: row.workspace_title,
      personaId: row.persona_id,
      activated: row.activated === 1,
      legacyMigrated: row.legacy_migrated === 1,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /** @returns {Array<{id: string, title: string, sessionIds: string[]}>} */
  listWorkspaces() {
    const registry = this.#registry()
    if (registry === undefined) return []
    return registry.list().map((entity) => ({
      id: String(entity.id),
      title: typeof entity.title === 'string' ? entity.title : '',
      sessionIds: Array.isArray(entity.sessionIds) ? [...entity.sessionIds] : [],
    }))
  }

  /** @param {string} workspaceId */
  #entity(workspaceId) {
    const registry = this.#registry()
    if (registry === undefined) return { error: 'workspace_registry_unavailable' }
    const entity = registry.get(workspaceId)
    if (entity === undefined) return { error: 'workspace_not_found' }
    return { entity }
  }

  /** @returns {Record<string, unknown>} */
  health() {
    const binding = this.binding()
    const registry = this.#registry()
    return {
      available: registry !== undefined,
      binding,
      lastError: this.lastError,
      workspaces: registry === undefined ? 'unavailable' : 'available',
    }
  }

  /**
   * Bind one existing official workspace and one stable Persona. This does not
   * activate autonomous wake for all members.
   * @param {{workspaceId: string, personaName?: string}} input
   */
  bind({ workspaceId, personaName = 'Amadeus' } = {}) {
    const id = requireString(workspaceId, 'workspaceId', 200)
    const name = requireString(personaName, 'personaName', 200)
    const { entity, error } = this.#entity(id)
    if (error) throw new LifeValidationError(`cannot bind workspace: ${error}`)
    const existing = this.binding()
    if (existing !== null && existing.workspaceId !== id) {
      throw new LifeConflictError('a different workspace is already bound; remove/migrate explicitly before rebinding')
    }
    const members = [...entity.sessionIds].filter((sessionId) => !this.#archived().includes(sessionId))
    let personaId = existing?.personaId
    if (personaId === undefined) {
      if (members.length > 0) {
        const result = this.v1.bootstrapLocalIdentity({ targetSessionIds: members, personaName: name })
        personaId = result.personaId
      } else {
        personaId = this.v1.createPersona({ id: 'life_bootstrap_persona', name }).id
      }
    }
    const now = this.core.iso()
    this.store.writeTransaction(() => {
      if (existing === null) {
        this.store.run(
          `INSERT INTO life_workspace
            (singleton, workspace_id, workspace_title, persona_id, activated, legacy_migrated, revision, created_at, updated_at)
           VALUES (1, ?, ?, ?, 0, 0, 1, ?, ?)`,
          id,
          typeof entity.title === 'string' ? entity.title : '',
          personaId,
          now,
          now,
        )
      } else {
        this.store.run(
          'UPDATE life_workspace SET workspace_title = ?, updated_at = ?, revision = revision + 1 WHERE singleton = 1',
          typeof entity.title === 'string' ? entity.title : '',
          now,
        )
      }
    })
    try {
      this.#ensureBindings(entity, name)
      this.#syncBudgets(entity)
    } catch (error) {
      if (existing === null) {
        this.store.run('DELETE FROM life_workspace WHERE singleton = 1')
      }
      throw error
    }
    return this.binding()
  }

  /**
   * Explicitly activate workspace-wide wake coverage. Legacy allowlists remain
   * untouched and no historical intent/wake is replayed.
   * @param {{acknowledgeLegacy?: boolean}} input
   */
  activate({ acknowledgeLegacy = false } = {}) {
    const binding = this.binding()
    if (binding === null) throw new LifeValidationError('bind a workspace before activating it')
    if (acknowledgeLegacy !== true) {
      throw new LifeValidationError('explicit acknowledgement is required: existing allowlist will not be treated as workspace-wide consent')
    }
    const { entity, error } = this.#entity(binding.workspaceId)
    if (error) throw new LifeValidationError(`cannot activate workspace: ${error}`)
    this.#ensureBindings(entity)
    const now = this.core.iso()
    this.store.writeTransaction(() => {
      this.store.run(
        'UPDATE life_workspace SET activated = 1, legacy_migrated = 1, revision = revision + 1, updated_at = ? WHERE singleton = 1',
        now,
      )
    })
    this.#syncBudgets(entity)
    return this.binding()
  }

  #archived() {
    const registry = this.#registry()
    return Array.isArray(registry?.archivedSessionIds) ? registry.archivedSessionIds : []
  }

  #ensureBindings(entity, personaName = null) {
    const binding = this.binding()
    if (binding === null) return
    const name = personaName ?? this.store.get('SELECT name FROM personas WHERE id = ?', binding.personaId)?.name
    if (typeof name !== 'string' || name.length === 0) {
      throw new LifeConflictError('bound Workspace Persona is missing; refusing to create Session bindings')
    }
    const archived = new Set(this.#archived())
    const members = (Array.isArray(entity.sessionIds) ? entity.sessionIds : []).filter((id) => !archived.has(id))
    const missing = []
    for (const sessionId of members) {
      try {
        const current = this.v1.getSessionBinding(sessionId)
        if (current.personaId !== binding.personaId) {
          const message = `Session ${sessionId} is bound to a different Persona/Scene; workspace binding is incomplete`
          this.lastError = message
          throw new LifeConflictError(message)
        }
        if (!current.active) missing.push(sessionId)
      } catch (error) {
        if (error instanceof LifeNotFoundError) missing.push(sessionId)
        else throw error
      }
    }
    if (missing.length > 0) {
      try {
        this.v1.bootstrapLocalIdentity({ targetSessionIds: missing, personaName: name })
        this.lastError = null
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
        throw new LifeConflictError(`cannot complete workspace Session bindings: ${this.lastError}`)
      }
    }
  }

  #ruleRow(sessionId) {
    return this.store.get('SELECT * FROM session_rules WHERE target_session_id = ?', sessionId)
  }

  /**
   * Resolve current mode and membership. Re-reads the registry every call.
   * @param {string} sessionId
   */
  resolve(sessionId) {
    const binding = this.binding()
    if (binding === null) {
      const id = String(sessionId)
      return { sessionId: id, mode: 'legacy', member: this.legacyAllowed().includes(id), source: 'legacy_allowlist', eligibleWake: this.legacyAllowed().includes(id) }
    }
    const id = assertSessionId(sessionId)
    const { entity, error } = this.#entity(binding.workspaceId)
    if (error) return { sessionId: id, mode: 'unavailable', member: false, source: error, eligibleWake: false }
    const member = Array.isArray(entity.sessionIds) && entity.sessionIds.includes(id)
    if (!member) return { sessionId: id, mode: 'outside', member: false, source: 'workspace_membership', eligibleWake: false }
    if (this.#archived().includes(id)) {
      return { sessionId: id, mode: 'archived', member: false, source: 'workspace_archive', eligibleWake: false }
    }
    const row = this.#ruleRow(id)
    const mode = row?.mode ?? 'inherit'
    const independent = mode === 'independent'
    const eligibleWake = (mode === 'inherit' || independent) && (binding.activated === true || this.legacyAllowed().includes(id))
    return {
      sessionId: id,
      mode,
      member: true,
      source: row ? 'session_rule' : 'workspace_default',
      eligibleWake,
      rule: row
        ? {
            wakeLimit: row.wake_limit,
            tokenLimit: row.token_limit,
            activityLimit: row.activity_limit,
            quietStartHour: row.quiet_start_hour,
            quietEndHour: row.quiet_end_hour,
            revision: row.revision,
          }
        : null,
    }
  }

  /** @param {string} sessionId @returns {number[]|null} */
  quietHoursFor(sessionId) {
    const resolved = this.resolve(sessionId)
    if (resolved.mode !== 'independent' || !resolved.rule) return null
    const { quietStartHour, quietEndHour } = resolved.rule
    if (!Number.isInteger(quietStartHour) || !Number.isInteger(quietEndHour)) return null
    return [quietStartHour, quietEndHour]
  }

  /** @param {string} sessionId */
  isDeliverable(sessionId) {
    const binding = this.binding()
    if (binding === null) return this.legacyAllowed().includes(sessionId)
    const resolved = this.resolve(sessionId)
    if (!resolved.member || !resolved.eligibleWake) return false
    try {
      const sessionBinding = this.v1.getSessionBinding(sessionId)
      return sessionBinding.active === true && sessionBinding.personaId === binding.personaId
    } catch {
      return false
    }
  }

  /** @returns {string[]} current trusted wake targets. */
  wakeTargets() {
    const binding = this.binding()
    if (binding === null) return [...new Set(this.legacyAllowed())]
    if (binding.activated !== true) {
      const { entity, error } = this.#entity(binding.workspaceId)
      if (error) {
        this.lastError = error
        return []
      }
      return [...new Set(this.legacyAllowed())].filter((sessionId) =>
        entity.sessionIds.includes(sessionId) &&
        !this.#archived().includes(sessionId) &&
        this.resolve(sessionId).eligibleWake,
      )
    }
    const { entity, error } = this.#entity(binding.workspaceId)
    if (error) {
      this.lastError = error
      return []
    }
    this.#ensureBindings(entity)
    this.#syncBudgets(entity)
    return [...new Set(entity.sessionIds)].filter((sessionId) => {
      const resolved = this.resolve(sessionId)
      if (!resolved.member || !resolved.eligibleWake) return false
      try {
        const sessionBinding = this.v1.getSessionBinding(sessionId)
        return sessionBinding.active === true && sessionBinding.personaId === binding.personaId
      } catch {
        return false
      }
    })
  }

  /** @returns {Array<Record<string, unknown>>} current members with effective mode. */
  sessions() {
    const binding = this.binding()
    if (binding === null) return []
    const { entity, error } = this.#entity(binding.workspaceId)
    if (error) return []
    // New Workspace members inherit Life identity even while autonomous wake
    // remains disabled. A listing is also the first contact after cold start.
    this.#ensureBindings(entity)
    return [...entity.sessionIds].filter((id) => !this.#archived().includes(id)).map((sessionId) => this.resolve(sessionId))
  }

  /** Reject a Life model tool for an outside/disabled member. */
  assertTool(sessionId) {
    const resolved = this.resolve(sessionId)
    if (resolved.mode === 'disabled' || resolved.mode === 'outside' || resolved.mode === 'archived' || resolved.mode === 'unavailable') {
      throw new LifeUnauthorizedError('Life is not enabled for this Session workspace rule', { sessionId, mode: resolved.mode })
    }
    const binding = this.binding()
    if (binding !== null) {
      this.#ensureBindings({ sessionIds: [resolved.sessionId] })
      const sessionBinding = this.v1.getSessionBinding(resolved.sessionId)
      if (!sessionBinding.active || sessionBinding.personaId !== binding.personaId) {
        throw new LifeUnauthorizedError('Session does not have the bound Workspace Persona', { sessionId })
      }
    }
    return resolved
  }

  /** Activity starts are denied for passive and disabled modes. */
  assertActivityStart(sessionId) {
    const resolved = this.assertTool(sessionId)
    if (resolved.mode === 'passive') {
      throw new LifeUnauthorizedError('passive Session rules do not allow autonomous activity starts', { sessionId })
    }
    const limit = resolved.rule?.activityLimit
    if (resolved.mode === 'independent' && limit !== null && limit !== undefined) {
      const count = this.store.get(
        `SELECT COUNT(*) AS n FROM activities
         WHERE owner_scope = ? AND status IN ('pending', 'running', 'paused', 'stopping', 'unknown')`,
        `${SCOPE_PREFIX}${sessionId}`,
      )
      if (Number(count.n) >= Number(limit)) {
        throw new LifeValidationError('independent session activity limit reached', { sessionId, limit })
      }
    }
    return resolved
  }

  /**
   * Set or clear one session override. Membership is checked against the live
   * registry; outside Sessions cannot be assigned.
   * @param {{sessionId: string, mode: string, wakeLimit?: number|null, tokenLimit?: number|null, activityLimit?: number|null, quietStartHour?: number|null, quietEndHour?: number|null}} input
   */
  setRule({ sessionId, mode, wakeLimit = null, tokenLimit = null, activityLimit = null, quietStartHour = null, quietEndHour = null } = {}, { deferActivityYield = false } = {}) {
    const id = assertSessionId(sessionId)
    if (!SESSION_MODES.includes(mode)) throw new LifeValidationError(`mode must be one of ${SESSION_MODES.join(', ')}`)
    const binding = this.binding()
    if (binding === null) throw new LifeValidationError('bind a workspace before assigning session rules')
    const { entity, error } = this.#entity(binding.workspaceId)
    if (error || !entity.sessionIds.includes(id) || this.#archived().includes(id)) {
      throw new LifeUnauthorizedError('Session is not a current member or is archived in the bound workspace', { sessionId: id })
    }
    const start = mode === 'independent' ? optionalLimit(quietStartHour, 'quietStartHour', 23) : null
    const end = mode === 'independent' ? optionalLimit(quietEndHour, 'quietEndHour', 23) : null
    if ((start === null) !== (end === null)) throw new LifeValidationError('quiet hours require both start and end')
    const caps = this.#effectiveLimits(mode, {
      wakeLimit: optionalLimit(wakeLimit, 'wakeLimit', 1_000_000),
      tokenLimit: optionalLimit(tokenLimit, 'tokenLimit', 1_000_000_000),
      activityLimit: optionalLimit(activityLimit, 'activityLimit', 1_000),
    })
    const now = this.core.iso()
    this.store.writeTransaction(() => {
      const existing = this.#ruleRow(id)
      if (existing === undefined) {
        this.store.run(
          `INSERT INTO session_rules
            (target_session_id, workspace_id, mode, wake_limit, token_limit, activity_limit, quiet_start_hour, quiet_end_hour, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          id, binding.workspaceId, mode, caps.wakeLimit, caps.tokenLimit, caps.activityLimit, start, end, now, now,
        )
      } else {
        this.store.run(
          `UPDATE session_rules SET mode = ?, wake_limit = ?, token_limit = ?, activity_limit = ?,
             quiet_start_hour = ?, quiet_end_hour = ?, revision = revision + 1, updated_at = ?
           WHERE target_session_id = ?`,
          mode, caps.wakeLimit, caps.tokenLimit, caps.activityLimit, start, end, now, id,
        )
      }
    })
    this.#syncBudgets(entity)
    if ((mode === 'disabled' || mode === 'passive') && !deferActivityYield) {
      // Conservative attention handling: pause/checkpoint where possible;
      // otherwise mark unknown. Never forge completion or deletion.
      try {
        const outcomes = this.v1.yieldActivitiesToUser({ targetSessionId: id })
        if (outcomes && typeof outcomes.then === 'function') outcomes.catch(() => {})
      } catch (error) {
        this.logger?.warn?.(`amadeus-life: could not pause activities for ${id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return this.resolve(id)
  }

  /**
   * Owner-facing rule update that waits for the conservative activity yield.
   * Failures are returned as an explicit degraded result; completion is never
   * fabricated or claimed from a failed Provider pause.
   * @param {Record<string, unknown>} input
   */
  async setRuleAsync(input = {}) {
    const result = this.setRule(input, { deferActivityYield: true })
    if (result.mode !== 'disabled' && result.mode !== 'passive') {
      return { ...result, activityYield: { status: 'not_required', outcomes: [] } }
    }
    try {
      const outcomes = await this.v1.yieldActivitiesToUser({ targetSessionId: result.sessionId })
      return { ...result, activityYield: { status: 'ok', outcomes: Array.isArray(outcomes) ? outcomes : [] } }
    } catch (error) {
      return {
        ...result,
        activityYield: {
          status: 'degraded',
          outcomes: [],
          error: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }

  #cap(requested, global) {
    if (requested === null || requested === undefined) return global ?? null
    if (global === null || global === undefined) return requested
    return Math.min(requested, global)
  }

  #effectiveLimits(mode, requested = {}) {
    const global = this.budgetConfig()
    const inherited = {
      wakeLimit: global.enabled === true ? global.wakeLimit : null,
      tokenLimit: global.enabled === true ? global.tokenLimit : null,
      costLimit: global.enabled === true ? global.costLimit ?? null : null,
      activityLimit: global.activityLimit ?? null,
    }
    if (mode !== 'independent') return inherited
    return {
      wakeLimit: this.#cap(requested.wakeLimit, inherited.wakeLimit),
      tokenLimit: this.#cap(requested.tokenLimit, inherited.tokenLimit),
      costLimit: inherited.costLimit,
      activityLimit: this.#cap(requested.activityLimit, inherited.activityLimit),
    }
  }

  #configureScope(scope, limits) {
    const global = this.budgetConfig()
    this.v1.configureBudget({
      scope,
      windowMs: global.windowMs,
      wakeLimit: limits.wakeLimit,
      tokenLimit: limits.tokenLimit,
      costLimit: limits.costLimit,
      activityLimit: limits.activityLimit,
    })
  }

  #syncBudgets(entity) {
    const binding = this.binding()
    if (binding === null) return
    const global = this.budgetConfig()
    const archived = new Set(this.#archived())
    const activityLimit = global.activityLimit ?? null
    const hasBudget = global.enabled === true || activityLimit !== null
    if (!hasBudget) return
    const members = entity.sessionIds.filter((id) => !archived.has(id)).map((id) => this.resolve(id))
    const signature = JSON.stringify({
      workspaceId: binding.workspaceId,
      personaId: binding.personaId,
      budget: global,
      members: members.map((member) => ({ sessionId: member.sessionId, mode: member.mode, rule: member.rule })),
    })
    if (this.budgetSignature === signature) return
    const caps = this.#effectiveLimits('inherit')
    this.#configureScope('global', caps)
    this.#configureScope(`persona:${binding.personaId}`, caps)
    for (const member of members) {
      if (!member.member || member.mode === 'disabled') continue
      this.#configureScope(`${SCOPE_PREFIX}${member.sessionId}`, this.#effectiveLimits(member.mode, member.rule ?? {}))
    }
    this.budgetSignature = signature
  }

  /** @returns {Record<string, unknown>} GUI-safe workspace status. */
  view() {
    return {
      workspaces: this.listWorkspaces(),
      binding: this.binding(),
      sessions: this.sessions(),
      health: this.health(),
    }
  }
}

export { randomUUID }
