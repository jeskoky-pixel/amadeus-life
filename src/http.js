/**
 * Minimal authenticated owner API for the Life settings page.
 *
 * Browser code never opens SQLite and never receives credentials. Every request
 * must be same-origin, carry the Life request marker for writes, and pass DSH
 * Connection owner authentication. Loopback alone is not authorization.
 */

const PREFIX = '/api/amadeus-life'
const MAX_BODY = 64 * 1024

/** @param {Record<string, any>} req */
export function sameOrigin(req) {
  const host = String(req.headers?.host ?? '')
  if (!host) return false
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers?.origin
  if (origin !== undefined) {
    try {
      const parsed = new URL(String(origin))
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
      if (parsed.host !== host) return false
    } catch {
      return false
    }
  }
  return true
}

/** @param {unknown} admission */
export function isOwnerAdmission(admission) {
  return admission?.peer?.principal?.kind === 'owner'
}

/** @param {Record<string, any>} connection @param {Record<string, any>} req */
export function authorizeRequest(connection, req) {
  if (!connection || typeof connection.admit !== 'function') {
    return { ok: false, status: 503, message: 'this DSH version cannot verify an owner session for settings' }
  }
  let admission
  try {
    admission = connection.admit(req)
  } catch {
    return { ok: false, status: 403, message: 'request authentication failed' }
  }
  if (!admission || admission.rejection !== undefined) {
    return { ok: false, status: Number(admission?.rejection ?? 403), message: 'DSH authentication is required' }
  }
  if (!isOwnerAdmission(admission)) {
    return { ok: false, status: 403, message: 'only the authenticated owner may manage Life settings' }
  }
  return { ok: true }
}

function statusFor(error) {
  const code = String(error?.code ?? '')
  if (code.includes('UNAUTHORIZED')) return 403
  if (code.includes('NOT_FOUND')) return 404
  if (code.includes('REVISION') || code.includes('CONFLICT')) return 409
  if (code.includes('VALIDATION')) return 400
  if (code.includes('STORAGE') || code.includes('CLOSED')) return 503
  return 500
}

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'",
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readBody(req) {
  const type = String(req.headers?.['content-type'] ?? '').toLowerCase()
  if (!type.startsWith('application/json')) throw new Error('POST requests require application/json')
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) throw new Error('request body is required')
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('request body must be valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed
}

function intParam(url, name, fallback, min, max) {
  const raw = url.searchParams.get(name)
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} is out of range`)
  return value
}

/**
 * Build the HTTP handler; exported for tests without a live DSH web server.
 * @param {Record<string, any>} controller
 */
export function createHandler(controller) {
  return async (req, res) => {
    const url = new URL(String(req.url ?? '/'), 'http://localhost')
    if (!url.pathname.startsWith(PREFIX)) return send(res, 404, { ok: false, error: 'not found' })
    if (!sameOrigin(req)) return send(res, 403, { ok: false, error: 'same-origin request required' })
    if (req.method === 'POST' && req.headers?.['x-amadeus-life'] !== '1') {
      return send(res, 403, { ok: false, error: 'missing Life request marker' })
    }
    let connection = controller.connection
    if (connection === undefined) {
      try {
        connection = typeof controller.get === 'function' ? controller.get('connection') : undefined
      } catch {
        connection = undefined
      }
    }
    const auth = authorizeRequest(connection, req)
    if (!auth.ok) return send(res, auth.status, { ok: false, error: auth.message })
    const path = url.pathname.slice(PREFIX.length) || '/'
    try {
      if (req.method === 'GET' && path === '/status') {
        return send(res, 200, {
          ok: true,
          health: controller.getHealth(),
          setup: controller.getSetup(),
          config: controller.getConfig(),
          budgets: controller.listBudgets(),
          recentWakes: controller.listWakes({ limit: 10 }),
        })
      }
      if (req.method === 'GET' && path === '/bindings') {
        return send(res, 200, { ok: true, bindings: controller.listBindings() })
      }
      if (req.method === 'GET' && path === '/intents') {
        const limit = intParam(url, 'limit', 50, 1, 200)
        const offset = intParam(url, 'offset', 0, 0, 1_000_000)
        return send(res, 200, { ok: true, ...controller.listIntents({ limit, offset }) })
      }
      if (req.method === 'GET' && path === '/activities') {
        const limit = intParam(url, 'limit', 50, 1, 200)
        const offset = intParam(url, 'offset', 0, 0, 1_000_000)
        return send(res, 200, { ok: true, ...controller.listActivities({ limit, offset }) })
      }
      if (req.method === 'GET' && path === '/budgets') {
        return send(res, 200, { ok: true, budgets: controller.listBudgets() })
      }
      if (req.method === 'GET' && path === '/wakes') {
        return send(res, 200, { ok: true, wakes: controller.listWakes({ limit: intParam(url, 'limit', 20, 1, 100) }) })
      }
      if (req.method === 'POST' && path === '/bootstrap') {
        const body = await readBody(req)
        const sessionIds = Array.isArray(body.sessionIds) ? body.sessionIds : []
        const result = controller.bootstrap({
          targetSessionIds: sessionIds,
          personaName: body.personaName === undefined ? 'Amadeus' : body.personaName,
        })
        return send(res, 200, { ok: true, setup: result })
      }
      if (req.method === 'POST' && path === '/intents/cancel') {
        const body = await readBody(req)
        const result = controller.cancelIntent(body.id, body.expectedRevision)
        return send(res, 200, { ok: true, intent: result })
      }
      if (req.method === 'POST' && path === '/activities/action') {
        const body = await readBody(req)
        const result = await controller.activityAction(body.action, body.id)
        return send(res, 200, { ok: true, activity: result })
      }
      if (req.method === 'POST' && path === '/bindings/revoke') {
        const body = await readBody(req)
        const result = controller.revokeBinding({ targetSessionId: body.targetSessionId })
        return send(res, 200, { ok: true, binding: result })
      }
      return send(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      return send(res, statusFor(error), { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * Mount under an optional webServer child. Missing services simply leave the
 * native settings page in a clear disconnected state.
 * @param {Record<string, any>} ctx @param {Record<string, any>} controller
 */
export function mountHttp(ctx, controller) {
  if (typeof ctx?.inject !== 'function') return
  const handle = ctx.inject(['webServer', 'connection'], (child) => {
    if (!child?.webServer || typeof child.webServer.register !== 'function') return
    child.effect(
      () =>
        child.webServer.register({
          kind: 'prefix',
          path: PREFIX,
          handler: createHandler({ ...controller, connection: child.connection, get: child.get }),
        }),
      'amadeus-life: settings API',
    )
  })
  if (typeof handle === 'function' && typeof ctx.effect === 'function') {
    ctx.effect(() => handle, 'amadeus-life: settings API injection')
  }
}
