import { parentPort, workerData } from 'node:worker_threads'
import { LifeCore } from '../src/core.js'

const { databasePath, scope } = workerData
const core = new LifeCore({ databasePath, tickIntervalMs: 0, maxReviewBatch: 20 })
try {
  parentPort.postMessage({ type: 'ready' })
  await new Promise((resolve) => parentPort.once('message', resolve))
  const activity = await core.v1.startActivity({
    description: 'concurrent worker activity',
    ownerScope: scope,
  })
  parentPort.postMessage({ type: 'done', ok: true, id: activity.id })
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
