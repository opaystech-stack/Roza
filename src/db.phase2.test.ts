/**
 * Phase 2 database schema tests (roza-step2-channels, Task 2.2) — Req 1.4, 15.6.
 *
 * Phase 2 adds three purely additive tables to the proven Phase 1 schema:
 *   - roza_profile        (single-row identity store; CHECK id = 1)        — Req 1.4
 *   - inbound_queue       (durable FIFO defer store; idx_inbound_order)    — Req 10.2–10.4
 *   - processed_messages  (idempotency + unsent-reply store; PK channel,external_id) — Req 11
 *
 * These tests live in a SEPARATE file from the Phase 1 `src/db.test.ts` so the
 * existing suite is left undisturbed. They exercise only the non-exiting
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

/** The five Phase 1 tables that Phase 2 must preserve untouched. */
const PHASE1_TABLES = [
  'private_journal',
  'human_relationships',
  'conversations',
  'messages',
  'task_invocations',
] as const;

/** The three new Phase 2 tables and the columns each must expose (Req 1.4). */
const PHASE2_COLUMNS: Record<string, readonly string[]> = {
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
  processed_messages: ['channel', 'external_id', 'answer_state', 'reply_text', 'answered_at', 'sent_at'],
};

/** All eight tables a complete Phase 2 schema must contain. */
const ALL_TABLES = [...PHASE1_TABLES, ...Object.keys(PHASE2_COLUMNS)];

/** Track temp dirs created during a test so afterEach can clean them all up. */
let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roza-db2-'));
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

/** Does an index of the given name exist in the open database? */
function indexExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
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

describe('db.phase2 — additive schema creation (Task 2.2, Req 1.4)', () => {
  // Validates: Requirements 1.4 — a fresh database carries the three Phase 2
  // tables in addition to the five Phase 1 tables.
  it('creates the three Phase 2 tables alongside the five Phase 1 tables', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      const tables = listTables(db);
      for (const table of ALL_TABLES) {
        expect(tables.has(table), `${table} should exist`).toBe(true);
      }
      // Exactly the eight known tables — no more, no fewer.
      expect(tables.size).toBe(ALL_TABLES.length);
    } finally {
      db.close();
    }
  });

  // Validates: Requirements 1.4 — each Phase 2 table exposes its documented columns.
  it('creates each Phase 2 table with its documented columns', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      for (const [table, expectedColumns] of Object.entries(PHASE2_COLUMNS)) {
        const info = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
        const present = new Set(info.map((c) => c.name));
        for (const column of expectedColumns) {
          expect(present.has(column), `${table}.${column} should exist`).toBe(true);
        }
      }
    } finally {
      db.close();
    }
  });

  // Validates: Requirements 1.4 — the FIFO ordering index is present.
  it('creates the idx_inbound_order index on inbound_queue', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      expect(indexExists(db, 'idx_inbound_order')).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('db.phase2 — Phase 2 CHECK constraints and keys (Task 2.2, Req 1.4)', () => {
  // Validates: Requirements 1.4 — roza_profile is a single-row store (CHECK id = 1).
  it('roza_profile accepts id = 1 and rejects any other id', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      // The canonical single row (id = 1) is accepted.
      expect(() =>
        db
          .prepare('INSERT INTO roza_profile (id, profile_json) VALUES (?, ?)')
          .run(1, '{"displayName":"Roza"}')
      ).not.toThrow();

      // Any other id violates CHECK (id = 1) and is rejected.
      expect(() =>
        db
          .prepare('INSERT INTO roza_profile (id, profile_json) VALUES (?, ?)')
          .run(2, '{"displayName":"Imposter"}')
      ).toThrow();
    } finally {
      db.close();
    }
  });

  // Validates: Requirements 1.4 — inbound_queue.channel is constrained to operative channels.
  it('inbound_queue accepts telegram/email and rejects any other channel', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      const insert = db.prepare(
        'INSERT INTO inbound_queue (id, channel, external_id, sender_id, text, received_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );

      // Both operative channels are accepted.
      expect(() =>
        insert.run(randomUUID(), 'telegram', 'ext-1', 'sender-1', 'hello', '2024-01-01T00:00:00Z', 1)
      ).not.toThrow();
      expect(() =>
        insert.run(randomUUID(), 'email', 'ext-2', 'sender-2', 'hello', '2024-01-01T00:00:01Z', 2)
      ).not.toThrow();

      // A non-operative channel violates the CHECK constraint.
      expect(() =>
        insert.run(randomUUID(), 'voice', 'ext-3', 'sender-3', 'hello', '2024-01-01T00:00:02Z', 3)
      ).toThrow();
    } finally {
      db.close();
    }
  });

  // Validates: Requirements 1.4 — processed_messages.answer_state is constrained,
  // and (channel, external_id) is the primary key (duplicates rejected).
  it('processed_messages enforces answer_state values and the (channel, external_id) primary key', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      const insert = db.prepare(
        'INSERT INTO processed_messages (channel, external_id, answer_state, answered_at) VALUES (?, ?, ?, ?)'
      );

      // Both documented answer states are accepted.
      expect(() =>
        insert.run('telegram', 'msg-1', 'answered_unsent', '2024-01-01T00:00:00Z')
      ).not.toThrow();
      expect(() =>
        insert.run('email', 'msg-2', 'answered_sent', '2024-01-01T00:00:01Z')
      ).not.toThrow();

      // An unknown answer_state violates the CHECK constraint.
      expect(() =>
        insert.run('telegram', 'msg-3', 'pending', '2024-01-01T00:00:02Z')
      ).toThrow();

      // A duplicate (channel, external_id) violates the composite primary key.
      expect(() =>
        insert.run('telegram', 'msg-1', 'answered_sent', '2024-01-01T00:00:03Z')
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

describe('db.phase2 — Phase 1 preservation across re-open (Task 2.2, Req 15.6)', () => {
  // Validates: Requirements 15.6 — opening an existing database with seeded
  // Phase 1 data preserves that data and still verifies as complete.
  it('preserves a seeded Phase 1 row across close and re-open via openDatabase', () => {
    const dir = makeTempDir();
    const userId = 'user-preserve';
    const fullName = 'Cofounder One';

    // First startup: create the database and seed a Phase 1 row.
    const db1 = openDatabase(dir, KEY_VERSION);
    db1
      .prepare('INSERT INTO human_relationships (id, user_id, full_name) VALUES (?, ?, ?)')
      .run(randomUUID(), userId, fullName);
    db1.close();

    // Second startup: re-open the existing valid file (never re-initialized).
    const db2 = openDatabase(dir, KEY_VERSION);
    try {
      const row = db2
        .prepare('SELECT user_id, full_name FROM human_relationships WHERE user_id = ?')
        .get(userId) as { user_id: string; full_name: string } | undefined;

      expect(row).toBeDefined();
      expect(row?.user_id).toBe(userId);
      expect(row?.full_name).toBe(fullName);

      // The additive CREATE TABLE IF NOT EXISTS did not disturb the schema.
      expect(verifySchema(db2).ok).toBe(true);
    } finally {
      db2.close();
    }
  });

  // Validates: Requirements 15.6 — applying the Phase 2 schema to a database
  // that only has Phase 1 tables is additive: it adds the new tables without
  // touching existing Phase 1 data (the real "upgrade an existing deployment"
  // path that CREATE TABLE IF NOT EXISTS guarantees).
  it('adds the Phase 2 tables to a Phase-1-only database without losing data', () => {
    // Build a database that contains ONLY the Phase 1 tables, then seed a row.
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
      `);

      // Seed a Phase 1 row before the Phase 2 upgrade.
      const userId = 'legacy-user';
      db.prepare('INSERT INTO human_relationships (id, user_id, full_name) VALUES (?, ?, ?)').run(
        randomUUID(),
        userId,
        'Legacy Cofounder'
      );

      // Pre-condition: the Phase 2 tables do not yet exist.
      let tables = listTables(db);
      for (const table of Object.keys(PHASE2_COLUMNS)) {
        expect(tables.has(table), `${table} should be absent before the upgrade`).toBe(false);
      }

      // Apply the additive Phase 2 schema.
      initSchema(db);

      // The three Phase 2 tables now exist...
      tables = listTables(db);
      for (const table of Object.keys(PHASE2_COLUMNS)) {
        expect(tables.has(table), `${table} should exist after the upgrade`).toBe(true);
      }
      expect(indexExists(db, 'idx_inbound_order')).toBe(true);

      // ...and the seeded Phase 1 row is untouched.
      const row = db
        .prepare('SELECT user_id, full_name FROM human_relationships WHERE user_id = ?')
        .get(userId) as { user_id: string; full_name: string } | undefined;
      expect(row).toBeDefined();
      expect(row?.full_name).toBe('Legacy Cofounder');

      // The schema now verifies as a complete Phase 2 schema.
      expect(verifySchema(db).ok).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('db.phase2 — verifySchema completeness (Task 2.2, Req 1.4)', () => {
  // Validates: Requirements 1.4 — verifySchema returns ok only when all eight
  // tables are present; a freshly opened DB satisfies this, and dropping a
  // Phase 2 table makes it fail.
  it('returns ok:true on a fresh DB and ok:false when a Phase 2 table is missing', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      // A freshly opened database has all eight tables.
      expect(verifySchema(db).ok).toBe(true);

      // Removing one Phase 2 table makes verification fail and names it.
      db.exec('DROP TABLE processed_messages');
      const check = verifySchema(db);
      expect(check.ok).toBe(false);
      expect(check.problems.some((p) => p.includes('processed_messages'))).toBe(true);
    } finally {
      db.close();
    }
  });
});
