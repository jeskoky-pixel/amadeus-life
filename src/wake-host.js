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

/**
 * Short reference-only prompt for the model. Deliberately excludes the intent
 * description and any scripted outgoing text.
 * @param {Record<string, unknown>} wake - wake row view.
 * @returns {string} prompt text.
 */
export function wakePrompt(wake) {
  return `Life wake ${String(wake.id)}: intent ${String(wake.intentId)} revision ${String(wake.intentRevision)}. Re-read the current Life state before deciding anything; do not send external messages from this wake.`
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
    sessionController,
    flushSession,
    enabled = false,
    allowedSessionIds,
    intervalMs,
    maxPerDrive,
    clock = () => Date.now(),
    logger,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  }) {
    this.core = core
    this.ownerId = ownerId
    this.sessionController = sessionController
    this.flushSession = flushSession
    this.allowed = [...new Set(allowedSessionIds ?? [])]
    this.allowedSet = new Set(this.allowed)
    this.intervalMs = intervalMs
    this.maxPerDrive = maxPerDrive
    this.clock = clock
    this.logger = logger
    this.setIntervalFn = setIntervalFn
    this.clearIntervalFn = clearIntervalFn

    // Both the trusted `enabled` flag and a non-empty administrator allowlist
    // are required; an allowlist alone must never enable delivery.
    this.requested = enabled === true
    this.enabled = this.requested && this.allowed.length > 0
    this.missing = []
    if (typeof sessionController?.resolveAgent !== 'function') this.missing.push('sessionController.resolveAgent')
    if (typeof flushSession !== 'function') this.missing.push('sessions.flush')

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
    const state = !this.enabled ? 'disabled' : this.missing.length > 0 ? 'degraded' : 'active'
    return {
      state,
      reason: !this.enabled
        ? this.requested
          ? 'no_allowed_sessions'
          : 'not_enabled'
        : this.missing.length > 0
          ? 'missing_capability'
          : undefined,
      enabled: this.enabled,
      allowedSessions: this.allowed.length,
      intervalMs: this.intervalMs,
      maxPerDrive: this.maxPerDrive,
      timerActive: this.timer !== null,
      inFlight: this.running,
      missing: this.missing.length > 0 ? [...this.missing] : undefined,
      lastError: this.lastError ?? undefined,
    }
  }

  /**
   * Register the Session event listener and low-frequency timer. No side effect
   * when disabled, without an allowlist, or when a Host capability is absent.
   * @param {{registerListener: (handler: (session: unknown, event: unknown) => void) => (() => void)}} options - listener registrar.
   */
  start({ registerListener } = {}) {
    if (this.disposed || !this.enabled || this.missing.length > 0) return
    if (typeof registerListener !== 'function') {
      this.missing.push('ctx.on')
      return
    }
    try {
      this.listenerDisposer = registerListener((session, event) => this.handleSessionEvent(session, event))
    } catch {
      // Listener registration is a delivery-only capability. Registration
      // failure must degrade delivery, not fail the whole Life plugin.
      this.listenerDisposer = null
      this.missing.push('ctx.on')
      return
    }
    this.timer = this.setIntervalFn(() => {
      this.driveOnce().catch((error) => {
        this.lastError = messageOf(error)
        this.logger?.warn?.(`amadeus-life: wake drive failed: ${this.lastError}`)
      })
    }, this.intervalMs)
    this.timer?.unref?.()
  }

  /** Stop the timer and listener; later async completions must not touch core. */
  stop() {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== null) {
      this.clearIntervalFn(this.timer)
      this.timer = null
    }
    try {
      this.listenerDisposer?.()
    } catch {
      // Listener removal must not block disposal.
    }
    this.listenerDisposer = null
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
    if (this.running) return { status: 'busy', delivered: [] }
    this.running = true
    const delivered = []
    try {
      this.core.tick()
      this.core.prepareDueWakes({
        limit: Math.min(100, Math.max(10, this.maxPerDrive * Math.max(1, this.allowed.length) * 2)),
      })
      let claimed = 0
      for (const sessionId of this.allowed) {
        if (this.disposed || claimed >= this.maxPerDrive) break
        if (this.core.hasUnreconciledWakeForSession(sessionId)) continue
        const wake = this.core.claimNextWake({ ownerId: this.ownerId, targetSessionId: sessionId })
        if (wake === null) continue
        claimed += 1
        const outcome = await this.deliver(wake)
        if (outcome !== null && outcome.status !== 'superseded') delivered.push(outcome)
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
   * Deliver one claimed wake: resolve, recheck, followup, flush, admission.
   * @param {Record<string, unknown>} wake - claimed wake.
   * @returns {Promise<Record<string, unknown> | null>} delivery outcome.
   */
  async deliver(wake) {
    let resolved
    try {
      resolved = await this.sessionController.resolveAgent(wake.targetSessionId)
    } catch (error) {
      return this.#uncertain(wake, `resolve threw: ${messageOf(error)}`)
    }
    if (this.disposed) return { status: 'disposed', wakeId: wake.id }
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

    const agent = resolved.agent
    const message = {
      role: 'user',
      id: randomUUID(),
      content: [{ type: 'text', text: wakePrompt(wake) }],
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
    if (this.disposed) return { status: 'disposed', wakeId: wake.id }
    if (flushed !== true) return this.#uncertain(wake, 'flush unconfirmed')

    try {
      const admitted = this.core.markWakeAdmitted(wake.id, { ownerId: this.ownerId, messageId: message.id })
      this.watched.set(message.id, { wakeId: wake.id, sessionId: wake.targetSessionId })
      this.reconcileAlreadyCompleted(wake, message.id, agent.session)
      return { status: 'admitted', wakeId: wake.id, messageId: message.id, wakeStatus: admitted.status }
    } catch {
      // A local acknowledgement may have superseded the wake; otherwise the
      // durable message exists but the ledger cannot prove admission.
      try {
        const current = this.core.getWake(wake.id)
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
        const watched = this.watched.get(messageId)
        if (watched !== undefined && (watched.sessionId !== sessionId || watched.wakeId !== wakeId)) return
        const turn = this.currentTurn.get(sessionId) ?? null
        if (watched !== undefined && turn !== null) {
          this.consumed.set(sessionId, { messageId, wakeId, turn })
        }
        this.seen.set(messageId, { sessionId, wakeId, turn, completed: false })
        pruneMap(this.seen)
        return
      }
      if (event.type === 'turn/end') {
        const turn = Number(event.data?.turn)
        const reason = event.data?.reason
        const consumed = this.consumed.get(sessionId)
        if (consumed !== undefined && consumed.turn === turn) {
          if (reason?.kind === 'completed') {
            this.complete(consumed.wakeId, consumed.messageId, turn, sessionId)
          }
          this.consumed.delete(sessionId)
        }
        for (const [messageId, entry] of this.seen) {
          if (entry.sessionId !== sessionId || entry.turn !== turn) continue
          if (reason?.kind === 'completed') {
            entry.completed = true
            if (this.watched.has(messageId)) this.complete(entry.wakeId, messageId, turn, sessionId)
          }
        }
        if (this.currentTurn.get(sessionId) === turn) this.currentTurn.delete(sessionId)
      }
    } catch {
      // Event observation must never break the Host.
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
      Number.isInteger(seen.turn)
    ) {
      this.complete(wake.id, messageId, seen.turn, seen.sessionId)
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
    // Bounded tail window: a very long Session cannot force an unbounded scan.
    // If the matching message fell outside the window, execution is not
    // guessed; it stays admitted for later evidence-based reconciliation.
    const window = events.length > SNAPSHOT_SCAN_LIMIT ? events.slice(-SNAPSHOT_SCAN_LIMIT) : events
    let openTurn = null
    let messageIndex = -1
    for (let index = 0; index < window.length; index += 1) {
      const event = window[index]
      if (event?.type === 'turn/start') openTurn = Number(event.data?.turn)
      else if (event?.type === 'turn/end') {
        if (Number(event.data?.turn) === openTurn) openTurn = null
      } else if (event?.type === 'user/message') {
        const data = event.data
        if (
          data?.id === messageId &&
          data?.source?.kind === WAKE_SOURCE_KIND &&
          data.source.wakeId === wake.id
        ) {
          if (openTurn === null) return
          messageIndex = index
          break
        }
      }
    }
    if (messageIndex < 0 || openTurn === null) return
    const turn = openTurn
    for (let index = messageIndex + 1; index < window.length; index += 1) {
      const event = window[index]
      if (event?.type === 'turn/start' && Number(event.data?.turn) !== turn) return
      if (event?.type === 'turn/end' && Number(event.data?.turn) === turn) {
        if (event.data?.reason?.kind === 'completed') {
          this.complete(wake.id, messageId, turn, wake.targetSessionId)
        }
        return
      }
    }
  }

  /** @param {string} wakeId @param {string} messageId @param {number} turn @param {string} sessionId */
  complete(wakeId, messageId, turn, sessionId) {
    if (this.disposed) return
    try {
      const wake = this.core.getWake(wakeId)
      if (
        wake.status !== 'admitted' ||
        wake.messageId !== messageId ||
        wake.targetSessionId !== sessionId
      ) {
        return
      }
      this.core.markWakeExecuted(wakeId, { messageId, turnSeq: turn })
      this.watched.delete(messageId)
      this.seen.delete(messageId)
    } catch {
      // Stale or closed: execution is never guessed.
    }
  }
}
