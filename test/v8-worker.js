import { parentPort, workerData } from 'node:worker_threads'
import { LifeCore } from '../src/core.js'

const { databasePath, scope, mode = 'activity', wakeId = null } = workerData
const core = new LifeCore({ databasePath, tickIntervalMs: 0, maxReviewBatch: 20 })
try {
  parentPort.postMessage({ type: 'ready' })
  await new Promise((resolve) => parentPort.once('message', resolve))
  if (mode === 'wake') {
    const budget = core.consumeWakeBudget({ scope, estimatedTokens: 60, wakeId })
    parentPort.postMessage({ type: 'done', ok: budget.allowed === true, id: budget.reservationId, scope })
  } else {
    const activity = await core.v1.startActivity({
      description: 'concurrent worker activity',
      ownerScope: scope,
    })
    parentPort.postMessage({ type: 'done', ok: true, id: activity.id, scope })
  }
} catch (error) {
  parentPort.postMessage({
    type: 'done',
    ok: false,
    code: error?.code,
    error: error instanceof Error ? error.message : String(error),
  })
} finally {
  core.close()
}
