import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { LifeCore } from '../src/core.js'
import { LifeStorageError } from '../src/model.js'
import { createBackup, listBackups, restoreBackup, verifyBackup } from '../src/backup.js'

const SESSION = 'session-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

function makeV9(path, description = 'v9 survivor') {
  const core = new LifeCore({ databasePath: path })
  core.createIntent({
    description,
    reviewAt: '2099-01-01T00:00:00.000Z',
    contextScope: `session:${SESSION}`,
    authorizationRef: 'test:v9',
  })
  core.close()
  const db = new DatabaseSync(path)
  try {
    db.exec('DROP TABLE session_rules; DROP TABLE life_workspace;')
    db.prepare("UPDATE meta SET value = '9' WHERE key = 'schema_version'").run()
  } finally {
    db.close()
  }
}

test('MIG1 v9 open creates a verified pre-migration snapshot before schema 10', () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-migrate-'))
  const path = join(dir, 'life.sqlite')
  makeV9(path)
  const core = new LifeCore({ databasePath: path })
  try {
    assert.equal(core.getHealth().schemaVersion, '10')
    assert.equal(core.listIntents({ scope: `session:${SESSION}` })[0].description, 'v9 survivor')
  } finally {
    core.close()
  }
  const backups = readdirSync(join(dir, 'backups')).filter((name) => name.endsWith('.sqlite'))
  assert.equal(backups.length, 1)
  const snapshot = new DatabaseSync(join(dir, 'backups', backups[0]), { readOnly: true })
  try {
    assert.equal(snapshot.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '9')
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.equal(snapshot.prepare('SELECT description FROM intents').get().description, 'v9 survivor')
    assert.equal(snapshot.prepare("SELECT name FROM sqlite_master WHERE name = 'life_workspace'").get(), undefined)
  } finally {
    snapshot.close()
  }
})

test('MIG2 failed pre-migration backup fails closed and leaves v9 untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-migrate-'))
  const path = join(dir, 'life.sqlite')
  makeV9(path)
  rmSync(join(dir, 'backups'), { recursive: true, force: true })
  writeFileSync(join(dir, 'backups'), 'not a directory')
  assert.throws(() => new LifeCore({ databasePath: path }), (error) => {
    assert.ok(error instanceof LifeStorageError)
    assert.equal(error.details?.reason, 'pre_migration_backup_failed')
    return true
  })
  const raw = new DatabaseSync(path)
  try {
    assert.equal(raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '9')
    assert.equal(raw.prepare('SELECT description FROM intents').get().description, 'v9 survivor')
    assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'life_workspace'").get(), undefined)
  } finally {
    raw.close()
  }
})

test('MIG3 v9 pre-upgrade backup and automatic snapshot can be verified and restored after migration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-v9-rollback-'))
  const source = join(dir, 'source.sqlite')
  const target = join(dir, 'target.sqlite')
  makeV9(source, 'rollback survivor')
  const beforeUpgrade = createBackup({ databasePath: source })
  assert.equal(beforeUpgrade.schemaVersion, '9')
  assert.equal(verifyBackup(beforeUpgrade.path).schemaVersion, '9')

  const upgraded = new LifeCore({ databasePath: source })
  assert.equal(upgraded.getHealth().schemaVersion, '10')
  upgraded.close()
  const automatic = join(dir, 'backups', readdirSync(join(dir, 'backups')).find((name) => /^life-pre-v9-.*\.sqlite$/.test(name)))
  assert.equal(verifyBackup(automatic).schemaVersion, '9')
  assert.ok(listBackups(join(dir, 'backups')).some((entry) => entry.fileName === beforeUpgrade.fileName))
  assert.ok(listBackups(join(dir, 'backups')).some((entry) => entry.fileName === automatic.split(/[\\/]/).at(-1)))

  const current = new LifeCore({ databasePath: target })
  current.close()
  assert.equal(restoreBackup({ backupPath: automatic, databasePath: target, dryRun: true }).schemaVersion, '9')
  assert.equal(verifyBackup(target).schemaVersion, '10')
  const restored = restoreBackup({ backupPath: automatic, databasePath: target })
  assert.equal(restored.restored, true)
  assert.equal(verifyBackup(target).schemaVersion, '9')
  assert.ok(existsSync(restored.previousPath))
  const db = new DatabaseSync(target, { readOnly: true })
  try {
    assert.equal(db.prepare('SELECT description FROM intents').get().description, 'rollback survivor')
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'life_workspace'").get(), undefined)
  } finally { db.close() }
})

test('MIG4 malformed, partial, or unknown v9 snapshots fail before target mutation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-v9-invalid-'))
  const target = join(dir, 'target.sqlite')
  const current = new LifeCore({ databasePath: target })
  current.close()
  for (const [name, sql] of [
    ['missing table', 'DROP TABLE token_reservation_scopes'],
    ['partial migration', 'CREATE TABLE life_workspace (singleton INTEGER)'],
    ['unknown version', "UPDATE meta SET value = '11' WHERE key = 'schema_version'"],
  ]) {
    const source = join(dir, `${name.replace(/ /g, '-')}.sqlite`)
    makeV9(source)
    const db = new DatabaseSync(source)
    try { db.exec(sql) } finally { db.close() }
    assert.throws(() => verifyBackup(source), /missing required table|partial future schema|unsupported Life schema/)
    assert.throws(() => restoreBackup({ backupPath: source, databasePath: target }), /missing required table|partial future schema|unsupported Life schema/)
    assert.equal(verifyBackup(target).schemaVersion, '10')
  }
})
