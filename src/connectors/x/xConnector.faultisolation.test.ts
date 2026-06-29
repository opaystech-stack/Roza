// Feature: roza-step5-x-twitter, Property 11: Fault isolation — an X failure never stops other channels or the scheduler
//
// Validates: Requirements 4.5, 5.6, 6.5, 11.1, 11.2, 11.4, 13.5
//
// Property 11 drives `createXConnector` (the I/O shell) with an in-memory FAKE
// `XSession` that can be configured to fail at every stage of an autonomy run —
// an anti-bot/login obstacle (`open`/`isAuthenticated`/`login` reject), a
// Timeline-read error (Req 4.5), a Mentions-read error, a browser/session crash
// while posting (Req 11.1), and a per-Mention error (Req 6.5) — plus a SPY
// logger and a `close()` call counter. For EVERY generated failure scenario it
// asserts the three fault-isolation invariants:
//
//   1. `runXAutonomy()` RESOLVES — it never throws/rejects, so a single X
//      failure can never abort the Scheduler tick or any other channel
//      (Req 11.1, 11.2, 13.5).
//   2. `session.close()` is ALWAYS called from the `finally`, exactly once per
//      run, releasing the browser resources whether the run succeeded or failed
//      (Req 11.4).
//   3. The failure is observable in the structured log (at least one log line),
//      never swallowed silently (Req 4.5, 5.6, 11.1).
//
// Additionally, for the per-Mention failure scenario (the run reaches the reply
// loop and one Mention's `postReply` rejects), it asserts the loop CONTINUES to
// the remaining Mentions — one bad Mention never stops the rest (Req 6.5).
//
// No real browser or X network runs — every edge is an in-memory fake (Req 13.6).

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { createXConnector } from './xConnector.js';
import type { XMention, XSession, XTweet } from './xSession.js';
import type { RozaConfig } from '../../config.js';
import type { Logger } from '../../types.js';
import type { NewXAction, Repository, XActionRow } from '../../repository.js';
import { DEFAULT_PROFILE, type RozaProfile } from '../../profile.js';
import type { chatCompletion } from '../../llm.js';

/** Minimum fast-check iterations mandated by the design for every property. */
const NUM_RUNS = 100;

/** The stage at which the fake `XSession` injects a failure. */
type FailPoint = 'none' | 'open' | 'auth' | 'login' | 'timeline' | 'postTweet' | 'mentions';

/** A logged call captured by the spy logger. */
interface LogCall {
  level: 'info' | 'error';
  message: string;
  meta: Record<string, unknown> | undefined;
}

/**
 * Build a fully-resolved `RozaConfig` with the X capability ENABLED and the
 * rate limits wide-open (`actionSpacingMs: 0`, a large `dailyPostLimit`) so the
 * Rate_Limit gate never blocks — this isolates the test to FAULT behavior, not
 * rate behavior. Every other channel is disabled; they are irrelevant here.
 */
function makeConfig(): RozaConfig {
  return {
    rozaPrivateKey: 'test-private-key',
    openRouterApiKey: 'test-api-key',
    openRouterModel: 'openai/gpt-4o-mini',
    dataDir: '/tmp/roza-test',
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
      video: { width: 320, height: 240, fps: 25, pixelFormat: 'rgba' },
      latency: { renderMs: 4000 },
      renderer: { endpoint: 'http://renderer.local/render', engine: 'liveportrait' },
      devices: { camera: 'roza_cam', microphone: 'roza_mic' },
      meet: { enabled: false, consent: false, account: '', password: '' },
      stream: { enabled: false, url: '', key: '' },
    },
    x: {
      enabled: true,
      credentials: { username: 'roza_x', password: 'x-secret' },
      storageStatePath: '/tmp/roza-test/x_storage_state.json',
      autonomyIntervalMinutes: 60,
      rateLimit: { dailyPostLimit: 1000, actionSpacingMs: 0 },
      maxTopics: 3,
      maxPostChars: 280,
      dryRun: false,
    },
  };
}

/** Mutable record of everything the connector did to the fake session. */
interface SessionTrace {
  closeCalls: number;
  postTweetCalls: number;
  /** Refs in the order `postReply` was ATTEMPTED (including a ref that then throws). */
  postReplyAttempts: string[];
}

/**
 * Build an in-memory fake {@link XSession} that injects the scenario's failure.
 * Every method is a no-op success unless the scenario marks its stage as the
 * `failPoint`; `close()` always increments its counter so the test can prove
 * the `finally` released the session even when an earlier stage threw.
 */
function makeFakeSession(opts: {
  failPoint: FailPoint;
  timeline: XTweet[];
  mentions: XMention[];
  failingReplyRefs: ReadonlySet<string>;
  trace: SessionTrace;
}): XSession {
  const { failPoint, timeline, mentions, failingReplyRefs, trace } = opts;
  return {
    descriptor: { backend: 'playwright', license: 'Apache-2.0' },
    open(): Promise<void> {
      return failPoint === 'open'
        ? Promise.reject(new Error('XSession failed to open: anti-bot challenge'))
        : Promise.resolve();
    },
    isAuthenticated(): Promise<boolean> {
      if (failPoint === 'auth') {
        return Promise.reject(new Error('XSession failed to check authentication'));
      }
      // For the login-obstacle scenario report "not authenticated" so the
      // connector attempts login(), which then rejects below.
      return Promise.resolve(failPoint !== 'login');
    },
    login(): Promise<void> {
      return failPoint === 'login'
        ? Promise.reject(new Error('XSession failed to log in: login obstacle'))
        : Promise.resolve();
    },
    persistState(): Promise<void> {
      return Promise.resolve();
    },
    readTimeline(): Promise<XTweet[]> {
      return failPoint === 'timeline'
        ? Promise.reject(new Error('XSession failed to read timeline'))
        : Promise.resolve(timeline);
    },
    readMentions(): Promise<XMention[]> {
      return failPoint === 'mentions'
        ? Promise.reject(new Error('XSession failed to read mentions'))
        : Promise.resolve(mentions);
    },
    postTweet(): Promise<void> {
      trace.postTweetCalls += 1;
      // A browser/session crash mid-post — the connector's outer try/finally
      // must isolate it (Req 11.1, 11.4).
      return failPoint === 'postTweet'
        ? Promise.reject(new Error('XSession browser disconnected'))
        : Promise.resolve();
    },
    postReply(ref: string): Promise<void> {
      // Record the attempt BEFORE possibly throwing so the test can prove the
      // loop reached every Mention even when one fails (Req 6.5).
      trace.postReplyAttempts.push(ref);
      return failingReplyRefs.has(ref)
        ? Promise.reject(new Error('XSession failed to post reply: per-mention obstacle'))
        : Promise.resolve();
    },
    close(): Promise<void> {
      trace.closeCalls += 1;
      return Promise.resolve();
    },
  };
}

/** A fake audit repository exposing only the three X-action methods the connector uses. */
function makeFakeRepo(): Repository {
  let seq = 0;
  return {
    recordXAction(input: NewXAction): XActionRow {
      seq += 1;
      return {
        id: `x-${seq}`,
        action_type: input.actionType,
        content: input.content,
        mention_ref: input.mentionRef ?? null,
        created_at: input.createdAt,
      };
    },
    // Always empty so the Rate_Limit gate is `allow` for every action — this
    // test isolates FAULT behavior, not rate behavior.
    listXActionsSince(): XActionRow[] {
      return [];
    },
    listRepliedMentionRefs(): string[] {
      return [];
    },
  } as unknown as Repository;
}

/** A fake LLM that always succeeds so formulation never short-circuits the run. */
const fakeLlm: typeof chatCompletion = () =>
  Promise.resolve({ ok: true, content: 'A grounded reflection on the topic at hand.' });

/** Arbitrary non-empty tweet text so `selectHotTopics` yields topics. */
const tweetArb: fc.Arbitrary<XTweet> = fc.record({
  id: fc.hexaString({ minLength: 4, maxLength: 8 }),
  author: fc.constant('@someone'),
  text: fc.string({ minLength: 1, maxLength: 40 }).filter((t) => t.trim().length > 0),
});

describe('Fault isolation — an X failure never stops other channels or the scheduler (Property 11)', () => {
  // Feature: roza-step5-x-twitter, Property 11: Fault isolation — an X failure never stops other channels or the scheduler
  // Validates: Requirements 4.5, 5.6, 6.5, 11.1, 11.2, 11.4, 13.5
  it('always resolves without throwing, always closes the session, and logs every injected failure', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          failPoint: fc.constantFrom<FailPoint>(
            'none',
            'open',
            'auth',
            'login',
            'timeline',
            'postTweet',
            'mentions',
          ),
          timeline: fc.array(tweetArb, { minLength: 1, maxLength: 5 }),
          // Mentions with unique refs; a boolean flags each as a per-Mention failure.
          mentions: fc
            .uniqueArray(
              fc.record({
                ref: fc.hexaString({ minLength: 4, maxLength: 10 }),
                author: fc.constant('@mentioner'),
                text: fc.string({ maxLength: 40 }),
                fails: fc.boolean(),
              }),
              { selector: (m) => m.ref, minLength: 0, maxLength: 6 },
            ),
        }),
        async (scenario) => {
          const cfg = makeConfig();
          const mentions: XMention[] = scenario.mentions.map((m) => ({
            ref: m.ref,
            author: m.author,
            text: m.text,
          }));
          const failingReplyRefs = new Set<string>(
            scenario.mentions.filter((m) => m.fails).map((m) => m.ref),
          );

          const trace: SessionTrace = { closeCalls: 0, postTweetCalls: 0, postReplyAttempts: [] };
          const logCalls: LogCall[] = [];
          const logger: Logger = {
            info: (message, meta) => logCalls.push({ level: 'info', message, meta }),
            error: (message, meta) => logCalls.push({ level: 'error', message, meta }),
          };

          const session = makeFakeSession({
            failPoint: scenario.failPoint,
            timeline: scenario.timeline,
            mentions,
            failingReplyRefs,
            trace,
          });

          const connector = createXConnector({
            session,
            cfg,
            profile: (): RozaProfile => DEFAULT_PROFILE,
            llm: fakeLlm,
            repo: makeFakeRepo(),
            now: () => new Date('2024-06-01T12:00:00.000Z'),
            timezone: cfg.timezone,
            logger,
          });

          // INVARIANT 1 (Req 11.1, 11.2, 13.5): the run resolves — never throws.
          // `fc.asyncProperty` fails the property if this rejects.
          await connector.runXAutonomy();

          // INVARIANT 2 (Req 11.4): `close()` is always called from the finally,
          // exactly once, releasing the session even when an earlier stage threw.
          expect(trace.closeCalls).toBe(1);

          // INVARIANT 3 (Req 4.5, 5.6, 11.1): the run produced at least one log
          // line — a failure is observable, never silently swallowed.
          expect(logCalls.length).toBeGreaterThan(0);

          // When a failure is injected, an error-level log records the obstacle.
          if (scenario.failPoint !== 'none') {
            expect(logCalls.some((c) => c.level === 'error')).toBe(true);
          }

          // PER-MENTION ISOLATION (Req 6.5): when the run reaches the reply loop
          // (no global failure), every unreplied Mention is attempted — a single
          // failing Mention never stops the rest.
          if (scenario.failPoint === 'none') {
            expect(trace.postReplyAttempts).toEqual(mentions.map((m) => m.ref));
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
