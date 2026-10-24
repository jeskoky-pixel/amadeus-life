import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSetup, PRESETS, validateSetup } from '../scripts/life-setup.mjs'

const A = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

test('SETUP1 core preset is silent by default', () => {
  const result = buildSetup({ preset: 'core' })
  assert.deepEqual(PRESETS, ['core', 'autonomous', 'activity'])
  assert.equal(result.config.wakeDelivery.enabled, false)
  assert.equal(result.config.idle.enabled, false)
  assert.equal(result.config.activityTools.enabled, false)
  assert.equal(result.config.bootstrap, undefined)
  assert.equal(validateSetup(result.config), true)
})

test('SETUP2 autonomous preset enables only the selected Session and idle target', () => {
  const result = buildSetup({ preset: 'autonomous', sessions: [A, B], idleWindowMinutes: 45 })
  assert.equal(result.config.wakeDelivery.enabled, true)
  assert.deepEqual(result.config.wakeDelivery.allowedSessionIds, [A, B])
  assert.equal(result.config.idle.targetSessionId, A)
  assert.equal(result.config.idle.windowMs, 45 * 60_000)
  assert.equal(result.config.wakeBudget.activityLimit, 1)
  assert.equal(result.config.wakeBudget.tokenLimit, undefined)
  assert.equal(result.config.wakeBudget.costLimit, undefined)
  assert.equal(result.config.bootstrap.enabled, true)
  assert.equal(validateSetup(result.config), true)
})

test('SETUP3 local activity preset does not enable Host wake or autonomous budget', () => {
  const result = buildSetup({ preset: 'activity', sessions: [A] })
  assert.equal(result.config.activityTools.enabled, true)
  assert.equal(result.config.wakeDelivery.enabled, false)
  assert.equal(result.config.idle.enabled, false)
  assert.equal(result.config.wakeBudget, undefined)
  assert.equal(result.config.bootstrap.enabled, true)
  assert.equal(validateSetup(result.config), true)
})

test('SETUP4 invalid Session ids and idle targets are rejected', () => {
  assert.throws(() => buildSetup({ preset: 'autonomous', sessions: ['not-a-session'] }), /invalid Session id/)
  assert.throws(() => buildSetup({ preset: 'autonomous', sessions: [] }), /at least one Session/)
  assert.throws(
    () => validateSetup({
      wakeDelivery: { enabled: true, allowedSessionIds: [A] },
      idle: { enabled: true, targetSessionId: B },
    }),
    /idle\.targetSessionId/,
  )
  assert.throws(() => validateSetup({ activityTools: { enabled: 'yes' } }), /activityTools\.enabled/)
  assert.throws(() => validateSetup({ bootstrap: { enabled: true } }), /bootstrap\.enabled requires/)
})
