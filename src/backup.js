/**
 * Isolated Life SQLite backup/restore helpers.
 *
 * A backup is a consistent SQLite snapshot created with VACUUM INTO, not a raw
 * file copy of a live WAL database. Restore preflights the snapshot, copies it
 * to the target directory, verifies the copy, then moves the old database/WAL/
 * SHM aside before an atomic rename. Old files are preserved, never deleted.
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { LIFE_SCHEMA_VERSION } from './model.js'
import { LIFE_REQUIRED_TABLES } from './store.js'

function requireFile(path, label) {
  if (typeof path !== 'string' || path.length === 0) throw new Error(`${label} path is required`)
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`)
  const stat = statSync(path)
  if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${path}`)
  return stat
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Read-only structural validation of a Life database. Validation is performed
 * on a private temporary copy so SQLite can never create or mutate `-wal`,
 * `-shm`, or `-journal` beside the user's file, even when the source is WAL-mode.
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
export function inspectLifeDatabase(path) {
  const stat = requireFile(path, 'database')
  const tempDir = mkdtempSync(join(tmpdir(), 'life-inspect-'))
  const copy = join(tempDir, 'life.sqlite')
  try {
    copyFileSync(path, copy)
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (existsSync(`${path}${suffix}`)) copyFileSync(`${path}${suffix}`, `${copy}${suffix}`)
    }
    const db = new DatabaseSync(copy, { readOnly: true })
    try {
      db.exec('PRAGMA query_only = ON')
      const integrity = db.prepare('PRAGMA integrity_check').all()
      if (integrity.length !== 1 || String(integrity[0].integrity_check).toLowerCase() !== 'ok') {
        throw new Error(`SQLite integrity check failed: ${JSON.stringify(integrity).slice(0, 300)}`)
      }
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
      for (const table of LIFE_REQUIRED_TABLES) {
        if (!tables.has(table)) throw new Error(`Life database is missing required table: ${table}`)
      }
      const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
      if (version === undefined) throw new Error('Life database has no schema_version')
      if (String(version.value) !== LIFE_SCHEMA_VERSION) {
        throw new Error(`unsupported Life schema version ${String(version.value)}; expected ${LIFE_SCHEMA_VERSION}`)
      }
      const counts = {}
      for (const table of ['intents', 'activities', 'wake_requests', 'session_bindings', 'budget_scopes']) {
        counts[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)
      }
      return {
        bytes: stat.size,
        sha256: hashFile(path),
        schemaVersion: String(version.value),
        tables: [...tables].length,
        counts,
      }
    } finally {
      db.close()
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function timestamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function uniquePath(base) {
  if (!existsSync(base)) return base
  const ext = base.endsWith('.sqlite') ? '.sqlite' : ''
  const stem = ext ? base.slice(0, -ext.length) : base
  for (let i = 1; i < 10_000; i += 1) {
    const candidate = `${stem}-${i}${ext}`
    if (!existsSync(candidate)) return candidate
  }
  throw new Error('could not allocate a unique backup filename')
}

function canonical(path) {
  const absolute = resolve(path)
  try {
    return realpathSync.native(absolute)
  } catch {
    // Target may not exist yet. Resolve its parent so `..`/symlinked directories
    // cannot disguise a self-restore as a different path.
    let parent = dirname(absolute)
    try { parent = realpathSync.native(parent) } catch { /* keep resolved parent */ }
    return join(parent, basename(absolute))
  }
}

function comparable(path) {
  const value = canonical(path)
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/**
 * Compare backup and target by canonical path and, when both exist, filesystem
 * identity (dev/ino). This catches `.`/`..`, relative aliases, symlinks, and
 * hardlinks before any copy or rename takes place.
 */
function sameFileIdentity(backupPath, databasePath) {
  if (comparable(backupPath) === comparable(databasePath)) return true
  try {
    const a = statSync(canonical(backupPath))
    const b = statSync(canonical(databasePath))
    return a.dev === b.dev && a.ino === b.ino
  } catch {
    return false
  }
}

/**
 * Create a consistent backup in a dedicated directory.
 * @param {{databasePath: string, backupDir?: string, now?: Date}} input
 */
export function createBackup({ databasePath, backupDir, now = new Date() } = {}) {
  requireFile(databasePath, 'database')
  const dir = backupDir === undefined ? join(dirname(databasePath), 'backups') : backupDir
  mkdirSync(dir, { recursive: true })
  const base = join(dir, `life-backup-${timestamp(now)}.sqlite`)
  const target = uniquePath(base)
  const db = new DatabaseSync(databasePath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    // VACUUM INTO includes committed WAL content and produces a standalone DB.
    db.prepare('VACUUM INTO ?').run(target)
  } finally {
    db.close()
  }
  const info = inspectLifeDatabase(target)
  const meta = {
    fileName: basename(target),
    bytes: info.bytes,
    sha256: info.sha256,
    schemaVersion: info.schemaVersion,
    counts: info.counts,
    createdAt: now.toISOString(),
  }
  writeFileSync(`${target}.json`, `${JSON.stringify(meta, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  return { ...meta, path: target, backupDir: dir }
}

/**
 * Verify a backup without modifying it.
 * @param {string} path
 */
export function verifyBackup(path) {
  const info = inspectLifeDatabase(path)
  return { ...info, path, fileName: basename(path), valid: true }
}

/**
 * List verified backups in a directory, newest first.
 * @param {string} backupDir
 * @param {number} [limit]
 */
export function listBackups(backupDir, limit = 50) {
  if (typeof backupDir !== 'string' || !existsSync(backupDir)) return []
  const files = readdirSync(backupDir)
    .filter((name) => /^life-backup-.*\.sqlite$/.test(name))
    .map((name) => join(backupDir, name))
    .sort()
    .reverse()
    .slice(0, Math.max(0, Math.min(100, limit)))
  const result = []
  for (const file of files) {
    try {
      const sidecar = `${file}.json`
      if (existsSync(sidecar)) {
        const meta = JSON.parse(readFileSync(sidecar, 'utf8'))
        result.push({
          fileName: basename(file),
          bytes: meta.bytes,
          sha256: meta.sha256,
          schemaVersion: meta.schemaVersion,
          createdAt: meta.createdAt,
        })
        continue
      }
      const info = inspectLifeDatabase(file)
      result.push({ fileName: basename(file), bytes: info.bytes, sha256: info.sha256, schemaVersion: info.schemaVersion })
    } catch (error) {
      result.push({ fileName: basename(file), invalid: true, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

/**
 * Restore a backup with preflight/dry-run and atomic replacement.
 * The `verify` hook is injectable for failure-path tests; production uses the
 * full read-only validator above.
 * @param {{backupPath: string, databasePath: string, dryRun?: boolean, now?: Date, verify?: (path: string) => Record<string, unknown>}} input
 */
export function restoreBackup({
  backupPath,
  databasePath,
  dryRun = false,
  now = new Date(),
  verify = verifyBackup,
} = {}) {
  requireFile(backupPath, 'backup')
  if (sameFileIdentity(backupPath, databasePath)) {
    throw new Error('backup and target database refer to the same file (alias, symlink, or hardlink); refusing self-restore')
  }
  const info = verify(backupPath)
  const plan = {
    dryRun,
    backup: { path: backupPath, fileName: basename(backupPath), ...info },
    target: databasePath,
    targetExists: existsSync(databasePath),
    schemaVersion: info.schemaVersion,
  }
  if (dryRun) return { ...plan, restored: false }
  mkdirSync(dirname(databasePath), { recursive: true })
  const stamp = timestamp(now)
  const temp = uniquePath(join(dirname(databasePath), `.life-restore-${stamp}.sqlite`))
  const previous = uniquePath(`${databasePath}.pre-restore-${stamp}`)
  copyFileSync(backupPath, temp)
  verify(temp)
  const moved = []
  let installed = false
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const source = `${databasePath}${suffix}`
      if (existsSync(source)) {
        const destination = `${previous}${suffix}`
        renameSync(source, destination)
        moved.push([destination, source])
      }
    }
    renameSync(temp, databasePath)
    installed = true
    // This is deliberately after the rename: a damaged/partially written target
    // must be quarantined and the old DB/WAL/SHM put back, not left in place.
    verify(databasePath)
  } catch (error) {
    let quarantinePath = null
    if (installed) {
      try {
        quarantinePath = uniquePath(`${databasePath}.failed-restore-${stamp}`)
        for (const suffix of ['', '-wal', '-shm']) {
          if (existsSync(`${databasePath}${suffix}`)) {
            renameSync(`${databasePath}${suffix}`, `${quarantinePath}${suffix}`)
          }
        }
      } catch (quarantineError) {
        const failure = new Error(
          `${error instanceof Error ? error.message : String(error)}; failed target could not be quarantined (${quarantineError.message}); previous DB preserved at ${previous}`,
        )
        failure.cause = error
        throw failure
      }
    }
    try { rmSync(temp, { force: true }) } catch { /* preserve original error */ }
    const restoreFailures = []
    for (const [destination, source] of moved.reverse()) {
      try { renameSync(destination, source) } catch (restoreError) {
        restoreFailures.push(`${source}: ${restoreError.message}`)
      }
    }
    if (restoreFailures.length > 0) {
      const failure = new Error(
        `${error instanceof Error ? error.message : String(error)}; previous DB preserved at ${previous}; rollback failed for ${restoreFailures.join('; ')}`,
      )
      failure.cause = error
      throw failure
    }
    if (quarantinePath !== null && error instanceof Error) error.quarantinePath = quarantinePath
    throw error
  }
  return {
    ...plan,
    restored: true,
    previousPath: moved.length > 0 ? previous : null,
    bytes: info.bytes,
    sha256: info.sha256,
  }
}

/** @param {string[]} argv */
export function runCli(argv) {
  const [command, ...rest] = argv
  const flags = {}
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = rest[i + 1]
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i += 1 }
      else flags[key] = true
    }
  }
  if (command === 'backup') {
    if (!flags.database) throw new Error('--database is required')
    const result = createBackup({ databasePath: flags.database, backupDir: flags.out })
    console.log(JSON.stringify({ ok: true, backup: result }, null, 2))
    return
  }
  if (command === 'verify') {
    if (!flags.file) throw new Error('--file is required')
    const result = verifyBackup(flags.file)
    console.log(JSON.stringify({ ok: true, backup: result }, null, 2))
    return
  }
  if (command === 'list') {
    if (!flags.dir) throw new Error('--dir is required')
    console.log(JSON.stringify({ ok: true, backups: listBackups(flags.dir, Number(flags.limit ?? 50)) }, null, 2))
    return
  }
  if (command === 'restore') {
    if (!flags.backup || !flags.database) throw new Error('--backup and --database are required')
    const result = restoreBackup({ backupPath: flags.backup, databasePath: flags.database, dryRun: flags['dry-run'] === true })
    console.log(JSON.stringify({ ok: true, restore: result }, null, 2))
    return
  }
  throw new Error('usage: life-backup.mjs <backup|verify|list|restore> [flags]')
}

/* c8 ignore next 4 -- CLI entry; functions are imported by tests. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
