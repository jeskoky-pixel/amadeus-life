/**
 * Trusted DSH Host wake dispatcher for Amadeus Life.
 *
 * This module is intentionally narrow: it consumes the v3 wake ledger, resolves
 * one allowlisted Session through the official Session Controller, queues one
 * follow-up message, waits for a durable Session flush, and records admission.
 * Execution is recorded only from matching `session/event` evidence for a
 * completed turn. It never steers or cancels a running turn, never sends platform
 * messages, and never trusts model-supplied text for target selection.
 */

import { randomUUID } from 'node:crypto'

const WAKE_SOURCE_KIND = 'amadeus-life'
const EXECUTION_CACHE_LIMIT = 500
/** Bounded tail window for conservative durable-snapshot evidence scans. */
export const SNAPSHOT_SCAN_LIMIT = 2000
const HISTORY_PAGE_MESSAGES = 200
const HISTORY_MAX_PAGES = 4
const EVIDENCE_EVENT_LIMIT = 800

/**
 * Short reference-only prompt for the model. Deliberately excludes the intent
 * description and any scripted outgoing text.
 * @param {Record<string, unknown>} wake - wake row view.
 * @returns {string} prompt text.
 */
export function wakePrompt(wake, externalMessageAllowed = false) {
  if (wake.origin === 'idle') {
    return `Life idle opportunity ${String(wake.id)}: no task is required. You may rest or stay silent; re-read current Life state if you decide to act. Do not send external messages from this wake.`
  }
  const boundary = externalMessageAllowed
    ? 'External messages may be sent only if the current intent calls for them, in this current Session, through tools that permit the target Scene. Do not send to another Scene.'
    : 'Do not send external messages from this wake.'
  return `Life wake ${String(wake.id)}: intent ${String(wake.intentId)} revision ${String(wake.intentRevision)}. Re-read the current Life state before deciding anything; ${boundary}`
}

/** @param {unknown} value @returns {string} */
function messageOf(value) {
  return value instanceof Error ? value.message : String(value)
}

/** Bounded FIFO prune for the observed-message cache. */
function pruneMap(map) {
  while (map.size > EXECUTION_CACHE_LIMIT) {
    const first = map.keys().next().value
    map.delete(first)
  }
}

/** One adapter-owned wake dispatcher. */
export class WakeHost {
  /**
   * @param {object} options - dispatcher options.
   * @param {import('./core.js').LifeCore} options.core - trusted core.
   * @param {string} options.ownerId - this adapter's wake claim owner.
   * @param {{resolveAgent: (sessionId: string) => Promise<unknown>}} [options.sessionController] - Host controller.
   * @param {(session: unknown) => Promise<boolean>} [options.flushSession] - durable Session flush.
   * @param {string[]} options.allowedSessionIds - administrator allowlist.
   * @param {string[]} options.externalMessageSessionIds - explicit administrator opt-in subset.
   * @param {number} options.intervalMs - low-frequency timer interval.
   * @param {number} options.maxPerDrive - bounded claims per drive.
   * @param {() => number} [options.clock] - clock.
   * @param {object} [options.logger] - optional logger.
   * @param {typeof setInterval} [options.setIntervalFn] - testable timer.
   * @param {typeof clearInterval} [options.clearIntervalFn] - testable timer.
   */
  constructor({
    core,
    ownerId,
    enabled = false,
    allowedSessionIds,
    externalMessageSessionIds = [],
    intervalMs,
    maxPerDrive,
    idle = null,
    budget = null,
    clock = () => Date.now(),
    logger,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  }) {
    this.core = core
    this.ownerId = ownerId
    this.sessionController = undefined
    this.flushSession = undefined
    this.listenerRegistrar = undefined
    this.allowed = [...new Set(allowedSessionIds ?? [])]
    this.allowedSet = new Set(this.allowed)
    this.externalMessageSessionIds = new Set(externalMessageSessionIds)
    this.intervalMs = intervalMs
    this.maxPerDrive = maxPerDrive
    this.idle = idle !== null && typeof idle === 'object' ? { enabled: idle.enabled === true, ...idle } : { enabled: false }
    this.budget = budget !== null && typeof budget === 'object' ? { ...budget } : { enabled: false }
    this.lastIdle = null
    this.lastBudgetError = null
    this.lastUsage = null
    this.autonomousTurns = new Map()
    this.userYieldPromises = []
    this.clock = clock
    this.logger = logger
    this.setIntervalFn = setIntervalFn
    this.clearIntervalFn = clearIntervalFn

    // Both the trusted `enabled` flag and a non-empty administrator allowlist
    // are required; an allowlist alone must never enable delivery.
    this.requested = enabled === true
    this.enabled = this.requested && this.allowed.length > 0
    this.missing = []
    this.bound = false
    this.bindingGeneration = 0
    this.reconcileState = 'pending'
    this.nextReconcileAt = 0
    this.reconcileBackoffMs = 30_000
    this.lastReconcileError = null
    this.reconcileAbort = null

    this.timer = null
    this.listenerDisposer = null
    this.running = false
    this.disposed = false
    this.lastError = null

    /** @type {Map<string, {wakeId: string, sessionId: string}>} */
    this.watched = new Map()
    /** @type {Map<string, {sessionId: string, wakeId: string, turn: number | null, completed: boolean}>} */
    this.seen = new Map()
    /** @type {Map<string, number>} */
    this.currentTurn = new Map()
    /** @type {Map<string, {messageId: string, wakeId: string, turn: number}>} */
    this.consumed = new Map()
  }

  /** @returns {Record<string, unknown>} trusted delivery health snapshot. */
  health() {
    const usable = this.missing.length === 0 && this.bound
    const hasUnresolved = this.#hasUnresolvedWake()
    let state = !this.enabled ? 'disabled' : usable ? 'active' : 'degraded'
    let reason = !this.enabled
      ? this.requested
        ? 'no_allowed_sessions'
        : 'not_enabled'
      : this.missing.length > 0
        ? 'missing_capability'
        : !this.bound
          ? 'awaiting_services'
          : undefined
    if (state === 'active' && hasUnresolved) {
      state = 'degraded'
      reason =
        this.reconcileState === 'unavailable'
          ? 'reconciliation_unavailable'
          : this.reconcileState === 'done'
            ? 'reconciliation_unresolved'
            : 'reconciliation_pending'
    }
    return {
      state,
      reason,
      enabled: this.enabled,
      bound: this.bound,
      allowedSessions: this.allowed.length,
      intervalMs: this.intervalMs,
      maxPerDrive: this.maxPerDrive,
      timerActive: this.timer !== null,
      inFlight: this.running,
      reconciliation: this.reconcileState,
      unresolvedWakes: hasUnresolved,
      idle: {
        enabled: this.idle.enabled === true,
        targetSessionId: this.idle.targetSessionId ?? null,
        lastReason: this.lastIdle?.reason ?? null,
        lastCreatedAt: this.lastIdle?.at ?? null,
      },
      budget: {
        enabled: this.budget.enabled === true,
        lastError: this.lastBudgetError ?? null,
      },
      usage: this.lastUsage === null ? { status: 'none' } : this.lastUsage,
      lastReconcileError: this.lastReconcileError ?? undefined,
      missing: this.missing.length > 0 ? [...this.missing] : undefined,
      lastError: this.lastError ?? undefined,
    }
  }

  /** @returns {boolean} whether any allowlisted Session has an unreconciled wake. */
  #hasUnresolvedWake() {
    for (const sessionId of this.allowed) {
      try {
        if (this.core.hasUnreconciledWakeForSession(sessionId)) return true
      } catch {
        return false
      }
    }
    return false
  }

  /**
   * Bind to services supplied by an optional Cordis injection scope, or by the
   * adapter's fallback lookup. Rebinding first tears down any previous binding,
   * so listeners/timers never duplicate.
   * @param {object} options - available Host services.
   * @param {{resolveAgent: (sessionId: string) => Promise<unknown>}} [options.sessionController] - Session controller.
   * @param {{flush: (session: unknown) => Promise<boolean>}} [options.sessions] - Session registry.
   * @param {(handler: (session: unknown, event: unknown) => void) => (() => void)} [options.registerListener] - listener registrar.
   * @returns {number} binding generation for safe cleanup.
   */
  bindHost({ sessionController, sessions, registerListener } = {}) {
    this.unbindHost()
    const generation = this.bindingGeneration
    this.sessionController = sessionController
    this.flushSession = typeof sessions?.flush === 'function' ? (session) => sessions.flush(session) : undefined
    this.listenerRegistrar = typeof registerListener === 'function' ? registerListener : undefined
    this.missing = []
    if (typeof this.sessionController?.resolveAgent !== 'function') {
      this.missing.push('sessionController.resolveAgent')
    }
    if (typeof this.flushSession !== 'function') this.missing.push('sessions.flush')
    if (this.listenerRegistrar === undefined) this.missing.push('ctx.on')
    if (!this.enabled || this.disposed || this.missing.length > 0) return generation
    try {
      this.listenerDisposer = this.listenerRegistrar((session, event) => this.handleSessionEvent(session, event))
    } catch {
      // Listener registration is a delivery-only capability. Registration
      // failure must degrade delivery, not fail the whole Life plugin.
      this.listenerDisposer = null
      this.missing.push('ctx.on')
      return generation
    }
    this.timer = this.setIntervalFn(() => {
      this.driveOnce().catch((error) => {
        this.lastError = messageOf(error)
        this.logger?.warn?.(`amadeus-life: wake drive failed: ${this.lastError}`)
      })
    }, this.intervalMs)
    this.timer?.unref?.()
    this.bound = true
    this.reconcileState = 'pending'
    this.nextReconcileAt = 0
    this.lastReconcileError = null
    return generation
  }

  /**
   * Tear down one binding. A stale generation (dependency withdrawn after a
   * newer binding) is ignored, so cleanup cannot detach the current listener.
   * @param {number} [generation] - binding generation to release.
   */
  unbindHost(generation) {
    if (generation !== undefined && generation !== this.bindingGeneration) return
    this.bindingGeneration += 1
    if (this.timer !== null) {
      this.clearIntervalFn(this.timer)
      this.timer = null
    }
    try {
      this.listenerDisposer?.()
    } catch {
      // Listener removal must not block withdrawal.
    }
    this.listenerDisposer = null
    this.bound = false
    this.sessionController = undefined
    this.flushSession = undefined
    this.listenerRegistrar = undefined
    this.missing = []
    this.reconcileState = 'unavailable'
  }

  /**
   * Record absent Host capabilities without binding anything.
   * @param {string[]} missing - capability names.
   */
  markMissing(missing) {
    this.unbindHost()
    this.missing = [...new Set(missing)]
    this.bound = false
  }

  /** Stop the timer and listener; later async completions must not touch core. */
  stop() {
    if (this.disposed) return
    this.disposed = true
    this.reconcileAbort?.abort()
    this.reconcileAbort = null
    this.unbindHost()
    this.watched.clear()
    this.seen.clear()
    this.currentTurn.clear()
    this.consumed.clear()
  }

  /**
   * One trusted, bounded drive. Ticks and prepares wakes, then claims only
   * allowlisted Sessions and delivers at most `maxPerDrive` wake messages.
   * @returns {Promise<Record<string, unknown>>} drive outcome.
   */
  async driveOnce() {
    if (this.disposed) return { status: 'disposed', delivered: [] }
    if (!this.enabled) return { status: 'disabled', delivered: [] }
    if (this.missing.length > 0) return { status: 'unavailable', missing: [...this.missing], delivered: [] }
    if (!this.bound) return { status: 'unavailable', reason: 'awaiting_services', delivered: [] }
    if (this.running) return { status: 'busy', delivered: [] }
    this.running = true
    const delivered = []
    try {
      await this.reconcileUnreconciledWakes()
      this.#maybeAllocateIdleWake()
      this.core.tick()
      this.core.prepareDueWakes({
        limit: Math.min(100, Math.max(10, this.maxPerDrive * Math.max(1, this.allowed.length) * 2)),
      })
      let claimed = 0
      for (const sessionId of this.allowed) {
        if (this.disposed || claimed >= this.maxPerDrive) break
        const bindingGeneration = this.bindingGeneration
        if (!this.#isCurrentBinding(bindingGeneration)) break
        if (this.core.hasUnreconciledWakeForSession(sessionId)) continue
        const wake = this.core.claimNextWake({ ownerId: this.ownerId, targetSessionId: sessionId })
        if (wake === null) continue
        claimed += 1
        const budget = this.core.consumeWakeBudget({
          scope: wake.contextScope,
          estimatedTokens: Number(this.budget.estimatedTokens ?? 0) || 0,
          wakeId: wake.id,
        })
        if (budget.allowed !== true || (this.budget.enabled === true && budget.unconfigured === true)) {
          this.lastBudgetError = `budget deferred: ${String(budget.unconfigured === true ? 'unconfigured' : budget.reason ?? 'unknown')}`
          try {
            this.core.releaseWakeClaim(wake.id, {
              ownerId: this.ownerId,
              reason: this.lastBudgetError,
            })
          } catch {
            // The wake remains conservatively claimed/uncertain; never resend.
          }
          continue
        }
        this.lastBudgetError = null
        const outcome = await this.deliver(wake, bindingGeneration)
        if (outcome !== null && outcome.status !== 'superseded') delivered.push(outcome)
        if (!this.#isCurrentBinding(bindingGeneration)) break
      }
      this.lastError = null
      return { status: 'ok', delivered }
    } catch (error) {
      this.lastError = messageOf(error)
      return { status: 'error', error: this.lastError, delivered }
    } finally {
      this.running = false
    }
  }

  /**
   * Cheap idle eligibility: one persisted opportunity per window, no model call
   * until an idle wake is actually claimed/delivered. Quiet hours and current
   * turn presence are checked before any DB write.
   */
  #maybeAllocateIdleWake() {
    if (this.idle.enabled !== true || this.disposed || !this.bound) return
    const sessionId = this.idle.targetSessionId
    if (typeof sessionId !== 'string' || !this.allowedSet.has(sessionId)) return
    const nowMs = this.clock()
    if (this.currentTurn.has(sessionId)) {
      this.lastIdle = { created: false, reason: 'session_turn_active', at: this.core.iso(nowMs) }
      return
    }
    if (this.#inQuietHours(nowMs)) {
      this.lastIdle = { created: false, reason: 'quiet_hours', at: this.core.iso(nowMs) }
      return
    }
    try {
      const result = this.core.allocateIdleWake({
        targetSessionId: sessionId,
        windowMs: Number(this.idle.windowMs),
        quietAfterActivityMs: Number(this.idle.quietAfterActivityMs ?? 0),
        now: this.core.iso(nowMs),
      })
      this.lastIdle = { ...result, at: this.core.iso(nowMs) }
    } catch (error) {
      this.lastIdle = { created: false, reason: `idle_error:${messageOf(error)}`, at: this.core.iso(nowMs) }
    }
  }

  /**
   * @param {number} nowMs - epoch ms.
   * @returns {boolean} whether current UTC hour is inside configured quiet hours.
   */
  #inQuietHours(nowMs) {
    const start = this.idle.quietStartHour
    const end = this.idle.quietEndHour
    if (!Number.isInteger(start) || !Number.isInteger(end) || start === end) return false
    const hour = new Date(nowMs).getUTCHours()
    return start < end ? hour >= start && hour < end : hour >= start || hour < end
  }

  /**
   * Deliver one claimed wake: resolve, recheck, followup, flush, admission.
   * The binding generation captured at claim time is rechecked after every
   * await and before followup; a withdrawn/replaced binding can never deliver
   * the old resolve's Agent in the new scope.
   * @param {Record<string, unknown>} wake - claimed wake.
   * @param {number} bindingGeneration - generation that claimed this wake.
   * @returns {Promise<Record<string, unknown> | null>} delivery outcome.
   */
  async deliver(wake, bindingGeneration) {
    if (!this.#isCurrentBinding(bindingGeneration)) {
      return this.#uncertain(wake, 'host binding changed before resolve')
    }
    let resolved
    try {
      resolved = await this.sessionController.resolveAgent(wake.targetSessionId)
    } catch (error) {
      return this.#uncertain(wake, `resolve threw: ${messageOf(error)}`)
    }
    if (!this.#isCurrentBinding(bindingGeneration)) {
      return this.#uncertain(wake, 'host binding changed during resolve')
    }
    if (resolved === null || typeof resolved !== 'object' || resolved.error !== undefined || resolved.agent === undefined) {
      return this.#uncertain(wake, 'resolve failed')
    }

    let recheck
    try {
      recheck = this.core.recheckClaimedWake(wake.id, { ownerId: this.ownerId })
    } catch (error) {
      return { status: 'error', wakeId: wake.id, reason: messageOf(error) }
    }
    if (recheck.valid !== true) return { status: 'superseded', wakeId: wake.id, reason: recheck.reason }
    if (!this.#isCurrentBinding(bindingGeneration)) {
      return this.#uncertain(wake, 'host binding changed before followup')
    }

    // External-message guidance is derived from the persisted current intent,
    // never from the wake row or the Session binding authorization string. Any
    // lookup error or disagreement fails closed to the non-sending prompt.
    const externalMessageAllowed = this.#externalMessageAllowed(wake)

    const agent = resolved.agent
    const messageId = randomUUID()
    try {
      this.core.prepareWakeDelivery(wake.id, { ownerId: this.ownerId, messageId })
    } catch {
      return this.#uncertain(wake, 'could not persist prepared message id')
    }
    const message = {
      role: 'user',
      id: messageId,
      content: [{ type: 'text', text: wakePrompt(wake, externalMessageAllowed) }],
      source: { kind: WAKE_SOURCE_KIND, wakeId: wake.id },
    }
    try {
      agent.followup(message)
    } catch (error) {
      return this.#uncertain(wake, `followup failed: ${messageOf(error)}`)
    }

    let flushed
    try {
      flushed = await this.flushSession(agent.session)
    } catch {
      flushed = false
    }
    if (!this.#isCurrentBinding(bindingGeneration)) {
      return this.#uncertain(wake, 'host binding changed during flush; delivery unconfirmed')
    }
    if (flushed !== true) return this.#uncertain(wake, 'flush unconfirmed')

    try {
      const admitted = this.core.markWakeAdmitted(wake.id, { ownerId: this.ownerId, messageId: message.id })
      this.watched.set(message.id, { wakeId: wake.id, sessionId: wake.targetSessionId })
      this.reconcileAlreadyCompleted(wake, message.id, agent.session)
      return { status: 'admitted', wakeId: wake.id, messageId: message.id, wakeStatus: admitted.status }
    } catch {
      // A local acknowledgement, cancellation, or pre-admission completion may
      // have moved the wake; never turn a proven completion into uncertain.
      try {
        const current = this.core.getWake(wake.id)
        if (current.status === 'executed' || current.status === 'admitted') {
          return { status: 'admitted', wakeId: wake.id, messageId, wakeStatus: current.status }
        }
        if (current.status === 'claimed') {
          this.core.markWakeUncertain(wake.id, {
            ownerId: this.ownerId,
            reason: 'admission failed after durable flush',
          })
        }
      } catch {
        // Best-effort: never guess execution.
      }
      return { status: 'uncertain', wakeId: wake.id, reason: 'admission failed' }
    }
  }

  /**
   * Decide whether the delivered prompt may mention external messaging.
   *
   * The authoritative provenance is the persisted current intent's
   * `authorizationRef`, not the wake row or the Session binding authorization
   * string. This changes only the prompt boundary: downstream tool and QQ Scene
   * permissions still decide whether anything can actually be sent.
   * @param {Record<string, unknown>} wake - rechecked claimed wake.
   * @returns {boolean} true only for an explicitly opted-in, tool-authorized intent wake.
   */
  #externalMessageAllowed(wake) {
    if (wake.origin === 'idle') return false
    const targetSessionId = wake.targetSessionId
    if (typeof targetSessionId !== 'string' || targetSessionId.length === 0) return false
    if (!this.allowedSet.has(targetSessionId)) return false
    if (!this.externalMessageSessionIds.has(targetSessionId)) return false
    if (typeof wake.intentId !== 'string' || wake.intentId.length === 0) return false
    if (wake.contextScope !== `session:${targetSessionId}`) return false
    let intent
    try {
      intent = this.core.getIntent(wake.intentId, { scope: wake.contextScope })
    } catch {
      return false
    }
    if (intent === null || typeof intent !== 'object') return false
    if (intent.id !== wake.intentId) return false
    if (intent.contextScope !== wake.contextScope) return false
    if (intent.status !== 'active') return false
    if (intent.authorizationRef !== `life-tool:session:${targetSessionId}`) return false
    if (Number(intent.revision) !== Number(wake.intentRevision)) return false
    return true
  }

  /** @param {number} generation - binding generation.
   * @returns {boolean} whether that exact binding is still current. */
  #isCurrentBinding(generation) {
    return !this.disposed && this.bound && this.bindingGeneration === generation
  }

  /** @param {Record<string, unknown>} wake @param {string} reason */
  #uncertain(wake, reason) {
    if (this.disposed) return { status: 'disposed', wakeId: wake.id }
    try {
      const current = this.core.getWake(wake.id)
      if (current.status === 'claimed') {
        this.core.markWakeUncertain(wake.id, {
          ownerId: this.ownerId,
          reason: reason.slice(0, 500),
        })
      }
    } catch {
      // The wake remains claimed for later conservative reconciliation.
    }
    return { status: 'uncertain', wakeId: wake.id, reason }
  }

  /**
   * Observe durable Session events globally. Only exact source/wakeId/message
   * matches consumed by a completed turn can execute a wake.
   * @param {unknown} session - Session object.
   * @param {unknown} event - Session event.
   */
  handleSessionEvent(session, event) {
    if (this.disposed || event === null || typeof event !== 'object') return
    const sessionId = typeof session?.id === 'string' ? session.id : undefined
    if (sessionId === undefined || typeof event.type !== 'string') return
    if (!this.allowedSet.has(sessionId)) return
    try {
      this.core.noteSessionActivity({ targetSessionId: sessionId, at: this.core.iso() })
    } catch {
      // Idle bookkeeping must never break event observation.
    }
    if (event.type === 'user/message' && event.data?.source?.kind !== WAKE_SOURCE_KIND) {
      // Real user turn wins over same-Session long activities. The Provider is
      // paused/checkpointed when supported; otherwise the activity stays
      // conservative unknown. Never cancel or resend.
      const promise = this.core.v1
        .yieldActivitiesToUser({ targetSessionId: sessionId })
        .catch(() => [])
      this.userYieldPromises.push(promise)
      while (this.userYieldPromises.length > 20) this.userYieldPromises.shift()
    }
    if (event.type === 'assistant/message') {
      const turn = Number(event.data?.turn)
      const key = `${sessionId}:${turn}`
      if (this.autonomousTurns.has(key)) {
        const usage = event.data?.usage
        if (usage !== null && typeof usage === 'object') {
          try {
            this.lastUsage = {
              status: 'recorded',
              at: this.core.iso(),
              seq: Number(event.seq),
              ...this.core.v1.recordSessionUsage({
                targetSessionId: sessionId,
                seq: Number(event.seq),
                usage,
                wakeId: this.autonomousTurns.get(key),
              }),
            }
          } catch (error) {
            this.lastUsage = { status: 'error', at: this.core.iso(), seq: Number(event.seq), error: messageOf(error) }
          }
        } else {
          this.lastUsage = { status: 'usage_unknown', at: this.core.iso(), seq: Number(event.seq) }
        }
      }
      return
    }
    try {
      if (event.type === 'turn/start') {
        this.currentTurn.set(sessionId, Number(event.data?.turn))
        return
      }
      if (event.type === 'user/message') {
        const data = event.data
        const source = data?.source
        if (source?.kind !== WAKE_SOURCE_KIND) return
        const messageId = data?.id
        const wakeId = source?.wakeId
        if (typeof messageId !== 'string' || typeof wakeId !== 'string') return
        let wake
        try {
          wake = this.core.getWake(wakeId)
        } catch {
          return
        }
        if (wake.targetSessionId !== sessionId) return
        if (wake.messageId !== messageId && wake.preparedMessageId !== messageId) return
        const watched = this.watched.get(messageId)
        if (watched !== undefined && (watched.sessionId !== sessionId || watched.wakeId !== wakeId)) return
        const turn = this.currentTurn.get(sessionId) ?? null
        const userSeq = Number(event.seq)
        if (turn !== null && Number.isInteger(turn)) {
          this.autonomousTurns.set(`${sessionId}:${turn}`, wakeId)
        }
        // Fix validity at the real event time, before any same-turn cancellation.
        if (turn !== null && Number.isInteger(userSeq) && userSeq >= 1) {
          try {
            this.core.recordWakeConsumed(wakeId, {
              targetSessionId: sessionId,
              messageId,
              turnSeq: turn,
              userMessageSeq: userSeq,
            })
          } catch {
            // Stale/conflicting evidence stays unreconciled; never guessed valid.
          }
        }
        this.seen.set(messageId, {
          sessionId,
          wakeId,
          messageId,
          turn,
          userMessageSeq: userSeq,
          completed: false,
          turnEndSeq: null,
          turnReason: null,
        })
        pruneMap(this.seen)
        return
      }
      if (event.type === 'turn/end') {
        const turn = Number(event.data?.turn)
        const reason = event.data?.reason?.kind ?? 'unknown'
        const turnEndSeq = Number(event.seq)
        if (!Number.isInteger(turnEndSeq) || turnEndSeq < 1) return
        for (const entry of this.seen.values()) {
          if (entry.sessionId !== sessionId || entry.turn !== turn || entry.turnEndSeq !== null) continue
          this.#recordTurnEnd(entry, sessionId, turn, turnEndSeq, String(reason))
          entry.completed = reason === 'completed'
          entry.turnEndSeq = turnEndSeq
          entry.turnReason = String(reason)
        }
        if (this.currentTurn.get(sessionId) === turn) this.currentTurn.delete(sessionId)
        this.autonomousTurns.delete(`${sessionId}:${turn}`)
      }
    } catch {
      // Event observation must never break the Host.
    }
  }

  /**
   * Record turn-end evidence through the v4 core; never fall back to guessing.
   * @param {Record<string, unknown>} entry - observed message entry.
   * @param {string} sessionId - target Session.
   * @param {number} turn - turn number.
   * @param {number} turnEndSeq - durable turn/end seq.
   * @param {string} reason - turn end reason kind.
   */
  #recordTurnEnd(entry, sessionId, turn, turnEndSeq, reason) {
    try {
      this.core.recordWakeTurnEnd(entry.wakeId, {
        targetSessionId: sessionId,
        messageId: entry.messageId,
        turnSeq: turn,
        turnEndSeq,
        reason,
      })
      this.watched.delete(entry.messageId)
    } catch {
      // Conservative: leave the wake unreconciled for later evidence.
    }
  }

  /**
   * @param {Record<string, unknown>} wake - admitted wake.
   * @param {string} messageId - admitted message id.
   * @param {unknown} session - Session object.
   */
  reconcileAlreadyCompleted(wake, messageId, session) {
    const seen = this.seen.get(messageId)
    if (
      seen?.completed === true &&
      seen.sessionId === wake.targetSessionId &&
      seen.wakeId === wake.id &&
      Number.isInteger(seen.turn) &&
      Number.isInteger(seen.turnEndSeq)
    ) {
      this.#recordTurnEnd(seen, seen.sessionId, seen.turn, seen.turnEndSeq, seen.turnReason ?? 'completed')
      return
    }
    this.scanSnapshot(wake, messageId, session)
  }

  /**
   * Scan durable Session events for this wake's message consumed by a completed
   * turn. Conservative: the message must appear inside an open turn and that
   * same turn must end completed.
   * @param {Record<string, unknown>} wake - admitted wake.
   * @param {string} messageId - admitted message id.
   * @param {unknown} session - Session object.
   */
  scanSnapshot(wake, messageId, session) {
    if (session?.id !== wake.targetSessionId) return
    let events
    try {
      events = session?.snapshotEvents?.() ?? []
    } catch {
      return
    }
    if (!Array.isArray(events)) return
    const found = this.#scanEventsForWake(events, wake.id, messageId)
    if (found === null) return
    try {
      this.core.recordWakeConsumedFromSnapshot(wake.id, {
        targetSessionId: wake.targetSessionId,
        messageId,
        turnSeq: found.turn,
        userMessageSeq: found.userSeq,
      })
      this.core.recordWakeTurnEnd(wake.id, {
        targetSessionId: wake.targetSessionId,
        messageId,
        turnSeq: found.turn,
        turnEndSeq: found.endSeq,
        reason: found.reason,
      })
    } catch {
      // Leave unreconciled; never guess.
    }
  }

  /**
   * Find one exact wake message inside an open turn and its same-turn end.
   * Bounded to SNAPSHOT_SCAN_LIMIT. Requires exactly one matching message.
   * @param {unknown[]} events - durable Session events.
   * @param {string} wakeId - ledger wake id.
   * @param {string} messageId - persistent message id.
   * @returns {{turn: number, userSeq: number, endSeq: number, reason: string} | null} evidence.
   */
  #scanEventsForWake(events, wakeId, messageId) {
    const window = events.length > SNAPSHOT_SCAN_LIMIT ? events.slice(-SNAPSHOT_SCAN_LIMIT) : events
    let openTurn = null
    let match = null
    let matches = 0
    for (let index = 0; index < window.length; index += 1) {
      const event = window[index]
      if (event?.type === 'turn/start') openTurn = Number(event.data?.turn)
      else if (event?.type === 'turn/end') {
        if (Number(event.data?.turn) === openTurn) openTurn = null
      } else if (event?.type === 'user/message') {
        const data = event.data
        if (
          data?.id !== messageId ||
          data?.source?.kind !== WAKE_SOURCE_KIND ||
          data.source.wakeId !== wakeId
        ) {
          continue
        }
        matches += 1
        if (matches > 1 || openTurn === null) return null
        match = { index, turn: openTurn, userSeq: Number(event.seq) }
      }
    }
    if (match === null || !Number.isInteger(match.turn) || !Number.isInteger(match.userSeq)) return null
    for (let index = match.index + 1; index < window.length; index += 1) {
      const event = window[index]
      if (event?.type === 'turn/start' && Number(event.data?.turn) !== match.turn) return null
      if (event?.type === 'turn/end' && Number(event.data?.turn) === match.turn) {
        const endSeq = Number(event.seq)
        if (!Number.isInteger(endSeq)) return null
        return {
          turn: match.turn,
          userSeq: match.userSeq,
          endSeq,
          reason: event.data?.reason?.kind ?? 'unknown',
        }
      }
    }
    return null
  }

  /**
   * Read bounded durable Session history through the official Host history API:
   * `projections()` supplies the exact `asOfSeq`, `page()` supplies chronological
   * `{type:'event', event}` records. No cold Agent resolution and no invented
   * `inspect` method.
   * @param {string} sessionId - target DSH Session.
   * @returns {Promise<{events: unknown[] | null, complete: boolean}>} bounded history.
   */
  async #readSessionEvents(sessionId, signal) {
    const controller = this.sessionController
    let projection
    try {
      projection = await controller.projections({ sessionId }, signal)
    } catch {
      return { events: null, complete: false }
    }
    if (
      projection === null ||
      typeof projection !== 'object' ||
      projection.kind !== 'sequenced' ||
      !Number.isInteger(Number(projection.asOfSeq))
    ) {
      return { events: null, complete: false }
    }
    const throughSeq = Number(projection.asOfSeq)
    let beforeSeq
    let events = []
    let complete = false
    for (let pageIndex = 0; pageIndex < HISTORY_MAX_PAGES; pageIndex += 1) {
      const request = {
        address: { kind: 'session', sessionId },
        throughSeq,
        maxMessages: HISTORY_PAGE_MESSAGES,
        turnWindow: { minMessages: 1, minTurns: 1 },
      }
      if (beforeSeq !== undefined) request.beforeSeq = beforeSeq
      let response
      try {
        response = await controller.page(request, signal)
      } catch {
        return { events, complete: false }
      }
      const records = Array.isArray(response?.records) ? response.records : []
      const pageEvents = []
      for (const record of records) {
        if (record?.type === 'event' && record.event && typeof record.event.type === 'string') {
          pageEvents.push(record.event)
        }
      }
      events = [...pageEvents, ...events]
      if (response?.hasMore !== true) {
        complete = true
        break
      }
      const firstSeq = pageEvents.length > 0 ? Number(pageEvents[0].seq) : NaN
      if (!Number.isInteger(firstSeq)) return { events, complete: false }
      beforeSeq = firstSeq
    }
    if (events.length > EVIDENCE_EVENT_LIMIT) {
      events = events.slice(-EVIDENCE_EVENT_LIMIT)
      complete = false
    }
    return { events, complete }
  }

  /**
   * Restart reconciliation using the real Host history API. A wake is cleared
   * only with exact target Session + persistent message id + source wakeId +
   * same-turn start/message/end evidence. Failures retry with bounded backoff;
   * unresolved/pending evidence never reports overall delivery as active.
   * @returns {Promise<Record<string, unknown>>} reconciliation outcome.
   */
  async reconcileUnreconciledWakes() {
    if (this.disposed || !this.bound) {
      this.reconcileState = 'unavailable'
      return { status: 'unavailable', reason: 'not_bound' }
    }
    const canRead =
      typeof this.sessionController?.projections === 'function' &&
      typeof this.sessionController?.page === 'function'
    if (!canRead) {
      this.reconcileState = 'unavailable'
      this.lastReconcileError = 'history_capability_missing'
      return { status: 'unavailable', reason: 'history_capability_missing' }
    }
    const now = this.clock()
    if (now < this.nextReconcileAt) return { status: 'throttled', retryAt: this.nextReconcileAt }
    this.reconcileState = 'running'
    const abort = new AbortController()
    this.reconcileAbort = abort
    let examined = 0
    let executed = 0
    let incomplete = false
    try {
      for (const sessionId of this.allowed) {
        let wakes
        try {
          wakes = this.core.listUnreconciledWakesForSession(sessionId, { limit: 20 })
        } catch {
          incomplete = true
          continue
        }
        if (wakes.length === 0) continue
        const history = await this.#readSessionEvents(sessionId, abort.signal)
        if (this.disposed) return { status: 'disposed', examined, executed }
        if (history.events === null) {
          incomplete = true
          continue
        }
        if (history.complete !== true) incomplete = true
        for (const wake of wakes) {
          if (this.disposed) return { status: 'disposed', examined, executed }
          const messageId = wake.messageId ?? wake.preparedMessageId
          if (typeof messageId !== 'string') continue
          const found = this.#scanEventsForWake(history.events, wake.id, messageId)
          if (found === null) continue
          examined += 1
          try {
            this.core.recordWakeConsumedFromSnapshot(wake.id, {
              targetSessionId: sessionId,
              messageId,
              turnSeq: found.turn,
              userMessageSeq: found.userSeq,
            })
            this.core.recordWakeTurnEnd(wake.id, {
              targetSessionId: sessionId,
              messageId,
              turnSeq: found.turn,
              turnEndSeq: found.endSeq,
              reason: found.reason,
            })
            if (found.reason === 'completed') executed += 1
          } catch {
            // Keep unreconciled; never guess.
          }
        }
      }
      this.reconcileState = incomplete ? 'partial' : 'done'
      this.lastReconcileError = incomplete ? 'history_window_incomplete' : null
      if (incomplete) {
        this.nextReconcileAt = this.clock() + this.reconcileBackoffMs
        this.reconcileBackoffMs = Math.min(this.reconcileBackoffMs * 2, 300_000)
      } else {
        this.reconcileBackoffMs = 30_000
        this.nextReconcileAt = this.clock() + this.intervalMs
      }
      return { status: 'ok', examined, executed, incomplete }
    } catch (error) {
      this.reconcileState = 'degraded'
      this.lastReconcileError = messageOf(error)
      this.nextReconcileAt = this.clock() + this.reconcileBackoffMs
      this.reconcileBackoffMs = Math.min(this.reconcileBackoffMs * 2, 300_000)
      return { status: 'error', error: this.lastReconcileError, examined, executed }
    } finally {
      if (this.reconcileAbort === abort) this.reconcileAbort = null
    }
  }
}
