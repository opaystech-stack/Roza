// Feature: roza-step3-voice-telephony, Property 6: Voice access control — allowlist enforced before the engine, and on outbound origination
//
// Property-based test for the Voice_Connector access-control gate (Component
// V8). It exercises THREE faces of the same allowlist rule, each at a minimum
// of 100 fast-check iterations and driven entirely by in-memory fakes — no real
// audio, SIP, STT/TTS, or native binary ever runs (Req 14.5):
//
//   1. PURE HELPER — `isVoiceCallerAllowed(voiceCfg, caller)` agrees with the
//      design rule: an empty allowlist defers to `defaultAccess === 'allow'`;
//      a non-empty allowlist admits the caller iff some normalized entry equals
//      the normalized Caller_Identity (Req 10.6, 5.5, 11.5).
//   2. INBOUND — a call is answered and the Cognitive_Engine is reachable ONLY
//      for an allowed caller; a rejected caller is hung up, never answered, and
//      the engine is NEVER invoked (allowlist enforced BEFORE the engine —
//      Req 10.5, 11.5).
//   3. OUTBOUND — `placeOutboundCall(callee)` originates IFF the callee is
//      allowed; a rejected callee yields no `originate`, returns
//      `{ ok: false, reason: 'not_allowlisted' }`, and logs the rejection
//      (Req 5.5).
//
// Validates: Requirements 5.5, 10.5, 10.6, 11.5

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { randomUUID } from 'node:crypto';

import {
  createVoiceConnector,
  isVoiceCallerAllowed,
  type VoiceConnector,
} from './voiceConnector.js';
import { TELEPHONY_PCM_8K, type AudioChunk } from './audio.js';
import type { CallHandle, TelephonyGateway } from './telephony.asterisk.js';
import type { SttEngine, TurnDetector } from './stt.whisper.js';
import type { TtsEngine } from './tts.piper.js';
import type { CognitiveEngine, HandleMessageInput } from '../../engine.js';
import { normalizeCallerIdentity, userIdForVoice } from '../sender.js';
import type { ActiveWindow } from '../../window.js';
import type { Logger } from '../../types.js';
import type { RozaConfig, VoiceChannelConfig, VoiceDefaultAccess } from '../../config.js';

/** Minimum fast-check iterations mandated for the property tests. */
const NUM_RUNS = 100;

/** A fixed instant; combined with the all-day window below it is ALWAYS inside
 *  the Active_Window, so the Right-to-Disconnect gate never interferes here. */
const FIXED_DATE = new Date('2024-06-01T12:00:00.000Z');
const now = (): Date => FIXED_DATE;
const TIMEZONE = 'UTC';
/** Whole-day Active_Window: every minute-of-day is "active" (no quiet hours). */
const WINDOW: ActiveWindow = { startMinutes: 0, endMinutes: 1440 };

/* -------------------------------------------------------------------------- *
 * The spec oracle: the design rule for voice access control, expressed
 * independently of the implementation so the assertions cannot be circular.
 * -------------------------------------------------------------------------- */
function oracleAllowed(
  allowlist: readonly string[],
  defaultAccess: VoiceDefaultAccess,
  caller: string,
): boolean {
  if (allowlist.length === 0) {
    return defaultAccess === 'allow';
  }
  const c = normalizeCallerIdentity(caller);
  return allowlist.some((entry) => normalizeCallerIdentity(entry) === c);
}

/* -------------------------------------------------------------------------- *
 * Config fixture — a structurally complete RozaConfig with `voice` ENABLED
 * (operative) and the allowlist/defaultAccess under test injected per run.
 * -------------------------------------------------------------------------- */
function makeConfig(allowlist: string[], defaultAccess: VoiceDefaultAccess): RozaConfig {
  const voice: VoiceChannelConfig = {
    enabled: true,
    sip: { host: 'sip.example.com', port: 5060, user: 'roza', password: 'secret', realm: 'example.com' },
    allowlist,
    defaultAccess,
    quietHoursInbound: 'take_message',
    tts: { engine: 'piper', voice: 'en_US-amy-medium', model: 'en_US-amy-medium' },
    stt: { engine: 'whisper.cpp', model: 'ggml-base.en' },
    maxReplyChars: 1000,
    latency: { ttsMs: 5000, sttMs: 5000, endToEndMs: 8000, ringTimeoutMs: 30000 },
  };
  return {
    rozaPrivateKey: 'test-private-key',
    openRouterApiKey: 'test-api-key',
    openRouterModel: 'openai/gpt-4o-mini',
    dataDir: '/tmp/roza-test',
    timezone: TIMEZONE,
    activeWindow: WINDOW,
    keyVersion: 'v1',
    telegram: { enabled: false, botToken: '', allowlist: [] },
    mail: {
      enabled: false,
      imap: { host: '', port: 0, user: '', password: '' },
      smtp: { host: '', port: 0, user: '', password: '' },
      allowlist: [],
    },
    voice,
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

/* -------------------------------------------------------------------------- *
 * In-memory FAKES for every injected edge (no real I/O — Req 14.5).
 * -------------------------------------------------------------------------- */

/** A recording, push-driven fake {@link TelephonyGateway}. */
interface FakeGateway extends TelephonyGateway {
  readonly answered: string[];
  readonly originated: Array<{ callerIdentity: string; ringTimeoutMs: number }>;
  readonly hungUp: Array<{ callId: string; reason: string }>;
  readonly played: Array<{ callId: string; chunk: AudioChunk }>;
  /** Drive an inbound ringing call through the connector's `onInboundCall`. */
  emitInbound(handle: CallHandle): Promise<void>;
  /** Deliver one caller audio frame to the per-call turn loop. */
  emitAudio(callId: string, chunk: AudioChunk): void;
}

function makeFakeGateway(): FakeGateway {
  const answered: string[] = [];
  const originated: Array<{ callerIdentity: string; ringTimeoutMs: number }> = [];
  const hungUp: Array<{ callId: string; reason: string }> = [];
  const played: Array<{ callId: string; chunk: AudioChunk }> = [];
  const audioHandlers = new Map<string, (chunk: AudioChunk) => void>();
  let inboundHandler: ((call: CallHandle) => Promise<void>) | null = null;

  return {
    answered,
    originated,
    hungUp,
    played,
    listen(onInboundCall) {
      inboundHandler = onInboundCall;
      return Promise.resolve();
    },
    answer(callId) {
      answered.push(callId);
      return Promise.resolve();
    },
    originate(callerIdentity, opts) {
      originated.push({ callerIdentity, ringTimeoutMs: opts.ringTimeoutMs });
      const handle: CallHandle = { callId: randomUUID(), callerIdentity, direction: 'outbound' };
      return Promise.resolve(handle);
    },
    onAudio(callId, onFrame) {
      audioHandlers.set(callId, onFrame);
    },
    playAudio(callId, chunk) {
      played.push({ callId, chunk });
      return Promise.resolve();
    },
    hangup(callId, reason) {
      hungUp.push({ callId, reason });
      return Promise.resolve();
    },
    onCallEnded() {
      // No-op: out-of-band teardown is not exercised by this property.
    },
    async emitInbound(handle) {
      if (inboundHandler) {
        await inboundHandler(handle);
      }
    },
    emitAudio(callId, chunk) {
      audioHandlers.get(callId)?.(chunk);
    },
  };
}

/** A fake engine that records every `handleMessage` it receives. */
interface FakeEngine {
  readonly calls: HandleMessageInput[];
  readonly engine: CognitiveEngine;
}
function makeFakeEngine(reply = 'roza voice reply'): FakeEngine {
  const calls: HandleMessageInput[] = [];
  const engine = {
    handleMessage(input: HandleMessageInput) {
      calls.push(input);
      return Promise.resolve({ ok: true as const, reply, conversationId: 'conv-1' });
    },
  };
  return { calls, engine: engine as unknown as CognitiveEngine };
}

/** A fake STT engine that returns a fixed (non-empty) transcript. */
function makeFakeStt(transcript: string): SttEngine {
  return {
    transcribe: () => Promise.resolve(transcript),
    descriptor: { name: 'whisper.cpp', license: 'MIT', model: 'ggml-base.en' },
  };
}

/** A fake TTS engine that returns a tiny playable chunk. */
function makeFakeTts(): TtsEngine {
  return {
    synthesize: () =>
      Promise.resolve<AudioChunk>({ format: TELEPHONY_PCM_8K, data: new Uint8Array([0, 0]) }),
    descriptor: { name: 'piper', license: 'MIT', voice: 'en_US-amy-medium' },
  };
}

/**
 * A fake TurnDetector factory: the first frame is `'speaking'` (accumulating
 * turn audio), the next is `'turn_end'` (closing the turn). One turn is enough
 * to confirm the engine is reachable for an allowed caller.
 */
function makeTurnDetectorFactory(): () => TurnDetector {
  return () => {
    let n = 0;
    return {
      push: () => {
        n += 1;
        return n === 1 ? 'speaking' : 'turn_end';
      },
      reset: () => {
        n = 0;
      },
    };
  };
}

/** A recording logger so the outbound-rejection log can be asserted (Req 5.5). */
interface SpyLogger extends Logger {
  readonly errors: Array<{ message: string; meta?: Record<string, unknown> }>;
}
function makeLogger(): SpyLogger {
  const errors: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  return {
    errors,
    info: () => undefined,
    error: (message, meta) => {
      errors.push(meta === undefined ? { message } : { message, meta });
    },
  };
}

/** Flush the microtask queue so the fire-and-forget turn loop settles. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeConnector(
  gateway: FakeGateway,
  engine: CognitiveEngine,
  stt: SttEngine,
  cfg: RozaConfig,
  logger: Logger,
): VoiceConnector {
  return createVoiceConnector({
    gateway,
    stt,
    tts: makeFakeTts(),
    turnDetector: makeTurnDetectorFactory(),
    engine,
    cfg,
    window: WINDOW,
    timezone: TIMEZONE,
    now,
    logger,
  });
}

/* -------------------------------------------------------------------------- *
 * Generators.
 * -------------------------------------------------------------------------- */

const digitsArb = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 6, maxLength: 12 })
  .map((a) => a.join(''));

const sipUserArb = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
    minLength: 3,
    maxLength: 10,
  })
  .map((a) => a.join(''));

/**
 * A Caller_Identity plus a formatting-VARIANT that normalizes to the same
 * canonical form — so an allowlist entry written in a different style still
 * matches (Req 10.1 canonicalization underpinning the access rule).
 */
const callerSpecArb = fc.oneof(
  digitsArb.map((d) => ({
    caller: `+${d}`,
    // Dashes are stripped by phone normalization → same canonical number.
    variant: `+${d.split('').join('-')}`,
  })),
  sipUserArb.map((u) => ({
    caller: `sip:${u}@host-a.example.com`,
    // Different scheme-case, host, and params; user part normalizes identically.
    variant: `SIP:${u.toUpperCase()}@host-b.example.org;transport=tcp`,
  })),
);

/** Arbitrary extra allowlist entries (usually non-matching noise). */
const extrasArb = fc.array(fc.string({ maxLength: 12 }), { maxLength: 3 });
const defaultAccessArb = fc.constantFrom<VoiceDefaultAccess>('allow', 'reject');
const transcriptArb = fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0);

/** Assemble the allowlist for an iteration, optionally including a match. */
function buildAllowlist(extras: string[], variant: string, includeMatch: boolean): string[] {
  return includeMatch ? [...extras, variant] : [...extras];
}

describe('Voice access control (Property 6)', () => {
  // Feature: roza-step3-voice-telephony, Property 6: Voice access control — allowlist enforced before the engine, and on outbound origination
  // Validates: Requirements 5.5, 10.5, 10.6, 11.5
  it('isVoiceCallerAllowed matches the empty→defaultAccess / non-empty→normalized-membership rule', () => {
    fc.assert(
      fc.property(
        callerSpecArb,
        extrasArb,
        fc.boolean(),
        defaultAccessArb,
        (spec, extras, includeMatch, defaultAccess) => {
          const allowlist = buildAllowlist(extras, spec.variant, includeMatch);
          const cfg = makeConfig(allowlist, defaultAccess);
          const expected = oracleAllowed(allowlist, defaultAccess, spec.caller);
          expect(isVoiceCallerAllowed(cfg.voice, spec.caller)).toBe(expected);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: roza-step3-voice-telephony, Property 6: Voice access control — allowlist enforced before the engine, and on outbound origination
  // Validates: Requirements 10.5, 10.6, 11.5
  it('an inbound call reaches the engine ONLY when allowed; a rejected caller is hung up and never answered', async () => {
    await fc.assert(
      fc.asyncProperty(
        callerSpecArb,
        extrasArb,
        fc.boolean(),
        defaultAccessArb,
        transcriptArb,
        async (spec, extras, includeMatch, defaultAccess, transcript) => {
          const allowlist = buildAllowlist(extras, spec.variant, includeMatch);
          const expected = oracleAllowed(allowlist, defaultAccess, spec.caller);
          const cfg = makeConfig(allowlist, defaultAccess);

          const gateway = makeFakeGateway();
          const { engine, calls } = makeFakeEngine();
          const connector = makeConnector(gateway, engine, makeFakeStt(transcript), cfg, makeLogger());

          await connector.start();

          const callId = randomUUID();
          const handle: CallHandle = { callId, callerIdentity: spec.caller, direction: 'inbound' };
          await gateway.emitInbound(handle);

          if (expected) {
            // Allowed: the call is answered (the precondition to the loop) and
            // the engine is reachable — never hung up by the allowlist gate.
            expect(gateway.answered).toContain(callId);
            expect(gateway.hungUp).toHaveLength(0);

            // Simulate one caller turn: speaking frame then a turn-end frame.
            const frame: AudioChunk = { format: TELEPHONY_PCM_8K, data: new Uint8Array([1, 2, 3, 4]) };
            gateway.emitAudio(callId, frame);
            gateway.emitAudio(callId, frame);
            await flush();

            // The transcript reached the engine on the `voice` channel keyed by
            // the normalized Caller_Identity (engine reached only when allowed).
            expect(calls).toHaveLength(1);
            expect(calls[0]).toEqual({
              channel: 'voice',
              userId: userIdForVoice(spec.caller),
              text: transcript,
            });
          } else {
            // Rejected: hung up BEFORE any answer or engine work (Req 10.5, 11.5).
            expect(gateway.answered).not.toContain(callId);
            expect(gateway.hungUp.some((h) => h.callId === callId)).toBe(true);
            expect(calls).toHaveLength(0);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: roza-step3-voice-telephony, Property 6: Voice access control — allowlist enforced before the engine, and on outbound origination
  // Validates: Requirements 5.5
  it('placeOutboundCall originates IFF the callee is allowed; a rejected callee yields not_allowlisted and logs', async () => {
    await fc.assert(
      fc.asyncProperty(
        callerSpecArb,
        extrasArb,
        fc.boolean(),
        defaultAccessArb,
        async (spec, extras, includeMatch, defaultAccess) => {
          const allowlist = buildAllowlist(extras, spec.variant, includeMatch);
          const expected = oracleAllowed(allowlist, defaultAccess, spec.caller);
          const cfg = makeConfig(allowlist, defaultAccess);

          const gateway = makeFakeGateway();
          const { engine } = makeFakeEngine();
          const logger = makeLogger();
          const connector = makeConnector(gateway, engine, makeFakeStt('unused'), cfg, logger);

          const res = await connector.placeOutboundCall(spec.caller);

          if (expected) {
            expect(res.ok).toBe(true);
            expect(gateway.originated.some((o) => o.callerIdentity === spec.caller)).toBe(true);
          } else {
            expect(res).toEqual({ ok: false, reason: 'not_allowlisted' });
            expect(gateway.originated).toHaveLength(0);
            // The rejection is logged with identifiers/reasons only (Req 5.5).
            expect(logger.errors.some((e) => e.message === 'voice.outbound.rejected_allowlist')).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
