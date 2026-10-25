import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { Config } from '../src/index.js'
import { CONFIG_DEFAULTS, CONFIG_FIELDS } from '../src/config-fields.js'
import { normalizeLifeConfig } from '../src/config.js'
import { createHandler, mountHttp, sameOrigin } from '../src/http.js'
import {
  buildSetOps,
  buildUnsetAllOps,
  draftFromSnapshot,
  hasRevisionConflict,
  isDirty,
  setDraftValue,
  validateAll,
  validateField,
} from '../src/client/logic.js'

const A = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

test('PROD1 Config schema and flat normalization are authoritative and validated', () => {
  assert.equal(CONFIG_FIELDS.length, 23)
  assert.equal(CONFIG_DEFAULTS.wakeDeliveryEnabled, false)
  assert.equal(CONFIG_DEFAULTS.bootstrapEnabled, false)
  const valid = Config['~standard'].validate(CONFIG_DEFAULTS)
  assert.equal(valid.issues, undefined)
  for (const field of CONFIG_FIELDS) {
    assert.equal(Config.dict[field.key].meta.volatile, true, `${field.key} must be volatile for DSH Config Forms`)
  }
  assert.equal(typeof valid.value.wakeDeliveryEnabled.get, 'function')
  assert.equal(valid.value.wakeDeliveryEnabled.get(), false)
  const autonomous = normalizeLifeConfig({
    ...CONFIG_DEFAULTS,
    wakeDeliveryEnabled: true,
    allowedSessionIds: [A, B],
    idleEnabled: true,
    idleTargetSessionId: A,
    wakeBudgetEnabled: true,
    activityLimit: 1,
    bootstrapEnabled: true,
    bootstrapPersonaName: 'Amadeus',
    wakeIntervalSeconds: 90,
  })
  assert.equal(autonomous.wakeDelivery.enabled, true)
  assert.deepEqual(autonomous.wakeDelivery.allowedSessionIds, [A, B])
  assert.equal(autonomous.wakeDelivery.intervalMs, 90_000)
  assert.equal(autonomous.idle.targetSessionId, A)
  assert.equal(autonomous.activityTools.enabled, false)
  assert.equal(autonomous.bootstrap.enabled, true)
  assert.equal(autonomous.wakeBudget.activityLimit, 1)
  assert.throws(() => normalizeLifeConfig({ ...CONFIG_DEFAULTS, allowedSessionIds: ['not-a-session'] }), /DSH Session/)
  assert.throws(
    () => normalizeLifeConfig({ ...CONFIG_DEFAULTS, allowedSessionIds: [A], idleEnabled: true, idleTargetSessionId: B }),
    /idleTargetSessionId/,
  )
  assert.throws(
    () => normalizeLifeConfig({ ...CONFIG_DEFAULTS, bootstrapEnabled: true, allowedSessionIds: [] }),
    /bootstrapEnabled/,
  )
  assert.ok(Config['~standard'].validate({ ...CONFIG_DEFAULTS, maxPerDrive: 99 }).issues?.length > 0)
})

test('PROD2 built client is a compilable lazy module registering the native settings section', () => {
  const bundlePath = join(process.cwd(), 'lib', 'client.js')
  assert.equal(existsSync(bundlePath), true, 'run npm run build first')
  const bundle = readFileSync(bundlePath, 'utf8')
  for (const marker of ['settings.section', 'plugins.detail.section', 'plugins.row.config', 'configForms', 'amadeus-life', 'Amadeus Life']) {
    assert.match(bundle, new RegExp(marker.replace('.', '\\.')))
  }
  assert.doesNotMatch(bundle, /^\s*import\s/m)
  let loaded
  vm.runInNewContext(bundle, {
    window: { __ModuleLoader__: { load(definition) { loaded = definition } } },
    console,
  })
  assert.equal(loaded.id, '@amadeus/life')
  const React = { createElement: () => null }
  const plugin = loaded.factory((name) => (name === 'react' ? React : {}))
  assert.deepEqual([...plugin.inject], ['slots', 'configForms'])
  let registered = []
  let configNamespace
  const ctx = {
    slots: {
      inject(name, callback) {
        callback()
      },
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    configForms: {
      whileServed(namespaces, callback) {
        configNamespace = namespaces
        callback()
        return () => {}
      },
    },
    effect(callback) {
      callback()
      return () => {}
    },
  }
  plugin.apply(ctx)
  assert.deepEqual([...configNamespace], ['amadeus-life'])
  assert.equal(registered.some((entry) => entry.name === 'settings.section' && entry.id === 'amadeus-life'), true)
  assert.equal(registered.some((entry) => entry.name === 'plugins.detail.section' && entry.id === 'amadeus-life-basic-config'), true)
  assert.equal(registered.some((entry) => entry.name === 'plugins.row.config' && entry.key === '@amadeus/life#amadeus-life'), true)
})

test('PROD3 admin API requires same-origin owner and exposes only bounded Life views', async () => {
  assert.equal(sameOrigin({ headers: { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' } }), true)
  assert.equal(sameOrigin({ headers: { host: '127.0.0.1:1', origin: 'http://evil.test' } }), false)
  assert.equal(sameOrigin({ headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' } }), false)
  const controller = {
    connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) },
    getHealth: () => ({ schemaVersion: '9', state: 'ok' }),
    getSetup: () => ({ state: 'ready' }),
    getConfig: () => ({ wakeDeliveryEnabled: false }),
    listBindings: () => [{ targetSessionId: A, active: true }],
    listIntents: () => ({ total: 0, items: [] }),
    listActivities: () => ({ total: 0, items: [] }),
    listWakes: () => [],
    listBudgets: () => [],
    cancelIntent: () => ({}),
    activityAction: async () => ({}),
    bootstrap: (input) => ({ state: 'ready', targets: input.targetSessionIds }),
    revokeBinding: () => ({}),
  }
  const owner = createHandler(controller)
  const response = () => ({
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = body },
  })
  const getReq = {
    method: 'GET',
    url: '/api/amadeus-life/status',
    headers: { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' },
  }
  const res = response()
  await owner(getReq, res)
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).health.schemaVersion, '9')
  assert.equal(JSON.parse(res.body).config.wakeDeliveryEnabled, false)

  const postBody = JSON.stringify({ sessionIds: [A], personaName: 'Amadeus' })
  const postReq = {
    method: 'POST',
    url: '/api/amadeus-life/bootstrap',
    headers: {
      host: '127.0.0.1:1',
      origin: 'http://127.0.0.1:1',
      'x-amadeus-life': '1',
      'content-type': 'application/json',
    },
    async *[Symbol.asyncIterator]() { yield Buffer.from(postBody) },
  }
  const postRes = response()
  await owner(postReq, postRes)
  assert.equal(postRes.status, 200)
  assert.deepEqual(JSON.parse(postRes.body).setup.targets, [A])

  const missingMarker = createHandler(controller)
  const missingRes = response()
  await missingMarker({ ...postReq, headers: { ...postReq.headers, 'x-amadeus-life': undefined } }, missingRes)
  assert.equal(missingRes.status, 403)

  const nonOwner = createHandler({ ...controller, connection: { admit: () => ({ peer: { principal: { kind: 'peer' } } }) } })
  const denied = response()
  await nonOwner(getReq, denied)
  assert.equal(denied.status, 403)

  let route
  mountHttp({
    inject(names, callback) {
      assert.deepEqual(names, ['webServer', 'connection'])
      callback({
        webServer: { register(spec) { route = spec; return () => {} } },
        connection: controller.connection,
        effect(callback2) { callback2(); return () => {} },
      })
    },
  }, controller)
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/api/amadeus-life')
})

test('PROD5 repeated mirror sync registers once and unload disposes every contribution', () => {
  const bundle = readFileSync(join(process.cwd(), 'lib', 'client.js'), 'utf8')
  let loaded
  vm.runInNewContext(bundle, {
    window: { __ModuleLoader__: { load(definition) { loaded = definition } } },
    console,
  })
  const React = { createElement: () => null }
  const plugin = loaded.factory((name) => (name === 'react' ? React : {}))
  const active = new Map()
  const slots = {
    inject(_name, callback) {
      const dispose = callback()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    register(definition) {
      const key = `${definition.name}:${definition.id ?? definition.key}`
      if (active.has(key)) throw new Error(`duplicate registration ${key}`)
      active.set(key, definition)
      return () => { active.delete(key) }
    },
  }
  const configForms = {
    whileServed(_namespaces, register) {
      // Simulate a mirror/declaration transition that invokes register twice
      // before the previous contribution has been torn down.
      const first = register(['amadeus-life'])
      const second = register(['amadeus-life'])
      return () => {
        first?.()
        second?.()
      }
    },
  }
  const disposers = []
  plugin.apply({
    slots,
    configForms,
    effect(callback) {
      disposers.push(callback())
      return () => {}
    },
  })
  assert.equal(active.size, 3)
  assert.equal(active.has('settings.section:amadeus-life'), true)
  assert.equal(active.has('plugins.detail.section:amadeus-life-basic-config'), true)
  assert.equal(active.has('plugins.row.config:@amadeus/life#amadeus-life'), true)
  for (const dispose of disposers) dispose()
  assert.equal(active.size, 0)
})

test('PROD6 config form draft/save/cancel/conflict operations are bounded and revisioned', () => {
  const byKey = Object.fromEntries(CONFIG_FIELDS.map((field) => [field.key, field]))
  assert.deepEqual(validateAll(CONFIG_DEFAULTS, CONFIG_FIELDS), {})
  assert.equal(validateField(byKey.wakeIntervalSeconds, 75), null)
  assert.equal(validateField(byKey.wakeIntervalSeconds, '75'), 'invalidNumber')
  assert.equal(validateField(byKey.wakeIntervalSeconds, 10), 'belowMin')
  assert.equal(validateField(byKey.allowedSessionIds, []), null)
  assert.equal(validateField(byKey.allowedSessionIds, ['bad']), 'invalidSessionId')
  assert.equal(validateField(byKey.bootstrapPersonaName, 'Amadeus'), null)
  assert.equal(validateField(byKey.bootstrapPersonaName, 42), 'invalidString')
  assert.equal(validateField(byKey.wakeDeliveryEnabled, true), null)
  assert.equal(validateField(byKey.wakeDeliveryEnabled, 'true'), 'invalidBoolean')
  assert.equal(
    validateAll({ ...CONFIG_DEFAULTS, idleEnabled: true, idleTargetSessionId: '' }, CONFIG_FIELDS).idleTargetSessionId,
    'idleTargetNotAllowed',
  )
  const snapshot = {
    status: 'ready',
    revision: 4,
    writable: true,
    value: { wakeDeliveryEnabled: false, allowedSessionIds: [] },
  };
  const draft = draftFromSnapshot(snapshot)
  assert.equal(draft.values.wakeDeliveryEnabled, false)
  const changed = setDraftValue(draft, 'wakeDeliveryEnabled', true)
  assert.equal(isDirty(changed, snapshot, CONFIG_FIELDS), true)
  assert.deepEqual(buildSetOps(changed, snapshot, CONFIG_FIELDS), [
    { op: 'set', path: ['wakeDeliveryEnabled'], value: true },
  ])
  assert.equal(buildUnsetAllOps(CONFIG_FIELDS).length, CONFIG_FIELDS.length)
  assert.equal(hasRevisionConflict(changed, { ...snapshot, revision: 5 }, CONFIG_FIELDS, true), true)
  assert.equal(isDirty(draftFromSnapshot(snapshot), snapshot, CONFIG_FIELDS), false)
})

test('PROD4 package manifest includes Host, client, schema, locale, docs, and explicit version', () => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@amadeus/life')
  assert.equal(manifest.version, '1.0.0')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
  assert.ok(manifest.files.includes('lib'))
  assert.ok(manifest.files.includes('src'))
  assert.ok(manifest.files.includes('locale/*.json'))
  assert.ok(existsSync(join(process.cwd(), 'lib', 'client.js')))
  assert.ok(existsSync(join(process.cwd(), 'icon.svg')))
  assert.ok(existsSync(join(process.cwd(), 'locale', 'zh.json')))
})
