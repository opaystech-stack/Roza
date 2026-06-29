// Feature: roza-step4-avatar-video, Property 1: Avatar capability gating and channel independence
//
// Validates: Requirements 1.1, 1.4, 1.5, 11.1, 12.1
//
// Property 1 asserts two independent guarantees of the avatar capability gate:
//
//   1. CAPABILITY GATING (Req 1.1, 1.4) — `decideAvatar(capability, cfg)` is
//      `{ ok: true }` exactly when the requested capability is enabled:
//        - `'avatar'` iff `cfg.avatar.enabled`;
//        - `'meet'`   iff `cfg.avatar.enabled && cfg.avatar.meet.enabled`;
//        - `'stream'` iff `cfg.avatar.enabled && cfg.avatar.stream.enabled`.
//      A sub-capability is never operative while the base avatar is disabled,
//      and every other case returns `{ ok: false, reason: 'avatar_not_enabled' }`.
//      The gate is total — it produces a verdict for every combination of the
//      three enable flags with no I/O.
//
//   2. CHANNEL INDEPENDENCE (Req 1.5, 11.1, 12.1) — the avatar is a presence/
//      output capability, NOT a conversation `Channel`. Therefore
//      `operativeChannels(cfg)` is byte-for-byte IDENTICAL for any two configs
//      that differ ONLY in their `cfg.avatar.*` fields: the avatar capability
//      never changes which conversation channels are operative and adds no
//      member (no `'avatar'` literal) to the operative set.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { decideAvatar, type AvatarCapability } from './avatarConnector.js';
import { operativeChannels } from '../../engine.js';
import type {
  RozaConfig,
  AvatarChannelConfig,
  AvatarPixelFormat,
} from '../../config.js';
import type { Channel } from '../../types.js';

/** Minimum fast-check iterations mandated by the design for every property. */
const NUM_RUNS = 100;

/** The conversation channels the avatar capability must never disturb. */
const ALL_CHANNELS: Channel[] = ['internal', 'telegram', 'email', 'voice'];

/** The three avatar capabilities the gate classifies. */
const capabilityArb: fc.Arbitrary<AvatarCapability> = fc.constantFrom(
  'avatar' as const,
  'meet' as const,
  'stream' as const,
);

const pixelFormatArb: fc.Arbitrary<AvatarPixelFormat> = fc.constantFrom(
  'rgba' as const,
  'yuv420p' as const,
  'nv12' as const,
);

/**
 * Generate a complete `AvatarChannelConfig` whose enable flags vary freely
 * while every other field stays well-formed (matching the disabled-avatar
 * fixture shape used across the suite). Credential/device/renderer values are
 * arbitrary text — the gate must depend ONLY on the enable flags.
 */
const avatarArb: fc.Arbitrary<AvatarChannelConfig> = fc.record({
  enabled: fc.boolean(),
  video: fc.record({
    width: fc.integer({ min: 1, max: 1920 }),
    height: fc.integer({ min: 1, max: 1080 }),
    fps: fc.integer({ min: 1, max: 60 }),
    pixelFormat: pixelFormatArb,
  }),
  latency: fc.record({ renderMs: fc.integer({ min: 1, max: 60000 }) }),
  renderer: fc.record({ endpoint: fc.string(), engine: fc.string() }),
  devices: fc.record({ camera: fc.string(), microphone: fc.string() }),
  meet: fc.record({
    enabled: fc.boolean(),
    consent: fc.boolean(),
    account: fc.string(),
    password: fc.string(),
  }),
  stream: fc.record({
    enabled: fc.boolean(),
    url: fc.string(),
    key: fc.string(),
  }),
});

/**
 * Build a fully-resolved `RozaConfig` whose conversation-channel enablement is
 * controlled per case and whose `avatar` field is supplied by the caller. The
 * non-avatar fields mirror `engine.channels.test.ts`'s fixture so the only
 * variable under test is what we explicitly vary.
 */
function makeConfig(opts: {
  telegramEnabled: boolean;
  mailEnabled: boolean;
  voiceEnabled: boolean;
  avatar: AvatarChannelConfig;
}): RozaConfig {
  return {
    rozaPrivateKey: 'test-private-key',
    openRouterApiKey: 'test-api-key',
    openRouterModel: 'openai/gpt-4o-mini',
    dataDir: '/tmp/roza-test',
    timezone: 'Africa/Kinshasa',
    activeWindow: { startMinutes: 420, endMinutes: 1320 },
    keyVersion: 'v1',
    telegram: {
      enabled: opts.telegramEnabled,
      botToken: opts.telegramEnabled ? 'test-bot-token' : '',
      allowlist: [],
    },
    mail: {
      enabled: opts.mailEnabled,
      imap: { host: '', port: 0, user: '', password: '' },
      smtp: { host: '', port: 0, user: '', password: '' },
      allowlist: [],
    },
    voice: {
      enabled: opts.voiceEnabled,
      sip: { host: '', port: 0, user: '', password: '', realm: '' },
      allowlist: [],
      defaultAccess: 'reject',
      quietHoursInbound: 'take_message',
      tts: { engine: 'piper', voice: 'en_US-amy-medium', model: 'en_US-amy-medium' },
      stt: { engine: 'whisper.cpp', model: 'ggml-base.en' },
      maxReplyChars: 1000,
      latency: { ttsMs: 5000, sttMs: 5000, endToEndMs: 8000, ringTimeoutMs: 30000 },
    },
    avatar: opts.avatar,
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
  };
}

describe('Avatar capability gating and channel independence (Property 1)', () => {
  // Feature: roza-step4-avatar-video, Property 1: Avatar capability gating and channel independence
  // Validates: Requirements 1.1, 1.4, 1.5, 11.1, 12.1
  it('decideAvatar is ok iff the requested capability is enabled, for every flag combination', () => {
    fc.assert(
      fc.property(
        capabilityArb,
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        avatarArb,
        (capability, telegramEnabled, mailEnabled, voiceEnabled, avatar) => {
          const cfg = makeConfig({ telegramEnabled, mailEnabled, voiceEnabled, avatar });

          const decision = decideAvatar(capability, cfg);

          // The expected truth table: the base capability gates everything, and
          // each sub-capability additionally requires its own enable flag.
          const expectedOk =
            capability === 'avatar'
              ? avatar.enabled
              : capability === 'meet'
                ? avatar.enabled && avatar.meet.enabled
                : avatar.enabled && avatar.stream.enabled;

          if (expectedOk) {
            expect(decision).toEqual({ ok: true });
          } else {
            expect(decision).toEqual({ ok: false, reason: 'avatar_not_enabled' });
          }

          // A sub-capability is NEVER operative while the base avatar is off.
          if (!avatar.enabled && capability !== 'avatar') {
            expect(decision).toEqual({ ok: false, reason: 'avatar_not_enabled' });
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: roza-step4-avatar-video, Property 1: Avatar capability gating and channel independence
  // Validates: Requirements 1.1, 1.4, 1.5, 11.1, 12.1
  it('operativeChannels is identical for any two configs differing only in cfg.avatar.*', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        avatarArb,
        avatarArb,
        (telegramEnabled, mailEnabled, voiceEnabled, avatarA, avatarB) => {
          // Two configs that agree on every conversation-channel field and
          // differ ONLY in their avatar capability sub-config.
          const cfgA = makeConfig({ telegramEnabled, mailEnabled, voiceEnabled, avatar: avatarA });
          const cfgB = makeConfig({ telegramEnabled, mailEnabled, voiceEnabled, avatar: avatarB });

          const operativeA = operativeChannels(cfgA);
          const operativeB = operativeChannels(cfgB);

          // The avatar capability changes nothing about the operative set: same
          // size and same members regardless of avatar.* (Req 1.5, 12.1).
          expect(operativeA.size).toBe(operativeB.size);
          for (const channel of ALL_CHANNELS) {
            expect(operativeA.has(channel)).toBe(operativeB.has(channel));
          }

          // And it adds no new member: the operative set is a subset of the
          // four conversation channels — no `'avatar'` literal ever appears
          // (Req 11.1).
          for (const member of operativeA) {
            expect(ALL_CHANNELS).toContain(member);
          }
          // The operative set tracks ONLY the conversation-channel flags.
          expect(operativeA.has('internal')).toBe(true);
          expect(operativeA.has('telegram')).toBe(telegramEnabled);
          expect(operativeA.has('email')).toBe(mailEnabled);
          expect(operativeA.has('voice')).toBe(voiceEnabled);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
