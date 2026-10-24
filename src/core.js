/**
 * Amadeus Life core: durable intents, activity state, and reconsideration
 * outbox, with an injected clock and no model calls.
 *
 * The core never sends messages, never starts an LLM loop, and never performs
 * external actions. A due review produces exactly one reference-bearing local
 * reconsideration event per intent revision; acknowledging that event is a
 * local bookkeeping fact, not proof of external completion.
 */

import { randomUUID } from 'node:crypto'
import { LifeStore } from './store.js'
import {
  ACTIVITY_STATUSES,
  INTENT_STATUSES,
  LIFE_SCHEMA_VERSION,
  LifeClosedError,
  LifeInvalidTransitionError,
  LifeNotFoundError,
  LifeRevisionConflictError,
  LifeStaleResultError,
  LifeUnauthorizedError,
  LifeValidationError,
  assertActivityTransition,
  assertInteger,
  normalizeTimestamp,
  reconsiderationEventId,
  requireString,
} from './model.js'

const EVENT_STATUSES = Object.freeze(['pending', 'acknowledged', 'superseded'])
const INTENT_PATCH_FIELDS = Object.freeze(['description', 'reviewAt', 'relatedActivityId'])

/**
 * Convert one `intents` row into the public intent view.
 * @param {Record<string, unknown>} row - database row.
 * @returns {Record<string, unknown>} intent view.
 */
function intentView(row) {
  return {
    id: row.id,
    revision: row.revision,
    status: row.status,
    description: row.description,
    contextScope: row.context_scope,
    authorizationRef: row.authorization_ref,
    relatedActivityId: row.related_activity_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewAt: row.review_at,
  }
}

/**
 * Convert one `activities` row into the public activity view.
 * @param {Record<string, unknown>} row - database row.
 * @returns {Record<string, unknown>} activity view.
 */
function activityView(row) {
  return {
    id: row.id,
    revision: row.revision,
    status: row.status,
    description: row.description,
    providerId: row.provider_id,
    intentId: row.intent_id,
    ownerScope: row.owner_scope,
    evidenceRefs: JSON.parse(String(row.evidence_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Build a status-count map with every declared status present.
 * @param {Record<string, unknown>[]} rows - `{ status, n }` rows.
 * @param {readonly string[]} statuses - statuses to seed.
 * @returns {Record<string, number>} counts.
 */
function statusCounts(rows, statuses) {
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(statuses.map((status) => [status, 0]))
  for (const row of rows) {
    const status = String(row.status)
    if (status in counts) counts[status] = Number(row.n)
  }
  return counts
}

/**
 * Liveness probe for a lease PID. Only an explicit "no such process" counts as
 * dead; EPERM or any unknown error is treated as alive so a stale lease is
 * never stolen from a live or ambiguous owner.
 * @param {number} pid - process id recorded in the lease.
 * @returns {boolean} whether the process may still be alive.
 */
function runtimePidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    return true
  }
}

/**
 * Validate the evidence list accepted by activity transitions.
 * @param {unknown} value - candidate list.
 * @returns {string[]} validated references.
 */
function evidenceList(value) {
  if (!Array.isArray(value)) {
    throw new LifeValidationError('evidenceRefs must be an array of non-empty strings')
  }
  if (value.length > 50) {
    throw new LifeValidationError('evidenceRefs must contain at most 50 entries')
  }
  return value.map((entry, index) => requireString(entry, `evidenceRefs[${index}]`, 500))
}

/** The Life ledger and its semantics. */
export class LifeCore {
  #closed = false

  /**
   * @param {object} options - core options.
   * @param {string} options.databasePath - absolute SQLite path.
   * @param {() => number} [options.clock] - injected epoch-millisecond clock.
   * @param {number} [options.maxReviewBatch] - bounded due-review batch size.
   * @param {{authorize: (request: {intent: Record<string, unknown>, actionRef: string, scope: string}) => Promise<unknown>} | null} [options.externalAuthorizer]
   *   trusted external-action authorizer; absent means every protected external
   *   action is refused.
   */
  constructor({ databasePath, clock = () => Date.now(), maxReviewBatch = 20, externalAuthorizer = null } = {}) {
    requireString(databasePath, 'databasePath', 4000)
    if (typeof clock !== 'function') throw new LifeValidationError('clock must be a function')
    this.maxReviewBatch = assertInteger(maxReviewBatch, 'maxReviewBatch', { min: 1, max: 500 })
    if (externalAuthorizer !== null && typeof externalAuthorizer?.authorize !== 'function') {
      throw new LifeValidationError('externalAuthorizer must expose authorize()')
    }
    this.clock = clock
    this.externalAuthorizer = externalAuthorizer
    this.databasePath = databasePath
    this.store = LifeStore.open(databasePath)
    this.startedAt = this.iso()
    /** @type {string | null} */
    this.lastTickAt = null
    /** @type {string | null} */
    this.lastTickError = null
    this.tickCount = 0
    this.degraded = false
  }

  #ensureOpen() {
    if (this.#closed) throw new LifeClosedError()
  }

  /** @returns {number} current epoch milliseconds from the injected clock. */
  nowMs() {
    return this.clock()
  }

  /**
   * @param {number} [ms] - epoch milliseconds.
   * @returns {string} ISO-8601 UTC timestamp.
   */
  iso(ms = this.nowMs()) {
    return new Date(ms).toISOString()
  }

  /**
   * Validate a trusted caller scope string.
   * @param {unknown} scope - caller scope.
   * @returns {string} the scope.
   */
  static scope(scope) {
    return requireString(scope, 'scope', 200)
  }

  /**
   * Create one future intent.
   * @param {object} input - intent fields.
   * @param {string} input.description - durable description, not a scripted message.
   * @param {string} input.reviewAt - ISO-8601 UTC reconsideration time.
   * @param {string} input.contextScope - trusted owning scope.
   * @param {string} input.authorizationRef - trusted provenance reference.
   * @param {string} [input.relatedActivityId] - optional related activity.
   * @param {string} [input.id] - optional id for deterministic tests.
   * @returns {Record<string, unknown>} created intent.
   */
  createIntent({ description, reviewAt, contextScope, authorizationRef, relatedActivityId, id } = {}) {
    this.#ensureOpen()
    this.#assertWritable()
    const createdAt = this.iso()
    const intent = {
      id: id === undefined ? `intent_${randomUUID()}` : requireString(id, 'id', 200),
      revision: 1,
      status: 'active',
      description: requireString(description, 'description', 4000),
      contextScope: LifeCore.scope(contextScope),
      authorizationRef: requireString(authorizationRef, 'authorizationRef', 500),
      relatedActivityId:
        relatedActivityId === undefined || relatedActivityId === null
          ? null
          : requireString(relatedActivityId, 'relatedActivityId', 200),
      createdAt,
      updatedAt: createdAt,
      reviewAt: normalizeTimestamp(reviewAt, 'reviewAt'),
    }
    this.store.run(
      `INSERT INTO intents (id, revision, status, description, context_scope, authorization_ref,
        related_activity_id, created_at, updated_at, review_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      intent.id,
      intent.revision,
      intent.status,
      intent.description,
      intent.contextScope,
      intent.authorizationRef,
      intent.relatedActivityId,
      intent.createdAt,
      intent.updatedAt,
      intent.reviewAt,
    )
    return intent
  }

  /**
   * Read one intent for its owning trusted scope.
   * @param {string} id - intent id.
   * @param {{scope: string}} options - trusted caller scope.
   * @returns {Record<string, unknown>} intent view.
   */
  getIntent(id, { scope } = {}) {
    this.#ensureOpen()
    const callerScope = LifeCore.scope(scope)
    const row = this.store.get('SELECT * FROM intents WHERE id = ?', requireString(id, 'id', 200))
    if (row === undefined) throw new LifeNotFoundError(`intent "${String(id)}" was not found`, { id })
    if (row.context_scope !== callerScope) {
      throw new LifeUnauthorizedError('intent belongs to a different scope', { id, scope: callerScope })
    }
    return intentView(row)
  }

  /**
   * List intents in one trusted scope.
   * @param {{scope: string, status?: string}} options - scope and optional filter.
   * @returns {Record<string, unknown>[]} intent views ordered by review time.
   */
  listIntents({ scope, status } = {}) {
    this.#ensureOpen()
    const callerScope = LifeCore.scope(scope)
    if (status !== undefined && !INTENT_STATUSES.includes(status)) {
      throw new LifeValidationError(`status must be one of ${INTENT_STATUSES.join(', ')}`)
    }
    const rows =
      status === undefined
        ? this.store.all(
            'SELECT * FROM intents WHERE context_scope = ? ORDER BY review_at ASC, id ASC',
            callerScope,
          )
        : this.store.all(
            'SELECT * FROM intents WHERE context_scope = ? AND status = ? ORDER BY review_at ASC, id ASC',
            callerScope,
            status,
          )
    return rows.map(intentView)
  }

  /**
   * Update mutable intent fields with revision CAS. A retimed or edited intent
   * invalidates its pending reconsideration events.
   * @param {string} id - intent id.
   * @param {object} options - update request.
   * @param {string} options.scope - trusted caller scope.
   * @param {number} options.expectedRevision - caller's exact revision.
   * @param {string} [options.description] - new description.
   * @param {string} [options.reviewAt] - new reconsideration time.
   * @param {string|null} [options.relatedActivityId] - new related activity.
   * @returns {Record<string, unknown>} updated intent.
   */
  updateIntent(id, { scope, expectedRevision, ...patch } = {}) {
    this.#ensureOpen()
    this.#assertWritable()
    const callerScope = LifeCore.scope(scope)
    const intentId = requireString(id, 'id', 200)
    assertInteger(expectedRevision, 'expectedRevision', { min: 1 })
    for (const key of Object.keys(patch)) {
      if (!INTENT_PATCH_FIELDS.includes(key)) {
        throw new LifeValidationError(`field "${key}" is immutable or unknown; allowed: ${INTENT_PATCH_FIELDS.join(', ')}`)
      }
    }
    if (Object.keys(patch).length === 0) {
      throw new LifeValidationError(`update requires at least one of: ${INTENT_PATCH_FIELDS.join(', ')}`)
    }
    const next = {}
    if (patch.description !== undefined) next.description = requireString(patch.description, 'description', 4000)
    if (patch.reviewAt !== undefined) next.reviewAt = normalizeTimestamp(patch.reviewAt, 'reviewAt')
    if (patch.relatedActivityId !== undefined) {
      next.relatedActivityId =
        patch.relatedActivityId === null ? null : requireString(patch.relatedActivityId, 'relatedActivityId', 200)
    }
    return this.store.writeTransaction(() => {
      const row = this.store.get('SELECT * FROM intents WHERE id = ?', intentId)
      if (row === undefined) throw new LifeNotFoundError(`intent "${intentId}" was not found`, { id: intentId })
      if (row.context_scope !== callerScope) {
        throw new LifeUnauthorizedError('intent belongs to a different scope', { id: intentId, scope: callerScope })
      }
      if (row.status !== 'active') {
        throw new LifeInvalidTransitionError(`cannot update intent in status "${String(row.status)}"`, {
          id: intentId,
          status: row.status,
        })
      }
      if (row.revision !== expectedRevision) {
        throw new LifeRevisionConflictError(
          `intent "${intentId}" revision is ${String(row.revision)}, expected ${expectedRevision}`,
          { id: intentId, expectedRevision, actualRevision: row.revision },
        )
      }
      const description = next.description ?? row.description
      const reviewAt = next.reviewAt ?? row.review_at
      const relatedActivityId = Object.hasOwn(next, 'relatedActivityId') ? next.relatedActivityId : row.related_activity_id
      const updatedAt = this.iso()
      const revision = Number(row.revision) + 1
      const result = this.store.run(
        `UPDATE intents SET revision = ?, description = ?, related_activity_id = ?, updated_at = ?, review_at = ?
         WHERE id = ? AND revision = ?`,
        revision,
        description,
        relatedActivityId,
        updatedAt,
        reviewAt,
        intentId,
        expectedRevision,
      )
      if (Number(result.changes) !== 1) {
        throw new LifeRevisionConflictError('intent revision changed during the update', { id: intentId })
      }
      this.store.run(
        "UPDATE intent_events SET status = 'superseded' WHERE intent_id = ? AND intent_revision <> ? AND status = 'pending'",
        intentId,
        revision,
      )
      return intentView(this.store.get('SELECT * FROM intents WHERE id = ?', intentId))
    })
  }

  /**
   * Cancel one intent. Pending reconsideration events are superseded and no
   * later tick produces new work for it.
   * @param {string} id - intent id.
   * @param {{scope: string, expectedRevision: number}} options - scope and revision.
   * @returns {Record<string, unknown>} cancelled intent.
   */
  cancelIntent(id, { scope, expectedRevision } = {}) {
    this.#ensureOpen()
    this.#assertWritable()
    const callerScope = LifeCore.scope(scope)
    const intentId = requireString(id, 'id', 200)
    assertInteger(expectedRevision, 'expectedRevision', { min: 1 })
    return this.store.writeTransaction(() => {
      const row = this.store.get('SELECT * FROM intents WHERE id = ?', intentId)
      if (row === undefined) throw new LifeNotFoundError(`intent "${intentId}" was not found`, { id: intentId })
      if (row.context_scope !== callerScope) {
        throw new LifeUnauthorizedError('intent belongs to a different scope', { id: intentId, scope: callerScope })
      }
      if (row.status === 'cancelled') {
        if (row.revision !== expectedRevision) {
          throw new LifeRevisionConflictError(
            `intent "${intentId}" revision is ${String(row.revision)}, expected ${expectedRevision}`,
            { id: intentId, expectedRevision, actualRevision: row.revision },
          )
        }
        return intentView(row)
      }
      if (row.revision !== expectedRevision) {
        throw new LifeRevisionConflictError(
          `intent "${intentId}" revision is ${String(row.revision)}, expected ${expectedRevision}`,
          { id: intentId, expectedRevision, actualRevision: row.revision },
        )
      }
      const revision = Number(row.revision) + 1
      const result = this.store.run(
        "UPDATE intents SET revision = ?, status = 'cancelled', updated_at = ? WHERE id = ? AND revision = ?",
        revision,
        this.iso(),
        intentId,
        expectedRevision,
      )
      if (Number(result.changes) !== 1) {
        throw new LifeRevisionConflictError('intent revision changed during cancellation', { id: intentId })
      }
      this.store.run(
        "UPDATE intent_events SET status = 'superseded' WHERE intent_id = ? AND status = 'pending'",
        intentId,
      )
      return intentView(this.store.get('SELECT * FROM intents WHERE id = ?', intentId))
    })
  }

  /**
   * Record a new activity owned by one trusted scope.
   * @param {object} input - activity fields.
   * @param {string} input.description - activity description.
   * @param {string} input.ownerScope - trusted owning scope.
   * @param {string} [input.providerId] - virtual/external provider identifier.
   * @param {string} [input.intentId] - optional related intent.
   * @returns {Record<string, unknown>} activity in `pending`.
   */
  recordActivity({ description, ownerScope, providerId, intentId } = {}) {
    this.#ensureOpen()
    this.#assertWritable()
    const createdAt = this.iso()
    const activity = {
      id: `activity_${randomUUID()}`,
      revision: 1,
      status: 'pending',
      description: requireString(description, 'description', 4000),
      providerId: providerId === undefined ? null : requireString(providerId, 'providerId', 200),
      intentId: intentId === undefined ? null : requireString(intentId, 'intentId', 200),
      ownerScope: LifeCore.scope(ownerScope),
      evidenceRefs: [],
      createdAt,
      updatedAt: createdAt,
    }
    this.store.run(
      `INSERT INTO activities (id, revision, status, description, provider_id, intent_id, owner_scope,
        evidence_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      activity.id,
      activity.revision,
      activity.status,
      activity.description,
      activity.providerId,
      activity.intentId,
      activity.ownerScope,
      '[]',
      activity.createdAt,
      activity.updatedAt,
    )
    return activity
  }

  /**
   * Read one activity for its owning trusted scope.
   * @param {string} id - activity id.
   * @param {{scope: string}} options - trusted caller scope.
   * @returns {Record<string, unknown>} activity view.
   */
  getActivity(id, { scope } = {}) {
    this.#ensureOpen()
    const callerScope = LifeCore.scope(scope)
    const row = this.store.get('SELECT * FROM activities WHERE id = ?', requireString(id, 'id', 200))
    if (row === undefined) throw new LifeNotFoundError(`activity "${String(id)}" was not found`, { id })
    if (row.owner_scope !== callerScope) {
      throw new LifeUnauthorizedError('activity belongs to a different scope', { id, scope: callerScope })
    }
    return activityView(row)
  }

  /**
   * List activities in one trusted scope.
   * @param {{scope: string}} options - trusted caller scope.
   * @returns {Record<string, unknown>[]} activity views.
   */
  listActivities({ scope } = {}) {
    this.#ensureOpen()
    const callerScope = LifeCore.scope(scope)
    return this.store
      .all('SELECT * FROM activities WHERE owner_scope = ? ORDER BY created_at ASC, id ASC', callerScope)
      .map(activityView)
  }

  /**
   * Apply one allowed activity transition with revision CAS.
   *
   * Completion requires real evidence references, and a late completion for a
   * cancelled intent is rejected without reviving the intent.
   * @param {string} id - activity id.
   * @param {object} options - transition request.
   * @param {string} options.scope - trusted caller scope.
   * @param {number} options.expectedRevision - caller's exact revision.
   * @param {string} options.to - next status.
   * @param {string[]} [options.evidenceRefs] - supporting references from the Provider boundary.
   * @param {string} [options.note] - optional audit note (kept out of state).
   * @param {boolean} [options.trustedEvidence] - only a trusted provider adapter may set true;
   *   model tool arguments always remain untrusted.
   * @returns {Record<string, unknown>} updated activity.
   */
  transitionActivity(id, { scope, expectedRevision, to, evidenceRefs = [], note, trustedEvidence = false } = {}) {
    this.#ensureOpen()
    this.#assertWritable()
    const callerScope = LifeCore.scope(scope)
    const activityId = requireString(id, 'id', 200)
    assertInteger(expectedRevision, 'expectedRevision', { min: 1 })
    if (!ACTIVITY_STATUSES.includes(to)) {
      throw new LifeValidationError(`to must be one of ${ACTIVITY_STATUSES.join(', ')}`)
    }
    if (note !== undefined) requireString(note, 'note', 500)
    if (typeof trustedEvidence !== 'boolean') {
      throw new LifeValidationError('trustedEvidence must be a boolean')
    }
    const evidence = evidenceList(evidenceRefs)
    return this.store.writeTransaction(() => {
      const row = this.store.get('SELECT * FROM activities WHERE id = ?', activityId)
      if (row === undefined) throw new LifeNotFoundError(`activity "${activityId}" was not found`, { id: activityId })
      if (row.owner_scope !== callerScope) {
        throw new LifeUnauthorizedError('activity belongs to a different scope', { id: activityId, scope: callerScope })
      }
      if (row.revision !== expectedRevision) {
        throw new LifeRevisionConflictError(
          `activity "${activityId}" revision is ${String(row.revision)}, expected ${expectedRevision}`,
          { id: activityId, expectedRevision, actualRevision: row.revision },
        )
      }
      assertActivityTransition(String(row.status), to)
      const needsTrustedProviderEvidence =
        (to === 'cancelled' && (row.status === 'stopping' || row.status === 'unknown')) ||
        (to === 'completed' && row.status === 'unknown')
      if (needsTrustedProviderEvidence && (evidence.length === 0 || trustedEvidence !== true)) {
        throw new LifeUnauthorizedError(
          'uncertain external work can only be completed or cancelled with evidence from a trusted provider boundary',
          { id: activityId, from: row.status, to, evidenceProvided: evidence.length > 0, trustedEvidence },
        )
      }
      if (to === 'completed' && evidence.length === 0) {
        throw new LifeValidationError('completion requires at least one evidenceRef')
      }
      if (to === 'completed' && row.intent_id !== null) {
        const intent = this.store.get('SELECT status FROM intents WHERE id = ?', row.intent_id)
        if (intent !== undefined && intent.status === 'cancelled') {
          throw new LifeStaleResultError('late completion for a cancelled intent is rejected', {
            activityId,
            intentId: row.intent_id,
          })
        }
      }
      const merged = [...new Set([...JSON.parse(String(row.evidence_json)), ...evidence])]
      const revision = Number(row.revision) + 1
      const result = this.store.run(
        `UPDATE activities SET revision = ?, status = ?, evidence_json = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
        revision,
        to,
        JSON.stringify(merged),
        this.iso(),
        activityId,
        expectedRevision,
      )
      if (Number(result.changes) !== 1) {
        throw new LifeRevisionConflictError('activity revision changed during the transition', { id: activityId })
      }
      return activityView(this.store.get('SELECT * FROM activities WHERE id = ?', activityId))
    })
  }

  /**
   * Request cancellation. A running activity enters `stopping`; it becomes
   * `cancelled` only after provider confirmation via `transitionActivity`.
   * @param {string} id - activity id.
   * @param {{scope: string, expectedRevision: number}} options - scope and revision.
   * @returns {Record<string, unknown>} updated activity.
   */
  requestCancelActivity(id, { scope, expectedRevision } = {}) {
    const activity = this.getActivity(id, { scope })
    if (activity.revision !== expectedRevision) {
      throw new LifeRevisionConflictError(
        `activity "${String(id)}" revision is ${String(activity.revision)}, expected ${expectedRevision}`,
        { id, expectedRevision, actualRevision: activity.revision },
      )
    }
    if (activity.status === 'running' || activity.status === 'paused') {
      return this.transitionActivity(id, {
        scope,
        expectedRevision,
        to: 'stopping',
        note: 'cancel requested; awaiting trusted provider confirmation',
      })
    }
    if (activity.status === 'pending') {
      return this.transitionActivity(id, {
        scope,
        expectedRevision,
        to: 'cancelled',
        note: 'local pre-start cancellation',
      })
    }
    if (activity.status === 'unknown') {
      // Uncertain external work may still be running: the request records
      // nothing as stopped and the activity stays unknown until a trusted
      // provider boundary supplies confirmation evidence.
      return activity
    }
    if (activity.status === 'stopping') {
      throw new LifeInvalidTransitionError('cancel was already requested; awaiting provider confirmation', {
        id,
        status: activity.status,
      })
    }
    throw new LifeInvalidTransitionError(`activity in status "${String(activity.status)}" cannot be cancelled`, {
      id,
      status: activity.status,
    })
  }

  /**
   * Bounded due review. Produces at most one durable reconsideration event per
   * intent revision, atomically claimed, and performs no model or external call.
   * @returns {{checked: number, produced: Record<string, unknown>[], at: string}} tick result.
   */
  tick() {
    this.#ensureOpen()
    this.#assertWritable()
    const nowMs = this.nowMs()
    const nowIso = this.iso(nowMs)
    try {
      const due = this.store.all(
        `SELECT * FROM intents
         WHERE status = 'active' AND review_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM intent_events e
             WHERE e.intent_id = intents.id AND e.intent_revision = intents.revision
           )
         ORDER BY review_at ASC, id ASC LIMIT ?`,
        nowIso,
        this.maxReviewBatch,
      )
      /** @type {Record<string, unknown>[]} */
      const produced = []
      for (const candidate of due) {
        const event = this.store.writeTransaction(() => {
          const row = this.store.get('SELECT * FROM intents WHERE id = ?', candidate.id)
          if (row === undefined || row.status !== 'active') return null
          if (Date.parse(String(row.review_at)) > nowMs) return null
          const eventId = reconsiderationEventId(String(row.id), Number(row.revision))
          if (this.store.get('SELECT id FROM intent_events WHERE id = ?', eventId) !== undefined) return null
          this.store.run(
            `UPDATE intent_events SET status = 'superseded'
             WHERE intent_id = ? AND intent_revision <> ? AND status = 'pending'`,
            row.id,
            row.revision,
          )
          const payload = {
            eventId,
            type: 'reconsideration',
            delivery: 'local-only',
            intentId: row.id,
            intentRevision: row.revision,
            reviewAt: row.review_at,
            contextScope: row.context_scope,
            relatedActivityId: row.related_activity_id,
            createdAt: nowIso,
          }
          this.store.run(
            `INSERT INTO intent_events (id, intent_id, intent_revision, type, status, created_at,
              acknowledged_at, payload_json)
             VALUES (?, ?, ?, 'reconsideration', 'pending', ?, NULL, ?)`,
            eventId,
            row.id,
            row.revision,
            nowIso,
            JSON.stringify(payload),
          )
          return this.#eventView(eventId)
        })
        if (event !== null) produced.push(event)
      }
      this.lastTickAt = nowIso
      this.lastTickError = null
      this.degraded = false
      this.tickCount += 1
      return { checked: due.length, produced, at: nowIso }
    } catch (error) {
      this.lastTickError = error instanceof Error ? error.message : String(error)
      this.degraded = true
      throw error
    }
  }

  /**
   * Read the local reconsideration outbox.
   * @param {{scope: string, status?: string}} options - scope and optional status.
   * @returns {Record<string, unknown>[]} event views.
   */
  listOutbox({ scope, status = 'pending' } = {}) {
    this.#ensureOpen()
    const callerScope = LifeCore.scope(scope)
    if (!EVENT_STATUSES.includes(status)) {
      throw new LifeValidationError(`status must be one of ${EVENT_STATUSES.join(', ')}`)
    }
    return this.store
      .all(
        `SELECT e.id FROM intent_events e
         JOIN intents i ON i.id = e.intent_id
         WHERE i.context_scope = ? AND e.status = ?
         ORDER BY e.created_at ASC, e.id ASC`,
        callerScope,
        status,
      )
      .map((row) => this.#eventView(String(row.id)))
  }

  /**
   * Acknowledge one local reconsideration event. This is local bookkeeping and
   * does not assert that any external action happened or completed.
   * @param {string} eventId - event id.
   * @param {{scope: string}} options - trusted caller scope.
   * @returns {Record<string, unknown>} event view.
   */
  acknowledgeEvent(eventId, { scope } = {}) {
    this.#ensureOpen()
    this.#assertWritable()
    const callerScope = LifeCore.scope(scope)
    const id = requireString(eventId, 'eventId', 500)
    return this.store.writeTransaction(() => {
      const row = this.store.get(
        `SELECT e.status, i.context_scope FROM intent_events e
         JOIN intents i ON i.id = e.intent_id WHERE e.id = ?`,
        id,
      )
      if (row === undefined) throw new LifeNotFoundError(`event "${id}" was not found`, { eventId: id })
      if (row.context_scope !== callerScope) {
        throw new LifeUnauthorizedError('event belongs to a different scope', { eventId: id, scope: callerScope })
      }
      if (row.status === 'acknowledged') return this.#eventView(id)
      if (row.status !== 'pending') {
        throw new LifeInvalidTransitionError(`event in status "${String(row.status)}" cannot be acknowledged`, {
          eventId: id,
          status: row.status,
        })
      }
      this.store.run(
        "UPDATE intent_events SET status = 'acknowledged', acknowledged_at = ? WHERE id = ? AND status = 'pending'",
        this.iso(),
        id,
      )
      return this.#eventView(id)
    })
  }

  /**
   * Refuse or delegate a protected external action. Without a trusted
   * authorizer configured, every such request is rejected.
   * @param {{intentId: string, scope: string, actionRef: string}} request - request.
   * @returns {Promise<unknown>} authorizer result when configured.
   */
  async requestExternalAction({ intentId, scope, actionRef } = {}) {
    this.#ensureOpen()
    const intent = this.getIntent(intentId, { scope })
    const reference = requireString(actionRef, 'actionRef', 500)
    if (intent.status !== 'active') {
      throw new LifeUnauthorizedError('intent is not active', { intentId, status: intent.status })
    }
    if (this.externalAuthorizer === null) {
      throw new LifeUnauthorizedError(
        'no trusted external authorization adapter is configured; Life refuses protected external actions',
        { intentId, actionRef: reference },
      )
    }
    return this.externalAuthorizer.authorize({ intent, actionRef: reference, scope: LifeCore.scope(scope) })
  }

  /**
   * Recovery hook for plugin start: work that was `running` or `stopping` when
   * the previous owner disappeared is uncertain. It becomes `unknown` and needs
   * explicit reconciliation; it is never marked completed or replayed. Intents
   * are untouched.
   * @returns {number} number of activities marked unknown.
   */
  markInterruptedAsUnknown() {
    this.#ensureOpen()
    this.#assertWritable()
    return this.store.writeTransaction(() => {
      const rows = this.store.all("SELECT id, revision FROM activities WHERE status IN ('running', 'stopping')")
      for (const row of rows) {
        this.store.run(
          "UPDATE activities SET revision = ?, status = 'unknown', updated_at = ? WHERE id = ? AND revision = ?",
          Number(row.revision) + 1,
          this.iso(),
          row.id,
          row.revision,
        )
      }
      return rows.length
    })
  }

  /**
   * Current health snapshot. `degraded` means the last tick failed; it clears
   * only after a later tick succeeds.
   * @returns {Record<string, unknown>} health.
   */
  getHealth() {
    this.#ensureOpen()
    const intents = statusCounts(this.store.all('SELECT status, COUNT(*) AS n FROM intents GROUP BY status'), INTENT_STATUSES)
    const activities = statusCounts(
      this.store.all('SELECT status, COUNT(*) AS n FROM activities GROUP BY status'),
      ACTIVITY_STATUSES,
    )
    const events = statusCounts(
      this.store.all('SELECT status, COUNT(*) AS n FROM intent_events GROUP BY status'),
      EVENT_STATUSES,
    )
    return {
      state: this.degraded ? 'degraded' : 'ok',
      schemaVersion: LIFE_SCHEMA_VERSION,
      databasePath: this.databasePath,
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
      lastTickError: this.lastTickError,
      tickCount: this.tickCount,
      counts: { intents, activities, events },
    }
  }

  /**
   * Scoped health for model-facing consumers: general health plus this caller's
   * counts. No database path, global counts, or other sessions' metadata.
   * @param {{scope: string}} options - trusted caller scope.
   * @returns {Record<string, unknown>} scoped health.
   */
  getScopedHealth({ scope } = {}) {
    this.#ensureOpen()
    const callerScope = LifeCore.scope(scope)
    const intents = statusCounts(
      this.store.all('SELECT status, COUNT(*) AS n FROM intents WHERE context_scope = ? GROUP BY status', callerScope),
      INTENT_STATUSES,
    )
    const activities = statusCounts(
      this.store.all('SELECT status, COUNT(*) AS n FROM activities WHERE owner_scope = ? GROUP BY status', callerScope),
      ACTIVITY_STATUSES,
    )
    const events = statusCounts(
      this.store.all(
        `SELECT e.status, COUNT(*) AS n FROM intent_events e
         JOIN intents i ON i.id = e.intent_id
         WHERE i.context_scope = ? GROUP BY e.status`,
        callerScope,
      ),
      EVENT_STATUSES,
    )
    return {
      state: this.degraded ? 'degraded' : 'ok',
      schemaVersion: LIFE_SCHEMA_VERSION,
      lastTickAt: this.lastTickAt,
      tickCount: this.tickCount,
      counts: { intents, activities, events },
    }
  }

  /**
   * Acquire the single adapter lease. Only an owner whose PID is verifiably
   * dead may be displaced; an alive, EPERM, or otherwise ambiguous PID keeps
   * the lease, so two live adapters can never both perform startup recovery.
   * @param {string} ownerId - unique per adapter activation.
   * @returns {{acquired: boolean, recovered?: boolean, heldBy?: string, pid?: number}} lease outcome.
   */
  acquireRuntimeLease(ownerId) {
    this.#ensureOpen()
    this.#assertWritable()
    const id = requireString(ownerId, 'ownerId', 200)
    return this.store.writeTransaction(() => {
      const row = this.store.get("SELECT * FROM runtime_leases WHERE key = 'adapter'")
      if (row === undefined) {
        this.store.run(
          "INSERT INTO runtime_leases (key, owner_id, pid, acquired_at) VALUES ('adapter', ?, ?, ?)",
          id,
          process.pid,
          this.iso(),
        )
        return { acquired: true, recovered: false }
      }
      if (row.owner_id === id) return { acquired: true, recovered: false }
      if (!runtimePidAlive(Number(row.pid))) {
        const result = this.store.run(
          "UPDATE runtime_leases SET owner_id = ?, pid = ?, acquired_at = ? WHERE key = 'adapter' AND owner_id = ?",
          id,
          process.pid,
          this.iso(),
          row.owner_id,
        )
        if (Number(result.changes) !== 1) {
          throw new LifeRevisionConflictError('runtime lease changed during stale-owner recovery')
        }
        return { acquired: true, recovered: true, previousPid: Number(row.pid) }
      }
      return { acquired: false, heldBy: String(row.owner_id), pid: Number(row.pid) }
    })
  }

  /**
   * Release the adapter lease. Only the exact owning instance can release it.
   * @param {string} ownerId - the caller's activation id.
   * @returns {boolean} whether this caller owned and released the lease.
   */
  releaseRuntimeLease(ownerId) {
    this.#ensureOpen()
    const id = requireString(ownerId, 'ownerId', 200)
    return this.store.writeTransaction(() => {
      const result = this.store.run("DELETE FROM runtime_leases WHERE key = 'adapter' AND owner_id = ?", id)
      return Number(result.changes) === 1
    })
  }

  /**
   * Read one outbox event as a view.
   * @param {string} eventId - event id.
   * @returns {Record<string, unknown>} event view.
   */
  #eventView(eventId) {
    const row = this.store.get('SELECT * FROM intent_events WHERE id = ?', eventId)
    if (row === undefined) throw new LifeNotFoundError(`event "${eventId}" was not found`, { eventId })
    return {
      eventId: row.id,
      type: row.type,
      status: row.status,
      intentId: row.intent_id,
      intentRevision: row.intent_revision,
      createdAt: row.created_at,
      acknowledgedAt: row.acknowledged_at,
      payload: JSON.parse(String(row.payload_json)),
    }
  }

  #assertWritable() {
    if (this.#closed) throw new LifeClosedError()
  }

  /** Close the store; later operations throw `LifeClosedError`. */
  close() {
    if (this.#closed) return
    this.#closed = true
    this.store.close()
  }
}
