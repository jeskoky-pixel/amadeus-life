/**
 * Shared errors, statuses, validation helpers, and identifiers for Amadeus Life.
 *
 * This module intentionally imports nothing: the Life core must be testable
 * without DSH, Cordis, QQ, Memory, State, or any other Amadeus plugin.
 */

/** Base class for every explicit Life failure. */
export class LifeError extends Error {
  /**
   * @param {string} message - human-readable description.
   * @param {string} code - stable machine-readable code (`LIFE_*`).
   * @param {Record<string, unknown>} [details] - non-secret context.
   */
  constructor(message, code, details = {}) {
    super(message)
    this.name = new.target.name
    this.code = code
    this.details = details
  }
}

/** Invalid input or an operation the current state does not allow. */
export class LifeValidationError extends LifeError {
  constructor(message, details) {
    super(message, 'LIFE_VALIDATION', details)
  }
}

/** The requested intent/activity/event does not exist for this trusted scope. */
export class LifeNotFoundError extends LifeError {
  constructor(message, details) {
    super(message, 'LIFE_NOT_FOUND', details)
  }
}

/** Optimistic-concurrency failure: the caller used a stale revision. */
export class LifeRevisionConflictError extends LifeError {
  constructor(message, details) {
    super(message, 'LIFE_REVISION_CONFLICT', details)
  }
}

/** A state transition outside the declared activity transition table. */
export class LifeInvalidTransitionError extends LifeError {
  constructor(message, details) {
    super(message, 'LIFE_INVALID_TRANSITION', details)
  }
}

/** A late result for cancelled or obsolete work; never revives the intent. */
export class LifeStaleResultError extends LifeError {
  constructor(message, details) {
    super(message, 'LIFE_STALE_RESULT', details)
  }
}

/** Missing trusted scope or missing external authorization adapter. */
export class LifeUnauthorizedError extends LifeError {
  constructor(message, details) {
    super(message, 'LIFE_UNAUTHORIZED', details)
  }
}

/** Storage could not be opened, verified, or written safely. */
export class LifeStorageError extends LifeError {
  constructor(message, details) {
    super(message, 'LIFE_STORAGE', details)
  }
}

/** Life is closed or disposed; no further work is accepted. */
export class LifeClosedError extends LifeError {
  constructor(message = 'Life is closed') {
    super(message, 'LIFE_CLOSED')
  }
}

/** Schema version written into `meta.schema_version` by this build. */
export const LIFE_SCHEMA_VERSION = '2'

/** Allowed intent statuses. Intents are never implicitly "completed". */
export const INTENT_STATUSES = Object.freeze(['active', 'cancelled'])

/** Allowed activity statuses, including external-work uncertainty. */
export const ACTIVITY_STATUSES = Object.freeze([
  'pending',
  'running',
  'paused',
  'stopping',
  'completed',
  'failed',
  'cancelled',
  'unknown',
])

/**
 * The complete activity transition table. `cancelled` is reachable from
 * `stopping`/`unknown` only with trusted provider evidence; a model tool call
 * or note is not a confirmation that external work stopped.
 */
export const ACTIVITY_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['running', 'failed', 'cancelled']),
  running: Object.freeze(['paused', 'stopping', 'failed', 'completed', 'unknown']),
  paused: Object.freeze(['running', 'stopping', 'failed']),
  stopping: Object.freeze(['cancelled', 'unknown']),
  unknown: Object.freeze(['completed', 'failed', 'cancelled']),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
})

/** Statuses from which no further transition is possible. */
export const TERMINAL_ACTIVITY_STATUSES = Object.freeze(['completed', 'failed', 'cancelled'])

const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/

/**
 * Validate and normalize an ISO-8601 UTC timestamp with millisecond precision.
 * Rejects calendar/time rollovers such as 2026-02-30 or 24:00 instead of
 * letting `Date.parse` silently normalize them.
 * @param {unknown} value - candidate value.
 * @param {string} field - field name for the error message.
 * @returns {string} canonical `toISOString()` form.
 */
export function normalizeTimestamp(value, field) {
  const match = typeof value === 'string' ? ISO_UTC.exec(value) : null
  if (match === null) {
    throw new LifeValidationError(`${field} must be an ISO-8601 UTC timestamp with millisecond precision`, { field })
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, msText] = match
  const numbers = [yearText, monthText, dayText, hourText, minuteText, secondText, msText].map(Number)
  const [year, month, day, hour, minute, second, millisecond] = numbers
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    throw new LifeValidationError(`${field} is not a valid calendar timestamp`, { field })
  }
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, millisecond)
  const roundTrips =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second &&
    date.getUTCMilliseconds() === millisecond
  if (!roundTrips) {
    throw new LifeValidationError(`${field} is not a valid calendar timestamp`, { field })
  }
  return date.toISOString()
}

/**
 * Validate a non-empty string with a maximum length.
 * @param {unknown} value - candidate value.
 * @param {string} field - field name for the error message.
 * @param {number} [maxLength] - maximum accepted length.
 * @returns {string} the original string.
 */
export function requireString(value, field, maxLength = 2000) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LifeValidationError(`${field} must be a non-empty string`, { field })
  }
  if (value.length > maxLength) {
    throw new LifeValidationError(`${field} must be at most ${maxLength} characters`, { field })
  }
  return value
}

/**
 * Validate an integer option.
 * @param {unknown} value - candidate value.
 * @param {string} field - field name for the error message.
 * @param {{min?: number, max?: number}} [range] - inclusive bounds.
 * @returns {number} the integer.
 */
export function assertInteger(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new LifeValidationError(`${field} must be an integer between ${min} and ${max}`, { field })
  }
  return value
}

/**
 * The stable outbox identity for one intent revision's reconsideration event.
 * Duplicate ticks and restarts converge on this identity.
 * @param {string} intentId - owning intent.
 * @param {number} intentRevision - exact intent revision.
 * @returns {string} stable event id.
 */
export function reconsiderationEventId(intentId, intentRevision) {
  return `reconsider:${intentId}:${intentRevision}`
}

/**
 * Assert one activity transition against the declared table.
 * @param {string} from - current status.
 * @param {string} to - requested status.
 */
export function assertActivityTransition(from, to) {
  const allowed = ACTIVITY_TRANSITIONS[from]
  if (allowed === undefined) {
    throw new LifeInvalidTransitionError(`unknown activity status "${from}"`, { from, to })
  }
  if (!allowed.includes(to)) {
    throw new LifeInvalidTransitionError(`activity transition ${from} -> ${to} is not allowed`, { from, to })
  }
}
