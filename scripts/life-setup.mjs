#!/usr/bin/env node
/**
 * Offline Life setup helper. It only prints or writes a DSH row `config` JSON.
 * It never edits a profile, reads credentials, binds Sessions, or enables
 * autonomous behavior by itself.
 */
import { writeFileSync } from 'node:fs'
import { isDshSessionScope } from '../src/model.js'
import { isFlatConfig, normalizeLifeConfig } from '../src/config.js'

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
    wakeDeliveryEnabled: false,
    allowedSessionIds: allowed,
    wakeIntervalSeconds: 60,
    maxPerDrive: 1,
    idleEnabled: false,
    idleTargetSessionId: '',
    idleWindowMinutes,
    quietAfterActivityMinutes: 5,
    wakeBudgetEnabled: false,
    wakeLimit: 20,
    wakeWindowHours: 24,
    tokenLimit: 0,
    costLimit: 0,
    activityLimit: 0,
    activityToolsEnabled: false,
    sharedReadEnabled: false,
    bootstrapEnabled: false,
    bootstrapPersonaName: 'Amadeus',
  }
  if (preset === 'autonomous') {
    config.wakeDeliveryEnabled = true
    config.idleEnabled = true
    config.idleTargetSessionId = allowed[0]
    config.wakeBudgetEnabled = true
    config.activityLimit = activityLimit
    config.bootstrapEnabled = true
  }
  if (preset === 'activity') {
    config.activityToolsEnabled = true
    config.bootstrapEnabled = true
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

/** Validate the flat authoritative Config shape emitted for a Life row. */
export function validateSetup(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('config must be a plain object')
  }
  if (!isFlatConfig(config)) throw new Error('config must use the flat Life Config fields')
  // The same normalizer used at Host activation validates the generated flat
  // fields, so the helper cannot emit a config the plugin would reject.
  normalizeLifeConfig(config)
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
