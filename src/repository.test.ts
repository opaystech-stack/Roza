import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import { openDatabase } from './db.js';
import { createRepository, type Repository } from './repository.js';
import type { Channel } from './types.js';

/**
 * Property-based tests for the repository (Component 4) over a real, isolated
 * `better-sqlite3` database created per test in a temp directory.
 *
 * Properties covered:
 *  - Property 9  — recent message retrieval is bounded and ordered (Req 6.2).
 *  - Property 18 — an unspecified channel defaults to `internal` (Req 9.1).
 *  - Property 19 — forward-compatible channels persist and round-trip (Req 9.2).
 *
 * Setup notes:
 *  - `conversations.user_id` has a foreign key to `human_relationships(user_id)`
 *    (and `foreign_keys = ON`), so every conversation is created against a
 *    relationship row inserted first.
 *  - fast-check runs many iterations against the single DB opened in
 *    `beforeEach`, so each iteration uses a fresh `randomUUID()` user id to
 *    avoid colliding with the unique index on `human_relationships(user_id)`.
 */

const NUM_RUNS = 100;

/** The four forward-compatible channel values from the schema CHECK constraint. */
const CHANNELS: readonly Channel[] = ['telegram', 'email', 'voice', 'internal'];

let tempDir: string;
let db: Database.Database;
let repo: Repository;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roza-repo-test-'));
  db = openDatabase(tempDir, 'v1');
  repo = createRepository(db, { secret: 'test-secret', keyVersion: 'v1' });
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Create a fresh relationship and return its (unique) user id. */
function freshUser(): string {
  const userId = randomUUID();
  repo.createRelationship({ userId });
  return userId;
}

/** ISO-8601 timestamp that increases strictly (and sorts lexicographically) with `index`. */
function timestampAt(index: number): string {
  // Base epoch + one minute per index keeps timestamps strictly increasing and
  // lexicographically ordered in the canonical ISO-8601 format SQLite compares.
  return new Date(Date.UTC(2024, 0, 1) + index * 60_000).toISOString();
}

describe('repository property-based tests', () => {
  // Feature: roza-agent, Property 9: Recent message retrieval is bounded and ordered — for any N messages added to a conversation and any limit L, getRecentMessages returns min(N, L) messages ordered by created_at DESC (most recent first).
  // Validates: Requirements 6.2
  it('Property 9: getRecentMessages returns min(N, L) messages, most-recent-first', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40 }), // N: number of messages added
        fc.integer({ min: 0, max: 40 }), // L: retrieval limit
        (n, limit) => {
          const userId = freshUser();
          const conv = repo.createConversation(userId, 'internal');

          // Add N messages with explicit, strictly increasing timestamps so the
          // DESC ordering is fully deterministic. Message at index i has the
          // i-th timestamp; index N-1 is therefore the most recent.
          const contentsByIndex: string[] = [];
          for (let i = 0; i < n; i++) {
            const content = `msg-${i}`;
            contentsByIndex.push(content);
            repo.addMessage({
              conversationId: conv.id,
              senderType: i % 2 === 0 ? 'user' : 'roza',
              content,
              createdAt: timestampAt(i),
            });
          }

          const result = repo.getRecentMessages(conv.id, limit);

          // Bounded: exactly min(N, L) rows are returned (Req 6.2).
          expect(result.length).toBe(Math.min(n, limit));

          // Ordered most-recent-first: the result is the tail of the inserted
          // messages reversed (indices N-1, N-2, ... down to N-min(N,L)).
          const expected = contentsByIndex
            .slice(n - Math.min(n, limit))
            .reverse();
          expect(result.map((m) => m.content)).toEqual(expected);

          // Ordering invariant: created_at is non-increasing across the result.
          for (let i = 1; i < result.length; i++) {
            expect(
              (result[i - 1] as { created_at: string }).created_at >=
                (result[i] as { created_at: string }).created_at
            ).toBe(true);
          }
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  // Feature: roza-agent, Property 18: Unspecified channel defaults to internal — createConversation(userId) with no channel arg yields a conversation whose channel === 'internal'.
  // Validates: Requirements 9.1
  it('Property 18: createConversation with no channel defaults to internal', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const userId = freshUser();
        const conv = repo.createConversation(userId);

        // Req 9.1: an unspecified channel defaults to `internal`, both on the
        // returned object and on the persisted row.
        expect(conv.channel).toBe('internal');

        const reread = repo.getOpenConversation(userId, 'internal');
        expect(reread).not.toBeNull();
        expect(reread?.channel).toBe('internal');
        expect(reread?.id).toBe(conv.id);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  // Feature: roza-agent, Property 19: Forward-compatible channels persist — for any channel in {'telegram','email','voice','internal'}, createConversation(userId, channel) persists and round-trips that exact channel value (re-read via getOpenConversation).
  // Validates: Requirements 9.2
  it('Property 19: any supported channel persists and round-trips', () => {
    fc.assert(
      fc.property(fc.constantFrom(...CHANNELS), (channel) => {
        const userId = freshUser();
        const conv = repo.createConversation(userId, channel);

        // The created conversation carries the exact requested channel (Req 9.2).
        expect(conv.channel).toBe(channel);

        // Re-reading the open conversation for that user+channel returns the
        // same persisted row with the same channel value.
        const reread = repo.getOpenConversation(userId, channel);
        expect(reread).not.toBeNull();
        expect(reread?.id).toBe(conv.id);
        expect(reread?.channel).toBe(channel);
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
