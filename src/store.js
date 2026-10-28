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

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LifeClosedError, LifeStorageError, LIFE_SCHEMA_VERSION } from './model.js'

const V2_TABLES = ['meta', 'intents', 'intent_events', 'activities', 'runtime_leases']
const V3_TABLES = [...V2_TABLES, 'wake_requests']
const V4_TABLES = [...V3_TABLES, 'wake_consumption']
const V5_TABLES = V4_TABLES
const V6_TABLES = [...V5_TABLES, 'personas', 'scenes', 'scene_shares', 'session_bindings', 'budget_scopes', 'idle_state']
const V7_TABLES = [...V6_TABLES, 'usage_events']
const V8_TABLES = [...V7_TABLES, 'cost_reservations']
const V9_TABLES = [...V8_TABLES, 'token_reservations', 'token_reservation_scopes']
const V10_TABLES = [...V9_TABLES, 'life_workspace', 'session_rules']
const REQUIRED_TABLES = V10_TABLES
export const LIFE_REQUIRED_TABLES = Object.freeze([...REQUIRED_TABLES])

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
  prepared_message_id TEXT,
  prepared_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_wake_status ON wake_requests (status, next_attempt_at);
CREATE INDEX idx_wake_scope ON wake_requests (context_scope, status);
CREATE INDEX idx_wake_intent ON wake_requests (intent_id, intent_revision);
`

const WAKE_CONSUMPTION_SQL = `
CREATE TABLE wake_consumption (
  wake_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  turn_seq INTEGER NOT NULL CHECK (turn_seq >= 1),
  user_message_seq INTEGER NOT NULL CHECK (user_message_seq >= 1),
  valid_at_consumption INTEGER NOT NULL CHECK (valid_at_consumption IN (0, 1)),
  validity_known INTEGER NOT NULL DEFAULT 1 CHECK (validity_known IN (0, 1)),
  consumed_at TEXT NOT NULL,
  turn_end_seq INTEGER,
  turn_reason TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (wake_id, message_id)
);
CREATE INDEX idx_wake_consumption_turn ON wake_consumption (target_session_id, turn_seq);
`

const V6_ALTER_SQL = `
ALTER TABLE wake_requests ADD COLUMN origin TEXT NOT NULL DEFAULT 'intent' CHECK (origin IN ('intent', 'idle'));
ALTER TABLE wake_requests ADD COLUMN idle_key TEXT;
ALTER TABLE wake_requests ADD COLUMN persona_id TEXT;
ALTER TABLE wake_requests ADD COLUMN scene_id TEXT;
ALTER TABLE intents ADD COLUMN persona_id TEXT;
ALTER TABLE intents ADD COLUMN scene_id TEXT;
ALTER TABLE intents ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE activities ADD COLUMN persona_id TEXT;
ALTER TABLE activities ADD COLUMN scene_id TEXT;
ALTER TABLE activities ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE activities ADD COLUMN checkpoint_ref TEXT;
ALTER TABLE activities ADD COLUMN resource_lease TEXT;
ALTER TABLE activities ADD COLUMN deadline_at TEXT;
CREATE UNIQUE INDEX idx_wake_idle_key ON wake_requests (idle_key) WHERE idle_key IS NOT NULL;
CREATE INDEX idx_wake_origin ON wake_requests (origin, status);
`

const V6_TABLES_SQL = `
CREATE TABLE personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE scenes (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  context_scope TEXT NOT NULL,
  privacy TEXT NOT NULL CHECK (privacy IN ('private', 'shared')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_scenes_scope ON scenes (context_scope, privacy);
CREATE TABLE scene_shares (
  scene_id TEXT NOT NULL,
  data_scope TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (scene_id, data_scope)
);
CREATE TABLE session_bindings (
  target_session_id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  authorization_ref TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE idle_state (
  target_session_id TEXT PRIMARY KEY,
  last_event_at TEXT,
  last_idle_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE budget_scopes (
  scope TEXT PRIMARY KEY,
  window_ms INTEGER NOT NULL CHECK (window_ms >= 1),
  wake_limit INTEGER,
  token_limit INTEGER,
  cost_limit INTEGER,
  window_start TEXT NOT NULL,
  wake_calls INTEGER NOT NULL DEFAULT 0 CHECK (wake_calls >= 0),
  tokens_used INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  cost_used INTEGER NOT NULL DEFAULT 0 CHECK (cost_used >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at TEXT NOT NULL
);
`

const V7_SQL = `
CREATE TABLE usage_events (
  target_session_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  total_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (target_session_id, seq)
);
CREATE UNIQUE INDEX idx_activity_resource_lease
  ON activities (resource_lease)
  WHERE resource_lease IS NOT NULL
    AND status IN ('pending', 'running', 'paused', 'stopping', 'unknown');
`

const V8_SQL = `
ALTER TABLE budget_scopes ADD COLUMN activity_limit INTEGER;
ALTER TABLE budget_scopes ADD COLUMN cost_reserved INTEGER NOT NULL DEFAULT 0 CHECK (cost_reserved >= 0);
CREATE TABLE cost_reservations (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'released')),
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  settled_at TEXT,
  released_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
CREATE INDEX idx_cost_reservations_scope ON cost_reservations (scope, status);
`

const V9_SQL = `
ALTER TABLE activities ADD COLUMN provider_managed INTEGER NOT NULL DEFAULT 0 CHECK (provider_managed IN (0, 1));
UPDATE activities SET provider_managed = 1
 WHERE provider_id IS NOT NULL
   AND status IN ('pending', 'running', 'paused', 'stopping', 'unknown');
ALTER TABLE budget_scopes ADD COLUMN tokens_reserved INTEGER NOT NULL DEFAULT 0 CHECK (tokens_reserved >= 0);
CREATE TABLE token_reservations (
  id TEXT PRIMARY KEY,
  session_scope TEXT NOT NULL,
  wake_id TEXT,
  total_amount INTEGER NOT NULL CHECK (total_amount >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'settled')),
  settled_tokens INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
CREATE INDEX idx_token_reservations_session ON token_reservations (session_scope, status, created_at);
CREATE UNIQUE INDEX idx_token_reservations_wake ON token_reservations (wake_id) WHERE wake_id IS NOT NULL;
CREATE TABLE token_reservation_scopes (
  reservation_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  reserved_tokens INTEGER NOT NULL CHECK (reserved_tokens >= 0),
  settled_tokens INTEGER,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'settled')),
  PRIMARY KEY (reservation_id, scope)
);
`

const V10_SQL = `
CREATE TABLE IF NOT EXISTS life_workspace (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  workspace_id TEXT NOT NULL,
  workspace_title TEXT NOT NULL DEFAULT '',
  persona_id TEXT NOT NULL,
  activated INTEGER NOT NULL DEFAULT 0 CHECK (activated IN (0, 1)),
  legacy_migrated INTEGER NOT NULL DEFAULT 0 CHECK (legacy_migrated IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_rules (
  target_session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('inherit', 'passive', 'independent', 'disabled')),
  wake_limit INTEGER CHECK (wake_limit IS NULL OR wake_limit >= 0),
  token_limit INTEGER CHECK (token_limit IS NULL OR token_limit >= 0),
  activity_limit INTEGER CHECK (activity_limit IS NULL OR activity_limit >= 0),
  quiet_start_hour INTEGER CHECK (quiet_start_hour IS NULL OR (quiet_start_hour >= 0 AND quiet_start_hour <= 23)),
  quiet_end_hour INTEGER CHECK (quiet_end_hour IS NULL OR (quiet_end_hour >= 0 AND quiet_end_hour <= 23)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_rules_workspace ON session_rules (workspace_id, mode);
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
${WAKE_CONSUMPTION_SQL}
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
      db.exec(V6_ALTER_SQL)
      db.exec(V6_TABLES_SQL)
      db.exec(V7_SQL)
      db.exec(V8_SQL)
      db.exec(V9_SQL)
      db.exec(V10_SQL)
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

  /**
   * One-time consistent snapshot before any schema write. VACUUM INTO includes
   * committed WAL content; the snapshot is verified on a separate read-only
   * connection. Failure aborts the open before migration can write.
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {string} fromVersion
   */
  #backupBeforeMigration(db, fromVersion) {
    const directory = join(dirname(this.databasePath), 'backups')
    const target = join(
      directory,
      `life-pre-v${fromVersion}-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}.sqlite`,
    )
    try {
      mkdirSync(directory, { recursive: true })
      db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`)
      const check = new DatabaseSync(target, { readOnly: true })
      try {
        const integrity = check.prepare('PRAGMA integrity_check').get()
        if (Object.values(integrity ?? {})[0] !== 'ok') throw new Error('pre-migration backup integrity_check failed')
        const version = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
        if (version?.value !== fromVersion) {
          throw new Error(`pre-migration backup schema mismatch (${String(version?.value)} != ${fromVersion})`)
        }
      } finally {
        check.close()
      }
    } catch (error) {
      try {
        rmSync(target, { force: true })
      } catch {
        // Preserve the original backup failure.
      }
      throw new LifeStorageError(`pre-migration backup failed; refusing to migrate v${fromVersion}: ${error.message}`, {
        path: this.databasePath,
        reason: 'pre_migration_backup_failed',
        backupPath: target,
      })
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
      this.#assertColumns(db, 'wake_requests', ['prepared_message_id', 'prepared_at', 'origin', 'idle_key', 'persona_id', 'scene_id'])
      this.#assertColumns(db, 'wake_consumption', ['validity_known'])
      this.#assertColumns(db, 'intents', ['persona_id', 'scene_id', 'priority'])
      this.#assertColumns(db, 'activities', ['persona_id', 'scene_id', 'priority', 'checkpoint_ref', 'resource_lease', 'deadline_at', 'provider_managed'])
      this.#assertColumns(db, 'usage_events', ['target_session_id', 'seq', 'input_tokens', 'output_tokens', 'total_tokens'])
      this.#assertColumns(db, 'budget_scopes', ['activity_limit', 'cost_reserved', 'tokens_reserved'])
      this.#assertColumns(db, 'cost_reservations', ['id', 'scope', 'amount', 'status', 'idempotency_key'])
      this.#assertColumns(db, 'token_reservations', ['id', 'session_scope', 'total_amount', 'status'])
      this.#assertColumns(db, 'token_reservation_scopes', ['reservation_id', 'scope', 'reserved_tokens', 'status'])
      return
    }
    if (version.value !== LIFE_SCHEMA_VERSION && /^(2|3|4|5|6|7|8|9)$/.test(String(version.value))) {
      this.#backupBeforeMigration(db, String(version.value))
    }
    if (version.value === '9') {
      this.#assertTables(db, V9_TABLES)
      this.#migrateFromV9(db)
      return
    }
    if (version.value === '8') {
      this.#assertTables(db, V8_TABLES)
      this.#migrateFromV8(db)
      return
    }
    if (version.value === '7') {
      this.#assertTables(db, V7_TABLES)
      this.#migrateFromV7(db)
      this.#migrateFromV8(db)
      return
    }
    if (version.value === '6') {
      this.#assertTables(db, V6_TABLES)
      this.#migrateFromV6(db)
      this.#migrateFromV7(db)
      this.#migrateFromV8(db)
      return
    }
    if (version.value === '5') {
      this.#assertTables(db, V5_TABLES)
      this.#migrateFromV5(db)
      this.#migrateFromV6(db)
      this.#migrateFromV7(db)
      this.#migrateFromV8(db)
      return
    }
    if (version.value === '4') {
      this.#assertTables(db, V4_TABLES)
      this.#migrateFromV4(db)
      this.#migrateFromV5(db)
      this.#migrateFromV6(db)
      this.#migrateFromV7(db)
      this.#migrateFromV8(db)
      return
    }
    if (version.value === '3') {
      this.#assertTables(db, V3_TABLES)
      this.#migrateFromV3(db)
      this.#migrateFromV5(db)
      this.#migrateFromV6(db)
      this.#migrateFromV7(db)
      this.#migrateFromV8(db)
      return
    }
    if (version.value === '2') {
      // Verify the complete v2 shape before touching anything; a broken v2
      // store is never "migrated" into a different shape.
      this.#assertTables(db, V2_TABLES)
      this.#migrateFromV2(db)
      this.#migrateFromV5(db)
      this.#migrateFromV6(db)
      this.#migrateFromV7(db)
      this.#migrateFromV8(db)
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
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {string} table - table name.
   * @param {readonly string[]} columns - required column names.
   */
  #assertColumns(db, table, columns) {
    const found = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name))
    for (const column of columns) {
      if (!found.has(column)) {
        throw new LifeStorageError(`Life store table "${table}" is missing required column "${column}"`, {
          path: this.databasePath,
          reason: 'missing_column',
          table,
          column,
        })
      }
    }
  }

  /**
   * Additive v2 -> v5 migration in one transaction (wake table plus v4/v5
   * consumption evidence and prepared-message columns). Re-checks the version
   * inside the write transaction; any failure rolls back to the original v2.
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
      if (current.value === '5' || current.value === '6' || current.value === '7' || current.value === '8' || current.value === '9' || current.value === '10') {
        db.exec('COMMIT')
        this.#assertTables(db, V5_TABLES)
        return
      }
      if (current.value !== '2') {
        throw new LifeStorageError(
          `unsupported Life store schema version ${String(current.value)} during migration`,
          { path: this.databasePath, reason: 'unsupported_schema', found: current.value },
        )
      }
      db.exec(WAKE_TABLE_SQL)
      db.exec(WAKE_CONSUMPTION_SQL)
      db.prepare("UPDATE meta SET value = '5' WHERE key = 'schema_version'").run()
      db.exec('COMMIT')
      this.#assertTables(db, V5_TABLES)
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Preserve the migration failure.
      }
      if (error instanceof LifeStorageError) throw error
      throw new LifeStorageError(`Life store v2 -> v5 migration failed: ${error.message}`, {
        path: this.databasePath,
        reason: 'migration_failed',
        cause: error.message,
      })
    }
  }

  /**
   * Additive v3 -> v5 migration: wake consumption table, prepared-message
   * columns, validity-known column. Re-checks the version in the transaction;
   * failure rolls back to v3.
   * @param {import('node:sqlite').DatabaseSync} db - verified v3 connection.
   */
  #migrateFromV3(db) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
      if (current === undefined) {
        throw new LifeStorageError('Life store lost schema_version during migration; refusing to continue', {
          path: this.databasePath,
          reason: 'missing_schema_version',
        })
      }
      if (current.value === '5' || current.value === '6' || current.value === '7' || current.value === '8' || current.value === '9' || current.value === '10') {
        db.exec('COMMIT')
        this.#assertTables(db, V5_TABLES)
        return
      }
      if (current.value !== '3') {
        throw new LifeStorageError(
          `unsupported Life store schema version ${String(current.value)} during migration`,
          { path: this.databasePath, reason: 'unsupported_schema', found: current.value },
        )
      }
      db.exec(WAKE_CONSUMPTION_SQL)
      db.exec(
        `ALTER TABLE wake_requests ADD COLUMN prepared_message_id TEXT;
         ALTER TABLE wake_requests ADD COLUMN prepared_at TEXT;`,
      )
      db.prepare("UPDATE meta SET value = '5' WHERE key = 'schema_version'").run()
      db.exec('COMMIT')
      this.#assertTables(db, V5_TABLES)
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Preserve the migration failure.
      }
      if (error instanceof LifeStorageError) throw error
      throw new LifeStorageError(`Life store v3 -> v5 migration failed: ${error.message}`, {
        path: this.databasePath,
        reason: 'migration_failed',
        cause: error.message,
      })
    }
  }

  /**
   * Additive v4 -> v5 migration: prepared-message columns and validity-known
   * evidence. Re-checks the version inside the transaction; failure rolls back
   * to v4 without touching existing rows.
   * @param {import('node:sqlite').DatabaseSync} db - verified v4 connection.
   */
  #migrateFromV4(db) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
      if (current === undefined) {
        throw new LifeStorageError('Life store lost schema_version during migration; refusing to continue', {
          path: this.databasePath,
          reason: 'missing_schema_version',
        })
      }
      if (current.value === '5' || current.value === '6' || current.value === '7' || current.value === '8' || current.value === '9' || current.value === '10') {
        db.exec('COMMIT')
        this.#assertTables(db, V5_TABLES)
        return
      }
      if (current.value !== '4') {
        throw new LifeStorageError(
          `unsupported Life store schema version ${String(current.value)} during migration`,
          { path: this.databasePath, reason: 'unsupported_schema', found: current.value },
        )
      }
      db.exec(
        `ALTER TABLE wake_requests ADD COLUMN prepared_message_id TEXT;
         ALTER TABLE wake_requests ADD COLUMN prepared_at TEXT;`,
      )
      db.exec(
        `ALTER TABLE wake_consumption
         ADD COLUMN validity_known INTEGER NOT NULL DEFAULT 1 CHECK (validity_known IN (0, 1));`,
      )
      db.prepare("UPDATE meta SET value = '5' WHERE key = 'schema_version'").run()
      db.exec('COMMIT')
      this.#assertTables(db, V5_TABLES)
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Preserve the migration failure.
      }
      if (error instanceof LifeStorageError) throw error
      throw new LifeStorageError(`Life store v4 -> v5 migration failed: ${error.message}`, {
        path: this.databasePath,
        reason: 'migration_failed',
        cause: error.message,
      })
    }
  }

  /**
   * Additive v5 -> v6 migration: identity/scenes/bindings, idle state, budget
   * table and wake/activity/intent v6 columns. Re-checks the version inside the
   * transaction; failure rolls back to v5.
   * @param {import('node:sqlite').DatabaseSync} db - verified v5 connection.
   */
  #migrateFromV5(db) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
      if (current === undefined) {
        throw new LifeStorageError('Life store lost schema_version during migration; refusing to continue', {
          path: this.databasePath,
          reason: 'missing_schema_version',
        })
      }
      if (current.value === '6' || current.value === '7' || current.value === '8' || current.value === '9' || current.value === '10') {
        db.exec('COMMIT')
        this.#assertTables(db, V6_TABLES)
        return
      }
      if (current.value !== '5') {
        throw new LifeStorageError(
          `unsupported Life store schema version ${String(current.value)} during migration`,
          { path: this.databasePath, reason: 'unsupported_schema', found: current.value },
        )
      }
      db.exec(V6_ALTER_SQL)
      db.exec(V6_TABLES_SQL)
      db.prepare("UPDATE meta SET value = '6' WHERE key = 'schema_version'").run()
      db.exec('COMMIT')
      this.#assertTables(db, V6_TABLES)
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Preserve the migration failure.
      }
      if (error instanceof LifeStorageError) throw error
      throw new LifeStorageError(`Life store v5 -> v6 migration failed: ${error.message}`, {
        path: this.databasePath,
        reason: 'migration_failed',
        cause: error.message,
      })
    }
  }

  /**
   * Additive v6 -> v7 migration: idempotent token-usage ledger and the partial
   * unique index that makes one activity resource lease mutually exclusive.
   * @param {import('node:sqlite').DatabaseSync} db - verified v6 connection.
   */
  #migrateFromV6(db) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
      if (current === undefined) {
        throw new LifeStorageError('Life store lost schema_version during migration; refusing to continue', {
          path: this.databasePath,
          reason: 'missing_schema_version',
        })
      }
      if (current.value === '7' || current.value === '8' || current.value === '9' || current.value === '10') {
        db.exec('COMMIT')
        this.#assertTables(db, V7_TABLES)
        return
      }
      if (current.value !== '6') {
        throw new LifeStorageError(
          `unsupported Life store schema version ${String(current.value)} during migration`,
          { path: this.databasePath, reason: 'unsupported_schema', found: current.value },
        )
      }
      db.exec(V7_SQL)
      db.prepare("UPDATE meta SET value = '7' WHERE key = 'schema_version'").run()
      db.exec('COMMIT')
      this.#assertTables(db, V7_TABLES)
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Preserve the migration failure.
      }
      if (error instanceof LifeStorageError) throw error
      throw new LifeStorageError(`Life store v6 -> v7 migration failed: ${error.message}`, {
        path: this.databasePath,
        reason: 'migration_failed',
        cause: error.message,
      })
    }
  }

  /**
   * Additive v7 -> v8 migration: activity concurrency limits and the trusted
   * paid-cost reservation ledger. Existing counters/history are preserved.
   * @param {import('node:sqlite').DatabaseSync} db - verified v7 connection.
   */
  #migrateFromV7(db) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
      if (current === undefined) {
        throw new LifeStorageError('Life store lost schema_version during migration; refusing to continue', {
          path: this.databasePath,
          reason: 'missing_schema_version',
        })
      }
      if (current.value === '8' || current.value === '9' || current.value === '10') {
        db.exec('COMMIT')
        this.#assertTables(db, V8_TABLES)
        return
      }
      if (current.value !== '7') {
        throw new LifeStorageError(
          `unsupported Life store schema version ${String(current.value)} during migration`,
          { path: this.databasePath, reason: 'unsupported_schema', found: current.value },
        )
      }
      db.exec(V8_SQL)
      db.prepare("UPDATE meta SET value = '8' WHERE key = 'schema_version'").run()
      db.exec('COMMIT')
      this.#assertTables(db, V8_TABLES)
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Preserve the migration failure.
      }
      if (error instanceof LifeStorageError) throw error
      throw new LifeStorageError(`Life store v7 -> v8 migration failed: ${error.message}`, {
        path: this.databasePath,
        reason: 'migration_failed',
        cause: error.message,
      })
    }
  }

  /**
   * Additive v8 -> v9 migration: durable per-wake token reservations/settlement.
   * Existing cost/wake/token counters and history are preserved.
   * @param {import('node:sqlite').DatabaseSync} db - verified v8 connection.
   */
  #migrateFromV8(db) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
      if (current === undefined) {
        throw new LifeStorageError('Life store lost schema_version during migration; refusing to continue', {
          path: this.databasePath,
          reason: 'missing_schema_version',
        })
      }
      if (current.value === '9' || current.value === LIFE_SCHEMA_VERSION) {
        db.exec('COMMIT')
        this.#assertTables(db, V9_TABLES)
        if (current.value === '9' || current.value === '10') this.#migrateFromV9(db)
        return
      }
      if (current.value !== '8') {
        throw new LifeStorageError(
          `unsupported Life store schema version ${String(current.value)} during migration`,
          { path: this.databasePath, reason: 'unsupported_schema', found: current.value },
        )
      }
      db.exec(V9_SQL)
      db.prepare("UPDATE meta SET value = '9' WHERE key = 'schema_version'").run()
      db.exec('COMMIT')
      this.#assertTables(db, V9_TABLES)
      this.#migrateFromV9(db)
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Preserve the migration failure.
      }
      if (error instanceof LifeStorageError) throw error
      throw new LifeStorageError(`Life store v8 -> v9 migration failed: ${error.message}`, {
        path: this.databasePath,
        reason: 'migration_failed',
        cause: error.message,
      })
    }
  }

  /**
   * Additive v9 -> v10 migration: workspace binding, activation/migration
   * markers, and durable per-session policy overrides. Existing intents,
   * activities, allowances, wake ledger, and budgets are preserved.
   * @param {import('node:sqlite').DatabaseSync} db - verified v9 connection.
   */
  #migrateFromV9(db) {
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
        db.exec('COMMIT')
        this.#assertTables(db, REQUIRED_TABLES)
        return
      }
      if (current.value !== '9') {
        throw new LifeStorageError(
          `unsupported Life store schema version ${String(current.value)} during migration`,
          { path: this.databasePath, reason: 'unsupported_schema', found: current.value },
        )
      }
      db.exec(V10_SQL)
      db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(LIFE_SCHEMA_VERSION, 'schema_version')
      db.exec('COMMIT')
      this.#assertTables(db, REQUIRED_TABLES)
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Preserve the migration failure.
      }
      if (error instanceof LifeStorageError) throw error
      throw new LifeStorageError(`Life store v9 -> v10 migration failed: ${error.message}`, {
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
