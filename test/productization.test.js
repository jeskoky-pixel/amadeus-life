import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { Config } from '../src/index.js'
import { LifeCore } from '../src/core.js'
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
  assert.equal(CONFIG_FIELDS.length, 24)
  assert.equal(CONFIG_DEFAULTS.wakeDeliveryEnabled, false)
  assert.equal(CONFIG_DEFAULTS.bootstrapEnabled, false)
  assert.deepEqual(CONFIG_DEFAULTS.externalMessageSessionIds, [])
  const externalField = CONFIG_FIELDS.find((field) => field.key === 'externalMessageSessionIds')
  assert.ok(externalField, 'flat external-message opt-in field must exist')
  assert.equal(externalField.type, 'array')
  assert.deepEqual(externalField.default, [])
  // The explanation must state the exact scope: tool-authorized intent wakes
  // only, and no QQ Scene permission grant.
  assert.match(externalField.zh.help, /intent wake/)
  assert.match(externalField.zh.help, /QQ Scene/)
  assert.match(externalField.zh.help, /不会授予/)
  assert.match(externalField.en.help, /tool-authorized intent wakes/)
  assert.match(externalField.en.help, /QQ Scene/)
  assert.match(externalField.en.help, /no QQ Scene permission/)
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
    externalMessageSessionIds: [A, A],
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
  assert.deepEqual(autonomous.wakeDelivery.externalMessageSessionIds, [A])
  assert.equal(autonomous.wakeDelivery.intervalMs, 90_000)
  assert.equal(autonomous.idle.targetSessionId, A)
  assert.equal(autonomous.activityTools.enabled, false)
  assert.equal(autonomous.bootstrap.enabled, true)
  assert.equal(autonomous.wakeBudget.activityLimit, 1)
  // Default deny: omitting the flat field maps to the empty nested opt-in.
  const deny = normalizeLifeConfig({ ...CONFIG_DEFAULTS, allowedSessionIds: [A, B] })
  assert.deepEqual(deny.wakeDelivery.externalMessageSessionIds, [])
  // Strict subset: an entry outside allowedSessionIds is rejected.
  assert.throws(
    () => normalizeLifeConfig({ ...CONFIG_DEFAULTS, allowedSessionIds: [A], externalMessageSessionIds: [B] }),
    /externalMessageSessionIds must be in allowedSessionIds/,
  )
  assert.throws(
    () => normalizeLifeConfig({ ...CONFIG_DEFAULTS, allowedSessionIds: [A], externalMessageSessionIds: ['not-a-session'] }),
    /externalMessageSessionIds must contain DSH Session ids/,
  )
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
  for (const marker of ['settings.section', 'plugins.detail.section', 'plugins.row.config', 'configForms', 'amadeus-life', 'Amadeus Life',
    'intents/create', 'activities/start', 'attention/yield', '/backups', 'createBackup',
    'externalMessageSessionIds', 'QQ Scene']) {
    assert.match(bundle, new RegExp(marker.replace('.', '\\.')))
  }
  for (const tab of ['overview', 'setup', 'sessions', 'intents', 'activities', 'budget', 'advanced']) {
    assert.match(bundle, new RegExp(`'${tab}'`))
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
    createIntent: (input) => ({ description: input.description, targetSessionId: input.targetSessionId }),
    startActivity: async (input) => ({ description: input.description, status: 'running' }),
    yieldActivities: async () => ([{ outcome: 'already_paused' }]),
    createBackup: () => ({ fileName: 'life-backup-test.sqlite', bytes: 1, sha256: 'a'.repeat(64) }),
    listBackups: () => [],
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

  const boundedRes = response()
  await owner({ ...getReq, url: '/api/amadeus-life/intents?limit=201' }, boundedRes)
  assert.equal(boundedRes.status, 400)
  assert.match(JSON.parse(boundedRes.body).error, /limit/)

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

  const makePost = (path, value) => ({
    method: 'POST',
    url: `/api/amadeus-life${path}`,
    headers: postReq.headers,
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(value)) },
  })
  const intentRes = response()
  await owner(makePost('/intents/create', { targetSessionId: A, description: 'review this', reviewAt: '2099-01-01T00:00:00.000Z' }), intentRes)
  assert.equal(intentRes.status, 200)
  assert.equal(JSON.parse(intentRes.body).intent.description, 'review this')

  const activityRes = response()
  await owner(makePost('/activities/start', { targetSessionId: A, description: 'local work' }), activityRes)
  assert.equal(activityRes.status, 200)
  assert.equal(JSON.parse(activityRes.body).activity.status, 'running')

  const yieldRes = response()
  await owner(makePost('/attention/yield', { targetSessionId: A }), yieldRes)
  assert.equal(yieldRes.status, 200)
  assert.equal(JSON.parse(yieldRes.body).outcomes.length, 1)

  const backupRes = response()
  await owner(makePost('/backups', {}), backupRes)
  assert.equal(backupRes.status, 200)
  assert.equal(JSON.parse(backupRes.body).backup.fileName, 'life-backup-test.sqlite')

  const malformedRes = response()
  await owner({
    ...postReq,
    url: '/api/amadeus-life/intents/create',
    async *[Symbol.asyncIterator]() { yield Buffer.from('{') },
  }, malformedRes)
  assert.equal(malformedRes.status, 400)
  assert.match(JSON.parse(malformedRes.body).error, /valid JSON/)

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
  assert.equal(validateField(byKey.externalMessageSessionIds, []), null)
  assert.equal(validateField(byKey.externalMessageSessionIds, [A]), null)
  assert.equal(validateField(byKey.externalMessageSessionIds, ['bad']), 'invalidSessionId')
  assert.equal(validateField(byKey.externalMessageSessionIds, 'not-an-array'), 'invalidArray')
  assert.equal(
    validateAll({ ...CONFIG_DEFAULTS, allowedSessionIds: [A], externalMessageSessionIds: [A] }, CONFIG_FIELDS).externalMessageSessionIds,
    undefined,
  )
  assert.equal(
    validateAll({ ...CONFIG_DEFAULTS, allowedSessionIds: [A], externalMessageSessionIds: [B] }, CONFIG_FIELDS).externalMessageSessionIds,
    'externalMessageNotAllowed',
  )
  assert.equal(
    validateAll({ ...CONFIG_DEFAULTS, allowedSessionIds: [], externalMessageSessionIds: [A] }, CONFIG_FIELDS).externalMessageSessionIds,
    'externalMessageNotAllowed',
  )
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
  // The external-message opt-in is an independent flat field: editing only it
  // produces exactly one Config operation and does not touch the allowlist.
  const externalChanged = setDraftValue(draft, 'externalMessageSessionIds', [A])
  assert.deepEqual(buildSetOps(externalChanged, snapshot, CONFIG_FIELDS), [
    { op: 'set', path: ['externalMessageSessionIds'], value: [A] },
  ])
  assert.equal(buildUnsetAllOps(CONFIG_FIELDS).length, CONFIG_FIELDS.length)
  assert.deepEqual(buildUnsetAllOps(CONFIG_FIELDS)[0], { op: 'unset', path: ['wakeDeliveryEnabled'] })
  // Defaults/reset are Config-form unset operations only; no Life data table
  // mutation exists in this path.
  assert.equal(hasRevisionConflict(changed, { ...snapshot, revision: 5 }, CONFIG_FIELDS, true), true)
  assert.equal(isDirty(draftFromSnapshot(snapshot), snapshot, CONFIG_FIELDS), false)
})

test('PROD7 admin intent/activity/attention actions derive scope and fail closed after revoke', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-admin-actions-'))
  const core = new LifeCore({ databasePath: join(dir, 'life.sqlite') })
  try {
    core.v1.bootstrapLocalIdentity({ targetSessionIds: [A] })
    const intent = core.v1.adminCreateIntent({
      targetSessionId: A,
      description: 'GUI-created intent',
      reviewAt: '2099-01-01T00:00:00.000Z',
    })
    assert.equal(intent.description, 'GUI-created intent')
    const activity = await core.v1.adminStartActivity({ targetSessionId: A, description: 'GUI activity' })
    assert.equal(activity.status, 'running')
    assert.equal(activity.ownerScope, `session:${A}`)
    const outcomes = await core.v1.adminYieldActivities({ targetSessionId: A })
    assert.equal(Array.isArray(outcomes), true)
    core.v1.adminRevokeBinding({ targetSessionId: A })
    assert.throws(() => core.v1.adminCreateIntent({
      targetSessionId: A,
      description: 'must fail',
      reviewAt: '2099-01-01T00:00:00.000Z',
    }), /inactive|unauthorized/i)
    await assert.rejects(core.v1.adminStartActivity({ targetSessionId: A, description: 'must fail' }), /inactive|unauthorized/i)
    await assert.rejects(core.v1.adminYieldActivities({ targetSessionId: A }), /inactive|unauthorized/i)
    assert.throws(() => core.v1.adminCreateIntent({
      targetSessionId: 'not-a-session',
      description: 'bad',
      reviewAt: '2099-01-01T00:00:00.000Z',
    }), /Session/)
  } finally {
    core.close()
  }
})

test('PROD8 rendered preset labels keep 本地活动/Local activity while budget says 活动并发/Activity concurrency', () => {
  const bundle = readFileSync(join(process.cwd(), 'lib', 'client.js'), 'utf8')
  const renderSection = (lang, overrides) => {
    let loaded
    vm.runInNewContext(bundle, {
      window: { __ModuleLoader__: { load(definition) { loaded = definition } } },
      navigator: { language: lang },
      console,
    })
    const sectionRefs = []
    const React = {
      createElement(type, props, ...children) {
        return { type, props: { ...(props || {}), children: children.length === 1 ? children[0] : children } }
      },
      useState(initial) {
        const index = React._stateIndex++
        const value = overrides[index] === undefined ? initial : overrides[index]
        return [value, () => {}]
      },
      useCallback(callback) { return callback },
      useRef(value) { return { current: value } },
      useEffect() {},
      _stateIndex: 0,
    }
    const plugin = loaded.factory((name) => (name === 'react' ? React : {}))
    const ctx = {
      slots: {
        inject(_name, callback) { callback() },
        register(definition, component) {
          sectionRefs.push({ definition, component })
          return () => {}
        },
      },
      configForms: {
        whileServed(_namespaces, callback) { callback(); return () => {} },
        get() { throw new Error('effect should not run in render test') },
      },
      effect(callback) { callback(); return () => {} },
    }
    plugin.apply(ctx)
    const settings = sectionRefs.find((entry) => entry.definition.name === 'settings.section')
    assert.ok(settings)
    const element = settings.component()
    const rendered = typeof element.type === 'function' ? element.type(element.props) : element
    const strings = []
    const buttons = []
    const walk = (node) => {
      if (node === null || node === undefined || typeof node === 'boolean') return
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (typeof node === 'string' || typeof node === 'number') { strings.push(String(node)); return }
      if (typeof node !== 'object') return
      if (typeof node.type === 'function') { walk(node.type(node.props)); return }
      if (node.type === 'button') {
        const text = [].concat(node.props.children ?? []).flat(Infinity).filter((item) => typeof item === 'string' || typeof item === 'number').join('')
        if (text) buttons.push(text)
      }
      walk(node.props?.children)
    }
    walk(rendered)
    return { strings, buttons }
  }

  const snapshot = { status: 'ready', revision: 1, writable: true, value: { ...CONFIG_DEFAULTS } }
  const draft = { values: { ...CONFIG_DEFAULTS, activityLimit: 3 }, writable: true, status: 'ready', revision: 1 }
  const health = { health: { state: 'ok' }, config: {}, setup: { state: 'ready' }, budgets: [] }
  const zh = renderSection('zh-CN', ['setup', snapshot, draft, health])
  assert.ok(zh.buttons.includes('仅核心管理'))
  assert.ok(zh.buttons.includes('自主唤醒'))
  assert.ok(zh.buttons.includes('本地活动'))
  assert.equal(zh.buttons.includes('活动并发'), false)
  const zhOverview = renderSection('zh-CN', ['overview', snapshot, draft, health])
  assert.ok(zhOverview.strings.some((text) => text.includes('活动并发: 3')))
  const en = renderSection('en-US', ['setup', snapshot, draft, health])
  assert.ok(en.buttons.includes('Core only'))
  assert.ok(en.buttons.includes('Autonomous wake'))
  assert.ok(en.buttons.includes('Local activity'))
  assert.equal(en.buttons.includes('Activity concurrency'), false)
  const enOverview = renderSection('en-US', ['overview', snapshot, draft, health])
  assert.ok(enOverview.strings.some((text) => text.includes('Activity concurrency: 3')))
})

test('PROD4 package manifest includes Host, client, schema, locale, docs, and explicit version', () => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@amadeus/life')
  assert.equal(manifest.version, '1.0.1')
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
