/**
 * Phase 4 database schema tests (roza-step4-avatar-video, Task 7.2) —
 * Req 8.5, 11.4.
 *
 * Phase 4 adds ONE purely additive table to the proven Phase 1/2/3 schema:
 *   - avatar_sessions  (additive, audit-only Avatar_Session log for the
 *                       render/Meet/stream presence capability; idx_avatar_kind_time)
 *                       — Req 6.6, 7.4, 8.5, 9.1, 10.3
 *
 * The table is a credential-free audit log: it stores only an id, the session
 * kind, an optional target (a meet URL / RTMP ingest URL), the outcome, and
 * timestamps — and NEVER any credential value (no Meet_Credentials, no
 * Stream_Key) (Req 8.5).
 *
 * These tests live in a SEPARATE file from `src/db.test.ts` (Phase 1),
 * `src/db.phase2.test.ts` (Phase 2), and `src/db.phase3.test.ts` (Phase 3) so
 * the existing suites are left undisturbed. They exercise only the non-exiting
 * `openDatabase`/`initSchema`/`verifySchema` core (never `initDatabaseOrExit`,
 * which calls `process.exit`). Every test uses an isolated temp directory
 * created under the OS temp dir and removed in `afterEach`, so no state leaks
 * between runs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { initSchema, openDatabase, verifySchema } from './db.js';

const KEY_VERSION = 'v1';

/** The nine Phase 1/2/3 tables that Phase 4 must preserve untouched. */
const PRIOR_PHASE_TABLES = [
  'private_journal',
  'human_relationships',
  'conversations',
  'messages',
  'task_invocations',
  'roza_profile',
  'inbound_queue',
  'processed_messages',
  'call_sessions',
] as const;

/**
 * The exact, documented column set of the additive Phase 4 `avatar_sessions`
 * table (Req 8.5). This is the COMPLETE set — there is intentionally no
 * meet/stream credential, stream_key, password, token, or secret column
 * (Req 8.5).
 */
const AVATAR_SESSIONS_COLUMNS = [
  'id',
  'kind',
  'target',
  'outcome',
  'started_at',
  'ended_at',
] as const;

/** All ten tables a complete Phase 4 schema must contain. */
const ALL_TABLES = [...PRIOR_PHASE_TABLES, 'avatar_sessions'];

/**
 * Tables legitimately added by later phases as purely additive schema. These
 * are NOT required by a Phase 4 schema, but their presence must not trip this
 * guard's "no unexpected/rogue tables" check:
 *   - x_actions  (additive X (Twitter) autonomy audit table, roza-step5-x-twitter)
 */
const KNOWN_LATER_PHASE_TABLES = ['x_actions'] as const;

/**
 * Every table name this guard recognizes: the ten Phase 4 tables plus the known
 * additive later-phase tables. Any live table outside this set is treated as an
 * unexpected/rogue table and fails the guard.
 */
const KNOWN_TABLES = new Set<string>([...ALL_TABLES, ...KNOWN_LATER_PHASE_TABLES]);

/** Track temp dirs created during a test so afterEach can clean them all up. */
let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roza-db4-'));
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

/** Insert an avatar_sessions row, returning the prepared-statement runner. */
function insertAvatarSession(db: Database.Database) {
  return db.prepare(
    'INSERT INTO avatar_sessions (id, kind, target, outcome) VALUES (?, ?, ?, ?)'
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

describe('db.avatar — additive avatar_sessions schema (Task 7.2, Req 8.5)', () => {
  // Validates: Requirements 8.5, 11.4 — a fresh database carries avatar_sessions
  // in addition to the nine prior-phase tables, and nothing else.
  it('creates the avatar_sessions table alongside the nine prior-phase tables', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      const tables = listTables(db);
      for (const table of ALL_TABLES) {
        expect(tables.has(table), `${table} should exist`).toBe(true);
      }
      // No unexpected/rogue tables: every live table must be a table this guard
      // knows about (the ten Phase 4 tables, plus any purely additive
      // later-phase tables such as x_actions). A truly unexpected table fails.
      const unexpected = [...tables].filter((t) => !KNOWN_TABLES.has(t));
      expect(unexpected, `no unexpected tables, found: ${unexpected.join(', ')}`).toEqual([]);
    } finally {
      db.close();
    }
  });

  // Validates: Requirements 8.5 — avatar_sessions exposes its documented columns.
  it('creates avatar_sessions with the documented columns', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      const present = columnSet(db, 'avatar_sessions');
      for (const column of AVATAR_SESSIONS_COLUMNS) {
        expect(present.has(column), `avatar_sessions.${column} should exist`).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  // Validates: Requirements 8.5 — the per-kind, time-ordered index is present.
  it('creates the idx_avatar_kind_time index on avatar_sessions', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      expect(indexExists(db, 'idx_avatar_kind_time')).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('db.avatar — avatar_sessions is credential-free (Task 7.2, Req 8.5)', () => {
  // Validates: Requirements 8.5 — the avatar_sessions column set is EXACTLY the
  // six documented columns. No Meet_Credentials and no Stream_Key value is ever
  // stored, so there must be no meet/stream credential, stream_key, password,
  // secret, token, or credential column.
  it('declares exactly the six documented columns and no credential column', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      const present = columnSet(db, 'avatar_sessions');

      // The column set is exactly the documented six — no more, no fewer.
      expect(present).toEqual(new Set(AVATAR_SESSIONS_COLUMNS));
      expect(present.size).toBe(6);

      // Defense-in-depth: explicitly assert no credential-shaped column leaked in
      // (no meet/stream credential, no stream_key, no password/secret/token).
      const forbidden = /password|passwd|secret|token|credential|auth|stream_key|streamkey|key/i;
      const offending = [...present].filter((c) => forbidden.test(c));
      expect(
        offending,
        `no credential column should exist, found: ${offending.join(', ')}`
      ).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('db.avatar — avatar_sessions CHECK constraints (Task 7.2, Req 8.5)', () => {
  // Validates: Requirements 8.5 — kind is constrained to render/meet/stream and
  // a fully valid row inserts cleanly for each kind.
  it('enforces the kind CHECK constraint and accepts every documented kind', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      const insert = insertAvatarSession(db);

      // A render session has no external target.
      expect(() => insert.run(randomUUID(), 'render', null, 'in_progress')).not.toThrow();
      // A meet session carries a meet URL as its (non-credential) target.
      expect(() =>
        insert.run(randomUUID(), 'meet', 'https://meet.google.com/abc-defg-hij', 'presented')
      ).not.toThrow();
      // A stream session carries an RTMP ingest URL as its (non-credential) target.
      expect(() =>
        insert.run(randomUUID(), 'stream', 'rtmp://live.example/app', 'presented')
      ).not.toThrow();

      // kind outside ('render','meet','stream') violates the CHECK constraint.
      expect(() => insert.run(randomUUID(), 'broadcast', null, 'in_progress')).toThrow();
    } finally {
      db.close();
    }
  });

  // Validates: Requirements 8.5 — outcome is constrained to the documented audit
  // set; each documented value is accepted and an unknown value is rejected.
  it('enforces the outcome CHECK constraint and accepts every documented outcome', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      const insert = insertAvatarSession(db);
      const outcomes = [
        'in_progress',
        'presented',
        'audio_only_fallback',
        'failed',
        'stopped',
      ] as const;

      for (const outcome of outcomes) {
        expect(
          () => insert.run(randomUUID(), 'render', null, outcome),
          `outcome "${outcome}" should be accepted`
        ).not.toThrow();
      }

      // outcome outside the allowed set violates the CHECK constraint.
      expect(() => insert.run(randomUUID(), 'render', null, 'cancelled')).toThrow();
    } finally {
      db.close();
    }
  });
});

describe('db.avatar — prior-phase preservation across re-open (Task 7.2, Req 11.4)', () => {
  // Validates: Requirements 11.4 — opening an existing database that holds
  // seeded Phase 1/2/3 data preserves that data, gains avatar_sessions, and
  // still verifies as a complete Phase 4 schema. Because initSchema is
  // idempotent CREATE TABLE IF NOT EXISTS, re-opening the same file is the
  // realistic "upgrade an existing deployment" path.
  it('preserves seeded prior-phase rows across close and re-open via openDatabase', () => {
    const dir = makeTempDir();
    const userId = 'user-preserve-4';
    const fullName = 'Cofounder Four';

    // First startup: create the database and seed Phase 1/2/3 rows.
    const db1 = openDatabase(dir, KEY_VERSION);
    db1
      .prepare('INSERT INTO human_relationships (id, user_id, full_name) VALUES (?, ?, ?)')
      .run(randomUUID(), userId, fullName);
    db1
      .prepare('INSERT INTO roza_profile (id, profile_json) VALUES (?, ?)')
      .run(1, '{"displayName":"Roza"}');
    db1
      .prepare(
        'INSERT INTO call_sessions (id, user_id, direction, caller_identity, outcome) VALUES (?, ?, ?, ?, ?)'
      )
      .run(randomUUID(), userId, 'inbound', 'tel:+15550009999', 'completed');
    db1.close();

    // Second startup: re-open the existing valid file (never re-initialized for
    // existing data; avatar_sessions already present from the first init).
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

      const call = db2
        .prepare('SELECT outcome FROM call_sessions WHERE caller_identity = ?')
        .get('tel:+15550009999') as { outcome: string } | undefined;
      expect(call?.outcome).toBe('completed');

      // avatar_sessions is present and the schema verifies as complete.
      expect(listTables(db2).has('avatar_sessions')).toBe(true);
      expect(verifySchema(db2).ok).toBe(true);
    } finally {
      db2.close();
    }
  });

  // Validates: Requirements 11.4 — applying the Phase 4 schema to a database that
  // only has the Phase 1/2/3 tables is additive: it adds avatar_sessions without
  // touching existing data (the real "upgrade an existing deployment" path that
  // CREATE TABLE IF NOT EXISTS guarantees).
  it('adds avatar_sessions to a prior-phase-only database without losing data', () => {
    // Build a database that contains ONLY the Phase 1/2/3 tables, then seed a row.
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
        CREATE TABLE call_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
          caller_identity TEXT NOT NULL,
          outcome TEXT NOT NULL DEFAULT 'in_progress'
            CHECK (outcome IN ('in_progress','completed','rejected','no_answer','dropped','error')),
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          ended_at TEXT,
          turns INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_call_user_time ON call_sessions(user_id, started_at DESC);
      `);

      // Seed a prior-phase row before the Phase 4 upgrade.
      const userId = 'legacy-avatar-user';
      db.prepare('INSERT INTO human_relationships (id, user_id, full_name) VALUES (?, ?, ?)').run(
        randomUUID(),
        userId,
        'Legacy Cofounder'
      );

      // Pre-condition: avatar_sessions does not yet exist, so the schema is not
      // yet a complete Phase 4 schema.
      expect(
        listTables(db).has('avatar_sessions'),
        'avatar_sessions should be absent before upgrade'
      ).toBe(false);
      expect(verifySchema(db).ok, 'schema is incomplete before the Phase 4 upgrade').toBe(false);

      // Apply the additive Phase 4 schema.
      initSchema(db);

      // avatar_sessions (and its index) now exist...
      expect(
        listTables(db).has('avatar_sessions'),
        'avatar_sessions should exist after upgrade'
      ).toBe(true);
      expect(indexExists(db, 'idx_avatar_kind_time')).toBe(true);

      // ...and the seeded prior-phase row is untouched.
      const row = db
        .prepare('SELECT user_id, full_name FROM human_relationships WHERE user_id = ?')
        .get(userId) as { user_id: string; full_name: string } | undefined;
      expect(row).toBeDefined();
      expect(row?.full_name).toBe('Legacy Cofounder');

      // The schema now verifies as a complete Phase 4 schema.
      expect(verifySchema(db).ok).toBe(true);
    } finally {
      db.close();
    }
  });

  // Validates: Requirements 11.4 — initSchema is idempotent: re-running it on an
  // already-complete Phase 4 database neither loses data nor errors (CREATE
  // TABLE IF NOT EXISTS semantics).
  it('is idempotent — re-running initSchema preserves avatar_sessions data', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      const id = randomUUID();
      db.prepare(
        'INSERT INTO avatar_sessions (id, kind, target, outcome) VALUES (?, ?, ?, ?)'
      ).run(id, 'meet', 'https://meet.google.com/keep-this', 'presented');

      // Re-running the additive schema init must not throw or wipe data.
      expect(() => initSchema(db)).not.toThrow();

      const row = db
        .prepare('SELECT target, outcome FROM avatar_sessions WHERE id = ?')
        .get(id) as { target: string; outcome: string } | undefined;
      expect(row).toBeDefined();
      expect(row?.target).toBe('https://meet.google.com/keep-this');
      expect(row?.outcome).toBe('presented');
      expect(verifySchema(db).ok).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('db.avatar — verifySchema completeness (Task 7.2, Req 8.5, 11.4)', () => {
  // Validates: Requirements 8.5, 11.4 — verifySchema returns ok only when
  // avatar_sessions is present; a freshly opened DB satisfies this, and dropping
  // avatar_sessions makes it fail and names the missing table.
  it('returns ok:true on a fresh Phase 4 DB and ok:false when avatar_sessions is missing', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      // A freshly opened database has the complete Phase 4 schema.
      expect(verifySchema(db).ok).toBe(true);

      // Removing avatar_sessions makes verification fail and names it.
      db.exec('DROP TABLE avatar_sessions');
      const check = verifySchema(db);
      expect(check.ok).toBe(false);
      expect(check.problems.some((p) => p.includes('avatar_sessions'))).toBe(true);
    } finally {
      db.close();
    }
  });
});
