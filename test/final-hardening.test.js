import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LifeCore } from '../src/core.js'

const A = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const scopeA = `session:${A}`
const scopeB = `session:${B}`
const clock = () => Date.parse('2026-10-25T00:00:00.000Z')
const open = () => new LifeCore({ databasePath: join(mkdtempSync(join(tmpdir(), 'life-final-')), 'life.sqlite'), clock })

function bind(core, session, personaId, sceneId) {
  return core.v1.bindSession({ targetSessionId: session, personaId, sceneId, principalId: `principal:${session}`, authorizationRef: 'admin:final' })
}

test('FINAL1 revoking one Session preserves the other Session in one Persona', async () => {
  const core = open()
  try {
    const persona = core.v1.createPersona({ name: 'shared persona' })
    const sceneA = core.v1.createScene({ personaId: persona.id, contextScope: scopeA })
    const sceneB = core.v1.createScene({ personaId: persona.id, contextScope: scopeB })
    bind(core, A, persona.id, sceneA.id)
    bind(core, B, persona.id, sceneB.id)
    const activityA = await core.v1.startActivity({ description: 'A work', ownerScope: scopeA, personaId: persona.id, sceneId: sceneA.id, resourceLease: 'A resource' })
    const activityB = await core.v1.startActivity({ description: 'B work', ownerScope: scopeB, personaId: persona.id, sceneId: sceneB.id, resourceLease: 'B resource' })
    core.v1.revokeSessionBinding({ targetSessionId: B })
    const actualA = core.getActivity(activityA.id, { scope: scopeA })
    const actualB = core.getActivity(activityB.id, { scope: scopeB })
    assert.equal(actualA.status, 'running')
    assert.equal(actualA.revision, activityA.revision)
    assert.equal(actualA.resourceLease, 'A resource')
    assert.equal(actualB.status, 'unknown')
    assert.equal(actualB.resourceLease, 'B resource')
  } finally { core.close() }
})

test('FINAL2 an untrusted transition cannot fail Provider work and release its resource', async () => {
  const core = open()
  try {
    const activity = await core.v1.startActivity({ description: 'Provider work', ownerScope: scopeA, resourceLease: 'scarce resource' })
    assert.throws(() => core.transitionActivity(activity.id, { scope: scopeA, expectedRevision: activity.revision, to: 'failed' }))
    assert.throws(() => core.transitionActivity(activity.id, { scope: scopeA, expectedRevision: activity.revision, to: 'completed', evidenceRefs: ['model:fake'] }))
    const current = core.getActivity(activity.id, { scope: scopeA })
    assert.equal(current.status, 'running')
    assert.equal(current.revision, activity.revision)
    await assert.rejects(() => core.v1.startActivity({ description: 'contender', ownerScope: scopeA, resourceLease: 'scarce resource' }))
    assert.equal((await core.v1.finishActivity(activity.id, scopeA, 'failed')).status, 'failed')
    assert.equal((await core.v1.startActivity({ description: 'released', ownerScope: scopeA, resourceLease: 'scarce resource' })).status, 'running')
  } finally { core.close() }
})

test('FINAL3 a Session cannot silently switch Persona or Scene over old private records', async () => {
  const core = open()
  try {
    const personaA = core.v1.createPersona({ name: 'first' })
    const personaB = core.v1.createPersona({ name: 'second' })
    const sceneA = core.v1.createScene({ personaId: personaA.id, contextScope: scopeA })
    const sceneA2 = core.v1.createScene({ personaId: personaA.id, contextScope: scopeA })
    const sceneB = core.v1.createScene({ personaId: personaB.id, contextScope: scopeA })
    bind(core, A, personaA.id, sceneA.id)
    core.createIntent({ description: 'old private plan', reviewAt: '2026-10-26T00:00:00.000Z', contextScope: scopeA, authorizationRef: 'admin:final' })
    assert.throws(() => bind(core, A, personaA.id, sceneA2.id))
    assert.throws(() => bind(core, A, personaB.id, sceneB.id))
    const binding = core.v1.getSessionBinding(A)
    assert.equal(binding.personaId, personaA.id)
    assert.equal(binding.sceneId, sceneA.id)
    assert.equal(core.listIntents({ scope: scopeA }).length, 1)
  } finally { core.close() }
})

test('FINAL4 shared read excludes private internals and unscoped historical rows', async () => {
  const core = open()
  try {
    const persona = core.v1.createPersona({ name: 'shared' })
    const shared = core.v1.createScene({ personaId: persona.id, contextScope: scopeA, privacy: 'shared' })
    const ownB = core.v1.createScene({ personaId: persona.id, contextScope: scopeB })
    bind(core, A, persona.id, shared.id)
    bind(core, B, persona.id, ownB.id)
    const activity = await core.v1.startActivity({ description: 'private details', ownerScope: scopeA, personaId: persona.id, sceneId: shared.id, resourceLease: 'secret-resource' })
    const legacy = core.recordActivity({ description: 'legacy unscoped', ownerScope: scopeA })
    core.v1.grantSceneShare({ sceneId: shared.id, dataScope: scopeB })
    const cross = core.v1.getSharedLifeView({ targetSessionId: B }).scenes.find((scene) => scene.id === shared.id)
    assert.ok(cross)
    assert.equal(cross.activities.some((item) => item.id === legacy.id), false)
    const payload = JSON.stringify(cross)
    assert.equal(payload.includes('secret-resource'), false)
    assert.equal(payload.includes('checkpointRef'), false)
    assert.equal(payload.includes('legacy unscoped'), false)
    assert.equal(cross.activities.some((item) => item.id === activity.id), true)
  } finally { core.close() }
})

test('FINAL5 actual usage settles an estimate once and shared budgets constrain Sessions', () => {
  const core = open()
  try {
    const persona = core.v1.createPersona({ name: 'budget persona' })
    const sceneA = core.v1.createScene({ personaId: persona.id, contextScope: scopeA })
    const sceneB = core.v1.createScene({ personaId: persona.id, contextScope: scopeB })
    bind(core, A, persona.id, sceneA.id)
    bind(core, B, persona.id, sceneB.id)
    for (const scope of [scopeA, scopeB]) core.v1.configureBudget({ scope, windowMs: 60_000, tokenLimit: 1000 })
    core.v1.configureBudget({ scope: `persona:${persona.id}`, windowMs: 60_000, wakeLimit: 1, tokenLimit: 100 })
    core.v1.configureBudget({ scope: 'global', windowMs: 60_000, wakeLimit: 1, tokenLimit: 100 })
    assert.equal(core.consumeWakeBudget({ scope: scopeA, estimatedTokens: 100 }).allowed, true)
    core.v1.recordSessionUsage({ targetSessionId: A, seq: 10, usage: { totalTokens: 70 } })
    core.v1.recordSessionUsage({ targetSessionId: A, seq: 10, usage: { totalTokens: 70 } })
    assert.equal(core.v1.getBudget(scopeA).tokensUsed, 70)
    assert.equal(core.v1.getBudget(`persona:${persona.id}`).tokensUsed, 70)
    assert.equal(core.v1.getBudget('global').tokensUsed, 70)
    assert.equal(core.consumeWakeBudget({ scope: scopeB, estimatedTokens: 1 }).allowed, false)
  } finally { core.close() }
})
