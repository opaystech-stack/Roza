/**
 * Database initialization tests (Component 4) — Req 3.1–3.10.
 *
 * Covers three tasks against `src/db.ts`:
 *   - 6.2 (integration): schema creation, column/constraint shapes, atomicity.
 *   - 6.3 (Property 17): an existing valid database is preserved on re-open.
 *   - 6.4 (integration): storage (absent dir) and corruption failure modes.
 *
 * All tests exercise the non-exiting `openDatabase`/`initSchema`/`verifySchema`
 * core — never `initDatabaseOrExit`, which calls `process.exit`. Every test
 * uses an isolated temp directory created under the OS temp dir and removed in
 * `afterEach`, so no state leaks between runs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  IntegrityError,
  StorageError,
  initSchema,
  openDatabase,
  resolveDbPath,
  verifySchema,
} from './db.js';

const KEY_VERSION = 'v1';

/** Required tables and the columns each must expose (mirrors the design DDL). */
const EXPECTED_COLUMNS: Record<string, readonly string[]> = {
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
};

const ALL_TABLES = Object.keys(EXPECTED_COLUMNS);

/** Track temp dirs created during a test so afterEach can clean them all up. */
let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roza-db-'));
  tempDirs.push(dir);
  return dir;
}

/** A path under the OS temp dir that is guaranteed not to exist yet. */
function absentDirPath(): string {
  const dir = path.join(os.tmpdir(), `roza-absent-${randomUUID()}`);
  // Register for cleanup in case a (buggy) implementation were to create it.
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

beforeEach(() => {
  tempDirs = [];
});

afterEach(() => {
  for (const dir of tempDirs) {
    // Best-effort teardown: on Windows a still-open SQLite handle (e.g. after a
    // failed open of a corrupt file) can hold a lock on the directory, so a
    // removal failure here must not fail the test. The OS temp dir is reclaimed
    // by the platform regardless.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore — cleanup is best-effort.
    }
  }
  tempDirs = [];
});

describe('db.ts — schema creation and atomicity (Task 6.2)', () => {
  // Validates: Requirements 3.1, 3.2, 3.5, 3.6, 3.7, 3.8
  it('creates the four canonical tables plus task_invocations on a fresh data dir', () => {
    const dir = makeTempDir();
    const dbPath = resolveDbPath(dir);

    // No database file exists before opening (no tables can exist).
    expect(fs.existsSync(dbPath)).toBe(false);

    const db = openDatabase(dir, KEY_VERSION);
    try {
      const tables = listTables(db);
      for (const table of ALL_TABLES) {
        expect(tables.has(table)).toBe(true);
      }
      // Schema verification considers the fresh database structurally sound.
      const check = verifySchema(db);
      expect(check.ok).toBe(true);
      expect(check.problems).toEqual([]);
    } finally {
      db.close();
    }
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  // Validates: Requirements 3.5, 3.6, 3.7, 3.8
  it('creates each table with the column shape described in the design', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      for (const [table, expectedColumns] of Object.entries(EXPECTED_COLUMNS)) {
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

  // Validates: Requirements 3.6, 3.7, 3.8 (CHECK constraints are enforced)
  it('enforces CHECK constraints on channel, sender_type, and affinity_score', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir, KEY_VERSION);
    try {
      const userId = 'user-checks';
      // A relationship is needed to satisfy the conversations.user_id FK.
      db.prepare('INSERT INTO human_relationships (id, user_id) VALUES (?, ?)').run(
        randomUUID(),
        userId
      );

      // affinity_score must stay within [0, 1].
      expect(() =>
        db
          .prepare('INSERT INTO human_relationships (id, user_id, affinity_score) VALUES (?, ?, ?)')
          .run(randomUUID(), 'user-over', 1.5)
      ).toThrow();

      // A valid channel is accepted.
      const okConvId = randomUUID();
      expect(() =>
        db
          .prepare('INSERT INTO conversations (id, channel, user_id) VALUES (?, ?, ?)')
          .run(okConvId, 'internal', userId)
      ).not.toThrow();

      // An invalid channel value is rejected by the CHECK constraint.
      expect(() =>
        db
          .prepare('INSERT INTO conversations (id, channel, user_id) VALUES (?, ?, ?)')
          .run(randomUUID(), 'carrier-pigeon', userId)
      ).toThrow();

      // An invalid sender_type is rejected by the CHECK constraint.
      expect(() =>
        db
          .prepare(
            'INSERT INTO messages (id, conversation_id, sender_type, content) VALUES (?, ?, ?, ?)'
          )
          .run(randomUUID(), okConvId, 'martian', 'hello')
      ).toThrow();

      // A valid sender_type is accepted.
      expect(() =>
        db
          .prepare(
            'INSERT INTO messages (id, conversation_id, sender_type, content) VALUES (?, ?, ?, ?)'
          )
          .run(randomUUID(), okConvId, 'roza', 'hello')
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  // Validates: Requirements 3.2 (initSchema is all-or-none — a mid-batch
  // failure rolls back so no partial schema remains).
  it('rolls back the whole schema when a statement in initSchema fails', () => {
    const db = new Database(':memory:');
    try {
      // Pre-create an object whose name collides with the `idx_hr_user` index
      // that initSchema creates. In SQLite tables and indexes share a
      // namespace, so the `CREATE UNIQUE INDEX ... idx_hr_user` statement will
      // fail mid-batch — after some CREATE TABLE statements have run.
      db.exec('CREATE TABLE idx_hr_user (x)');

      expect(() => initSchema(db)).toThrow();

      // Because initSchema runs inside a single transaction, the failure rolls
      // back every table it had created — none of the canonical tables remain.
      const tables = listTables(db);
      for (const table of ALL_TABLES) {
        expect(tables.has(table), `${table} should have been rolled back`).toBe(false);
      }
    } finally {
      db.close();
    }
  });
});

describe('db.ts — Property 17: existing valid database is preserved on open (Task 6.3)', () => {
  // Feature: roza-agent, Property 17: Existing valid database is preserved on open —
  // for any set of rows seeded into a valid existing roza_mind.sqlite, opening the
  // database on a subsequent startup preserves every row without re-initializing or
  // truncating any table.
  // Validates: Requirements 3.3
  it('preserves every populated table across close and re-open without re-initializing', () => {
    const modelArb = fc.record({
      users: fc.array(
        fc.record({
          fullName: fc.string({ maxLength: 40 }),
          channel: fc.constantFrom('internal', 'telegram', 'email', 'voice'),
          messages: fc.array(
            fc.record({
              sender: fc.constantFrom('user', 'roza'),
              content: fc.string({ minLength: 1, maxLength: 120 }),
            }),
            { maxLength: 5 }
          ),
        }),
        { maxLength: 4 }
      ),
      journal: fc.array(
        fc.record({
          thought: fc.string({ minLength: 1, maxLength: 80 }),
          mood: fc.option(fc.string({ maxLength: 16 }), { nil: null }),
        }),
        { maxLength: 4 }
      ),
      tasks: fc.array(fc.string({ minLength: 1, maxLength: 24 }), { maxLength: 4 }),
    });

    fc.assert(
      fc.property(modelArb, (model) => {
        const dir = makeTempDir();
        try {
          // --- First startup: create + seed -----------------------------------
          const db1 = openDatabase(dir, KEY_VERSION);

          // Deterministic ids keep the seed collision-free regardless of inputs.
          const expected = {
            relationships: model.users.length,
            conversations: model.users.length,
            messages: 0,
            private_journal: model.journal.length,
            task_invocations: model.tasks.length,
          };
          // Capture content we will re-verify after re-open.
          const messageContents: string[] = [];
          const journalThoughts: string[] = [];

          const insertRel = db1.prepare(
            'INSERT INTO human_relationships (id, user_id, full_name) VALUES (?, ?, ?)'
          );
          const insertConv = db1.prepare(
            'INSERT INTO conversations (id, channel, user_id) VALUES (?, ?, ?)'
          );
          const insertMsg = db1.prepare(
            'INSERT INTO messages (id, conversation_id, sender_type, content) VALUES (?, ?, ?, ?)'
          );
          const insertJournal = db1.prepare(
            'INSERT INTO private_journal (id, thought, mood, encryption_key_version) VALUES (?, ?, ?, ?)'
          );
          const insertTask = db1.prepare(
            'INSERT INTO task_invocations (id, invoked_at) VALUES (?, ?)'
          );

          model.users.forEach((user, i) => {
            const userId = `user-${i}`;
            insertRel.run(randomUUID(), userId, user.fullName);
            const convId = randomUUID();
            insertConv.run(convId, user.channel, userId);
            for (const msg of user.messages) {
              insertMsg.run(randomUUID(), convId, msg.sender, msg.content);
              messageContents.push(msg.content);
              expected.messages += 1;
            }
          });
          for (const entry of model.journal) {
            insertJournal.run(randomUUID(), entry.thought, entry.mood, KEY_VERSION);
            journalThoughts.push(entry.thought);
          }
          model.tasks.forEach((invokedAt, i) => {
            insertTask.run(randomUUID(), `${invokedAt}-${i}`);
          });

          db1.close();

          // --- Second startup: re-open the existing valid file -----------------
          const db2 = openDatabase(dir, KEY_VERSION);
          try {
            // The existing file must be treated as valid, not re-initialized.
            expect(verifySchema(db2).ok).toBe(true);

            const count = (table: string): number =>
              (db2.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

            expect(count('human_relationships')).toBe(expected.relationships);
            expect(count('conversations')).toBe(expected.conversations);
            expect(count('messages')).toBe(expected.messages);
            expect(count('private_journal')).toBe(expected.private_journal);
            expect(count('task_invocations')).toBe(expected.task_invocations);

            // Content survives intact (sorted comparison; order is irrelevant).
            const msgs = (
              db2.prepare('SELECT content FROM messages').all() as Array<{ content: string }>
            ).map((r) => r.content);
            expect(msgs.sort()).toEqual([...messageContents].sort());

            const thoughts = (
              db2.prepare('SELECT thought FROM private_journal').all() as Array<{ thought: string }>
            ).map((r) => r.thought);
            expect(thoughts.sort()).toEqual([...journalThoughts].sort());
          } finally {
            db2.close();
          }
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 }
    );
  });
});

describe('db.ts — storage and corruption failure modes (Task 6.4)', () => {
  // Validates: Requirements 3.9 (absent data dir → StorageError, no file created)
  it('throws StorageError and creates no file when the data dir is absent', () => {
    const dir = absentDirPath();
    expect(fs.existsSync(dir)).toBe(false);

    expect(() => openDatabase(dir, KEY_VERSION)).toThrow(StorageError);

    // Neither the directory nor the database file was created.
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(resolveDbPath(dir))).toBe(false);
  });

  // Validates: Requirements 3.10 (corrupt existing file → IntegrityError, file left untouched)
  it('throws IntegrityError and leaves a corrupt file byte-for-byte untouched', () => {
    const dir = makeTempDir();
    const dbPath = resolveDbPath(dir);

    // Write garbage bytes that are definitely not a valid SQLite database
    // (the SQLite header magic is "SQLite format 3\0").
    const garbage = Buffer.from(
      'this is not a sqlite database — just raw garbage bytes 0123456789 ABCDEF',
      'utf8'
    );
    fs.writeFileSync(dbPath, garbage);
    const before = fs.readFileSync(dbPath);

    expect(() => openDatabase(dir, KEY_VERSION)).toThrow(IntegrityError);

    // The offending file is preserved exactly — never overwritten or deleted.
    expect(fs.existsSync(dbPath)).toBe(true);
    const after = fs.readFileSync(dbPath);
    expect(after.equals(before)).toBe(true);
  });
});
