// Feature: roza-step5-x-twitter, Property 10: Secrets, session state, and journal never leak through logs, audit, or posts
//
// Validates: Requirements 3.4, 7.4, 7.5, 9.4, 10.3
//
// Property 10 drives the `createXConnector` I/O shell (`runXAutonomy`) with
// in-memory FAKES for every injected edge — a fake `XSession` whose
// `postTweet`/`postReply` (and `login`) record their arguments, a fake `llm` we
// fully control, a REAL `better-sqlite3` `x_actions` audit repository over an
// in-memory database, and a SPY logger — and asserts that a set of distinctive
// sentinel secrets NEVER leak through any observable surface:
//
//   - the X_Credentials (`X_USERNAME` / `X_PASSWORD`),
//   - a simulated X_Session_State value,
//   - a simulated Private_Journal value,
//   - a simulated Channel_Credential (a Phase 2 Bot_Token) and the journal key,
//
// must appear in NONE of:
//   - any spy-logger info/error line (message + meta serialized) — Req 3.4, 7.4, 9.4, 10.3,
//   - any surfaced error message (`runXAutonomy` never throws, but its caught
//     errors are logged) — Req 7.4,
//   - any persisted `x_actions` row (every column scanned) — Req 7.5, 10.3,
//   - any value handed to `postTweet(text)` or `postReply(ref, text)` — Req 9.4.
//
// The ONLY place the X_Credentials may legitimately appear is the dedicated
// `session.login(creds)` parameter, and the test proves the credentials travel
// ONLY there (verbatim) and into no other sink. The Channel_Credential / journal
// key sit in the wider `RozaConfig` the connector holds but never uses, and the
// X_Session_State / Private_Journal sentinels ride inside the Untrusted_X_Content
// (timeline tweet + mention text) the connector reads — proving the connector
// never copies untrusted content, config secrets, or credentials into its logs,
// its audit rows, or the published posts/replies.
//
// Both the success and the failure paths are exercised (a fake session that may
// throw on login / timeline read / mentions read / postTweet / postReply /
// close, plus an llm that may fail) so the degradation/error-logging paths are
// scanned too. The schema check additionally asserts the `x_actions` table
// carries NO credential or session-state column (Req 7.5, 10.3). No real
// browser, X network, or filesystem session-state I/O runs — every edge is an
// in-memory fake.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import Database from 'better-sqlite3';

import { createXConnector } from './xConnector.js';
import type { XMention, XSession, XTweet } from './xSession.js';
import { initSchema } from '../../db.js';
import { createRepository, type Repository, type XActionRow } from '../../repository.js';
import { DEFAULT_PROFILE, type RozaProfile } from '../../profile.js';
import type { ChatMessage, LlmResult } from '../../llm.js';
import type { RozaConfig } from '../../config.js';
import type { Logger } from '../../types.js';

/** Minimum fast-check iterations mandated by the design for every property. */
const NUM_RUNS = 100;

/** A logged call captured by the spy logger. */
interface LogCall {
  level: 'info' | 'error';
  message: string;
  meta: Record<string, unknown> | undefined;
}

/** Serialize a log call (message + meta) into a single scannable string. */
function serializeLog(call: LogCall): string {
  let metaStr: string;
  try {
    metaStr = JSON.stringify(call.meta ?? {}, (_k, v) =>
      v instanceof Error ? `${v.name}: ${v.message}` : (v as unknown),
    );
  } catch {
    metaStr = String(call.meta);
  }
  return `${call.level} ${call.message} ${metaStr}`;
}

/** Assert that none of the forbidden sentinels appear in `haystack`. */
function assertNoSecret(haystack: string, forbidden: string[], where: string): void {
  for (const secret of forbidden) {
    expect(
      haystack.includes(secret),
      `${where} leaked a secret value (substring match): ${secret}`,
    ).toBe(false);
  }
}

/** A distinctive, collision-free random token for building sentinel secrets. */
const tokenArb = fc.hexaString({ minLength: 8, maxLength: 16 });

/**
 * Build a fully-resolved `RozaConfig` with the X capability ENABLED (so the
 * gate passes and the X_Credentials actually flow to `session.login`), seeding
 * the secret-bearing fields with the supplied sentinels. The non-X channels are
 * disabled, but a Channel_Credential sentinel is planted on the (unused) Phase 2
 * Bot_Token and the journal private key so the test proves the connector never
 * dumps the wider config it holds.
 */
function makeConfig(opts: {
  username: string;
  password: string;
  botTokenSecret: string;
  privateKeySecret: string;
  maxTopics: number;
  maxPostChars: number;
}): RozaConfig {
  return {
    rozaPrivateKey: opts.privateKeySecret,
    openRouterApiKey: 'test-api-key',
    openRouterModel: 'openai/gpt-4o-mini',
    dataDir: '/tmp/roza-test',
    timezone: 'Africa/Kinshasa',
    activeWindow: { startMinutes: 420, endMinutes: 1320 },
    keyVersion: 'v1',
    telegram: { enabled: false, botToken: opts.botTokenSecret, allowlist: [] },
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
      credentials: { username: opts.username, password: opts.password },
      storageStatePath: '/tmp/roza-test/x_storage_state.json',
      autonomyIntervalMinutes: 60,
      // dailyPostLimit high + spacing 0 so the Rate_Limit always allows the
      // post/reply path to publish (the leak surface we want to scan).
      rateLimit: { dailyPostLimit: 1000, actionSpacingMs: 0 },
      maxTopics: opts.maxTopics,
      maxPostChars: opts.maxPostChars,
      dryRun: false,
    },
  };
}

describe('Secrets, session state, and journal never leak through logs, audit, or posts (Property 10)', () => {
  // Feature: roza-step5-x-twitter, Property 10: Secrets, session state, and journal never leak through logs, audit, or posts
  // Validates: Requirements 3.4, 7.4, 7.5, 9.4, 10.3
  it('never surfaces credentials, session state, or journal values in logs, errors, audit rows, or posts', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          tokens: fc.tuple(tokenArb, tokenArb, tokenArb, tokenArb, tokenArb),
          // Untrusted timeline + mention payloads (carry the journal/session sentinels).
          tweetTokens: fc.array(tokenArb, { minLength: 0, maxLength: 4 }),
          mentionTokens: fc.array(tokenArb, { minLength: 0, maxLength: 4 }),
          // Failure-path toggles so the error-logging paths are scanned too.
          alreadyAuthenticated: fc.boolean(),
          loginFails: fc.boolean(),
          timelineFails: fc.boolean(),
          mentionsFails: fc.boolean(),
          postTweetFails: fc.boolean(),
          postReplyFails: fc.boolean(),
          closeFails: fc.boolean(),
          llmFails: fc.boolean(),
        }),
        async (scenario) => {
          const [tU, tP, tSession, tJournal, tChannel] = scenario.tokens;

          // Distinctive sentinel secrets so substring scans are meaningful.
          const usernameSecret = `SECRET-XUSER-${tU}`;
          const passwordSecret = `SECRET-XPASS-${tP}`;
          const sessionStateSecret = `SECRET-XSESSION-${tSession}`;
          const journalSecret = `SECRET-JOURNAL-${tJournal}`;
          const channelCredSecret = `SECRET-CHANNELCRED-${tChannel}`;

          // Every one of these must appear in NO log, error, audit row, or post.
          const forbidden = [
            usernameSecret,
            passwordSecret,
            sessionStateSecret,
            journalSecret,
            channelCredSecret,
          ];

          const cfg = makeConfig({
            username: usernameSecret,
            password: passwordSecret,
            botTokenSecret: channelCredSecret,
            privateKeySecret: journalSecret,
            maxTopics: 3,
            maxPostChars: 280,
          });

          // --- Real x_actions audit repository over an in-memory database ------
          const db = new Database(':memory:');
          db.pragma('foreign_keys = ON');
          initSchema(db);
          const repo: Repository = createRepository(db, {
            secret: 'test-journal-secret',
            keyVersion: 'v1',
          });

          // --- Captured sinks --------------------------------------------------
          const logCalls: LogCall[] = [];
          const loginCalls: { username: string; password: string }[] = [];
          const postTweetCalls: string[] = [];
          const postReplyCalls: { ref: string; text: string }[] = [];

          // --- Spy logger ------------------------------------------------------
          const logger: Logger = {
            info: (message, meta) => logCalls.push({ level: 'info', message, meta }),
            error: (message, meta) => logCalls.push({ level: 'error', message, meta }),
          };

          // --- Untrusted_X_Content carrying the session/journal sentinels ------
          // A malicious/secret-bearing timeline + mentions: the connector must
          // never echo this text into a log, an audit row, or a published post.
          const timeline: XTweet[] = scenario.tweetTokens.map((tok, i) => ({
            id: `tweet-${i}-${tok}`,
            author: `@author_${i}`,
            text: `Hot take ${tok} :: ${sessionStateSecret} / ${journalSecret}`,
          }));
          const mentions: XMention[] = scenario.mentionTokens.map((tok, i) => ({
            // `ref` is a PUBLIC tweet id (non-secret) — the connector logs it.
            ref: `mref-${i}-${tok}`,
            author: `@mentioner_${i}`,
            text: `Replying about ${tok} :: ${sessionStateSecret} / ${journalSecret}`,
          }));

          // --- Fake XSession: records login/post args; may fail per scenario ---
          const session: XSession = {
            descriptor: { backend: 'playwright', license: 'Apache-2.0' },
            open: () => Promise.resolve(),
            isAuthenticated: () => Promise.resolve(scenario.alreadyAuthenticated),
            login: (creds) => {
              // The dedicated credential sink — the ONLY place creds may appear.
              loginCalls.push({ username: creds.username, password: creds.password });
              return scenario.loginFails
                ? Promise.reject(new Error('XSession failed to log in: anti-bot challenge'))
                : Promise.resolve();
            },
            persistState: () => Promise.resolve(),
            readTimeline: () =>
              scenario.timelineFails
                ? Promise.reject(new Error('XSession failed to read timeline: navigation timeout'))
                : Promise.resolve(timeline),
            readMentions: () =>
              scenario.mentionsFails
                ? Promise.reject(new Error('XSession failed to read mentions: navigation timeout'))
                : Promise.resolve(mentions),
            postTweet: (text) => {
              postTweetCalls.push(text);
              return scenario.postTweetFails
                ? Promise.reject(new Error('XSession failed to post tweet: compose blocked'))
                : Promise.resolve();
            },
            postReply: (ref, text) => {
              postReplyCalls.push({ ref, text });
              return scenario.postReplyFails
                ? Promise.reject(new Error('XSession failed to post reply: rate-limit block'))
                : Promise.resolve();
            },
            close: () =>
              scenario.closeFails
                ? Promise.reject(new Error('XSession failed to close: browser already gone'))
                : Promise.resolve(),
          };

          // --- Fake llm: returns CLEAN content (never echoes a secret) ---------
          const llm = (
            _llmCfg: { apiKey: string; model: string },
            _messages: ChatMessage[],
          ): Promise<LlmResult> => {
            if (scenario.llmFails) {
              return Promise.resolve({ ok: false, reason: 'OpenRouter returned an empty response' });
            }
            return Promise.resolve({
              ok: true,
              content: 'A clean, persona-grounded thought with no secrets whatsoever.',
            });
          };

          const profile = (): RozaProfile => DEFAULT_PROFILE;

          const connector = createXConnector({
            session,
            cfg,
            profile,
            llm,
            repo,
            now: () => new Date('2024-06-01T12:00:00.000Z'),
            timezone: cfg.timezone,
            logger,
          });

          // --- Drive the full surface across success AND failure paths ---------
          await connector.start();
          // runXAutonomy must never throw (Req 11) — any obstacle is caught + logged.
          await connector.runXAutonomy();
          await connector.stop();

          // --- Assertions: no secret in any leak surface -----------------------

          // 1. Logs (Req 3.4, 7.4, 9.4, 10.3): every spy-logger call, serialized.
          for (const call of logCalls) {
            assertNoSecret(serializeLog(call), forbidden, `log '${call.message}'`);
          }

          // 2. Posts (Req 9.4): no value handed to postTweet carries a secret.
          for (const text of postTweetCalls) {
            assertNoSecret(text, forbidden, 'postTweet text');
          }

          // 3. Replies (Req 9.4): neither the ref nor the body carries a secret.
          for (const reply of postReplyCalls) {
            assertNoSecret(reply.text, forbidden, 'postReply text');
            assertNoSecret(reply.ref, forbidden, 'postReply ref');
          }

          // 4. Audit rows (Req 7.5, 10.3): every persisted x_actions column —
          //    including the published content and mention_ref — is secret-free.
          const rows = db.prepare('SELECT * FROM x_actions').all() as XActionRow[];
          for (const row of rows) {
            assertNoSecret(JSON.stringify(row), forbidden, 'x_actions row');
          }

          // 5. Credentials travel ONLY in the dedicated login parameter, verbatim
          //    (Req 7.4): when login ran, it carried exactly the X_Credentials
          //    and smuggled no other secret.
          for (const creds of loginCalls) {
            expect(creds.username).toBe(usernameSecret);
            expect(creds.password).toBe(passwordSecret);
            assertNoSecret(
              creds.username,
              [sessionStateSecret, journalSecret, channelCredSecret],
              'login creds.username',
            );
            assertNoSecret(
              creds.password,
              [sessionStateSecret, journalSecret, channelCredSecret],
              'login creds.password',
            );
          }

          db.close();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Validates: Requirements 7.5, 10.3 — the additive x_actions audit table holds
  // NO X_Credentials column and NO X_Session_State column; it carries only the
  // action type, the published content, the optional public Mention dedupe ref,
  // and the timestamp.
  it('x_actions schema carries no credential or session-state column', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      initSchema(db);

      const columns = (db.pragma('table_info(x_actions)') as Array<{ name: string }>).map(
        (c) => c.name,
      );

      // Exactly the documented audit columns — nothing credential/session-bearing.
      expect(new Set(columns)).toEqual(
        new Set(['id', 'action_type', 'content', 'mention_ref', 'created_at']),
      );

      // Defensively assert no column name hints at a credential / session state.
      const forbiddenColumnPattern = /credential|password|username|session|storage|state|secret|token/i;
      for (const name of columns) {
        expect(
          forbiddenColumnPattern.test(name),
          `x_actions must not expose a credential/session-state column: "${name}"`,
        ).toBe(false);
      }
    } finally {
      db.close();
    }
  });
});
