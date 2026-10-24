/**
 * Durable SQLite storage for Amadeus Life.
 *
 * Design choices (see docs/adr/0001-life-runtime.md):
 * - `node:sqlite` synchronous API, no external dependency.
 * - WAL + `busy_timeout` so independent connections do not silently interleave.
 * - every write runs inside `BEGIN IMMEDIATE`, and mutation methods use
 *   revision CAS (`... WHERE revision = ?`) inside that transaction.
 * - an existing file is never replaced: integrity, schema version, and required
 *   tables are verified before use; failure throws `LifeStorageError`.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LifeClosedError, LifeStorageError, LIFE_SCHEMA_VERSION } from './model.js'

const V2_TABLES = ['meta', 'intents', 'intent_events', 'activities', 'runtime_leases']
const REQUIRED_TABLES = [...V2_TABLES, 'wake_requests']

const WAKE_TABLE_SQL = `
CREATE TABLE wake_requests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('intent_due')),
  event_id TEXT NOT NULL UNIQUE,
  intent_id TEXT NOT NULL,
  intent_revision INTEGER NOT NULL CHECK (intent_revision >= 1),
  context_scope TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  authorization_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'admitted', 'executed', 'uncertain', 'superseded', 'failed')),
  claim_owner TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT NOT NULL,
  expires_at TEXT,
  message_id TEXT,
  admitted_at TEXT,
  executed_at TEXT,
  executed_turn_seq INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_wake_status ON wake_requests (status, next_attempt_at);
CREATE INDEX idx_wake_scope ON wake_requests (context_scope, status);
CREATE INDEX idx_wake_intent ON wake_requests (intent_id, intent_revision);
`

const SCHEMA_SQL = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE intents (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL,
  description TEXT NOT NULL,
  context_scope TEXT NOT NULL,
  authorization_ref TEXT NOT NULL,
  related_activity_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  review_at TEXT NOT NULL
);
CREATE INDEX idx_intents_due ON intents (status, review_at);
CREATE TABLE intent_events (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  intent_revision INTEGER NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT,
  payload_json TEXT NOT NULL,
  UNIQUE (intent_id, intent_revision, type)
);
CREATE INDEX idx_intent_events_status ON intent_events (status);
CREATE TABLE activities (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL,
  description TEXT NOT NULL,
  provider_id TEXT,
  intent_id TEXT,
  owner_scope TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_activities_owner ON activities (owner_scope, status);
CREATE TABLE runtime_leases (
  key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  acquired_at TEXT NOT NULL
);
${WAKE_TABLE_SQL}
`

/** One verified connection to the Life ledger. */
export class LifeStore {
  /** @type {import('node:sqlite').DatabaseSync | null} */
  #db = null

  /**
   * Open and verify a store.
   * @param {string} databasePath - absolute path to the SQLite file.
   * @returns {LifeStore} verified store.
   * @throws {LifeStorageError} when the file is corrupt, has an unknown schema,
   *   or cannot be written. A broken file is never replaced with an empty one.
   */
  static open(databasePath) {
    return new LifeStore(databasePath)
  }

  /** @param {string} databasePath */
  constructor(databasePath) {
    this.databasePath = databasePath
    const existed = existsSync(databasePath)
    mkdirSync(dirname(databasePath), { recursive: true })
    /** @type {import('node:sqlite').DatabaseSync | undefined} */
    let db
    try {
      db = new DatabaseSync(databasePath)
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec('PRAGMA synchronous = NORMAL')
      if (existed) {
        // Verify/migrate before any journal-mode conversion: PRAGMA
        // journal_mode can fail with SQLITE_BUSY while another opener holds the
        // migration transaction. A v2 store created by this package is already
        // WAL; conversion here is best-effort after the schema is safe.
        this.#verifyOrMigrate(db)
        try {
          db.prepare('PRAGMA journal_mode = WAL').get()
        } catch {
          // Keep the existing journal mode under contention; durability and
          // schema safety do not depend on converting at open time.
        }
      } else {
        db.prepare('PRAGMA journal_mode = WAL').get()
        this.#initialize(db)
      }
      this.#db = db
      this.closed = false
    } catch (error) {
      try {
        db?.close()
      } catch {
        // Preserve the original failure.
      }
      if (error instanceof LifeStorageError) throw error
      throw new LifeStorageError(`cannot open Life store at ${databasePath}: ${error.message}`, {
        path: databasePath,
        reason: error.message,
      })
    }
  }

  /** @param {import('node:sqlite').DatabaseSync} db */
  #initialize(db) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(SCHEMA_SQL)
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', LIFE_SCHEMA_VERSION)
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Preserve the original failure.
      }
      throw error
    }
  }

  /** @param {import('node:sqlite').DatabaseSync} db */
  #verifyOrMigrate(db) {
    const integrity = db.prepare('PRAGMA integrity_check').get()
    const verdict = Object.values(integrity ?? {})[0]
    if (verdict !== 'ok') {
      throw new LifeStorageError(`Life store integrity_check failed: ${String(verdict)}`, {
        path: this.databasePath,
        reason: 'integrity',
      })
    }
    const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()
    if (hasMeta === undefined) {
      throw new LifeStorageError('existing Life store has no schema metadata; refusing to create a new empty store', {
        path: this.databasePath,
        reason: 'missing_schema',
      })
    }
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
    if (version === undefined) {
      throw new LifeStorageError('existing Life store has no schema_version; refusing to create a new empty store', {
        path: this.databasePath,
        reason: 'missing_schema_version',
      })
    }
    if (version.value === LIFE_SCHEMA_VERSION) {
      this.#assertTables(db, REQUIRED_TABLES)
      return
    }
    if (version.value === '2') {
      // Verify the complete v2 shape before touching anything; a broken v2
      // store is never "migrated" into a different shape.
      this.#assertTables(db, V2_TABLES)
      this.#migrateFromV2(db)
      return
    }
    throw new LifeStorageError(
      `unsupported Life store schema version ${String(version.value)}; this build supports ${LIFE_SCHEMA_VERSION}`,
      { path: this.databasePath, reason: 'unsupported_schema', found: version.value, expected: LIFE_SCHEMA_VERSION },
    )
  }

  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {readonly string[]} tables - required table names.
   */
  #assertTables(db, tables) {
    for (const table of tables) {
      const found = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
      if (found === undefined) {
        throw new LifeStorageError(`Life store is missing required table "${table}"`, {
          path: this.databasePath,
          reason: 'missing_table',
          table,
        })
      }
    }
  }

  /**
   * Additive v2 -> v3 migration. Re-checks the version inside the write
   * transaction so two concurrent openers cannot migrate twice; any failure
   * rolls back and leaves the original v2 store untouched.
   * @param {import('node:sqlite').DatabaseSync} db - verified v2 connection.
   */
  #migrateFromV2(db) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
      if (current === undefined) {
        throw new LifeStorageError('Life store lost schema_version during migration; refusing to continue', {
          path: this.databasePath,
          reason: 'missing_schema_version',
        })
      }
      if (current.value === LIFE_SCHEMA_VERSION) {
        // Another opener completed the migration while this one waited.
        db.exec('COMMIT')
        this.#assertTables(db, REQUIRED_TABLES)
        return
      }
      if (current.value !== '2') {
        throw new LifeStorageError(
          `unsupported Life store schema version ${String(current.value)} during migration`,
          { path: this.databasePath, reason: 'unsupported_schema', found: current.value },
        )
      }
      db.exec(WAKE_TABLE_SQL)
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(LIFE_SCHEMA_VERSION)
      db.exec('COMMIT')
      this.#assertTables(db, REQUIRED_TABLES)
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Preserve the migration failure.
      }
      if (error instanceof LifeStorageError) throw error
      throw new LifeStorageError(`Life store v2 -> v3 migration failed: ${error.message}`, {
        path: this.databasePath,
        reason: 'migration_failed',
        cause: error.message,
      })
    }
  }

  #connection() {
    if (this.closed || this.#db === null) throw new LifeClosedError('Life store is closed')
    return this.#db
  }

  /**
   * Run a mutating SQL statement.
   * @param {string} sql - statement.
   * @param {...unknown} params - bound parameters.
   * @returns {{changes: number | bigint, lastInsertRowid: number | bigint}} result.
   */
  run(sql, ...params) {
    return this.#connection().prepare(sql).run(...params)
  }

  /**
   * Read one row.
   * @param {string} sql - statement.
   * @param {...unknown} params - bound parameters.
   * @returns {Record<string, unknown> | undefined} row.
   */
  get(sql, ...params) {
    return this.#connection().prepare(sql).get(...params)
  }

  /**
   * Read all rows.
   * @param {string} sql - statement.
   * @param {...unknown} params - bound parameters.
   * @returns {Record<string, unknown>[]} rows.
   */
  all(sql, ...params) {
    return this.#connection().prepare(sql).all(...params)
  }

  /**
   * Run `fn` inside `BEGIN IMMEDIATE`; roll back on any throw.
   * @template T
   * @param {() => T} fn - transaction body.
   * @returns {T} body result after commit.
   */
  writeTransaction(fn) {
    const db = this.#connection()
    db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      db.exec('COMMIT')
      return value
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Preserve the original failure.
      }
      throw error
    }
  }

  /** Close the connection; safe to call twice. */
  close() {
    if (this.closed) return
    this.closed = true
    this.#db?.close()
    this.#db = null
  }
}
