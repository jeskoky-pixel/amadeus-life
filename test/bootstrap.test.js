import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LifeCore } from '../src/core.js'
import { apply } from '../src/index.js'
import { buildSetup, validateSetup, writeSetupFile } from '../scripts/life-setup.mjs'

const A = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'life-bootstrap-'))
}

function fakeCtx() {
  const provided = new Map()
  const effects = []
  const ctx = {
    logger: { error() {}, warn() {}, info() {} },
    provided,
    tools: { register() {} },
    get() { return undefined },
    on() { return () => {} },
    provide(name, value) { provided.set(name, value) },
    effect(fn) { effects.push(fn()) },
  }
  const dispose = () => {
    while (effects.length > 0) {
      const fn = effects.pop()
      if (typeof fn === 'function') fn()
    }
  }
  return { ctx, provided, dispose }
}

function config(databasePath, extra = {}) {
  return {
    databasePath,
    clock: () => Date.parse('2026-10-25T00:00:00.000Z'),
    tickIntervalMs: 0,
    wakeDelivery: { enabled: false, allowedSessionIds: [A, B] },
    bootstrap: { enabled: true, personaName: 'Amadeus' },
    ...extra,
  }
}

test('BOOT1 first load creates one Persona, private Scenes, bindings; second load is idempotent', () => {
  const databasePath = join(tempDir(), 'life.sqlite')
  const first = fakeCtx()
  apply(first.ctx, config(databasePath))
  const life = first.provided.get('life')
  const health = life.getHealth()
  assert.equal(health.setup.state, 'ready')
  assert.equal(health.setup.created.persona, true)
  assert.equal(health.setup.created.scenes, 2)
  assert.equal(health.setup.created.bindings, 2)
  const bindingA = life.getSessionBinding(A)
  const bindingB = life.getSessionBinding(B)
  assert.equal(bindingA.personaId, bindingB.personaId)
  assert.notEqual(bindingA.sceneId, bindingB.sceneId, 'private Scenes are per Session')
  assert.equal(life.getScene(bindingA.sceneId).privacy, 'private')
  assert.equal(life.getScene(bindingB.sceneId).privacy, 'private')
  assert.equal(bindingA.revision, 1)
  first.dispose()

  const second = fakeCtx()
  apply(second.ctx, config(databasePath))
  const life2 = second.provided.get('life')
  const health2 = life2.getHealth()
  assert.equal(health2.setup.state, 'ready')
  assert.equal(health2.setup.created.persona, false)
  assert.equal(health2.setup.created.scenes, 0)
  assert.equal(health2.setup.created.bindings, 0)
  assert.equal(life2.getSessionBinding(A).revision, 1)
  assert.equal(life2.getSessionBinding(B).revision, 1)
  assert.equal(life2.getSessionBinding(A).sceneId, bindingA.sceneId)
  second.dispose()

  const core = new LifeCore({ databasePath })
  try {
    const db = core.store
    assert.equal(db.get('SELECT COUNT(*) AS n FROM personas').n, 1)
    assert.equal(db.get('SELECT COUNT(*) AS n FROM scenes').n, 2)
    assert.equal(db.get("SELECT COUNT(*) AS n FROM scene_shares").n, 0)
  } finally {
    core.close()
  }
})

test('BOOT2 conflicting existing binding fails closed without mutation', () => {
  const databasePath = join(tempDir(), 'life.sqlite')
  const core = new LifeCore({ databasePath })
  const persona = core.v1.createPersona({ name: 'existing' })
  const scene = core.v1.createScene({ personaId: persona.id, contextScope: `session:${A}` })
  core.v1.bindSession({
    targetSessionId: A,
    personaId: persona.id,
    sceneId: scene.id,
    principalId: 'admin',
    authorizationRef: 'admin:existing',
  })
  core.close()

  const host = fakeCtx()
  apply(host.ctx, config(databasePath))
  const life = host.provided.get('life')
  const health = life.getHealth()
  assert.equal(health.state, 'degraded')
  assert.equal(health.reason, 'bootstrap_failed')
  assert.equal(health.setup.state, 'failed')
  assert.match(health.setup.error.message, /different Persona\/Scene/)
  assert.equal(health.delivery.state, 'disabled')
  host.dispose()

  const check = new LifeCore({ databasePath })
  try {
    const binding = check.v1.getSessionBinding(A)
    assert.equal(binding.personaId, persona.id)
    assert.equal(binding.sceneId, scene.id)
    assert.equal(binding.revision, 1)
    assert.equal(check.store.get("SELECT COUNT(*) AS n FROM personas WHERE id='life_bootstrap_persona'").n, 0)
  } finally {
    check.close()
  }
})

test('BOOT5 bootstrap never silently reactivates a revoked binding', () => {
  const databasePath = join(tempDir(), 'life.sqlite')
  const first = fakeCtx()
  apply(first.ctx, config(databasePath))
  const life = first.provided.get('life')
  const original = life.getSessionBinding(A)
  life.revokeSessionBinding({ targetSessionId: A })
  first.dispose()

  const second = fakeCtx()
  apply(second.ctx, config(databasePath))
  const health = second.provided.get('life').getHealth()
  assert.equal(health.reason, 'bootstrap_failed')
  assert.match(health.setup.error.message, /was revoked/)
  second.dispose()

  const check = new LifeCore({ databasePath })
  try {
    const binding = check.v1.getSessionBinding(A)
    assert.equal(binding.active, false)
    assert.equal(binding.revision, original.revision + 1)
  } finally { check.close() }
})

test('BOOT3 core preset creates nothing and generator output is accepted', () => {
  const databasePath = join(tempDir(), 'life.sqlite')
  const coreOnly = fakeCtx()
  apply(coreOnly.ctx, {
    databasePath,
    clock: () => Date.parse('2026-10-25T00:00:00.000Z'),
    tickIntervalMs: 0,
    wakeDelivery: { enabled: false, allowedSessionIds: [A] },
  })
  const life = coreOnly.provided.get('life')
  assert.equal(life.getHealth().setup.state, 'disabled')
  coreOnly.dispose()
  const check = new LifeCore({ databasePath })
  try {
    assert.equal(check.store.get('SELECT COUNT(*) AS n FROM personas').n, 0)
    assert.equal(check.store.get('SELECT COUNT(*) AS n FROM scenes').n, 0)
  } finally {
    check.close()
  }

  const generated = buildSetup({ preset: 'autonomous', sessions: [A] })
  assert.equal(generated.config.bootstrap.enabled, true)
  assert.equal(validateSetup(generated.config), true)
  const generatedHost = fakeCtx()
  apply(generatedHost.ctx, {
    ...generated.config,
    databasePath: join(tempDir(), 'generated.sqlite'),
    clock: () => Date.parse('2026-10-25T00:00:00.000Z'),
    tickIntervalMs: 0,
  })
  assert.equal(generatedHost.provided.get('life').getHealth().setup.state, 'ready')
  generatedHost.dispose()
})

test('BOOT4 invalid config is rejected and output files are exclusive', () => {
  assert.throws(
    () => apply(fakeCtx().ctx, {
      databasePath: join(tempDir(), 'invalid.sqlite'),
      bootstrap: { enabled: true },
      wakeDelivery: { enabled: false, allowedSessionIds: [] },
    }),
    /bootstrap\.enabled requires/,
  )
  assert.throws(
    () => validateSetup({ bootstrap: { enabled: true } }),
    /bootstrap\.enabled requires/,
  )
  const dir = tempDir()
  const path = join(dir, 'life-config.json')
  writeSetupFile(path, buildSetup({ preset: 'core' }).config)
  assert.throws(() => writeSetupFile(path, buildSetup({ preset: 'core' }).config), /refusing to overwrite/)
  const before = readFileSync(path, 'utf8')
  assert.match(before, /wakeDelivery/)
})
