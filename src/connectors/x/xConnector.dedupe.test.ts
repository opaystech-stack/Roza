// Feature: roza-step5-x-twitter, Property 9: Reply dedupe and additive audit
//
// Validates: Requirements 6.4, 10.2
//
// Property 9 drives the X_Connector I/O shell (`createXConnector`) with
// in-memory fakes over fast-check-generated Mentions and an already-replied ref
// set recorded in a REAL `better-sqlite3` `x_actions` audit table, and asserts
// three guarantees hold for EVERY generated scenario:
//
//   1. DEDUPE SELECTION (Req 6.4) — `selectUnrepliedMentions(mentions,
//      repliedRefs)` returns exactly the Mentions whose `ref` is NOT in the
//      already-replied set, preserving input order.
//
//   2. REPLAY NEVER DOUBLE-REPLIES (Req 6.4) — one autonomy run replies once to
//      each unreplied Mention and never to an already-recorded ref; REPLAYING
//      the identical run publishes ZERO further Replies because every ref is now
//      recorded in the audit trail.
//
//   3. ADDITIVE, MONOTONIC AUDIT (Req 10.2) — the `x_actions` audit is
//      append-only: after the first run every recorded ref maps to exactly one
//      reply row, the row count never decreases across the replay, and every
//      row id present after run 1 is still present (unmodified) after run 2.
//
// A real temporary in-memory `better-sqlite3` database backs the audit
// (`recordXAction`/`listXActionsSince`/`listRepliedMentionRefs`); the XSession,
// the LLM, and the clock/timezone are all injected fakes — NO real browser, X
// network, or filesystem session-state I/O runs (Req 13.6).

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import Database from 'better-sqlite3';

import { createXConnector, selectUnrepliedMentions } from './xConnector.js';
import type { XCredentials, XMention, XSession, XTweet } from './xSession.js';
import { initSchema } from '../../db.js';
import { createRepository, type Repository, type XActionRow } from '../../repository.js';
import { DEFAULT_PROFILE } from '../../profile.js';
import type { LlmResult } from '../../llm.js';
import type { ChatMessage } from '../../llm.js';
import type { Logger } from '../../types.js';
import type { RozaConfig, XChannelConfig } from '../../config.js';

/** Minimum fast-check iterations mandated by the design for every property. */
const NUM_RUNS = 100;

/** Deterministic clock + timezone so the audit + day-count math never reads a real clock. */
const FIXED_NOW = new Date('2024-06-15T12:00:00.000Z');
const TIMEZONE = 'UTC';

// ───────────────────────────────────────────────────────────────────────────
// Fakes — every external edge is in-memory.
// ───────────────────────────────────────────────────────────────────────────

/** A captured `postReply` delegation. */
interface ReplyCall {
  ref: string;
  text: string;
}

/**
 * Build a fake authenticated {@link XSession} that returns the generated
 * Mentions, an empty Timeline (so the run exercises only the reply loop), and
 * records every `postTweet`/`postReply` delegation. No real browser or network.
 */
function makeFakeSession(mentions: XMention[]): {
  session: XSession;
  replyCalls: ReplyCall[];
  postCalls: string[];
} {
  const replyCalls: ReplyCall[] = [];
  const postCalls: string[] = [];
  const session: XSession = {
    descriptor: { backend: 'playwright', license: 'Apache-2.0' },
    async open(): Promise<void> {},
    async isAuthenticated(): Promise<boolean> {
      // A restored, still-valid session — no fresh login needed.
      return true;
    },
    async login(_creds: XCredentials): Promise<void> {},
    async persistState(): Promise<void> {},
    async readTimeline(): Promise<XTweet[]> {
      // Empty Timeline → no Hot_Topics → no posts; the run is reply-only.
      return [];
    },
    async readMentions(): Promise<XMention[]> {
      // Return a defensive copy so the connector cannot mutate our source.
      return mentions.map((m) => ({ ...m }));
    },
    async postTweet(text: string): Promise<void> {
      postCalls.push(text);
    },
    async postReply(ref: string, text: string): Promise<void> {
      replyCalls.push({ ref, text });
    },
    async close(): Promise<void> {},
  };
  return { session, replyCalls, postCalls };
}

/** A fake LLM that always succeeds with a fixed, non-empty reply body. */
const fakeLlm = async (
  _cfg: { apiKey: string; model: string },
  _messages: ChatMessage[],
): Promise<LlmResult> => {
  return { ok: true, content: 'A considered, on-topic reply in Roza\u2019s own voice.' };
};

/** Inert logger — only identifiers/counts ever reach it; the test ignores them. */
const inertLogger: Logger = {
  info: () => undefined,
  error: () => undefined,
};

/** Build a fully-resolved X capability config with rate gates wide open. */
function makeXConfig(): XChannelConfig {
  return {
    enabled: true,
    credentials: { username: 'roza_thinker', password: 'secret-password' },
    storageStatePath: '/tmp/roza-test/x_storage_state.json',
    autonomyIntervalMinutes: 60,
    // dailyPostLimit huge + actionSpacingMs 0 so neither gate blocks the run:
    // every unreplied Mention is replied to within a single pass.
    rateLimit: { dailyPostLimit: 1_000_000, actionSpacingMs: 0 },
    maxTopics: 3,
    maxPostChars: 280,
    dryRun: false,
  };
}

/** Build a fully-resolved RozaConfig carrying the enabled X capability. */
function makeConfig(x: XChannelConfig): RozaConfig {
  return {
    rozaPrivateKey: 'test-private-key',
    openRouterApiKey: 'test-api-key',
    openRouterModel: 'openai/gpt-4o-mini',
    dataDir: '/tmp/roza-test',
    timezone: TIMEZONE,
    activeWindow: { startMinutes: 0, endMinutes: 1439 },
    keyVersion: 'v1',
    telegram: { enabled: false, botToken: '', allowlist: [] },
    mail: {
      enabled: false,
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
      video: { width: 1280, height: 720, fps: 30, pixelFormat: 'yuv420p' },
      latency: { renderMs: 4000 },
      renderer: { endpoint: 'http://renderer.local', engine: 'fake' },
      devices: { camera: 'cam0', microphone: 'mic0' },
      meet: { enabled: false, consent: false, account: '', password: '' },
      stream: { enabled: false, url: '', key: '' },
    },
    x,
  };
}

/** Open a fresh, isolated in-memory `better-sqlite3` repository for one scenario. */
function makeRepo(): { db: Database.Database; repo: Repository } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  const repo = createRepository(db, { secret: 'test-secret', keyVersion: 'v1' });
  return { db, repo };
}

// ───────────────────────────────────────────────────────────────────────────
// Generators
// ───────────────────────────────────────────────────────────────────────────

/** A non-blank Mention `ref` (the dedupe key). */
const refArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((s) => s.trim().length > 0);

/** A scenario: a set of unique Mention refs, each flagged as already-replied or not. */
interface Scenario {
  refs: string[];
  /** Aligned with `refs`: true ⇒ that ref is pre-recorded as already replied. */
  preReplied: boolean[];
  /** Aligned with `refs`: the (possibly empty/untrusted) Mention text. */
  texts: string[];
}

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .uniqueArray(refArb, { minLength: 0, maxLength: 8 })
  .chain((refs) =>
    fc.record({
      refs: fc.constant(refs),
      preReplied: fc.array(fc.boolean(), { minLength: refs.length, maxLength: refs.length }),
      texts: fc.array(fc.string({ maxLength: 40 }), {
        minLength: refs.length,
        maxLength: refs.length,
      }),
    }),
  );

/** Set of refs that appear in any reply row of the audit trail. */
function recordedReplyRefs(repo: Repository): Set<string> {
  return new Set(repo.listRepliedMentionRefs());
}

/** Set of `x_actions` row ids currently in the audit (additivity probe). */
function auditRowIds(repo: Repository): Set<string> {
  return new Set(repo.listXActionsSince('1970-01-01T00:00:00.000Z').map((r: XActionRow) => r.id));
}

describe('Reply dedupe and additive audit (Property 9)', () => {
  // Feature: roza-step5-x-twitter, Property 9: Reply dedupe and additive audit
  // Validates: Requirements 6.4, 10.2
  it('replies only to unreplied refs, never double-replies on replay, and the audit is additive/monotonic', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { refs, preReplied, texts } = scenario;

        const mentions: XMention[] = refs.map((ref, i) => ({
          ref,
          author: `author-${i}`,
          text: texts[i] ?? '',
        }));
        const preRepliedRefs = refs.filter((_, i) => preReplied[i]);
        const expectedUnreplied = refs.filter((_, i) => !preReplied[i]);

        const { repo } = makeRepo();
        const cfg = makeConfig(makeXConfig());

        // Pre-seed the audit with the already-replied refs (one reply row each).
        for (const ref of preRepliedRefs) {
          repo.recordXAction({
            actionType: 'reply',
            content: 'previously published reply',
            mentionRef: ref,
            createdAt: FIXED_NOW.toISOString(),
          });
        }

        // (1) DEDUPE SELECTION — the pure helper returns exactly the unreplied
        // refs, in input order (Req 6.4).
        const selected = selectUnrepliedMentions(mentions, preRepliedRefs);
        expect(selected.map((m) => m.ref)).toEqual(expectedUnreplied);

        // ── Run 1 ────────────────────────────────────────────────────────────
        const run1 = makeFakeSession(mentions);
        const connector1 = createXConnector({
          session: run1.session,
          cfg,
          profile: () => DEFAULT_PROFILE,
          llm: fakeLlm,
          repo,
          now: () => FIXED_NOW,
          timezone: TIMEZONE,
          logger: inertLogger,
        });
        await connector1.runXAutonomy();

        // No original posts (the Timeline is empty).
        expect(run1.postCalls).toHaveLength(0);

        // Exactly the unreplied refs were replied to, once each — and NEVER a
        // pre-recorded ref (Req 6.4).
        expect(run1.replyCalls.map((c) => c.ref).sort()).toEqual([...expectedUnreplied].sort());
        for (const ref of preRepliedRefs) {
          expect(run1.replyCalls.some((c) => c.ref === ref)).toBe(false);
        }

        // After run 1 every unique ref maps to exactly one reply row; the audit
        // holds one row per ref (seeds + new replies), no duplicates.
        const idsAfterRun1 = auditRowIds(repo);
        expect(idsAfterRun1.size).toBe(refs.length);
        expect(recordedReplyRefs(repo)).toEqual(new Set(refs));

        // ── Run 2 (replay) ───────────────────────────────────────────────────
        const run2 = makeFakeSession(mentions);
        const connector2 = createXConnector({
          session: run2.session,
          cfg,
          profile: () => DEFAULT_PROFILE,
          llm: fakeLlm,
          repo,
          now: () => FIXED_NOW,
          timezone: TIMEZONE,
          logger: inertLogger,
        });
        await connector2.runXAutonomy();

        // (2) REPLAY NEVER DOUBLE-REPLIES — every ref is now recorded, so the
        // replay publishes ZERO further Replies (Req 6.4).
        expect(run2.replyCalls).toHaveLength(0);
        expect(run2.postCalls).toHaveLength(0);

        // (3) ADDITIVE, MONOTONIC AUDIT (Req 10.2) — the row count never
        // decreased, no new rows were appended on the no-op replay, and every
        // row id from run 1 is still present (unmodified) after run 2.
        const idsAfterRun2 = auditRowIds(repo);
        expect(idsAfterRun2.size).toBeGreaterThanOrEqual(idsAfterRun1.size);
        expect(idsAfterRun2.size).toBe(idsAfterRun1.size);
        for (const id of idsAfterRun1) {
          expect(idsAfterRun2.has(id)).toBe(true);
        }
        // The recorded reply-ref set is unchanged by the replay.
        expect(recordedReplyRefs(repo)).toEqual(new Set(refs));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
