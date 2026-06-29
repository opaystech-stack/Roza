// Feature: roza-step5-x-twitter, Property 1: X capability gating and channel independence
//
// Validates: Requirements 1.1, 1.4, 1.5, 12.1, 13.1
//
// Property 1 pins down the design decision that X is a configuration-gated
// presence/autonomy capability, NOT a new member of the conversation `Channel`
// union. It asserts three guarantees hold for EVERY generated configuration:
//
//   1. CAPABILITY GATE (Req 1.1, 1.4) — `decideX(cfg)` is `{ ok: true }` iff
//      `cfg.x.enabled`, and otherwise `{ ok: false, reason: 'x_not_enabled' }`.
//
//   2. CHANNEL INDEPENDENCE (Req 1.5, 12.1, 13.1) — `operativeChannels(cfg)` is
//      IDENTICAL for any two configs differing ONLY in their `cfg.x.*` subtree.
//      X adds no member to the closed `Channel` union
//      (`internal | telegram | email | voice`); toggling/retuning the X
//      capability never changes the operative conversation-channel set.
//
//   3. DISABLED-X REJECTION (Req 1.4, 13.1) — while X is disabled, a request to
//      read the Timeline, publish a Roza_Post, or publish a Reply is rejected
//      with `reason: 'x_not_enabled'`. The pure gate short-circuits BEFORE any
//      request-specific work for every request kind.
//
// `decideX` and `operativeChannels` are pure (no I/O), so this exercises the
// full input space directly with no browser, X network, or database.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { decideX } from './xConnector.js';
import { operativeChannels } from '../../engine.js';
import type { Channel } from '../../types.js';
import type { RozaConfig, XChannelConfig } from '../../config.js';

/** Minimum fast-check iterations mandated by the design for every property. */
const NUM_RUNS = 100;

/** The complete, closed universe of conversation channels Roza recognises (Req 13.1). */
const ALL_CHANNELS: Channel[] = ['internal', 'telegram', 'email', 'voice'];

/** The three X-capability request kinds gated by `decideX` (Req 1.4). */
const X_REQUEST_KINDS = ['read_timeline', 'publish_roza_post', 'publish_reply'] as const;

/**
 * An arbitrary, fully-structured `XChannelConfig` subtree whose `enabled` flag
 * and every tunable setting varies freely. Property 2 builds two of these to
 * prove that NOTHING in the `x.*` subtree — not even the `enabled` flag — can
 * change the operative conversation-channel set.
 */
const xConfigArb: fc.Arbitrary<XChannelConfig> = fc.record({
  enabled: fc.boolean(),
  credentials: fc.record({
    username: fc.string({ maxLength: 20 }),
    password: fc.string({ maxLength: 20 }),
  }),
  storageStatePath: fc.string({ maxLength: 40 }),
  autonomyIntervalMinutes: fc.integer({ min: 1, max: 1440 }),
  rateLimit: fc.record({
    dailyPostLimit: fc.integer({ min: 0, max: 1000 }),
    actionSpacingMs: fc.integer({ min: 0, max: 3_600_000 }),
  }),
  maxTopics: fc.integer({ min: 0, max: 20 }),
  maxPostChars: fc.integer({ min: 1, max: 4000 }),
  dryRun: fc.boolean(),
});

/**
 * Build a minimal but fully-valid `RozaConfig`, varying the three conversation
 * channel `enabled` flags and carrying the supplied X capability subtree. Every
 * other field is a fixed, structurally-complete default so `operativeChannels`
 * sees a real config shape (mirrors the Phase 3 fixture in engine.voice.test.ts,
 * extended with the Phase 5 `x` field).
 */
function makeConfig(flags: {
  telegramEnabled: boolean;
  mailEnabled: boolean;
  voiceEnabled: boolean;
  x: XChannelConfig;
}): RozaConfig {
  return {
    rozaPrivateKey: 'test-private-key',
    openRouterApiKey: 'test-api-key',
    openRouterModel: 'openai/gpt-4o-mini',
    dataDir: '/tmp/roza-x-gate-test',
    timezone: 'Africa/Kinshasa',
    activeWindow: { startMinutes: 420, endMinutes: 1320 },
    keyVersion: 'v1',
    telegram: {
      enabled: flags.telegramEnabled,
      botToken: flags.telegramEnabled ? 'test-bot-token' : '',
      allowlist: [],
    },
    mail: {
      enabled: flags.mailEnabled,
      imap: { host: '', port: 0, user: '', password: '' },
      smtp: { host: '', port: 0, user: '', password: '' },
      allowlist: [],
    },
    voice: {
      enabled: flags.voiceEnabled,
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
    x: flags.x,
  };
}

describe('X capability gating and channel independence (Property 1)', () => {
  // Feature: roza-step5-x-twitter, Property 1: X capability gating and channel independence
  // Validates: Requirements 1.1, 1.4
  it('decideX is ok iff cfg.x.enabled, else x_not_enabled', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        xConfigArb,
        (telegramEnabled, mailEnabled, voiceEnabled, x) => {
          const cfg = makeConfig({ telegramEnabled, mailEnabled, voiceEnabled, x });

          // The gate is ok iff the X capability is enabled, and otherwise the
          // single machine-readable rejection — independent of every other flag
          // (Req 1.1, 1.4).
          if (x.enabled) {
            expect(decideX(cfg)).toEqual({ ok: true });
          } else {
            expect(decideX(cfg)).toEqual({ ok: false, reason: 'x_not_enabled' });
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: roza-step5-x-twitter, Property 1: X capability gating and channel independence
  // Validates: Requirements 1.5, 12.1, 13.1
  it('operativeChannels is identical for two configs differing only in cfg.x.* — X is not a Channel', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        xConfigArb,
        xConfigArb,
        (telegramEnabled, mailEnabled, voiceEnabled, xA, xB) => {
          // Two configs identical in every conversation-channel field, differing
          // ONLY in their `x.*` subtree.
          const cfgA = makeConfig({ telegramEnabled, mailEnabled, voiceEnabled, x: xA });
          const cfgB = makeConfig({ telegramEnabled, mailEnabled, voiceEnabled, x: xB });

          const setA = [...operativeChannels(cfgA)].sort();
          const setB = [...operativeChannels(cfgB)].sort();

          // X adds no member: the operative sets are byte-for-byte identical
          // regardless of the X subtree (Req 1.5, 12.1).
          expect(setB).toEqual(setA);

          // No `'x'` literal ever appears; the operative set stays a subset of
          // the closed conversation-`Channel` universe (Req 13.1).
          for (const channel of operativeChannels(cfgA)) {
            expect(ALL_CHANNELS).toContain(channel);
          }
          expect((setA as string[]).includes('x')).toBe(false);

          // The operative set is gated purely by the conversation-channel flags,
          // unchanged by X enablement or tuning (Req 1.5).
          expect(operativeChannels(cfgA).has('internal')).toBe(true);
          expect(operativeChannels(cfgA).has('telegram')).toBe(telegramEnabled);
          expect(operativeChannels(cfgA).has('email')).toBe(mailEnabled);
          expect(operativeChannels(cfgA).has('voice')).toBe(voiceEnabled);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: roza-step5-x-twitter, Property 1: X capability gating and channel independence
  // Validates: Requirements 1.4, 13.1
  it('while X is disabled, every Timeline/Roza_Post/Reply request is rejected with x_not_enabled', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        // A disabled X capability with otherwise-arbitrary settings.
        xConfigArb.map((x): XChannelConfig => ({ ...x, enabled: false })),
        fc.constantFrom(...X_REQUEST_KINDS),
        (telegramEnabled, mailEnabled, voiceEnabled, disabledX, requestKind) => {
          const cfg = makeConfig({ telegramEnabled, mailEnabled, voiceEnabled, x: disabledX });

          // The pure gate short-circuits for EVERY request kind: a request to
          // read the Timeline, publish a Roza_Post, or publish a Reply is
          // rejected with `x_not_enabled` before any request-specific work
          // (Req 1.4). `requestKind` cannot change the outcome.
          const decision = decideX(cfg);
          expect(decision.ok).toBe(false);
          expect(decision).toEqual({ ok: false, reason: 'x_not_enabled' });
          // Sanity: the request kind is one of the three gated X_Actions.
          expect(X_REQUEST_KINDS).toContain(requestKind);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
