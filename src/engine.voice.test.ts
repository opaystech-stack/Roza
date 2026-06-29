import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { operativeChannels, decideChannel } from './engine.js';
import type { Channel } from './types.js';
import type { RozaConfig } from './config.js';

/**
 * Property-based test for the voice channel's operative gating and the mutual
 * independence of every channel's membership in the operative set (Phase 3).
 *
 * Feature: roza-step3-voice-telephony, Property 1: Voice channel gating and channel independence
 *
 * For ANY combination of `telegram.enabled` / `mail.enabled` / `voice.enabled`:
 *   - `operativeChannels(cfg)` always contains `internal`;
 *   - contains `telegram` iff `telegram.enabled`;
 *   - contains `email` iff `mail.enabled`;
 *   - contains `voice` iff `voice.enabled`;
 *   - is a subset of `{ internal, telegram, email, voice }`;
 *   - and each membership is independent of the others (toggling one flag never
 *     changes the membership of another channel).
 * And `decideChannel('voice', cfg)` returns `{ ok: true }` iff `voice.enabled`
 * (otherwise `{ ok: false, reason: 'channel_not_operative' }`); while
 * `decideChannel('internal', cfg)` is always `{ ok: true }`.
 *
 * Validates: Requirements 1.1, 1.3, 1.4, 1.5, 13.1, 14.1
 *
 * The functions under test are pure (no I/O), so this exercises the full
 * 2x2x2 = 8 enablement combinations directly with no database or network.
 */

const NUM_RUNS = 100;

/** The complete, closed universe of channels Roza recognises (Req 13.1, 14.1). */
const ALL_CHANNELS: Channel[] = ['internal', 'telegram', 'email', 'voice'];

/**
 * Build a minimal but fully-valid `RozaConfig`, varying ONLY the three channel
 * `enabled` flags. Every other field is a fixed, structurally-complete default
 * so `operativeChannels` / `decideChannel` see a real config shape (mirrors the
 * fixture pattern in engine.channels.test.ts, extended with the voice flag).
 */
function makeConfig(flags: {
  telegramEnabled: boolean;
  mailEnabled: boolean;
  voiceEnabled: boolean;
}): RozaConfig {
  return {
    rozaPrivateKey: 'test-private-key',
    openRouterApiKey: 'test-api-key',
    openRouterModel: 'openai/gpt-4o-mini',
    dataDir: '/tmp/roza-voice-test',
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
  };
}

describe('Voice channel gating and channel independence (Property 1)', () => {
  // Feature: roza-step3-voice-telephony, Property 1: Voice channel gating and channel independence
  // Validates: Requirements 1.1, 1.3, 1.4, 1.5, 13.1, 14.1
  it('operativeChannels gates each channel on exactly its own flag, independently', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (telegramEnabled, mailEnabled, voiceEnabled) => {
          const cfg = makeConfig({ telegramEnabled, mailEnabled, voiceEnabled });
          const operative = operativeChannels(cfg);

          // `internal` is always operative regardless of any flag (Req 1.3, 13.1).
          expect(operative.has('internal')).toBe(true);
          // Each optional channel is operative iff its OWN flag is set (Req 1.4, 1.5).
          expect(operative.has('telegram')).toBe(telegramEnabled);
          expect(operative.has('email')).toBe(mailEnabled);
          expect(operative.has('voice')).toBe(voiceEnabled);

          // The operative set is a subset of the closed channel universe — no
          // unknown channel ever appears (Req 13.1, 14.1).
          for (const channel of operative) {
            expect(ALL_CHANNELS).toContain(channel);
          }

          // Independence: each membership equals exactly its own flag and is
          // unaffected by the other two. Toggling voice never changes telegram/
          // email/internal, and vice versa (Req 1.4, 1.5).
          const expectedMembership: Record<Channel, boolean> = {
            internal: true,
            telegram: telegramEnabled,
            email: mailEnabled,
            voice: voiceEnabled,
          };
          for (const channel of ALL_CHANNELS) {
            expect(operative.has(channel)).toBe(expectedMembership[channel]);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: roza-step3-voice-telephony, Property 1: Voice channel gating and channel independence
  // Validates: Requirements 1.1, 1.3, 1.4, 1.5, 13.1, 14.1
  it('decideChannel gates voice on voice.enabled and always admits internal', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (telegramEnabled, mailEnabled, voiceEnabled) => {
          const cfg = makeConfig({ telegramEnabled, mailEnabled, voiceEnabled });

          // `decideChannel('voice', cfg)` is ok iff voice is enabled, else the
          // not-operative rejection (Req 1.1, 1.4).
          const voiceDecision = decideChannel('voice', cfg);
          if (voiceEnabled) {
            expect(voiceDecision).toEqual({ ok: true });
          } else {
            expect(voiceDecision).toEqual({ ok: false, reason: 'channel_not_operative' });
          }

          // `internal` is always admitted, independent of every flag (Req 1.3).
          expect(decideChannel('internal', cfg)).toEqual({ ok: true });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
