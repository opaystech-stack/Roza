/**
 * Database initialization (Component 4) — Req 3.1–3.10.
 *
 * Mirrors the proven Opays HQ `server/db.ts` pattern (`better-sqlite3`,
 * `journal_mode = WAL`, `foreign_keys = ON`, idempotent `CREATE TABLE IF NOT
 * EXISTS` schema) but points at Roza's own isolated file `roza_mind.sqlite`
 * and uses Roza's schema. The Roza_Mind_Database shares no handle, client, or
 * connection with Opays HQ tooling (Req 3.4).
 *
 * The module is split into side-effect-free, non-exiting core functions
 * (`openDatabase`, `initSchema`, `verifySchema`) that throw typed errors, and
 * a thin imperative wrapper (`initDatabaseOrExit`) that logs and
 * `process.exit(1)` on failure — so integration tests can exercise schema
 * creation and the failure modes without killing the test process.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

/** The canonical Roza_Mind_Database file name (Req 3.1). */
export const DB_FILE_NAME = 'roza_mind.sqlite';

/**
 * Raised when the `data/` directory is absent or not writable, so the database
 * can neither be created nor opened. No partial file is created (Req 3.9).
 */
export class StorageError extends Error {
  override readonly name = 'StorageError';
}

/**
 * Raised when an existing database file is corrupt or has an incomplete schema.
 * The offending file is always left untouched — never overwritten or deleted
 * (Req 3.10).
 */
export class IntegrityError extends Error {
  override readonly name = 'IntegrityError';
}

/** Result of a schema verification pass (Req 3.3, 3.10). */
export interface SchemaCheck {
  ok: boolean;
  problems: string[];
}

/**
 * The required tables and the columns each must expose for the schema to be
 * considered complete (Req 3.5–3.8 plus the `task_invocations` audit log for
 * Req 2.5 and the `last_language` Phase-1 extension column for Req 7.2).
 */
const REQUIRED_TABLES: Record<string, readonly string[]> = {
  private_journal: ['id', 'created_at', 'thought', 'mood', 'encryption_key_version'],
  human_relationships: [
    'id',
    'user_id',
    'full_name',
    'role',
    'affinity_score',
    'personality_notes',
    'last_language',
    'last_interaction',
  ],
  conversations: ['id', 'channel', 'user_id', 'created_at', 'last_message_at'],
  messages: ['id', 'conversation_id', 'sender_type', 'content', 'created_at'],
  task_invocations: ['id', 'invoked_at'],
  // Phase 2 (Req 1.4, 10.2, 10.4, 11.1, 11.3, 11.5): profile, durable inbound queue,
  // and idempotency/unsent-reply store — all additive to the Phase 1 schema.
  roza_profile: ['id', 'profile_json', 'updated_at'],
  inbound_queue: [
    'id',
    'channel',
    'external_id',
    'sender_id',
    'text',
    'thread_ref',
    'received_at',
    'seq',
  ],
  processed_messages: [
    'channel',
    'external_id',
    'answer_state',
    'reply_text',
    'answered_at',
    'sent_at',
  ],
};

/** Resolve the absolute path to the Roza_Mind_Database file under `dataDir`. */
export function resolveDbPath(dataDir: string): string {
  return path.join(dataDir, DB_FILE_NAME);
}

/**
 * Create the four canonical tables (Req 3.5–3.8) plus `task_invocations`
 * (Req 2.5) and the three additive Phase 2 tables — `roza_profile` (Req 1.4),
 * `inbound_queue` (Req 10.2–10.4), and `processed_messages` (Req 11.1, 11.3,
 * 11.5) — inside a single transaction so initialization is all-or-none: if any
 * statement fails, the whole batch rolls back and no partial schema remains
 * (Req 3.2). Every statement is an idempotent `CREATE TABLE/INDEX IF NOT
 * EXISTS`, so an existing Phase 1 database gains the Phase 2 tables without any
 * destructive migration. The DDL carries the CHECK constraints, indexes, and
 * the forward-compatible channel values from the design.
 */
export function initSchema(db: Database.Database): void {
  const create = db.transaction(() => {
    db.exec(`
      -- private_journal (Req 3.5, 4): thought stored ONLY as ciphertext envelope
      CREATE TABLE IF NOT EXISTS private_journal (
        id                     TEXT PRIMARY KEY,
        created_at             TEXT NOT NULL DEFAULT (datetime('now')),
        thought                TEXT NOT NULL,          -- 'keyVersion:ivHex:tagHex:cipherHex'
        mood                   TEXT,
        encryption_key_version TEXT NOT NULL
      );

      -- human_relationships (Req 3.6)
      CREATE TABLE IF NOT EXISTS human_relationships (
        id                TEXT PRIMARY KEY,
        user_id           TEXT NOT NULL,               -- references an Opays HQ user id (opaque)
        full_name         TEXT,
        role              TEXT,
        affinity_score    REAL DEFAULT 0.5 CHECK (affinity_score >= 0.0 AND affinity_score <= 1.0),
        personality_notes TEXT DEFAULT '{}',           -- JSON { notes, taughtTerms[] }
        last_language     TEXT,                         -- Phase-1 extension for Req 7.2
        last_interaction  TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_user ON human_relationships(user_id);

      -- conversations (Req 3.7, 9.1)
      CREATE TABLE IF NOT EXISTS conversations (
        id              TEXT PRIMARY KEY,
        channel         TEXT NOT NULL DEFAULT 'internal'
                        CHECK (channel IN ('telegram','email','voice','internal')),
        user_id         TEXT NOT NULL REFERENCES human_relationships(user_id),
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        last_message_at TEXT
      );

      -- messages (Req 3.8)
      CREATE TABLE IF NOT EXISTS messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_type     TEXT NOT NULL CHECK (sender_type IN ('user','roza')),
        content         TEXT NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_msg_conv_time ON messages(conversation_id, created_at DESC);

      -- task_invocations (Req 2.5): autonomous task audit trail
      CREATE TABLE IF NOT EXISTS task_invocations (
        id          TEXT PRIMARY KEY,
        invoked_at  TEXT NOT NULL                       -- timestamp in configured timezone
      );

      -- roza_profile (Req 1.3, 1.4, 2.2): single-row identity store, text-only (no credentials)
      CREATE TABLE IF NOT EXISTS roza_profile (
        id           INTEGER PRIMARY KEY CHECK (id = 1),  -- enforce a single row
        profile_json TEXT NOT NULL,                       -- validated RozaProfile JSON
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- inbound_queue (Req 10.2–10.4): durable defer store, drained FIFO on Active_Window entry
      CREATE TABLE IF NOT EXISTS inbound_queue (
        id          TEXT PRIMARY KEY,                     -- UUID
        channel     TEXT NOT NULL CHECK (channel IN ('telegram','email')),
        external_id TEXT NOT NULL,
        sender_id   TEXT NOT NULL,
        text        TEXT NOT NULL,
        thread_ref  TEXT,
        received_at TEXT NOT NULL,                         -- ISO-8601; primary FIFO key
        seq         INTEGER NOT NULL                       -- AUTOINCREMENT-like tiebreak for identical instants
      );
      CREATE INDEX IF NOT EXISTS idx_inbound_order ON inbound_queue(received_at, seq);

      -- processed_messages (Req 11): idempotency + unsent-reply retention, keyed by (channel, external_id)
      CREATE TABLE IF NOT EXISTS processed_messages (
        channel      TEXT NOT NULL CHECK (channel IN ('telegram','email')),
        external_id  TEXT NOT NULL,
        answer_state TEXT NOT NULL CHECK (answer_state IN ('answered_unsent','answered_sent')),
        reply_text   TEXT,                                 -- retained until successfully sent (Req 11.5)
        answered_at  TEXT NOT NULL,
        sent_at      TEXT,
        PRIMARY KEY (channel, external_id)                 -- one row per external message (Req 11.1–11.3)
      );
    `);
  });

  create();
}

/**
 * Verify an opened database is structurally sound: SQLite's own
 * `integrity_check` passes and every required table exists with every required
 * column present (Req 3.3, 3.10). Returns a result describing any problems
 * rather than throwing, so callers decide how to react.
 */
export function verifySchema(db: Database.Database): SchemaCheck {
  const problems: string[] = [];

  // 1. SQLite physical integrity check.
  const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  const verdict = integrity[0]?.integrity_check;
  if (verdict !== 'ok') {
    problems.push(`integrity_check returned "${verdict ?? 'no result'}"`);
    // A failed integrity check means the file is corrupt; column shape is moot.
    return { ok: false, problems };
  }

  // 2. Table + column shape presence.
  for (const [table, requiredColumns] of Object.entries(REQUIRED_TABLES)) {
    const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (columns.length === 0) {
      problems.push(`missing table "${table}"`);
      continue;
    }
    const present = new Set(columns.map((c) => c.name));
    for (const column of requiredColumns) {
      if (!present.has(column)) {
        problems.push(`table "${table}" is missing column "${column}"`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Ensure `dataDir` exists and is writable. Throws {@link StorageError} when the
 * directory is absent or not writable so that no partial database file is ever
 * created (Req 3.9). The directory is intentionally NOT auto-created: it is the
 * durable volume mount and its absence is a deployment fault, not something to
 * paper over.
 */
function ensureWritableDir(dataDir: string, dbPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dataDir);
  } catch {
    throw new StorageError(
      `data directory "${dataDir}" is absent; cannot create Roza_Mind_Database at "${dbPath}" (no file created)`
    );
  }

  if (!stat.isDirectory()) {
    throw new StorageError(
      `storage path "${dataDir}" exists but is not a directory; cannot create Roza_Mind_Database at "${dbPath}" (no file created)`
    );
  }

  try {
    fs.accessSync(dataDir, fs.constants.W_OK);
  } catch {
    throw new StorageError(
      `data directory "${dataDir}" is not writable; cannot create Roza_Mind_Database at "${dbPath}" (no file created)`
    );
  }
}

/**
 * Core, non-exiting open routine (testable variant of `initDatabaseOrExit`).
 *
 * Behavior:
 * - Absent/unwritable `data/`        → throws {@link StorageError}, no file created (Req 3.9).
 * - Existing valid file              → opened, schema verified, NOT re-initialized (Req 3.3).
 * - Existing corrupt/incomplete file → throws {@link IntegrityError}, file left untouched (Req 3.10).
 * - Absent file                      → created and schema initialized atomically (Req 3.1, 3.2).
 *
 * Always opens with WAL journaling and `foreign_keys = ON`. The connection is
 * isolated to this file and shares nothing with Opays HQ (Req 3.4).
 */
export function openDatabase(dataDir: string, keyVersion: string): Database.Database {
  const dbPath = resolveDbPath(dataDir);

  // Fail before touching disk if the directory cannot host the file (Req 3.9).
  ensureWritableDir(dataDir, dbPath);

  // Decide create-vs-open from whether the file is already present.
  const fileExisted = fs.existsSync(dbPath);

  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // If the handle was opened before a later step (e.g. a pragma) threw, close
    // it best-effort so we never leak a handle that locks the file on Windows.
    if (db !== undefined) {
      try {
        db.close();
      } catch {
        // Best-effort: a failed close must not mask the original error.
      }
    }
    if (fileExisted) {
      // An existing file we cannot even open is corrupt; leave it untouched (Req 3.10).
      throw new IntegrityError(
        `existing Roza_Mind_Database at "${dbPath}" could not be opened and was left untouched: ${message}`
      );
    }
    throw new StorageError(
      `unable to create Roza_Mind_Database at "${dbPath}": ${message}`
    );
  }

  if (fileExisted) {
    // Req 3.3 / 3.10: verify an existing file; never re-initialize it.
    let check: SchemaCheck;
    try {
      check = verifySchema(db);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      db.close();
      throw new IntegrityError(
        `existing Roza_Mind_Database at "${dbPath}" failed verification and was left untouched: ${message}`
      );
    }

    if (!check.ok) {
      db.close();
      throw new IntegrityError(
        `existing Roza_Mind_Database at "${dbPath}" is corrupt or has an incomplete schema ` +
          `(${check.problems.join('; ')}); file left untouched`
      );
    }

    return db; // valid, populated tables preserved without re-init (Req 3.3)
  }

  // Fresh file: initialize the schema atomically (Req 3.1, 3.2).
  try {
    initSchema(db);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.close();
    throw new Error(
      `schema initialization for "${dbPath}" failed and was rolled back (no partial schema): ${message}`
    );
  }

  console.log(
    `[db] Initialized new Roza_Mind_Database at "${dbPath}" (encryption key version ${keyVersion}).`
  );

  return db;
}

/**
 * Imperative startup wrapper (Req 3.1–3.3, 3.9, 3.10).
 *
 * Delegates to {@link openDatabase} and, on any failure, emits a descriptive
 * error log and terminates startup with a non-zero exit code. Storage failures
 * (Req 3.9) name the failing path and create no file; integrity failures
 * (Req 3.10) report the problem and leave the existing file untouched. On a
 * valid existing file it opens without re-initializing (Req 3.3).
 */
export function initDatabaseOrExit(dataDir: string, keyVersion: string): Database.Database {
  try {
    return openDatabase(dataDir, keyVersion);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`❌ [db] Database initialization failed: ${message}`);
    process.exit(1);
  }
}
