import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import { openDatabase } from './db.js';
import { createRepository, type Repository } from './repository.js';
import { CognitiveEngine } from './engine.js';
import { DEFAULT_PROFILE } from './profile.js';
import { userIdForVoice } from './connectors/sender.js';
import type { ChatMessage, LlmResult } from './llm.js';
import type { Logger } from './types.js';
import type { RozaConfig } from './config.js';

/**
 * Property-based + integration test for the Memory_Loop on the `voice` channel
 * (Phase 3). It runs the REAL `repository` + the unchanged `CognitiveEngine`
 * over an isolated `better-sqlite3` database created per test in a temp
 * directory, with a stubbed `llm` we fully control (no network). Voice is the
 * operative channel here (`cfg.voice.enabled = true`), and every user identity
 * is derived from a Caller_Identity via `userIdForVoice` exactly as the live
 * voice connector will (Req 14.3).
 *
 * Feature: roza-step3-voice-telephony, Property 10: Voice turns persist through the Memory_Loop
 *
 * For any random caller and arbitrary non-empty text:
 *  - a successful `handleMessage({ channel: 'voice', userId, text })` persists a
 *    `conversations` row on the `voice` channel for that user, holding BOTH a
 *    `user` and a `roza` message retrievable via `getRecentMessages`, with the
 *    relationship created (then reused) and `last_interaction` /
 *    `last_message_at` stamped to the response time (Req 5.3, 9.4, 14.3);
 *  - an engine/LLM failure writes NO partial exchange — the database state is
 *    byte-for-byte identical to before the call — and the result is
 *    `{ ok: false, reason: 'llm_failed' }` (Req 4.5);
 *  - a second voice turn for the same caller reuses the same relationship and
 *    the same voice conversation (create-then-reuse, Req 9.4).
 *
 * Validates: Requirements 4.5, 5.3, 9.4, 14.3
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roza-voice-persist-test-'));
  db = openDatabase(tempDir, 'v1');
  repo = createRepository(db, { secret: 'test-secret', keyVersion: 'v1' });
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Build a fully-resolved config with the `voice` channel ENABLED (so it is
 * operative) and a non-blank API key. Every other field is a structurally
 * complete default mirroring the fixtures in engine.test.ts / engine.voice.test.ts.
 */
function makeConfig(overrides?: Partial<RozaConfig>): RozaConfig {
  return {
    rozaPrivateKey: 'test-private-key',
    openRouterApiKey: 'test-api-key',
    openRouterModel: 'openai/gpt-4o-mini',
    dataDir: tempDir,
    timezone: 'Africa/Kinshasa',
    activeWindow: { startMinutes: 420, endMinutes: 1320 },
    keyVersion: 'v1',
    telegram: { enabled: false, botToken: '', allowlist: [] },
    mail: {
      enabled: false,
      imap: { host: '', port: 0, user: '', password: '' },
      smtp: { host: '', port: 0, user: '', password: '' },
      allowlist: [],
    },
    voice: {
      enabled: true,
      sip: { host: '', port: 0, user: '', password: '', realm: '' },
      allowlist: [],
      defaultAccess: 'reject',
      quietHoursInbound: 'take_message',
      tts: { engine: 'piper', voice: 'en_US-amy-medium', model: 'en_US-amy-medium' },
      stt: { engine: 'whisper.cpp', model: 'ggml-base.en' },
      maxReplyChars: 1000,
      latency: { ttsMs: 5000, sttMs: 5000, endToEndMs: 8000, ringTimeoutMs: 30000 },
    },
    avatar: {
      enabled: false,
      video: { width: 512, height: 512, fps: 25, pixelFormat: 'yuv420p' },
      latency: { renderMs: 4000 },
      renderer: { endpoint: '', engine: '' },
      devices: { camera: '', microphone: '' },
      meet: { enabled: false, consent: false, account: '', password: '' },
      stream: { enabled: false, url: '', key: '' },
    },
    x: {
      enabled: false,
      credentials: { username: '', password: '' },
      storageStatePath: '',
      autonomyIntervalMinutes: 60,
      rateLimit: { dailyPostLimit: 10, actionSpacingMs: 600000 },
      maxTopics: 3,
      maxPostChars: 280,
      dryRun: false,
    },
    ...overrides,
  };
}

/** A stub LLM that always succeeds, recording each prompt it was handed. */
function makeOkLlm(content = 'Roza voice reply'): { llm: LlmFn; calls: ChatMessage[][] } {
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

/**
 * Build a UNIQUE-per-iteration Caller_Identity. fast-check supplies the shape
 * (E.164 phone vs SIP URI) and some randomness; a monotonic counter guarantees
 * the normalized `userIdForVoice(...)` never collides across iterations on the
 * unique index on `human_relationships(user_id)`.
 */
let callerSeq = 0;
function freshCaller(kind: 'phone' | 'sip', seed: number): string {
  callerSeq += 1;
  const unique = `${callerSeq}${Math.abs(seed)}${Date.now()}`;
  if (kind === 'sip') {
    return `sip:user${unique}@voip.example.com`;
  }
  return `+${unique}`;
}

/** Serialize the full mutable database state for before/after comparison. */
function snapshot(): string {
  const messages = db.prepare('SELECT * FROM messages ORDER BY id').all();
  const conversations = db.prepare('SELECT * FROM conversations ORDER BY id').all();
  const relationships = db.prepare('SELECT * FROM human_relationships ORDER BY id').all();
  return JSON.stringify({ messages, conversations, relationships });
}

/** Count voice conversations belonging to a given user. */
function voiceConversationCount(userId: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM conversations WHERE user_id = ? AND channel = 'voice'",
      )
      .get(userId) as { c: number }
  ).c;
}

/** Non-whitespace text generator (so stored content is a meaningful substring). */
const textArb = fc
  .string({ minLength: 1, maxLength: 200 })
  .filter((s) => s.trim().length > 0);

/** Caller shape + a numeric seed for variety; uniqueness is enforced separately. */
const callerKindArb = fc.constantFrom<'phone' | 'sip'>('phone', 'sip');
const callerSeedArb = fc.integer({ min: 0, max: 1_000_000 });

describe('Voice Memory_Loop persistence (Property 10)', () => {
  // Feature: roza-step3-voice-telephony, Property 10: Voice turns persist through the Memory_Loop
  // Validates: Requirements 4.5, 5.3, 9.4, 14.3
  it('a successful voice turn persists both messages on the voice channel and reuses the relationship on the next turn', async () => {
    await fc.assert(
      fc.asyncProperty(
        callerKindArb,
        callerSeedArb,
        textArb,
        textArb,
        async (kind, seed, text1, text2) => {
          const caller = freshCaller(kind, seed);
          const userId = userIdForVoice(caller);
          const reply1 = `voice-reply-${randomUUID()}`;
          const { llm } = makeOkLlm(reply1);
          const engine = makeEngine(llm);

          // --- First voice turn: succeeds and must persist everything (Req 5.3, 9.4, 14.3).
          const res1 = await engine.handleMessage({ channel: 'voice', userId, text: text1 });
          expect(res1.ok).toBe(true);

          // Relationship was created and stamped (Req 9.4).
          const rel = repo.getRelationshipByUserId(userId);
          expect(rel).not.toBeNull();
          expect(rel?.last_interaction).toBe(FIXED_TS);

          // The conversation lives on the `voice` channel and was touched (Req 5.3, 9.4).
          const conv = repo.getOpenConversation(userId, 'voice');
          expect(conv).not.toBeNull();
          expect(conv?.channel).toBe('voice');
          expect(conv?.last_message_at).toBe(FIXED_TS);
          if (res1.ok) {
            expect(res1.conversationId).toBe(conv!.id);
          }
          expect(voiceConversationCount(userId)).toBe(1);

          // BOTH the user message and Roza's reply are retrievable (Req 5.3, 14.3).
          const stored = repo.getRecentMessages(conv!.id, 20);
          expect(stored.length).toBe(2);
          const userMsg = stored.find((m) => m.sender_type === 'user');
          const rozaMsg = stored.find((m) => m.sender_type === 'roza');
          expect(userMsg?.content).toBe(text1);
          expect(rozaMsg?.content).toBe(reply1);

          // --- Second voice turn for the SAME caller: create-then-reuse (Req 9.4).
          const res2 = await engine.handleMessage({ channel: 'voice', userId, text: text2 });
          expect(res2.ok).toBe(true);

          // Same relationship row reused (no duplicate created).
          const relAfter = repo.getRelationshipByUserId(userId);
          expect(relAfter?.id).toBe(rel?.id);

          // Same voice conversation reused; now four messages, all retrievable.
          expect(voiceConversationCount(userId)).toBe(1);
          const convAfter = repo.getOpenConversation(userId, 'voice');
          expect(convAfter?.id).toBe(conv?.id);
          const all = repo.getRecentMessages(conv!.id, 20);
          expect(all.length).toBe(4);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: roza-step3-voice-telephony, Property 10: Voice turns persist through the Memory_Loop
  // Validates: Requirements 4.5, 5.3, 9.4, 14.3
  it('an engine/LLM failure on a voice turn writes no partial exchange and returns llm_failed', async () => {
    await fc.assert(
      fc.asyncProperty(
        callerKindArb,
        callerSeedArb,
        fc.array(textArb, { minLength: 1, maxLength: 3 }),
        textArb,
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
        async (kind, seed, seedTexts, failingText, failReason) => {
          const caller = freshCaller(kind, seed);
          const userId = userIdForVoice(caller);

          // Seed prior successful voice turns so the relationship + voice
          // conversation already exist (the unchanged engine resolves those
          // before generation); the failure path must then write no partial
          // exchange and mutate no prior field.
          const okEngine = makeEngine(makeOkLlm('seeded voice reply').llm);
          for (const t of seedTexts) {
            const r = await okEngine.handleMessage({ channel: 'voice', userId, text: t });
            expect(r.ok).toBe(true);
          }

          const before = snapshot();

          // A failing generation must return llm_failed and mutate nothing.
          const { llm, calls } = makeFailLlm(failReason);
          const failEngine = makeEngine(llm);
          const res = await failEngine.handleMessage({
            channel: 'voice',
            userId,
            text: failingText,
          });

          expect(res).toEqual({ ok: false, reason: 'llm_failed' });
          expect(calls.length).toBe(1); // generation was attempted...
          expect(snapshot()).toBe(before); // ...but no partial exchange persisted (Req 4.5).
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
