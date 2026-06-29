/**
 * Phase 3 database schema tests (roza-step3-voice-telephony, Task 8.2) —
 * Req 4.6, 7.5, 13.5.
 *
 * Phase 3 adds ONE purely additive table to the proven Phase 1/2 schema:
 *   - call_sessions  (additive, audit-only Call_Session log on the 'voice'
 *                     channel; idx_call_user_time)  — Req 4.6, 5.4, 7.5, 9.1
 *
 * The table is a credential-free audit log: it stores the Caller_Identity-derived
 * identifiers, direction, outcome, timestamps, and turn count — and NEVER any
 * SIP_Trunk_Credentials value (Req 7.5).
 *
 * These tests live in a SEPARATE file from `src/db.test.ts` (Phase 1) and
 * `src/db.phase2.test.ts` (Phase 2) so the existing suites are left undisturbed.
 * They exercise only the non-exiting `openDatabase`/`initSchema`/`verifySchema`
 * core (never `initDatabaseOrExit`, which calls `process.exit`). Every test uses
 * an isolated temp directory created under the OS temp dir and removed in
 * `afterEach`, so no state leaks between runs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { initSchema, openDatabase, verifySchema } from './db.js';

const KEY_VERSION = 'v1';

/** The eight Phase 1/2 tables that Phase 3 must preserve untouched. */
const PRIOR_PHASE_TABLES = [
  'private_journal',
  'human_relationships',
  'conversations',
  'messages',
  'task_invocations',
  'roza_profile',
  'inbound_queue',
  'processed_messages',
] as const;

/**
 * The exact, documented column set of the additive Phase 3 `call_sessions`
 * table (Req 4.6). This is the COMPLETE set — there is intentionally no SIP /
 * password / token / credential column (Req 7.5).
 */
const CALL_SESSIONS_COLUMNS = [
  'id',
  'user_id',
  'direction',
  'caller_identity',
  'outcome',
  'started_at',
  'ended_at',
  'turns',
] as const;

/** All nine tables a complete Phase 3 schema must contain. */
const ALL_TABLES = [...PRIOR_PHASE_TABLES, 'call_sessions'];

/** Track temp dirs created during a test so afterEach can clean them all up. */
let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roza-db3-'));
  tempDirs.push(dir);
  return dir;
}

/** List the user tables present in an open database. */
function listTables(db: Database.Database): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/** The set of column names declared on a table. */
function columnSet(db: Database.Database, table: string): Set<string> {
  const info = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return new Set(info.map((c) => c.name));
}

/** Does an index of the given name exist in the open database? */
function indexExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

/** Insert a call_sessions row, returning the prepared-statement runner. */
function insertCallSession(db: Database.Database) {
  return db.prepare(
    'INSERT INTO call_sessions (id, user_id, direction, caller_identity, outcome) VALUES (?, ?, ?, ?, ?)'
  );
}

beforeEach(() => {
  tempDirs = [];
});

afterEach(() => {
  for (const dir of tempDirs) {
    // Best-effort teardown: on Windows a still-open SQLite handle can hold a
    // lock on the directory, so a removal failure here must not fail the test.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore — cleanup is best-effort.
    }
  }
  tempDirs = [];
});

describe('db.phase3 — additive call_sessions schema (Task 8.2, Req 4.6)', () => {
  // Validates: Requirements 4.6 — a fresh database carries call_sessions in
  // addition to the eight prior-phase tables.
  it('creates the call_sessions table alongside the eight prior-phase tables', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      const tables = listTables(db);
      for (const table of ALL_TABLES) {
        expect(tables.has(table), `${table} should exist`).toBe(true);
      }
      // Every known prior-phase + Phase 3 table is present. A later phase may
      // add further additive tables, so we assert a floor, not an exact ceiling.
      expect(tables.size).toBeGreaterThanOrEqual(ALL_TABLES.length);
    } finally {
      db.close();
    }
  });

  // Validates: Requirements 4.6 — call_sessions exposes its documented columns.
  it('creates call_sessions with the documented columns', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      const present = columnSet(db, 'call_sessions');
      for (const column of CALL_SESSIONS_COLUMNS) {
        expect(present.has(column), `call_sessions.${column} should exist`).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  // Validates: Requirements 4.6 — the per-user, time-ordered index is present.
  it('creates the idx_call_user_time index on call_sessions', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      expect(indexExists(db, 'idx_call_user_time')).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('db.phase3 — call_sessions is credential-free (Task 8.2, Req 7.5)', () => {
  // Validates: Requirements 7.5 — the call_sessions column set is EXACTLY the
  // eight documented columns. No SIP_Trunk_Credentials value is ever stored, so
  // there must be no sip/password/secret/token/credential column.
  it('declares exactly the eight documented columns and no credential column', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      const present = columnSet(db, 'call_sessions');

      // The column set is exactly the documented eight — no more, no fewer.
      expect(present).toEqual(new Set(CALL_SESSIONS_COLUMNS));
      expect(present.size).toBe(8);

      // Defense-in-depth: explicitly assert no credential-shaped column leaked in.
      const forbidden = /sip|password|passwd|secret|token|credential|auth/i;
      const offending = [...present].filter((c) => forbidden.test(c));
      expect(offending, `no credential column should exist, found: ${offending.join(', ')}`).toEqual(
        []
      );
    } finally {
      db.close();
    }
  });
});

describe('db.phase3 — call_sessions CHECK constraints (Task 8.2, Req 4.6)', () => {
  // Validates: Requirements 4.6 — direction is constrained to inbound/outbound,
  // outcome to the allowed audit set, and a fully valid row inserts cleanly.
  it('enforces the direction and outcome CHECK constraints and accepts a valid row', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      const insert = insertCallSession(db);

      // A fully valid inbound row inserts cleanly.
      expect(() =>
        insert.run(randomUUID(), 'user-1', 'inbound', 'tel:+15550001111', 'completed')
      ).not.toThrow();

      // A valid outbound row inserts cleanly too.
      expect(() =>
        insert.run(randomUUID(), 'user-1', 'outbound', 'tel:+15550002222', 'in_progress')
      ).not.toThrow();

      // direction outside ('inbound','outbound') violates the CHECK constraint.
      expect(() =>
        insert.run(randomUUID(), 'user-1', 'sideways', 'tel:+15550003333', 'completed')
      ).toThrow();

      // outcome outside the allowed set violates the CHECK constraint.
      expect(() =>
        insert.run(randomUUID(), 'user-1', 'inbound', 'tel:+15550004444', 'voicemail')
      ).toThrow();
    } finally {
      db.close();
    }
  });

  // Validates: Requirements 4.6 — each documented outcome value is accepted.
  it('accepts every documented outcome value', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      const insert = insertCallSession(db);
      const outcomes = [
        'in_progress',
        'completed',
        'rejected',
        'no_answer',
        'dropped',
        'error',
      ] as const;

      for (const outcome of outcomes) {
        expect(() =>
          insert.run(randomUUID(), 'user-out', 'inbound', 'tel:+15550005555', outcome),
          `outcome "${outcome}" should be accepted`
        ).not.toThrow();
      }
    } finally {
      db.close();
    }
  });
});

describe('db.phase3 — prior-phase preservation across re-open (Task 8.2, Req 13.5)', () => {
  // Validates: Requirements 13.5 — opening an existing database that holds
  // seeded Phase 1/2 data preserves that data, gains call_sessions, and still
  // verifies as a complete Phase 3 schema. Because initSchema is idempotent
  // CREATE TABLE IF NOT EXISTS, re-opening the same file is the realistic
  // "upgrade an existing deployment" path.
  it('preserves seeded prior-phase rows across close and re-open via openDatabase', () => {
    const dir = makeTempDir();
    const userId = 'user-preserve-3';
    const fullName = 'Cofounder Three';

    // First startup: create the database and seed Phase 1 + Phase 2 rows.
    const db1 = openDatabase(dir, KEY_VERSION);
    db1
      .prepare('INSERT INTO human_relationships (id, user_id, full_name) VALUES (?, ?, ?)')
      .run(randomUUID(), userId, fullName);
    db1
      .prepare('INSERT INTO roza_profile (id, profile_json) VALUES (?, ?)')
      .run(1, '{"displayName":"Roza"}');
    db1
      .prepare(
        'INSERT INTO inbound_queue (id, channel, external_id, sender_id, text, received_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(randomUUID(), 'telegram', 'ext-keep', 'sender-keep', 'remember me', '2024-01-01T00:00:00Z', 1);
    db1.close();

    // Second startup: re-open the existing valid file (never re-initialized for
    // existing data; call_sessions already present from the first init).
    const db2 = openDatabase(dir, KEY_VERSION);
    try {
      const rel = db2
        .prepare('SELECT user_id, full_name FROM human_relationships WHERE user_id = ?')
        .get(userId) as { user_id: string; full_name: string } | undefined;
      expect(rel).toBeDefined();
      expect(rel?.full_name).toBe(fullName);

      const profile = db2
        .prepare('SELECT profile_json FROM roza_profile WHERE id = 1')
        .get() as { profile_json: string } | undefined;
      expect(profile?.profile_json).toBe('{"displayName":"Roza"}');

      const queued = db2
        .prepare('SELECT text FROM inbound_queue WHERE external_id = ?')
        .get('ext-keep') as { text: string } | undefined;
      expect(queued?.text).toBe('remember me');

      // call_sessions is present and the schema verifies as complete.
      expect(listTables(db2).has('call_sessions')).toBe(true);
      expect(verifySchema(db2).ok).toBe(true);
    } finally {
      db2.close();
    }
  });

  // Validates: Requirements 13.5 — applying the Phase 3 schema to a database
  // that only has the Phase 1/2 tables is additive: it adds call_sessions
  // without touching existing data (the real "upgrade an existing deployment"
  // path that CREATE TABLE IF NOT EXISTS guarantees).
  it('adds call_sessions to a prior-phase-only database without losing data', () => {
    // Build a database that contains ONLY the Phase 1/2 tables, then seed a row.
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      db.exec(`
        CREATE TABLE private_journal (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          thought TEXT NOT NULL,
          mood TEXT,
          encryption_key_version TEXT NOT NULL
        );
        CREATE TABLE human_relationships (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          full_name TEXT,
          role TEXT,
          affinity_score REAL DEFAULT 0.5 CHECK (affinity_score >= 0.0 AND affinity_score <= 1.0),
          personality_notes TEXT DEFAULT '{}',
          last_language TEXT,
          last_interaction TEXT
        );
        CREATE UNIQUE INDEX idx_hr_user ON human_relationships(user_id);
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL DEFAULT 'internal'
            CHECK (channel IN ('telegram','email','voice','internal')),
          user_id TEXT NOT NULL REFERENCES human_relationships(user_id),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_message_at TEXT
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          sender_type TEXT NOT NULL CHECK (sender_type IN ('user','roza')),
          content TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_msg_conv_time ON messages(conversation_id, created_at DESC);
        CREATE TABLE task_invocations (
          id TEXT PRIMARY KEY,
          invoked_at TEXT NOT NULL
        );
        CREATE TABLE roza_profile (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          profile_json TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE inbound_queue (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL CHECK (channel IN ('telegram','email')),
          external_id TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          text TEXT NOT NULL,
          thread_ref TEXT,
          received_at TEXT NOT NULL,
          seq INTEGER NOT NULL
        );
        CREATE INDEX idx_inbound_order ON inbound_queue(received_at, seq);
        CREATE TABLE processed_messages (
          channel TEXT NOT NULL CHECK (channel IN ('telegram','email')),
          external_id TEXT NOT NULL,
          answer_state TEXT NOT NULL CHECK (answer_state IN ('answered_unsent','answered_sent')),
          reply_text TEXT,
          answered_at TEXT NOT NULL,
          sent_at TEXT,
          PRIMARY KEY (channel, external_id)
        );
      `);

      // Seed a prior-phase row before the Phase 3 upgrade.
      const userId = 'legacy-voice-user';
      db.prepare('INSERT INTO human_relationships (id, user_id, full_name) VALUES (?, ?, ?)').run(
        randomUUID(),
        userId,
        'Legacy Cofounder'
      );

      // Pre-condition: call_sessions does not yet exist.
      expect(listTables(db).has('call_sessions'), 'call_sessions should be absent before upgrade').toBe(
        false
      );

      // Apply the additive Phase 3 schema.
      initSchema(db);

      // call_sessions (and its index) now exist...
      expect(listTables(db).has('call_sessions'), 'call_sessions should exist after upgrade').toBe(
        true
      );
      expect(indexExists(db, 'idx_call_user_time')).toBe(true);

      // ...and the seeded prior-phase row is untouched.
      const row = db
        .prepare('SELECT user_id, full_name FROM human_relationships WHERE user_id = ?')
        .get(userId) as { user_id: string; full_name: string } | undefined;
      expect(row).toBeDefined();
      expect(row?.full_name).toBe('Legacy Cofounder');

      // The schema now verifies as a complete Phase 3 schema.
      expect(verifySchema(db).ok).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('db.phase3 — verifySchema completeness (Task 8.2, Req 4.6, 13.5)', () => {
  // Validates: Requirements 4.6, 13.5 — verifySchema returns ok only when
  // call_sessions is present; a freshly opened DB satisfies this, and dropping
  // call_sessions makes it fail and names the missing table.
  it('returns ok:true on a fresh Phase 3 DB and ok:false when call_sessions is missing', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      // A freshly opened database has the complete Phase 3 schema.
      expect(verifySchema(db).ok).toBe(true);

      // Removing call_sessions makes verification fail and names it.
      db.exec('DROP TABLE call_sessions');
      const check = verifySchema(db);
      expect(check.ok).toBe(false);
      expect(check.problems.some((p) => p.includes('call_sessions'))).toBe(true);
    } finally {
      db.close();
    }
  });
});
