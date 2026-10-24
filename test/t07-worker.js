/**
 * Worker used by the T07 concurrency test. Two workers open independent
 * `LifeCore` connections to the same initialized SQLite store, synchronize on a
 * SharedArrayBuffer barrier, then tick at the same time.
 */

import { parentPort, workerData } from 'node:worker_threads'
import { LifeCore } from '../src/core.js'

const { databasePath, barrier } = workerData
const state = new Int32Array(barrier)
const core = new LifeCore({ databasePath })

Atomics.add(state, 0, 1)
parentPort.postMessage({ type: 'ready' })

const waited = Atomics.wait(state, 1, 0, 5000)
if (waited === 'timed-out') {
  core.close()
  parentPort.postMessage({ type: 'timeout' })
} else {
  const tick = core.tick()
  core.close()
  parentPort.postMessage({ type: 'done', produced: tick.produced.length })
}
