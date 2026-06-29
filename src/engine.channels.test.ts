import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import { openDatabase } from './db.js';
import { createRepository, type Repository } from './repository.js';
import { CognitiveEngine, operativeChannels, decideChannel } from './engine.js';
import { DEFAULT_PROFILE } from './profile.js';
import type { ChatMessage, LlmResult } from './llm.js';
import type { Channel, Logger } from './types.js';
import type { RozaConfig } from './config.js';

/**
 * Property-based test for the engine's operative-channel decision and its
 * non-mutating rejection of non-operative channels (Phase 2).
 *
 * Feature: roza-step2-channels, Property 2: Engine operative-channel decision and
 * rejection are total and non-mutating — for any configuration (every combination
 * of telegram.enabled and mail.enabled) and any pre-existing database state:
 * `internal` is always operative; `telegram` is operative iff enabled; `email` is
 * operative iff enabled; `voice` is never operative. When handleMessage is called
 * on a non-operative channel it returns channel_not_operative, performs no LLM
 * call, and leaves the database byte-for-byte unchanged.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.5, 15.1, 15.3
 *
 * The pure half (operativeChannels / decideChannel) is exercised across all four
 * enablement combinations with no I/O. The engine half runs against a REAL,
 * isolated `better-sqlite3` database created per test in a temp directory, with a
 * stubbed `llm` we fully control (no network). A non-blank OPENROUTER_API_KEY is
 * supplied so any rejection is attributable to the channel, not config.
 */

const NUM_RUNS = 100;

/** A fixed clock so the engine never depends on wall-clock time. */
const FIXED_DATE = new Date('2024-06-01T12:00:00.000Z');
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roza-channels-test-'));
  db = openDatabase(tempDir, 'v1');
  repo = createRepository(db, { secret: 'test-secret', keyVersion: 'v1' });
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Build a fully-resolved config, mirroring engine.test.ts's `makeConfig`. Phase 2
 * channels default to disabled; callers override `.enabled` per case. The API key
 * is non-blank by default so a rejection is due to the channel, not config.
 */
function makeConfig(overrides?: {
  telegramEnabled?: boolean;
  mailEnabled?: boolean;
}): RozaConfig {
  return {
    rozaPrivateKey: 'test-private-key',
    openRouterApiKey: 'test-api-key',
    openRouterModel: 'openai/gpt-4o-mini',
    dataDir: tempDir,
    timezone: 'Africa/Kinshasa',
    activeWindow: { startMinutes: 420, endMinutes: 1320 },
    keyVersion: 'v1',
    telegram: {
      enabled: overrides?.telegramEnabled ?? false,
      botToken: overrides?.telegramEnabled ? 'test-bot-token' : '',
      allowlist: [],
    },
    mail: {
      enabled: overrides?.mailEnabled ?? false,
      imap: { host: '', port: 0, user: '', password: '' },
      smtp: { host: '', port: 0, user: '', password: '' },
      allowlist: [],
    },
    voice: {
      enabled: false,
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

/** Construct an engine over the shared repo with the supplied llm + config. */
function makeEngine(llm: LlmFn, cfg: RozaConfig): CognitiveEngine {
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

/** Non-whitespace text generator (so any stored content would be meaningful). */
const textArb = fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0);

const ALL_CHANNELS: Channel[] = ['internal', 'telegram', 'email', 'voice'];

describe('Engine operative-channel decision and non-mutation (Property 2)', () => {
  // Feature: roza-step2-channels, Property 2: Engine operative-channel decision and rejection are total and non-mutating
  // Validates: Requirements 5.1, 5.2, 5.3, 5.5, 15.1, 15.3
  it('operativeChannels/decideChannel are total over every enablement combination', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (telegramEnabled, mailEnabled) => {
        const cfg = makeConfig({ telegramEnabled, mailEnabled });
        const operative = operativeChannels(cfg);

        // `internal` is always operative (Req 5.5, 15.1).
        expect(operative.has('internal')).toBe(true);
        // `telegram`/`email` are operative iff enabled (Req 5.1).
        expect(operative.has('telegram')).toBe(telegramEnabled);
        expect(operative.has('email')).toBe(mailEnabled);
        // `voice` is never operative in Phase 2 (Req 15.3).
        expect(operative.has('voice')).toBe(false);

        // decideChannel agrees with the operative set for every channel, and is
        // total: it returns a verdict for each (Req 5.2, 5.3, 15.3).
        for (const channel of ALL_CHANNELS) {
          const decision = decideChannel(channel, cfg);
          if (operative.has(channel)) {
            expect(decision).toEqual({ ok: true });
          } else {
            expect(decision).toEqual({ ok: false, reason: 'channel_not_operative' });
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: roza-step2-channels, Property 2: Engine operative-channel decision and rejection are total and non-mutating
  // Validates: Requirements 5.1, 5.2, 5.3, 5.5, 15.1, 15.3
  it('handleMessage on a non-operative channel rejects without calling the LLM or mutating the DB', async () => {
    // Channels that are non-operative when both Telegram and Mail are disabled:
    // disabled `telegram`/`email` and the always-rejected `voice` (Req 5.2, 5.3, 15.3).
    const nonOperative = fc.constantFrom<Channel>('telegram', 'email', 'voice');

    await fc.assert(
      fc.asyncProperty(
        nonOperative,
        textArb,
        fc.boolean(),
        async (channel, text, seedFirst) => {
          const cfg = makeConfig({ telegramEnabled: false, mailEnabled: false });
          const { llm, calls } = makeOkLlm('should not be used');
          const engine = makeEngine(llm, cfg);

          // Optionally establish pre-existing state on the operative `internal`
          // channel so we prove a non-operative request leaves real memory
          // byte-for-byte unchanged.
          if (seedFirst) {
            const seeded = await engine.handleMessage({
              userId: freshUserId('seed'),
              channel: 'internal',
              text: 'hello seed',
            });
            expect(seeded.ok).toBe(true);
          }

          const callsBefore = calls.length;
          const before = snapshot();

          const res = await engine.handleMessage({
            userId: freshUserId('skip'),
            channel,
            text,
          });

          // Rejected as not operative (Req 5.2, 5.3, 15.3).
          expect(res).toEqual({ ok: false, reason: 'channel_not_operative' });
          // No LLM call was made for the non-operative request.
          expect(calls.length).toBe(callsBefore);
          // The database is byte-for-byte unchanged (no rows, no field mutated).
          expect(snapshot()).toBe(before);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
