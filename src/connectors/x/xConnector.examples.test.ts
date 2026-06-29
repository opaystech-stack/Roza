// Feature: roza-step5-x-twitter, Task 8.6 — example/integration tests for the
// X_Connector I/O shell (`createXConnector`) driven entirely by in-memory fakes.
//
// Validates: Requirements 2.3, 3.3, 3.5, 4.1, 4.2, 5.3, 6.1, 6.3, 10.1
//
// These are example-based (not property-based) integration tests: each one
// drives one concrete autonomy run of `createXConnector` over a fake `XSession`,
// a fake `llm`, and a REAL in-memory `better-sqlite3` `x_actions` audit
// repository, then asserts the end-to-end orchestration outcome. No real
// browser, X network, or filesystem session-state I/O runs — every external edge
// is an in-memory fake (Req 13.6).
//
// Scenarios covered:
//   1. Autonomy happy path — timeline → topic → post → audit (Req 4.1, 4.2, 5.3, 10.1).
//   2. Reply loop happy path — mentions → dedupe → reply → audit (Req 6.1, 6.3).
//   3. No valid session state → login + persist (Req 3.3).
//   4. Expired restored state → fresh login + replace stored state (Req 3.5).
//   5. A swapped ALTERNATE XSession fake produces identical orchestration (Req 2.3).
//   6. dryRun=true formulates but NEVER publishes — no postTweet/postReply (Req 5.3 dry-run).

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import { createXConnector } from './xConnector.js';
import type { XCredentials, XMention, XSession, XTweet } from './xSession.js';
import { initSchema } from '../../db.js';
import { createRepository, type Repository, type XActionRow } from '../../repository.js';
import { DEFAULT_PROFILE } from '../../profile.js';
import type { ChatMessage, LlmResult } from '../../llm.js';
import type { Logger } from '../../types.js';
import type { RozaConfig, XChannelConfig } from '../../config.js';

/** Deterministic clock + timezone so the audit + day-count math never reads a real clock. */
const FIXED_NOW = new Date('2024-06-15T12:00:00.000Z');
const TIMEZONE = 'UTC';

/** The fixed, clean body the fake LLM returns (never echoes a secret or untrusted text). */
const LLM_BODY = "A considered, on-topic thought in Roza's own voice.";

// ───────────────────────────────────────────────────────────────────────────
// Fakes — every external edge is in-memory.
// ───────────────────────────────────────────────────────────────────────────

/** Captured delegations + call order for one fake {@link XSession}. */
interface SessionCalls {
  /** Ordered method-name trace so we can assert restore→login→persist→read ordering. */
  order: string[];
  postTweet: string[];
  postReply: { ref: string; text: string }[];
  login: XCredentials[];
  persistState: number;
  opened: number;
  closed: number;
}

/** Options controlling the primary fake {@link XSession} behavior for a scenario. */
interface FakeSessionOptions {
  /** What `isAuthenticated()` returns (false ⇒ the connector logs in). */
  authenticated: boolean;
  /** Home Timeline returned by `readTimeline()`. */
  timeline?: XTweet[];
  /** Mentions returned by `readMentions()`. */
  mentions?: XMention[];
  /** A shared in-memory X_Session_State store the fake mutates on login (Req 3.3, 3.5). */
  stateStore?: { value: string | null };
  /** When set, a fresh `login()` replaces `stateStore.value` with this (Req 3.5). */
  loginNewState?: string;
}

/**
 * Build the primary fake {@link XSession}, recording every delegation. Its
 * `login()` mirrors the real Playwright adapter contract: a fresh login persists
 * the resulting X_Session_State, replacing any expired/invalid restored state
 * (Req 3.3, 3.5). No real browser or network.
 */
function makeFakeSession(opts: FakeSessionOptions): { session: XSession; calls: SessionCalls } {
  const calls: SessionCalls = {
    order: [],
    postTweet: [],
    postReply: [],
    login: [],
    persistState: 0,
    opened: 0,
    closed: 0,
  };
  const timeline = opts.timeline ?? [];
  const mentions = opts.mentions ?? [];

  const session: XSession = {
    descriptor: { backend: 'playwright', license: 'Apache-2.0' },
    async open(): Promise<void> {
      calls.order.push('open');
      calls.opened += 1;
    },
    async isAuthenticated(): Promise<boolean> {
      calls.order.push('isAuthenticated');
      return opts.authenticated;
    },
    async login(creds: XCredentials): Promise<void> {
      calls.order.push('login');
      calls.login.push({ ...creds });
      // Mirror the adapter: a fresh login persists the resulting state,
      // replacing any expired/invalid restored state (Req 3.3, 3.5).
      if (opts.stateStore && opts.loginNewState !== undefined) {
        opts.stateStore.value = opts.loginNewState;
      }
      calls.order.push('persistState');
      calls.persistState += 1;
    },
    async persistState(): Promise<void> {
      calls.order.push('persistState');
      calls.persistState += 1;
    },
    async readTimeline(): Promise<XTweet[]> {
      calls.order.push('readTimeline');
      return timeline.map((t) => ({ ...t }));
    },
    async readMentions(): Promise<XMention[]> {
      calls.order.push('readMentions');
      return mentions.map((m) => ({ ...m }));
    },
    async postTweet(text: string): Promise<void> {
      calls.order.push('postTweet');
      calls.postTweet.push(text);
    },
    async postReply(ref: string, text: string): Promise<void> {
      calls.order.push('postReply');
      calls.postReply.push({ ref, text });
    },
    async close(): Promise<void> {
      calls.order.push('close');
      calls.closed += 1;
    },
  };
  return { session, calls };
}

/**
 * A deliberately DIFFERENT XSession implementation (Req 2.3) — class-based,
 * authenticated, storing the Timeline/Mentions in private fields and exposing
 * the captured posts/replies through getters. Proves the autonomy/reply
 * orchestration is identical no matter which adapter backs the interface.
 */
class AlternateFakeSession implements XSession {
  readonly descriptor = { backend: 'playwright' as const, license: 'Apache-2.0' };
  readonly postedTweets: string[] = [];
  readonly postedReplies: { ref: string; text: string }[] = [];
  private readonly tl: XTweet[];
  private readonly mn: XMention[];

  constructor(timeline: XTweet[], mentions: XMention[]) {
    this.tl = timeline;
    this.mn = mentions;
  }

  open(): Promise<void> {
    return Promise.resolve();
  }
  isAuthenticated(): Promise<boolean> {
    return Promise.resolve(true);
  }
  login(_creds: XCredentials): Promise<void> {
    return Promise.resolve();
  }
  persistState(): Promise<void> {
    return Promise.resolve();
  }
  readTimeline(): Promise<XTweet[]> {
    // A different internal representation: rebuild fresh objects via reduce.
    return Promise.resolve(this.tl.reduce<XTweet[]>((acc, t) => [...acc, { ...t }], []));
  }
  readMentions(): Promise<XMention[]> {
    return Promise.resolve(this.mn.reduce<XMention[]>((acc, m) => [...acc, { ...m }], []));
  }
  postTweet(text: string): Promise<void> {
    this.postedTweets.push(text);
    return Promise.resolve();
  }
  postReply(ref: string, text: string): Promise<void> {
    this.postedReplies.push({ ref, text });
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** A fake LLM that always succeeds with the fixed body and counts its invocations. */
function makeFakeLlm(): { llm: (cfg: { apiKey: string; model: string }, messages: ChatMessage[]) => Promise<LlmResult>; calls: { count: number } } {
  const calls = { count: 0 };
  const llm = (
    _cfg: { apiKey: string; model: string },
    _messages: ChatMessage[],
  ): Promise<LlmResult> => {
    calls.count += 1;
    return Promise.resolve({ ok: true, content: LLM_BODY });
  };
  return { llm, calls };
}

/** Inert logger — only identifiers/counts ever reach it; most tests ignore them. */
const inertLogger: Logger = {
  info: () => undefined,
  error: () => undefined,
};

/** A capturing logger so the dry-run test can assert the dry-run events fired. */
function makeCapturingLogger(): { logger: Logger; events: string[] } {
  const events: string[] = [];
  const logger: Logger = {
    info: (message) => events.push(message),
    error: (message) => events.push(message),
  };
  return { logger, events };
}

/** Build a fully-resolved X capability config; rate gates wide open unless overridden. */
function makeXConfig(overrides: Partial<XChannelConfig> = {}): XChannelConfig {
  return {
    enabled: true,
    credentials: { username: 'roza_thinker', password: 'secret-password' },
    storageStatePath: '/tmp/roza-test/x_storage_state.json',
    autonomyIntervalMinutes: 60,
    // dailyPostLimit huge + actionSpacingMs 0 so neither Rate_Limit gate blocks.
    rateLimit: { dailyPostLimit: 1_000_000, actionSpacingMs: 0 },
    maxTopics: 3,
    maxPostChars: 280,
    dryRun: false,
    ...overrides,
  };
}

/** Build a fully-resolved RozaConfig carrying the supplied X capability. */
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

/** Read all `x_actions` rows (oldest-first by created_at is not needed for these counts). */
function allAuditRows(repo: Repository): XActionRow[] {
  return repo.listXActionsSince('1970-01-01T00:00:00.000Z');
}

// ───────────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────────

describe('X_Connector example/integration runs with in-memory fakes (Task 8.6)', () => {
  // Validates: Requirements 4.1, 4.2, 5.3, 10.1
  it('autonomy happy path: timeline → topic → post → audit', async () => {
    const timeline: XTweet[] = [
      { id: 't1', author: '@a', text: 'AI regulation is heating up across the EU.' },
      { id: 't2', author: '@b', text: 'Open-source models are closing the gap fast.' },
    ];
    const { session, calls } = makeFakeSession({ authenticated: true, timeline, mentions: [] });
    const { llm, calls: llmCalls } = makeFakeLlm();
    const { db, repo } = makeRepo();
    try {
      const connector = createXConnector({
        session,
        cfg: makeConfig(makeXConfig()),
        profile: () => DEFAULT_PROFILE,
        llm,
        repo,
        now: () => FIXED_NOW,
        timezone: TIMEZONE,
        logger: inertLogger,
      });

      await connector.runXAutonomy();

      // Two Hot_Topics extracted ⇒ two formulations ⇒ two published Roza_Posts (Req 4.2, 5.3).
      expect(llmCalls.count).toBe(2);
      expect(calls.postTweet).toEqual([LLM_BODY, LLM_BODY]);
      // An authenticated restored session ⇒ no fresh login (Req 3.2).
      expect(calls.login).toHaveLength(0);
      // Exactly one additive audit row per published post (Req 10.1).
      const rows = allAuditRows(repo);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.action_type === 'post')).toBe(true);
      expect(rows.every((r) => r.content === LLM_BODY)).toBe(true);
      expect(rows.every((r) => r.mention_ref === null)).toBe(true);
      // The session is always released (Req 11.4).
      expect(calls.closed).toBe(1);
    } finally {
      db.close();
    }
  });

  // Validates: Requirements 6.1, 6.3 (and 6.4 dedupe, 10.1 audit)
  it('reply loop happy path: mentions → dedupe → reply → audit', async () => {
    const mentions: XMention[] = [
      { ref: 'm1', author: '@x', text: 'What do you think about this?' },
      { ref: 'm2', author: '@y', text: 'Curious for your take.' },
      { ref: 'm3', author: '@z', text: 'Already answered earlier.' },
    ];
    // Empty Timeline ⇒ the run exercises only the reply loop.
    const { session, calls } = makeFakeSession({ authenticated: true, timeline: [], mentions });
    const { llm, calls: llmCalls } = makeFakeLlm();
    const { db, repo } = makeRepo();
    try {
      // Pre-seed m3 as already replied so dedupe excludes it (Req 6.4).
      repo.recordXAction({
        actionType: 'reply',
        content: 'an earlier reply',
        mentionRef: 'm3',
        createdAt: FIXED_NOW.toISOString(),
      });

      const connector = createXConnector({
        session,
        cfg: makeConfig(makeXConfig()),
        profile: () => DEFAULT_PROFILE,
        llm,
        repo,
        now: () => FIXED_NOW,
        timezone: TIMEZONE,
        logger: inertLogger,
      });

      await connector.runXAutonomy();

      // No original posts (empty Timeline); only the two unreplied mentions answered (Req 6.1, 6.3).
      expect(calls.postTweet).toHaveLength(0);
      expect(llmCalls.count).toBe(2);
      expect(calls.postReply).toEqual([
        { ref: 'm1', text: LLM_BODY },
        { ref: 'm2', text: LLM_BODY },
      ]);
      // m3 (already replied) was never replied to again (Req 6.4).
      expect(calls.postReply.some((c) => c.ref === 'm3')).toBe(false);

      // Audit: the seed reply (m3) plus the two new replies, each additive (Req 10.1).
      const replyRows = allAuditRows(repo).filter((r) => r.action_type === 'reply');
      expect(replyRows).toHaveLength(3);
      expect(new Set(replyRows.map((r) => r.mention_ref))).toEqual(new Set(['m1', 'm2', 'm3']));
      const newRows = replyRows.filter((r) => r.mention_ref === 'm1' || r.mention_ref === 'm2');
      expect(newRows.every((r) => r.content === LLM_BODY)).toBe(true);
      expect(calls.closed).toBe(1);
    } finally {
      db.close();
    }
  });

  // Validates: Requirement 3.3 — no valid session state ⇒ login + persist.
  it('no valid session state: connector logs in and persists the new state', async () => {
    const timeline: XTweet[] = [{ id: 't1', author: '@a', text: 'A fresh topic to post about.' }];
    const stateStore = { value: null as string | null };
    const { session, calls } = makeFakeSession({
      authenticated: false, // X reports the session is not authenticated.
      timeline,
      mentions: [],
      stateStore,
      loginNewState: 'FRESH-AUTHENTICATED-STATE',
    });
    const { llm } = makeFakeLlm();
    const { db, repo } = makeRepo();
    try {
      const cfg = makeConfig(makeXConfig());
      const connector = createXConnector({
        session,
        cfg,
        profile: () => DEFAULT_PROFILE,
        llm,
        repo,
        now: () => FIXED_NOW,
        timezone: TIMEZONE,
        logger: inertLogger,
      });

      await connector.runXAutonomy();

      // A fresh login was performed with exactly the configured X_Credentials (Req 3.3).
      expect(calls.login).toHaveLength(1);
      expect(calls.login[0]).toEqual(cfg.x.credentials);
      // The resulting state was persisted (Req 3.3).
      expect(calls.persistState).toBeGreaterThanOrEqual(1);
      expect(stateStore.value).toBe('FRESH-AUTHENTICATED-STATE');
      // Ordering: open → isAuthenticated → login → persistState → readTimeline.
      expect(calls.order.slice(0, 5)).toEqual([
        'open',
        'isAuthenticated',
        'login',
        'persistState',
        'readTimeline',
      ]);
      // The run continues normally and publishes after the login (Req 3.3 → 4.2/5.3).
      expect(calls.postTweet).toEqual([LLM_BODY]);
      expect(allAuditRows(repo)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  // Validates: Requirement 3.5 — an expired restored state triggers a fresh login
  // that REPLACES the stored state.
  it('expired restored state: fresh login replaces the stored session state', async () => {
    const timeline: XTweet[] = [{ id: 't1', author: '@a', text: 'Another topic worth a post.' }];
    // A stale state is present but X rejects it as expired (isAuthenticated=false).
    const stateStore = { value: 'EXPIRED-STALE-STATE' as string | null };
    const { session, calls } = makeFakeSession({
      authenticated: false,
      timeline,
      mentions: [],
      stateStore,
      loginNewState: 'REPLACEMENT-AUTHENTICATED-STATE',
    });
    const { llm } = makeFakeLlm();
    const { db, repo } = makeRepo();
    try {
      const cfg = makeConfig(makeXConfig());
      const connector = createXConnector({
        session,
        cfg,
        profile: () => DEFAULT_PROFILE,
        llm,
        repo,
        now: () => FIXED_NOW,
        timezone: TIMEZONE,
        logger: inertLogger,
      });

      await connector.runXAutonomy();

      // A fresh login replaced the expired state with the new authenticated state (Req 3.5).
      expect(calls.login).toHaveLength(1);
      expect(calls.login[0]).toEqual(cfg.x.credentials);
      expect(calls.persistState).toBeGreaterThanOrEqual(1);
      expect(stateStore.value).toBe('REPLACEMENT-AUTHENTICATED-STATE');
      expect(stateStore.value).not.toBe('EXPIRED-STALE-STATE');
      // The run still proceeds to publish after the replacement login.
      expect(calls.postTweet).toEqual([LLM_BODY]);
    } finally {
      db.close();
    }
  });

  // Validates: Requirement 2.3 — a swapped ALTERNATE XSession implementation
  // produces identical orchestration, proving the interface is swappable.
  it('a swapped alternate XSession fake produces identical orchestration', async () => {
    const timeline: XTweet[] = [
      { id: 't1', author: '@a', text: 'Topic one for the timeline.' },
      { id: 't2', author: '@b', text: 'Topic two for the timeline.' },
    ];
    const mentions: XMention[] = [
      { ref: 'm1', author: '@x', text: 'Mention one.' },
      { ref: 'm2', author: '@y', text: 'Mention two.' },
    ];
    const cfg = makeConfig(makeXConfig());

    // --- Run A: the primary (object-literal) fake session ---
    const { session: primary, calls } = makeFakeSession({ authenticated: true, timeline, mentions });
    const { llm: llmA } = makeFakeLlm();
    const repoA = makeRepo();
    try {
      await createXConnector({
        session: primary,
        cfg,
        profile: () => DEFAULT_PROFILE,
        llm: llmA,
        repo: repoA.repo,
        now: () => FIXED_NOW,
        timezone: TIMEZONE,
        logger: inertLogger,
      }).runXAutonomy();

      // --- Run B: a deliberately different (class-based) XSession implementation ---
      const alternate = new AlternateFakeSession(timeline, mentions);
      const { llm: llmB } = makeFakeLlm();
      const repoB = makeRepo();
      try {
        await createXConnector({
          session: alternate,
          cfg,
          profile: () => DEFAULT_PROFILE,
          llm: llmB,
          repo: repoB.repo,
          now: () => FIXED_NOW,
          timezone: TIMEZONE,
          logger: inertLogger,
        }).runXAutonomy();

        // Identical published posts and replies across both implementations (Req 2.3).
        expect(alternate.postedTweets).toEqual(calls.postTweet);
        expect(alternate.postedReplies).toEqual(calls.postReply);

        // Identical audit outcome (same action types, contents, and mention refs).
        const summarize = (rows: XActionRow[]) =>
          rows
            .map((r) => `${r.action_type}|${r.content}|${r.mention_ref ?? ''}`)
            .sort();
        expect(summarize(allAuditRows(repoB.repo))).toEqual(summarize(allAuditRows(repoA.repo)));

        // Sanity: the run actually did something to compare.
        expect(calls.postTweet).toHaveLength(2);
        expect(calls.postReply).toHaveLength(2);
      } finally {
        repoB.db.close();
      }
    } finally {
      repoA.db.close();
    }
  });

  // Validates: Requirement 5.3 (dry-run) — dryRun=true formulates but NEVER publishes.
  it('dryRun=true formulates content but never publishes a post or reply', async () => {
    const timeline: XTweet[] = [
      { id: 't1', author: '@a', text: 'A topic to dry-run.' },
      { id: 't2', author: '@b', text: 'Another topic to dry-run.' },
    ];
    const mentions: XMention[] = [{ ref: 'm1', author: '@x', text: 'A mention to dry-run.' }];
    const { session, calls } = makeFakeSession({ authenticated: true, timeline, mentions });
    const { llm, calls: llmCalls } = makeFakeLlm();
    const { logger, events } = makeCapturingLogger();
    const { db, repo } = makeRepo();
    try {
      const connector = createXConnector({
        session,
        cfg: makeConfig(makeXConfig({ dryRun: true })),
        profile: () => DEFAULT_PROFILE,
        llm,
        repo,
        now: () => FIXED_NOW,
        timezone: TIMEZONE,
        logger,
      });

      await connector.runXAutonomy();

      // Formulation still happens (two topics + one mention = three LLM calls).
      expect(llmCalls.count).toBe(3);
      // But NOTHING is ever published — no postTweet, no postReply (Req 5.3 dry-run).
      expect(calls.postTweet).toHaveLength(0);
      expect(calls.postReply).toHaveLength(0);
      // The dry-run path emits dedicated events and writes no audit rows.
      expect(events).toContain('x.autonomy.post_dry_run');
      expect(events).toContain('x.autonomy.reply_dry_run');
      expect(allAuditRows(repo)).toHaveLength(0);
      // The session is still released cleanly (Req 11.4).
      expect(calls.closed).toBe(1);
    } finally {
      db.close();
    }
  });
});
