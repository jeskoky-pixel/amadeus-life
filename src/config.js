/**
 * Normalize the authoritative flat Config into the existing nested runtime
 * shape. Existing nested programmatic configs remain accepted for backward
 * compatibility.
 */

import { CONFIG_DEFAULTS, CONFIG_FIELDS } from './config-fields.js'
import { isDshSessionScope, LifeValidationError } from './model.js'

function hasGet(value) {
  return typeof value === 'object' && value !== null && typeof value.get === 'function'
}

/** @param {Record<string, unknown>} config @param {string} key */
export function readField(config, key) {
  const value = config?.[key]
  return hasGet(value) ? value.get() : value
}

/** @param {Record<string, unknown>} raw */
export function isFlatConfig(raw) {
  // A flat Config form always includes at least one UI-only marker. Merely
  // having databasePath/tickIntervalMs must not reinterpret a legacy nested
  // programmatic config as a flat form value.
  return [
    'wakeDeliveryEnabled',
    'wakeIntervalSeconds',
    'maxPerDrive',
    'idleEnabled',
    'idleTargetSessionId',
    'wakeBudgetEnabled',
    'activityToolsEnabled',
    'sharedReadEnabled',
    'bootstrapEnabled',
    'allowedSessionIds',
  ].some((key) => Object.hasOwn(raw ?? {}, key))
}

function fieldValue(raw, field) {
  const value = readField(raw, field.key)
  return value === undefined ? field.default : value
}

/**
 * @param {Record<string, unknown>} [raw]
 * @returns {Record<string, unknown>} nested runtime config.
 */
export function normalizeLifeConfig(raw = {}) {
  if (!isFlatConfig(raw)) return raw
  const values = {}
  for (const field of CONFIG_FIELDS) {
    const value = fieldValue(raw, field)
    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') throw new LifeValidationError(`${field.key} must be a boolean`)
      values[field.key] = value
    } else if (field.type === 'array') {
      if (!Array.isArray(value)) throw new LifeValidationError(`${field.key} must be an array`)
      values[field.key] = value.map((entry) => {
        if (typeof entry !== 'string' || entry.length === 0 || entry.length > 200) {
          throw new LifeValidationError(`${field.key} entries must be strings`)
        }
        return entry
      })
    } else if (field.type === 'string') {
      if (typeof value !== 'string') throw new LifeValidationError(`${field.key} must be a string`)
      if (field.max !== undefined && value.length > field.max) throw new LifeValidationError(`${field.key} is too long`)
      values[field.key] = value
    } else {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new LifeValidationError(`${field.key} must be a finite number`)
      if (field.min !== undefined && value < field.min) throw new LifeValidationError(`${field.key} is below ${field.min}`)
      if (field.max !== undefined && value > field.max) throw new LifeValidationError(`${field.key} is above ${field.max}`)
      values[field.key] = value
    }
  }
  const allowed = [...new Set(values.allowedSessionIds)]
  for (const id of allowed) {
    if (!isDshSessionScope(`session:${id}`)) throw new LifeValidationError('allowedSessionIds must contain DSH Session ids')
  }
  if (values.idleEnabled && !allowed.includes(values.idleTargetSessionId)) {
    throw new LifeValidationError('idleTargetSessionId must be in allowedSessionIds')
  }
  if (values.bootstrapEnabled && allowed.length === 0) {
    throw new LifeValidationError('bootstrapEnabled requires allowedSessionIds')
  }
  const hasStart = values.quietStartHour >= 0
  const hasEnd = values.quietEndHour >= 0
  if (hasStart !== hasEnd) throw new LifeValidationError('quietStartHour and quietEndHour must both be set or both -1')
  const wakeWindowMs = values.wakeWindowHours * 60 * 60 * 1000
  return {
    databasePath: values.databasePath === '' ? undefined : values.databasePath,
    tickIntervalMs: values.tickIntervalMs,
    maxReviewBatch: values.maxReviewBatch,
    wakeDelivery: {
      enabled: values.wakeDeliveryEnabled,
      allowedSessionIds: allowed,
      intervalMs: values.wakeIntervalSeconds * 1000,
      maxPerDrive: values.maxPerDrive,
    },
    idle: values.idleEnabled
      ? {
          enabled: true,
          targetSessionId: values.idleTargetSessionId,
          windowMs: values.idleWindowMinutes * 60 * 1000,
          quietAfterActivityMs: values.quietAfterActivityMinutes * 60 * 1000,
          ...(hasStart ? { quietStartHour: values.quietStartHour, quietEndHour: values.quietEndHour } : {}),
        }
      : { enabled: false },
    wakeBudget: {
      enabled: values.wakeBudgetEnabled,
      windowMs: wakeWindowMs,
      wakeLimit: values.wakeLimit,
      tokenLimit: values.tokenLimit === 0 ? undefined : values.tokenLimit,
      costLimit: values.costLimit === 0 ? undefined : values.costLimit,
      activityLimit: values.activityLimit === 0 ? undefined : values.activityLimit,
      estimatedTokens: 0,
    },
    activityTools: { enabled: values.activityToolsEnabled },
    sharedRead: { enabled: values.sharedReadEnabled },
    bootstrap: {
      enabled: values.bootstrapEnabled,
      personaName: values.bootstrapPersonaName,
    },
  }
}

/** @param {Record<string, unknown>} raw */
export function publicConfig(raw = {}) {
  const output = {}
  for (const field of CONFIG_FIELDS) output[field.key] = fieldValue(raw, field)
  return output
}

export { CONFIG_DEFAULTS }
