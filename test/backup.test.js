import assert from 'node:assert/strict'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { LifeCore } from '../src/core.js'
import {
  createBackup,
  inspectLifeDatabase,
  listBackups,
  restoreBackup,
  verifyBackup,
} from '../src/backup.js'

const SESSION = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SCOPE = `session:${SESSION}`

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'life-backup-'))
}

function seed(path, description) {
  const core = new LifeCore({ databasePath: path })
  try {
    core.createIntent({
      description,
      reviewAt: '2099-01-01T00:00:00.000Z',
      contextScope: SCOPE,
      authorizationRef: 'admin:test',
    })
  } finally {
    core.close()
  }
}

function intentDescriptions(path) {
  const core = new LifeCore({ databasePath: path })
  try {
    return core.listIntents({ scope: SCOPE, limit: 20 }).map((item) => item.description)
  } finally {
    core.close()
  }
}

test('BACKUP1 consistent snapshot verifies and restores to an isolated database', () => {
  const dir = tempDir()
  const databasePath = join(dir, 'life.sqlite')
  seed(databasePath, 'first intent')
  const backup = createBackup({ databasePath })
  assert.equal(existsSync(backup.path), true)
  assert.equal(backup.schemaVersion, '9')
  assert.equal(backup.counts.intents, 1)
  assert.match(backup.sha256, /^[0-9a-f]{64}$/)
  assert.equal(verifyBackup(backup.path).valid, true)
  assert.equal(listBackups(join(dir, 'backups')).length, 1)

  const target = join(dir, 'restored.sqlite')
  const dry = restoreBackup({ backupPath: backup.path, databasePath: target, dryRun: true })
  assert.equal(dry.restored, false)
  assert.equal(dry.schemaVersion, '9')
  assert.equal(existsSync(target), false, 'dry-run must not create or replace the target')
  const restored = restoreBackup({ backupPath: backup.path, databasePath: target })
  assert.equal(restored.restored, true)
  assert.deepEqual(intentDescriptions(target), ['first intent'])
  assert.equal(inspectLifeDatabase(target).schemaVersion, '9')

  // The old target is preserved when restoring over an existing database.
  seed(target, 'second intent')
  assert.deepEqual(intentDescriptions(target).sort(), ['first intent', 'second intent'])
  const over = restoreBackup({ backupPath: backup.path, databasePath: target })
  assert.equal(over.restored, true)
  assert.equal(over.previousPath !== null, true)
  assert.equal(existsSync(over.previousPath), true)
  assert.equal(intentDescriptions(over.previousPath).includes('second intent'), true)
  assert.deepEqual(intentDescriptions(target), ['first intent'])
})

test('BACKUP2 malformed or unsafe backups are rejected before touching the target', () => {
  const dir = tempDir()
  const databasePath = join(dir, 'life.sqlite')
  seed(databasePath, 'keep me')
  const before = readFileSync(databasePath)
  const bad = join(dir, 'bad.sqlite')
  writeFileSync(bad, 'not sqlite')
  assert.throws(() => verifyBackup(bad), /not a database|integrity|SQLite/i)
  assert.throws(() => restoreBackup({ backupPath: bad, databasePath }), /not a database|integrity|SQLite/i)
  assert.deepEqual(readFileSync(databasePath), before)
  assert.throws(() => restoreBackup({ backupPath: databasePath, databasePath }), /same file|self-restore/)
})

test('BACKUP3 restore preflight and naming remain isolated and bounded', () => {
  const dir = tempDir()
  const databasePath = join(dir, 'life.sqlite')
  seed(databasePath, 'alpha')
  const backup = createBackup({ databasePath, now: new Date('2026-10-25T00:00:00.000Z') })
  assert.match(backup.fileName, /^life-backup-20261025T000000Z\.sqlite$/)
  const backups = listBackups(join(dir, 'backups'), 1)
  assert.equal(backups.length, 1)
  assert.equal(backups[0].fileName, backup.fileName)
  assert.equal(readdirSync(dir).some((name) => name.startsWith('.life-restore-')), false)
})

test('BACKUP4 validation is source-read-only and never creates or changes sidecars', () => {
  const dir = tempDir()
  const databasePath = join(dir, 'life.sqlite')
  seed(databasePath, 'read only')
  for (const suffix of ['-wal', '-shm', '-journal']) rmSync(`${databasePath}${suffix}`, { force: true })
  const before = statSync(databasePath)
  const beforeHash = readFileSync(databasePath)
  const info = inspectLifeDatabase(databasePath)
  assert.equal(info.schemaVersion, '9')
  for (const suffix of ['-wal', '-shm', '-journal']) {
    assert.equal(existsSync(`${databasePath}${suffix}`), false, `inspection created ${suffix}`)
  }
  const after = statSync(databasePath)
  assert.equal(after.mtimeMs, before.mtimeMs, 'inspection changed source mtime')
  assert.deepEqual(readFileSync(databasePath), beforeHash)
})

test('BACKUP5 self-restore through relative alias, hardlink, and symlink is rejected', () => {
  const dir = tempDir()
  const databasePath = join(dir, 'life.sqlite')
  seed(databasePath, 'self')
  const backup = createBackup({ databasePath })
  const before = readFileSync(backup.path)
  mkdirSync(join(dir, 'alias-parent'))
  const relativeAlias = join(dir, 'alias-parent', '..', 'backups', basename(backup.path))
  const attempts = [
    () => restoreBackup({ backupPath: backup.path, databasePath: relativeAlias }),
  ]
  const hardlink = join(dir, 'hardlink.sqlite')
  linkSync(backup.path, hardlink)
  attempts.push(() => restoreBackup({ backupPath: backup.path, databasePath: hardlink }))
  const symlink = join(dir, 'symlink.sqlite')
  try {
    symlinkSync(backup.path, symlink, 'file')
    attempts.push(() => restoreBackup({ backupPath: backup.path, databasePath: symlink }))
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
  }
  for (const attempt of attempts) {
    assert.throws(attempt, /same file|self-restore/)
  }
  assert.deepEqual(readFileSync(backup.path), before)
})

test('BACKUP6 failure after target replacement quarantines new DB and restores old DB/WAL/SHM', () => {
  const dir = tempDir()
  const sourceDir = join(dir, 'source')
  const targetDir = join(dir, 'target')
  const source = join(sourceDir, 'life.sqlite')
  const target = join(targetDir, 'life.sqlite')
  seed(source, 'new backup')
  seed(target, 'old target')
  const backup = createBackup({ databasePath: source })
  const beforeOld = readFileSync(target)
  let calls = 0
  assert.throws(
    () => restoreBackup({
      backupPath: backup.path,
      databasePath: target,
      verify(path) {
        calls += 1
        if (calls === 3) {
          writeFileSync(`${path}-wal`, 'injected new sidecar')
          throw new Error('injected post-replacement verification failure')
        }
        return verifyBackup(path)
      },
    }),
    /injected post-replacement/,
  )
  assert.deepEqual(intentDescriptions(target), ['old target'])
  assert.deepEqual(readFileSync(target), beforeOld)
  assert.equal(existsSync(`${target}-wal`), false, 'failed target WAL must be quarantined')
  const names = readdirSync(targetDir)
  assert.equal(names.some((name) => name.includes('.failed-restore-')), true)
  const failed = names.find((name) => name.includes('.failed-restore-'))
  assert.equal(names.some((name) => name === `${failed}-wal`), true)
  assert.equal(intentDescriptions(join(targetDir, failed)).includes('new backup'), true)
})

test('BACKUP7 pre-install verification failure leaves target and sidecars untouched', () => {
  const dir = tempDir()
  const sourceDir = join(dir, 'source')
  const targetDir = join(dir, 'target')
  const source = join(sourceDir, 'life.sqlite')
  const target = join(targetDir, 'life.sqlite')
  seed(source, 'new')
  seed(target, 'old')
  const backup = createBackup({ databasePath: source })
  const before = readFileSync(target)
  let calls = 0
  assert.throws(
    () => restoreBackup({
      backupPath: backup.path,
      databasePath: target,
      verify(path) {
        calls += 1
        if (calls === 2) throw new Error('injected pre-install verification failure')
        return verifyBackup(path)
      },
    }),
    /injected pre-install/,
  )
  assert.deepEqual(readFileSync(target), before)
  assert.deepEqual(intentDescriptions(target), ['old'])
})
