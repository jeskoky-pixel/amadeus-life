/**
 * Worker used by concurrency tests. Workers synchronize on a SharedArrayBuffer
 * barrier, then open independent `LifeCore` connections and either open, tick,
 * or claim one wake at the same time.
 */

import { parentPort, workerData } from 'node:worker_threads'
import { LifeCore } from '../src/core.js'

const { databasePath, barrier, mode, ownerId } = workerData
const state = new Int32Array(barrier)

Atomics.add(state, 0, 1)
parentPort.postMessage({ type: 'ready' })

const waited = Atomics.wait(state, 1, 0, 5000)
if (waited === 'timed-out') {
  parentPort.postMessage({ type: 'timeout' })
} else {
  const core = new LifeCore({ databasePath })
  try {
    if (mode === 'open') {
      parentPort.postMessage({ type: 'done', produced: 0, version: core.getHealth().schemaVersion })
    } else if (mode === 'claim') {
      const wake = core.claimNextWake({ ownerId })
      parentPort.postMessage({ type: 'done', produced: wake === null ? 0 : 1 })
    } else {
      const tick = core.tick()
      parentPort.postMessage({ type: 'done', produced: tick.produced.length })
    }
  } finally {
    core.close()
  }
}
