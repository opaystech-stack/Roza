/**
 * Inbound queue + idempotency store tests (roza-step2-channels, Task 5.2).
 *
 * Property 9 (Req 10.3, 10.4): the durable inbound queue drains in receipt
 * order and survives a restart. We exercise a REAL {@link InboundQueueStore}
 * built by {@link createInboundQueueStore} over a genuine on-disk
 * `better-sqlite3` database (via {@link openDatabase} + {@link createRepository}
 * in a fresh temp directory), never a mock — so the FIFO ordering, the
 * transactional clear-on-drain, and the cross-restart durability are validated
 * against the actual SQLite tables the production code uses.
 *
 * Restart is simulated faithfully: messages are enqueued through one store,
 * the database handle is CLOSED, a NEW database handle + repository + store are
 * opened over the SAME file, and the drain is performed there. Nothing may be
 * lost and the receipt order must be preserved.
 *
 * The property runs a minimum of 100 fast-check iterations; each iteration uses
 * its own temp directory so no state leaks between runs. The idempotency-store
 * basics (Req 11) are exercised by a small companion example test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type Database from 'better-sqlite3';
import { openDatabase } from '../db.js';
import { createRepository, type Repository } from '../repository.js';
import { createInboundQueueStore } from './queue.js';
import type { InboundMessage, OperativeChannel } from './connector.js';

/** Minimum fast-check iterations mandated for the property tests. */
const NUM_RUNS = 100;

const KEY_VERSION = 'v1';
const SECRET = 'test-secret';

/** Temp dirs created during a test, removed best-effort in afterEach. */
let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roza-queue-test-'));
  tempDirs.push(dir);
  return dir;
}

// A default DB/repo for the non-property idempotency example test.
let defaultDir: string;
let defaultDb: Database.Database;
let defaultRepo: Repository;

beforeEach(() => {
  tempDirs = [];
  defaultDir = makeTempDir();
  defaultDb = openDatabase(defaultDir, KEY_VERSION);
  defaultRepo = createRepository(defaultDb, { secret: SECRET, keyVersion: KEY_VERSION });
});

afterEach(() => {
  try {
    defaultDb.close();
  } catch {
    // best-effort
  }
  for (const dir of tempDirs) {
    // On Windows a still-open SQLite handle can hold a lock on the directory,
    // so a removal failure here must not fail the test.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore — cleanup is best-effort.
    }
  }
  tempDirs = [];
});

/** Compare two messages on the fields the queue persists and replays. */
function expectSameMessage(actual: InboundMessage, expected: InboundMessage): void {
  expect(actual.channel).toBe(expected.channel);
  expect(actual.externalId).toBe(expected.externalId);
  expect(actual.senderId).toBe(expected.senderId);
  expect(actual.text).toBe(expected.text);
  expect(actual.receivedAt).toBe(expected.receivedAt);
  // The store omits threadRef entirely when the stored column is NULL, so
  // normalize both sides to a nullable value before comparing.
  expect(actual.threadRef ?? null).toBe(expected.threadRef ?? null);
}

describe('queue — Property 9: FIFO drain + restart durability (Task 5.2, Req 10.3, 10.4)', () => {
  // Feature: roza-step2-channels, Property 9: Inbound queue drains in receipt order and survives restart
  // Validates: Requirements 10.3, 10.4
  it('drains enqueued messages in receipt order after a simulated restart, losing nothing', async () => {
    const baseMs = Date.UTC(2024, 0, 1, 0, 0, 0);

    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            channel: fc.constantFrom<OperativeChannel>('telegram', 'email'),
            senderId: fc.string({ minLength: 1, maxLength: 24 }),
            text: fc.string({ minLength: 0, maxLength: 200 }),
            withThread: fc.boolean(),
            threadRef: fc.string({ minLength: 1, maxLength: 24 }),
          }),
          { minLength: 0, maxLength: 20 },
        ),
        async (raw) => {
          // Build the canonical message sequence: distinct externalId per item
          // and strictly-increasing ISO receivedAt so the expected FIFO order is
          // exactly the enqueue order (received_at is the primary ordering key).
          const messages: InboundMessage[] = raw.map((r, i) => {
            const msg: InboundMessage = {
              channel: r.channel,
              externalId: `ext-${i}`,
              senderId: r.senderId,
              text: r.text,
              receivedAt: new Date(baseMs + i * 1000).toISOString(),
            };
            if (r.withThread) {
              msg.threadRef = r.threadRef;
            }
            return msg;
          });

          // Each iteration gets its own on-disk database so restart semantics
          // are exercised in full isolation (no cross-iteration leakage).
          const dir = makeTempDir();

          // --- Process lifetime #1: enqueue everything, then "shut down". ---
          const db1 = openDatabase(dir, KEY_VERSION);
          try {
            const repo1 = createRepository(db1, { secret: SECRET, keyVersion: KEY_VERSION });
            const store1 = createInboundQueueStore(repo1);
            for (const msg of messages) {
              store1.enqueue(msg);
            }
          } finally {
            db1.close(); // simulate process exit: drop the handle entirely
          }

          // --- Process lifetime #2: NEW handle/repo/store over the SAME file. ---
          const db2 = openDatabase(dir, KEY_VERSION);
          try {
            const repo2 = createRepository(db2, { secret: SECRET, keyVersion: KEY_VERSION });
            const store2 = createInboundQueueStore(repo2);

            const drained = store2.dequeueInReceiptOrder();

            // Durability (Req 10.4): nothing was lost across the restart.
            expect(drained.length).toBe(messages.length);

            // Receipt order (Req 10.3): FIFO by received_at then insertion order.
            for (let i = 0; i < messages.length; i += 1) {
              const expected = messages[i];
              const actual = drained[i];
              expect(expected).toBeDefined();
              expect(actual).toBeDefined();
              if (expected && actual) {
                expectSameMessage(actual, expected);
              }
            }

            // The drain clears the queue: a second drain yields nothing.
            expect(store2.dequeueInReceiptOrder()).toEqual([]);
          } finally {
            db2.close();
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('queue — idempotency store basics (Task 5.2, supports Req 11)', () => {
  it('transitions none -> answered_unsent -> answered_sent and retains the reply', () => {
    const store = createInboundQueueStore(defaultRepo);

    // Initially unseen.
    expect(store.lookup('telegram', 'm-1')).toBe('none');
    expect(store.getStoredReply('telegram', 'm-1')).toBeNull();

    // Record a generated reply: retained as answered_unsent.
    store.recordAnswered('telegram', 'm-1', 'bonjour');
    expect(store.lookup('telegram', 'm-1')).toBe('answered_unsent');
    expect(store.getStoredReply('telegram', 'm-1')).toBe('bonjour');

    // Mark delivered: flips to answered_sent, reply still retained.
    store.markSent('telegram', 'm-1');
    expect(store.lookup('telegram', 'm-1')).toBe('answered_sent');

    // A different (channel, externalId) pair is independent.
    expect(store.lookup('email', 'm-1')).toBe('none');
  });
});
