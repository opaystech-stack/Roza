/**
 * Phase 5 database schema tests (roza-step5-x-twitter, Task 5.2) —
 * Req 10.3, 12.2.
 *
 * Phase 5 adds ONE purely additive table to the proven Phase 1/2/3/4 schema:
 *   - x_actions  (additive, audit-only X_Action log for the autonomous
 *                 X / Twitter presence capability; idx_x_actions_time,
 *                 idx_x_actions_reply_ref) — Req 6.4, 8.2, 8.4, 10.1, 10.2, 10.3, 7.5
 *
 * The table is a credential-free, session-state-free audit log: it stores only
 * an id, the action type ('post' | 'reply'), the posted content, an optional
 * Mention dedupe ref, and a timestamp — and NEVER any X_Credentials value and
 * NEVER any X_Session_State content (Req 7.5, 10.3).
 *
 * These tests live in a SEPARATE file from the Phase 1/2/3/4 suites so the
 * existing suites are left undisturbed. They exercise only the non-exiting
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

/** The ten Phase 1/2/3/4 tables that Phase 5 must preserve untouched. */
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
  'avatar_sessions',
] as const;

/**
 * The exact, documented column set of the additive Phase 5 `x_actions` table
 * (Req 10.3). This is the COMPLETE set — there is intentionally NO
 * X_Credentials column and NO X_Session_State column (no password, secret,
 * token, credential, session, cookie, or storage column) (Req 7.5, 10.3).
 */
const X_ACTIONS_COLUMNS = ['id', 'action_type', 'content', 'mention_ref', 'created_at'] as const;

/** All eleven tables a complete Phase 5 schema must contain. */
const ALL_TABLES = [...PRIOR_PHASE_TABLES, 'x_actions'];

/** Track temp dirs created during a test so afterEach can clean them all up. */
let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roza-db5-'));
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

/** Insert an x_actions row, returning the prepared-statement runner. */
function insertXAction(db: Database.Database) {
  return db.prepare(
    'INSERT INTO x_actions (id, action_type, content, mention_ref, created_at) VALUES (?, ?, ?, ?, ?)'
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

describe('db.x — additive x_actions schema (Task 5.2, Req 10.3)', () => {
  // Validates: Requirements 10.3, 12.2 — a fresh database carries x_actions in
  // addition to the ten prior-phase tables, and nothing else.
  it('creates the x_actions table alongside the ten prior-phase tables', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      const tables = listTables(db);
      for (const table of ALL_TABLES) {
        expect(tables.has(table), `${table} should exist`).toBe(true);
      }
      // Exactly the eleven known tables — no more, no fewer.
      expect(tables.size).toBe(ALL_TABLES.length);
    } finally {
      db.close();
    }
  });

  // Validates: Requirements 10.3 — x_actions exposes its documented columns.
  it('creates x_actions with the documented columns', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      const present = columnSet(db, 'x_actions');
      for (const column of X_ACTIONS_COLUMNS) {
        expect(present.has(column), `x_actions.${column} should exist`).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  // Validates: Requirements 10.3 — the time-ordered and reply-dedupe indexes are present.
  it('creates the idx_x_actions_time and idx_x_actions_reply_ref indexes on x_actions', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      expect(indexExists(db, 'idx_x_actions_time')).toBe(true);
      expect(indexExists(db, 'idx_x_actions_reply_ref')).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('db.x — x_actions action_type CHECK constraint (Task 5.2, Req 10.3)', () => {
  // Validates: Requirements 10.3 — action_type is constrained to ('post','reply')
  // and a fully valid row inserts cleanly for each documented type.
  it('enforces the action_type CHECK IN (post, reply) and accepts every documented type', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      const insert = insertXAction(db);
      const now = new Date().toISOString();

      // A 'post' is an autonomous Roza_Post with no mention ref.
      expect(() => insert.run(randomUUID(), 'post', 'A thought on autonomy.', null, now)).not.toThrow();
      // A 'reply' carries the Mention dedupe ref it answers.
      expect(() =>
        insert.run(randomUUID(), 'reply', 'Thanks for the question.', 'mention-123', now)
      ).not.toThrow();

      // action_type outside ('post','reply') violates the CHECK constraint.
      expect(() => insert.run(randomUUID(), 'retweet', 'nope', null, now)).toThrow();
      expect(() => insert.run(randomUUID(), 'like', 'nope', null, now)).toThrow();
    } finally {
      db.close();
    }
  });
});

describe('db.x — x_actions is credential- and session-state-free (Task 5.2, Req 7.5, 10.3)', () => {
  // Validates: Requirements 10.3, 12.2 — the x_actions column set is EXACTLY the
  // five documented columns. No X_Credentials and no X_Session_State content is
  // ever stored, so there must be no password/secret/token/credential/session/
  // cookie/storage column (defense-in-depth over the column names).
  it('declares exactly the five documented columns and no credential/session-state column', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      const present = columnSet(db, 'x_actions');

      // The column set is exactly the documented five — no more, no fewer.
      expect(present).toEqual(new Set(X_ACTIONS_COLUMNS));
      expect(present.size).toBe(5);

      // Defense-in-depth: explicitly assert no credential- or session-state-shaped
      // column leaked in (no X_Credentials, no X_Session_State).
      const forbidden = /password|passwd|secret|token|credential|session|cookie|storage/i;
      const offending = [...present].filter((c) => forbidden.test(c));
      expect(
        offending,
        `no credential or session-state column should exist, found: ${offending.join(', ')}`
      ).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('db.x — prior-phase preservation across re-open (Task 5.2, Req 12.2)', () => {
  // Validates: Requirements 12.2 — opening an existing database that holds seeded
  // Phase 1/2/3/4 data preserves that data, gains x_actions, and still verifies
  // as a complete Phase 5 schema. Because initSchema is idempotent CREATE TABLE
  // IF NOT EXISTS, re-opening the same file is the realistic "upgrade an existing
  // deployment" path.
  it('preserves seeded prior-phase rows across close and re-open via openDatabase', () => {
    const dir = makeTempDir();
    const userId = 'user-preserve-5';
    const fullName = 'Cofounder Five';

    // First startup: create the database and seed Phase 1/2/3/4 rows.
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
    db1
      .prepare('INSERT INTO avatar_sessions (id, kind, target, outcome) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), 'meet', 'https://meet.google.com/keep-this', 'presented');
    db1.close();

    // Second startup: re-open the existing valid file (never re-initialized for
    // existing data; x_actions already present from the first init).
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

      const avatar = db2
        .prepare('SELECT outcome FROM avatar_sessions WHERE target = ?')
        .get('https://meet.google.com/keep-this') as { outcome: string } | undefined;
      expect(avatar?.outcome).toBe('presented');

      // x_actions is present and the schema verifies as complete.
      expect(listTables(db2).has('x_actions')).toBe(true);
      expect(verifySchema(db2).ok).toBe(true);
    } finally {
      db2.close();
    }
  });

  // Validates: Requirements 12.2 — applying the Phase 5 schema to a database that
  // only has the Phase 1/2/3/4 tables is additive: it adds x_actions without
  // touching existing data (the real "upgrade an existing deployment" path that
  // CREATE TABLE IF NOT EXISTS guarantees).
  it('adds x_actions to a prior-phase-only database without losing data', () => {
    // Build a database that contains ONLY the Phase 1/2/3/4 tables, then seed a row.
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
        CREATE TABLE avatar_sessions (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('render','meet','stream')),
          target TEXT,
          outcome TEXT NOT NULL DEFAULT 'in_progress'
            CHECK (outcome IN ('in_progress','presented','audio_only_fallback','failed','stopped')),
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          ended_at TEXT
        );
        CREATE INDEX idx_avatar_kind_time ON avatar_sessions(kind, started_at DESC);
      `);

      // Seed a prior-phase row before the Phase 5 upgrade.
      const userId = 'legacy-x-user';
      db.prepare('INSERT INTO human_relationships (id, user_id, full_name) VALUES (?, ?, ?)').run(
        randomUUID(),
        userId,
        'Legacy Cofounder'
      );

      // Pre-condition: x_actions does not yet exist, so the schema is not yet a
      // complete Phase 5 schema.
      expect(
        listTables(db).has('x_actions'),
        'x_actions should be absent before upgrade'
      ).toBe(false);
      expect(verifySchema(db).ok, 'schema is incomplete before the Phase 5 upgrade').toBe(false);

      // Apply the additive Phase 5 schema.
      initSchema(db);

      // x_actions (and its indexes) now exist...
      expect(listTables(db).has('x_actions'), 'x_actions should exist after upgrade').toBe(true);
      expect(indexExists(db, 'idx_x_actions_time')).toBe(true);
      expect(indexExists(db, 'idx_x_actions_reply_ref')).toBe(true);

      // ...and the seeded prior-phase row is untouched.
      const row = db
        .prepare('SELECT user_id, full_name FROM human_relationships WHERE user_id = ?')
        .get(userId) as { user_id: string; full_name: string } | undefined;
      expect(row).toBeDefined();
      expect(row?.full_name).toBe('Legacy Cofounder');

      // The schema now verifies as a complete Phase 5 schema.
      expect(verifySchema(db).ok).toBe(true);
    } finally {
      db.close();
    }
  });

  // Validates: Requirements 12.2 — initSchema is idempotent: re-running it on an
  // already-complete Phase 5 database neither loses data nor errors (CREATE
  // TABLE IF NOT EXISTS semantics).
  it('is idempotent — re-running initSchema preserves x_actions data', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      const id = randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO x_actions (id, action_type, content, mention_ref, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(id, 'reply', 'keep this reply', 'mention-keep', now);

      // Re-running the additive schema init must not throw or wipe data.
      expect(() => initSchema(db)).not.toThrow();

      const row = db
        .prepare('SELECT action_type, content, mention_ref FROM x_actions WHERE id = ?')
        .get(id) as { action_type: string; content: string; mention_ref: string } | undefined;
      expect(row).toBeDefined();
      expect(row?.action_type).toBe('reply');
      expect(row?.content).toBe('keep this reply');
      expect(row?.mention_ref).toBe('mention-keep');
      expect(verifySchema(db).ok).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('db.x — verifySchema completeness (Task 5.2, Req 10.3, 12.2)', () => {
  // Validates: Requirements 10.3, 12.2 — verifySchema returns ok only when
  // x_actions is present; a freshly opened DB satisfies this, and dropping
  // x_actions makes it fail and names the missing table.
  it('returns ok:true on a fresh Phase 5 DB and ok:false when x_actions is missing', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      // A freshly opened database has the complete Phase 5 schema.
      expect(verifySchema(db).ok).toBe(true);

      // Removing x_actions makes verification fail and names it.
      db.exec('DROP TABLE x_actions');
      const check = verifySchema(db);
      expect(check.ok).toBe(false);
      expect(check.problems.some((p) => p.includes('x_actions'))).toBe(true);
    } finally {
      db.close();
    }
  });
});
