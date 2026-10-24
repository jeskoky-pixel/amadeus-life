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

const REQUIRED_TABLES = ['meta', 'intents', 'intent_events', 'activities', 'runtime_leases']

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
      db.prepare('PRAGMA journal_mode = WAL').get()
      if (existed) this.#verify(db)
      else this.#initialize(db)
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
  #verify(db) {
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
    if (version.value !== LIFE_SCHEMA_VERSION) {
      throw new LifeStorageError(
        `unsupported Life store schema version ${String(version.value)}; this build supports ${LIFE_SCHEMA_VERSION}`,
        { path: this.databasePath, reason: 'unsupported_schema', found: version.value, expected: LIFE_SCHEMA_VERSION },
      )
    }
    for (const table of REQUIRED_TABLES) {
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
