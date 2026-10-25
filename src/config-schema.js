/**
 * DSH-visible authoritative Config schema. Every field is volatile so DSH's
 * Settings/Config Forms projection serves the `amadeus-life` namespace and the
 * Settings page, row Configure page, and Plugin Manager card all edit the same
 * revisioned form. The Host wake/idle/budget runtime is constructed at
 * activation; the client marks these changes as requiring a restart and never
 * claims the running scheduler already changed.
 */

import { Schema } from './schema.js'
import { CONFIG_FIELDS } from './config-fields.js'

function fieldSchema(field) {
  let schema
  if (field.type === 'boolean') schema = Schema.boolean()
  else if (field.type === 'array') schema = Schema.array(Schema.string()).default([])
  else if (field.type === 'string') schema = Schema.string()
  else schema = Schema.number()
  if (field.type === 'array') {
    schema.meta.max = 100
    schema.meta.description = `${field.zh.label} — ${field.zh.help}`
  } else {
    if (field.min !== undefined && typeof schema.min === 'function') schema.min(field.min)
    if (field.max !== undefined) {
      if (typeof schema.max === 'function') schema.max(field.max)
      else schema.meta.maxLength = field.max
    }
    if (field.step !== undefined && typeof schema.step === 'function') schema.step(field.step)
    schema.description(`${field.zh.label} — ${field.zh.help}`)
  }
  if (field.default !== undefined) schema.default(field.default)
  schema.meta.restart = field.restart === true
  schema.meta.group = field.group
  // DSH dsh-settings exposes only fields beneath a volatile schema node. This
  // is what makes the namespace appear in the Settings describe mirror; it is
  // also why the UI labels every field as needing a restart for runtime effect.
  schema.volatile()
  return schema
}

const dict = Object.fromEntries(CONFIG_FIELDS.map((field) => [field.key, fieldSchema(field)]))
export const Config = Schema.object(dict).default({})
