#!/usr/bin/env node
/**
 * Offline Life setup helper. It only prints or writes a DSH row `config` JSON.
 * It never edits a profile, reads credentials, binds Sessions, or enables
 * autonomous behavior by itself.
 */
import { writeFileSync } from 'node:fs'
import { isDshSessionScope } from '../src/model.js'

export const PRESETS = Object.freeze(['core', 'autonomous', 'activity'])

const SESSION_HINT = 'DSH Session ids look like session-<uuid>; copy them from the Session list.'

export function normalizeSessions(sessions = []) {
  const values = Array.isArray(sessions)
    ? sessions
    : String(sessions).split(',').map((value) => value.trim()).filter(Boolean)
  const unique = []
  for (const value of values) {
    if (!isDshSessionScope(`session:${value}`)) {
      throw new Error(`invalid Session id ${JSON.stringify(value)}; ${SESSION_HINT}`)
    }
    if (!unique.includes(value)) unique.push(value)
  }
  if (unique.length > 100) throw new Error('at most 100 Sessions can be allowlisted')
  return unique
}

/**
 * @param {{preset?: 'core'|'autonomous'|'activity', sessions?: string[], idleWindowMinutes?: number, activityLimit?: number}} options
 * @returns {Record<string, unknown>} setup result.
 */
export function buildSetup({
  preset = 'core',
  sessions = [],
  idleWindowMinutes = 30,
  activityLimit = 1,
} = {}) {
  if (!PRESETS.includes(preset)) throw new Error(`preset must be one of ${PRESETS.join(', ')}`)
  const allowed = normalizeSessions(sessions)
  if (preset !== 'core' && allowed.length === 0) {
    throw new Error('choose at least one Session for autonomous or activity setup')
  }
  if (!Number.isInteger(idleWindowMinutes) || idleWindowMinutes < 1 || idleWindowMinutes > 1440) {
    throw new Error('idleWindowMinutes must be an integer from 1 to 1440')
  }
  if (!Number.isInteger(activityLimit) || activityLimit < 0) {
    throw new Error('activityLimit must be a non-negative integer')
  }
  const config = {
    wakeDelivery: {
      enabled: false,
      allowedSessionIds: allowed,
      intervalMs: 60_000,
      maxPerDrive: 1,
    },
    idle: { enabled: false },
    activityTools: { enabled: false },
    sharedRead: { enabled: false },
  }
  if (preset === 'autonomous') {
    config.wakeDelivery.enabled = true
    config.bootstrap = { enabled: true, personaName: 'Amadeus' }
    config.idle = {
      enabled: true,
      targetSessionId: allowed[0],
      windowMs: idleWindowMinutes * 60_000,
      quietAfterActivityMs: 5 * 60_000,
    }
    config.wakeBudget = {
      enabled: true,
      windowMs: 86_400_000,
      wakeLimit: 20,
      activityLimit,
      estimatedTokens: 0,
    }
  }
  if (preset === 'activity') {
    config.activityTools = { enabled: true }
    config.bootstrap = { enabled: true, personaName: 'Amadeus' }
  }
  return {
    preset,
    config,
    notes: buildNotes(preset, allowed),
  }
}

function buildNotes(preset, allowed) {
  const notes = []
  if (preset === 'core') {
    notes.push('Core only: no Host wake, no idle, no autonomous model calls, no new model tools.')
  }
  if (preset === 'autonomous') {
    notes.push('Autonomous delivery is enabled only for the listed Sessions; idle is enabled for the first Session.')
    notes.push('Bootstrap creates one stable local Persona and one private Scene/binding per allowlisted Session. Existing different bindings fail closed; no history is overwritten.')
  }
  if (preset === 'activity') {
    notes.push('Local virtual activity tools are enabled; Host wake/idle remain off unless combined with the autonomous preset.')
    notes.push('Bootstrap creates one stable local Persona and one private Scene/binding per allowlisted Session. Existing different bindings fail closed; no history is overwritten.')
  }
  if (allowed.length > 0) notes.push('Only these allowlisted Session ids can receive Life wake/idle delivery.')
  return notes
}

/** Minimal independent validator for a generated row config. */
export function validateSetup(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('config must be a plain object')
  }
  const provider = config.wakeDelivery
  if (provider !== undefined) {
    if (provider === null || typeof provider !== 'object') throw new Error('wakeDelivery must be an object')
    const allowed = normalizeSessions(provider.allowedSessionIds ?? [])
    if (provider.enabled === true && allowed.length === 0) {
      throw new Error('wakeDelivery.enabled requires at least one allowed Session')
    }
    if (provider.intervalMs !== undefined && (!Number.isInteger(provider.intervalMs) || provider.intervalMs < 1000)) {
      throw new Error('wakeDelivery.intervalMs must be an integer >= 1000')
    }
    if (provider.maxPerDrive !== undefined && (!Number.isInteger(provider.maxPerDrive) || provider.maxPerDrive < 1 || provider.maxPerDrive > 5)) {
      throw new Error('wakeDelivery.maxPerDrive must be 1..5')
    }
    if (config.idle?.enabled === true) {
      if (typeof config.idle.targetSessionId !== 'string' || !allowed.includes(config.idle.targetSessionId)) {
        throw new Error('idle.targetSessionId must be in wakeDelivery.allowedSessionIds')
      }
    }
  }
  if (config.activityTools !== undefined && typeof config.activityTools?.enabled !== 'boolean') {
    throw new Error('activityTools.enabled must be a boolean')
  }
  if (config.bootstrap !== undefined) {
    if (config.bootstrap === null || typeof config.bootstrap !== 'object') {
      throw new Error('bootstrap must be an object')
    }
    if (typeof config.bootstrap.enabled !== 'boolean') {
      throw new Error('bootstrap.enabled must be a boolean')
    }
    if (config.bootstrap.enabled === true) {
      const allowed = normalizeSessions(config.wakeDelivery?.allowedSessionIds ?? [])
      if (allowed.length === 0) throw new Error('bootstrap.enabled requires wakeDelivery.allowedSessionIds')
      if (config.bootstrap.personaName !== undefined && typeof config.bootstrap.personaName !== 'string') {
        throw new Error('bootstrap.personaName must be a string')
      }
    }
  }
  if (config.sharedRead !== undefined && typeof config.sharedRead?.enabled !== 'boolean') {
    throw new Error('sharedRead.enabled must be a boolean')
  }
  return true
}

/**
 * Write a new config file exclusively. Existing files are never overwritten.
 * @param {string} path @param {Record<string, unknown>} config
 */
export function writeSetupFile(path, config) {
  if (typeof path !== 'string' || path.length === 0) throw new Error('output path must be a non-empty string')
  try {
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`refusing to overwrite existing file ${JSON.stringify(path)}; choose a new path`)
    }
    throw error
  }
}

export function renderSetup(result) {
  return [
    `Life setup preset: ${result.preset}`,
    '',
    'Add this object as the `config` of the amadeus-life row (do not edit a profile by hand):',
    '',
    JSON.stringify(result.config, null, 2),
    '',
    'Notes:',
    ...result.notes.map((note) => `- ${note}`),
    '',
    'Next: enable the row in DSH, then check ctx.life.getHealth(). If delivery is degraded, read delivery.reason/missing.',
  ].join('\n')
}

function parseArgs(argv) {
  const args = { preset: 'core', sessions: [], out: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      args.help = true
    } else if (arg === '--preset') {
      args.preset = argv[++index]
    } else if (arg === '--sessions') {
      args.sessions = argv[++index] ?? ''
    } else if (arg === '--out') {
      args.out = argv[++index]
    } else if (arg === '--activity-limit') {
      args.activityLimit = Number(argv[++index])
    } else if (arg === '--idle-window') {
      args.idleWindowMinutes = Number(argv[++index])
    } else {
      throw new Error(`unknown argument ${arg}`)
    }
  }
  return args
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) {
      process.stdout.write(
        [
          'Usage: node scripts/life-setup.mjs --preset core|autonomous|activity [options]',
          '',
          '  --sessions id1,id2         DSH Session ids for the allowlist',
          '  --idle-window MINUTES      idle opportunity interval (default 30)',
          '  --activity-limit N         concurrent activity limit (default 1)',
          '  --out FILE                 create a NEW JSON config file (never overwrites)',
          '',
          'The helper never edits a profile, reads secrets, binds Sessions, or enables anything.',
        ].join('\n'),
      )
    } else {
      const result = buildSetup(args)
      validateSetup(result.config)
      const text = renderSetup(result)
      if (args.out !== undefined) writeSetupFile(args.out, result.config)
      process.stdout.write(`${text}\n`)
    }
  } catch (error) {
    process.stderr.write(`life-setup: ${error.message}\n`)
    process.exitCode = 1
  }
}
