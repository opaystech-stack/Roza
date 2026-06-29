import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import { openDatabase } from './db.js';
import { createRepository, type Repository } from './repository.js';
import { CognitiveEngine, nextAffinity } from './engine.js';
import { extractTaughtTerms, type Lang } from './language.js';
import { MAX_PROMPT_TAUGHT_TERMS } from './prompt.js';
import { DEFAULT_PROFILE } from './profile.js';
import type { ChatMessage, LlmResult } from './llm.js';
import type { Channel, HumanRelationship, Logger } from './types.js';
import type { RozaConfig } from './config.js';

/**
 * Property-based + integration tests for the Cognitive Engine (Component 9) —
 * the Memory Loop — over a REAL, isolated `better-sqlite3` database created per
 * test in a temp directory, with a stubbed `llm` we fully control (no network).
 *
 * Properties covered:
 *  - Property 10 — Memory loop persists and re-retrieves (Req 6.1,6.4,6.5,6.7,6.8,6.9,8.3).
 *  - Property 11 — Generation failure preserves prior state (Req 5.7, 6.10).
 *  - Property 12 — Affinity score stays within bounds (Req 6.6).
 *  - Property 20 — Non-internal channels are not processed and cause no mutation (Req 9.3).
 *  - Task 13.6 — missing-key short-circuit and taught-term persistence edges (Req 5.2, 7.4).
 *
 * Setup notes:
 *  - `conversations.user_id` has a foreign key to `human_relationships(user_id)`;
 *    the engine creates the relationship itself before the conversation, so the
 *    FK is always satisfied on the success path.
 *  - fast-check runs many iterations against the single DB opened in
 *    `beforeEach`, so each iteration uses a fresh `randomUUID()`-suffixed user
 *    id to avoid colliding with the unique index on
 *    `human_relationships(user_id)`.
 */

const NUM_RUNS = 100;

/** A fixed clock so every persisted timestamp is deterministic and comparable. */
const FIXED_DATE = new Date('2024-06-01T12:00:00.000Z');
const FIXED_TS = FIXED_DATE.toISOString();
const now = (): Date => FIXED_DATE;

/** No-op logger: the engine must never need real logging to function. */
const logger: Logger = { info() {}, error() {} };

/** The signature the engine expects for its `llm` dependency (typeof chatCompletion). */
type LlmFn = (
  cfg: { apiKey: string; model: string },
  messages: ChatMessage[],
  opts?: { temperature?: number; timeoutMs?: number },
) => Promise<LlmResult>;

let tempDir: string;
let db: Database.Database;
let repo: Repository;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roza-engine-test-'));
  db = openDatabase(tempDir, 'v1');
  repo = createRepository(db, { secret: 'test-secret', keyVersion: 'v1' });
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Build a fully-resolved config with a non-blank API key by default. */
function makeConfig(overrides?: Partial<RozaConfig>): RozaConfig {
  return {
    rozaPrivateKey: 'test-private-key',
    openRouterApiKey: 'test-api-key',
    openRouterModel: 'openai/gpt-4o-mini',
    dataDir: tempDir,
    timezone: 'Africa/Kinshasa',
    activeWindow: { startMinutes: 420, endMinutes: 1320 },
    keyVersion: 'v1',
    // Phase 2 channels default to disabled (no credentials required).
    telegram: { enabled: false, botToken: '', allowlist: [] },
    mail: {
      enabled: false,
      imap: { host: '', port: 0, user: '', password: '' },
      smtp: { host: '', port: 0, user: '', password: '' },
      allowlist: [],
    },
    ...overrides,
  };
}

/** A stub LLM that always succeeds, recording each prompt it was handed. */
function makeOkLlm(content = 'Roza reply'): { llm: LlmFn; calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  const llm: LlmFn = (_cfg, messages) => {
    calls.push(messages);
    return Promise.resolve({ ok: true, content });
  };
  return { llm, calls };
}

/** A stub LLM that always fails, recording how many times it was invoked. */
function makeFailLlm(reason = 'network error'): { llm: LlmFn; calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  const llm: LlmFn = (_cfg, messages) => {
    calls.push(messages);
    return Promise.resolve({ ok: false, reason });
  };
  return { llm, calls };
}

/** Construct an engine over the shared repo with the supplied llm + config. */
function makeEngine(llm: LlmFn, cfg: RozaConfig = makeConfig()): CognitiveEngine {
  return new CognitiveEngine({ repo, llm, cfg, now, logger, profile: () => DEFAULT_PROFILE });
}

/** A unique user id per iteration (avoids the unique index on user_id). */
function freshUserId(seed: string): string {
  return `${seed}-${randomUUID()}`;
}

/** Serialize the full mutable database state for before/after comparison. */
function snapshot(): string {
  const messages = db.prepare('SELECT * FROM messages ORDER BY id').all();
  const conversations = db.prepare('SELECT * FROM conversations ORDER BY id').all();
  const relationships = db.prepare('SELECT * FROM human_relationships ORDER BY id').all();
  return JSON.stringify({ messages, conversations, relationships });
}

/** Count rows across the tables the engine could mutate. */
function rowCounts(): { messages: number; conversations: number; relationships: number } {
  const c = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  return {
    messages: c('messages'),
    conversations: c('conversations'),
    relationships: c('human_relationships'),
  };
}

/** Non-whitespace text generator (so stored content is a meaningful substring). */
const textArb = fc
  .string({ minLength: 1, maxLength: 200 })
  .filter((s) => s.trim().length > 0);

describe('CognitiveEngine property-based tests', () => {
  // Feature: roza-agent, Property 10: Memory loop persists and re-retrieves — for any user identifier and message, when the engine successfully generates a response, a relationship and conversation exist for that user, both the user message and Roza's response are stored as retrievable messages, last_interaction and last_message_at equal the response time, and a subsequent retrieval returns the newly persisted entries.
  // Validates: Requirements 6.1, 6.4, 6.5, 6.7, 6.8, 6.9, 8.3
  it('Property 10: a successful turn persists memory and is re-retrieved on the next turn', async () => {
    await fc.assert(
      fc.asyncProperty(textArb, textArb, async (text1, text2) => {
        const userId = freshUserId('mem');
        const reply1 = `reply-${randomUUID()}`;
        const { llm, calls } = makeOkLlm(reply1);
        const engine = makeEngine(llm);

        // --- First turn: succeeds and must persist everything (Req 6.1,6.4,6.7,6.8,6.9).
        const res1 = await engine.handleMessage({ userId, channel: 'internal', text: text1 });
        expect(res1.ok).toBe(true);

        // Relationship was created and stamped (Req 6.1, 6.5, 6.8).
        const rel = repo.getRelationshipByUserId(userId);
        expect(rel).not.toBeNull();
        expect(rel?.last_interaction).toBe(FIXED_TS);
        expect(rel?.last_language === 'fr' || rel?.last_language === 'en').toBe(true);

        // Conversation exists and was touched to the response time (Req 6.7, 6.9).
        const conv = repo.getOpenConversation(userId, 'internal');
        expect(conv).not.toBeNull();
        expect(conv?.last_message_at).toBe(FIXED_TS);

        // Both the user message and Roza's reply are retrievable (Req 6.4, 8.3).
        const stored = repo.getRecentMessages(conv!.id, 20);
        expect(stored.length).toBe(2);
        const userMsg = stored.find((m) => m.sender_type === 'user');
        const rozaMsg = stored.find((m) => m.sender_type === 'roza');
        expect(userMsg?.content).toBe(text1);
        expect(rozaMsg?.content).toBe(reply1);

        // --- Second turn: the engine must retrieve the prior history (Req 6.2, 6.3).
        const res2 = await engine.handleMessage({ userId, channel: 'internal', text: text2 });
        expect(res2.ok).toBe(true);

        // The prompt built for the 2nd turn carries the prior turn's content.
        const secondPrompt = calls[1];
        expect(secondPrompt).toBeDefined();
        const systemContent = secondPrompt![0]!.content;
        expect(systemContent.includes(text1)).toBe(true);
        expect(systemContent.includes(reply1)).toBe(true);

        // And the database now holds all four messages (two turns), retrievable.
        const all = repo.getRecentMessages(conv!.id, 20);
        expect(all.length).toBe(4);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: roza-agent, Property 11: Generation failure preserves prior state — for any pre-existing database state and any user message, when the OpenRouter request fails, times out, or returns an error, the engine returns an error result and the database state after handling is identical to the state before handling (no message stored, no relationship or conversation field mutated).
  // Validates: Requirements 5.7, 6.10
  it('Property 11: an LLM failure returns llm_failed and mutates no prior state', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(textArb, { minLength: 1, maxLength: 3 }),
        textArb,
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
        async (seedTexts, failingText, failReason) => {
          const userId = freshUserId('fail');

          // Seed a non-trivial pre-existing state with successful turns so the
          // relationship + conversation already exist (the failure path must not
          // create or mutate them).
          const okEngine = makeEngine(makeOkLlm('seeded reply').llm);
          for (const t of seedTexts) {
            const r = await okEngine.handleMessage({ userId, channel: 'internal', text: t });
            expect(r.ok).toBe(true);
          }

          const before = snapshot();

          // Now a failing generation must return an error and mutate nothing.
          const { llm, calls } = makeFailLlm(failReason);
          const failEngine = makeEngine(llm);
          const res = await failEngine.handleMessage({
            userId,
            channel: 'internal',
            text: failingText,
          });

          expect(res).toEqual({ ok: false, reason: 'llm_failed' });
          expect(calls.length).toBe(1); // generation was attempted...
          expect(snapshot()).toBe(before); // ...but nothing was persisted (Req 5.7, 6.10).
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: roza-agent, Property 12: Affinity score stays within bounds — for any sequence of successfully handled messages for a user, the relationship's affinity_score always remains within the inclusive range 0.0 to 1.0.
  // Validates: Requirements 6.6
  it('Property 12 (nextAffinity): result is always within [0.0, 1.0] for any prior value', () => {
    const affinityArb = fc.oneof(
      fc.double({ min: -1000, max: 1000, noNaN: false }),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.5, 1.5),
    );
    const langArb = fc.constantFrom<Lang | null>('fr', 'en', null);

    fc.assert(
      fc.property(
        affinityArb,
        langArb,
        fc.double({ min: 0, max: 1, noNaN: true }),
        (affinity, lang, confidence) => {
          const rel: HumanRelationship = {
            id: randomUUID(),
            user_id: randomUUID(),
            full_name: null,
            role: null,
            affinity_score: affinity,
            personality_notes: '{}',
            last_language: null,
            last_interaction: null,
          };
          const next = nextAffinity(rel, { lang, confidence });
          expect(Number.isFinite(next)).toBe(true);
          expect(next).toBeGreaterThanOrEqual(0);
          expect(next).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: roza-agent, Property 12: Affinity score stays within bounds — for any sequence of successfully handled messages for a user, the relationship's affinity_score always remains within the inclusive range 0.0 to 1.0.
  // Validates: Requirements 6.6
  it('Property 12 (handleMessage): persisted affinity_score stays within [0.0, 1.0] across many turns', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 12 }),
        fc.array(textArb, { minLength: 1, maxLength: 12 }),
        async (turns, texts) => {
          const userId = freshUserId('aff');
          const engine = makeEngine(makeOkLlm('ok').llm);

          for (let i = 0; i < turns; i++) {
            const text = texts[i % texts.length]!;
            const res = await engine.handleMessage({ userId, channel: 'internal', text });
            expect(res.ok).toBe(true);

            const rel = repo.getRelationshipByUserId(userId);
            expect(rel).not.toBeNull();
            expect(rel!.affinity_score).toBeGreaterThanOrEqual(0);
            expect(rel!.affinity_score).toBeLessThanOrEqual(1);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: roza-agent, Property 20: Non-internal channels are not processed and cause no mutation — for any non-internal channel and any pre-existing database state, handleMessage returns a channel_not_operative error, invokes no LLM call, and leaves the database state unchanged.
  // Validates: Requirements 9.3
  it('Property 20: a non-internal channel returns channel_not_operative and mutates nothing', async () => {
    const nonInternal = fc.constantFrom<Channel>('telegram', 'email', 'voice');

    await fc.assert(
      fc.asyncProperty(
        nonInternal,
        textArb,
        fc.boolean(),
        async (channel, text, seedFirst) => {
          const { llm, calls } = makeOkLlm('ok');
          const engine = makeEngine(llm);

          // Optionally establish pre-existing state on the operative channel so
          // we prove a non-internal request leaves existing memory untouched.
          if (seedFirst) {
            const r = await engine.handleMessage({
              userId: freshUserId('seed'),
              channel: 'internal',
              text: 'hello seed',
            });
            expect(r.ok).toBe(true);
          }

          const callsBefore = calls.length;
          const before = snapshot();

          const res = await engine.handleMessage({
            userId: freshUserId('skip'),
            channel,
            text,
          });

          // Rejected without processing (Req 9.3).
          expect(res).toEqual({ ok: false, reason: 'channel_not_operative' });
          // No LLM call was made for the non-internal request.
          expect(calls.length).toBe(callsBefore);
          // No new rows, no field mutated.
          expect(snapshot()).toBe(before);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('CognitiveEngine integration edges (task 13.6)', () => {
  // Task 13.6(a): a missing/empty OPENROUTER_API_KEY short-circuits before any
  // network call or memory mutation (Req 5.2).
  it('returns config_missing without calling the LLM or mutating history when the API key is blank', async () => {
    for (const blankKey of ['', '   ', '\t\n']) {
      const { llm, calls } = makeOkLlm('should not be used');
      const engine = makeEngine(llm, makeConfig({ openRouterApiKey: blankKey }));

      const before = rowCounts();
      const res = await engine.handleMessage({
        userId: `cfg-${randomUUID()}`,
        channel: 'internal',
        text: 'are you there?',
      });

      expect(res).toEqual({ ok: false, reason: 'config_missing' });
      expect(calls.length).toBe(0); // LLM never invoked.
      expect(rowCounts()).toEqual(before); // No relationship/conversation/message created.
    }
  });

  // Task 13.6(b): a teach instruction is persisted into personality_notes on a
  // successful reply, while a non-teach message leaves prior notes unchanged
  // (Req 7.4). Forcing an internal serialization failure is impractical, so we
  // assert the happy path and the no-op path.
  it('persists a taught term on a teach instruction and leaves notes unchanged otherwise', async () => {
    const engine = makeEngine(makeOkLlm('Asante! Got it.').llm);
    const userId = `teach-${randomUUID()}`;

    // 1) Teach instruction → term recorded in personality_notes after the reply.
    const taughtRes = await engine.handleMessage({
      userId,
      channel: 'internal',
      text: 'teach me asante means thank you',
    });
    expect(taughtRes.ok).toBe(true);

    const afterTeach = repo.getRelationshipByUserId(userId);
    expect(afterTeach).not.toBeNull();
    const terms = extractTaughtTerms(afterTeach!.personality_notes, MAX_PROMPT_TAUGHT_TERMS);
    expect(terms.length).toBe(1);
    expect(terms[0]!.term).toBe('asante');
    expect(terms[0]!.meaning).toBe('thank you');

    // 2) A non-teach follow-up must not change the recorded taught terms.
    const notesBefore = repo.getRelationshipByUserId(userId)!.personality_notes;
    const plainRes = await engine.handleMessage({
      userId,
      channel: 'internal',
      text: 'how is the project going today?',
    });
    expect(plainRes.ok).toBe(true);

    const afterPlain = repo.getRelationshipByUserId(userId)!;
    expect(afterPlain.personality_notes).toBe(notesBefore);
    const termsAfter = extractTaughtTerms(afterPlain.personality_notes, MAX_PROMPT_TAUGHT_TERMS);
    expect(termsAfter.length).toBe(1);
    expect(termsAfter[0]!.term).toBe('asante');
  });
});
