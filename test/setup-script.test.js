import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSetup, PRESETS, validateSetup } from '../scripts/life-setup.mjs'

const A = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

test('SETUP1 core preset is silent by default', () => {
  const result = buildSetup({ preset: 'core' })
  assert.deepEqual(PRESETS, ['core', 'autonomous', 'activity'])
  assert.equal(result.config.wakeDeliveryEnabled, false)
  assert.equal(result.config.idleEnabled, false)
  assert.equal(result.config.activityToolsEnabled, false)
  assert.equal(result.config.bootstrapEnabled, false)
  assert.equal(validateSetup(result.config), true)
})

test('SETUP2 autonomous preset enables only the selected Session and idle target', () => {
  const result = buildSetup({ preset: 'autonomous', sessions: [A, B], idleWindowMinutes: 45 })
  assert.equal(result.config.wakeDeliveryEnabled, true)
  assert.deepEqual(result.config.allowedSessionIds, [A, B])
  assert.equal(result.config.idleTargetSessionId, A)
  assert.equal(result.config.idleWindowMinutes, 45)
  assert.equal(result.config.activityLimit, 1)
  assert.equal(result.config.tokenLimit, 0)
  assert.equal(result.config.costLimit, 0)
  assert.equal(result.config.bootstrapEnabled, true)
  assert.equal(validateSetup(result.config), true)
})

test('SETUP3 local activity preset does not enable Host wake or autonomous budget', () => {
  const result = buildSetup({ preset: 'activity', sessions: [A] })
  assert.equal(result.config.activityToolsEnabled, true)
  assert.equal(result.config.wakeDeliveryEnabled, false)
  assert.equal(result.config.idleEnabled, false)
  assert.equal(result.config.wakeBudgetEnabled, false)
  assert.equal(result.config.bootstrapEnabled, true)
  assert.equal(validateSetup(result.config), true)
})

test('SETUP4 invalid Session ids and idle targets are rejected', () => {
  assert.throws(() => buildSetup({ preset: 'autonomous', sessions: ['not-a-session'] }), /invalid Session id/)
  assert.throws(() => buildSetup({ preset: 'autonomous', sessions: [] }), /at least one Session/)
  assert.throws(
    () => validateSetup({ allowedSessionIds: [A], idleEnabled: true, idleTargetSessionId: B }),
    /idleTargetSessionId/,
  )
  assert.throws(() => validateSetup({ activityToolsEnabled: 'yes' }), /activityToolsEnabled/)
  assert.throws(() => validateSetup({ bootstrapEnabled: true, allowedSessionIds: [] }), /bootstrapEnabled/)
})
