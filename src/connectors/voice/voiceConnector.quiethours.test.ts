import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createVoiceConnector, type VoiceConnectorDeps } from './voiceConnector.js';
import { type AudioChunk, TELEPHONY_PCM_8K } from './audio.js';
import type { CallHandle, TelephonyGateway } from './telephony.asterisk.js';
import type { SttEngine, TurnDetector } from './stt.whisper.js';
import type { TtsEngine } from './tts.piper.js';
import type { CognitiveEngine, HandleMessageInput } from '../../engine.js';
import type { QuietHoursInboundPolicy, RozaConfig } from '../../config.js';
import type { ActiveWindow } from '../../window.js';
import type { Logger } from '../../types.js';

/**
 * Property-based test for the Voice_Connector's Right-to-Disconnect gates: the
 * quiet-hours OUTBOUND block and the quiet-hours INBOUND policy.
 *
 * Feature: roza-step3-voice-telephony, Property 7: Right to disconnect — quiet-hours outbound block and inbound policy
 *
 * Validates: Requirements 8.1, 8.2, 8.3
 *
 * The connector renders the injected `now()` clock to minutes-since-midnight in
 * the configured `timezone` and checks it against the `window`
 * (`isWithinActiveWindow` + `minutesInTimezone`). Quiet_Hours is the complement
 * of the Active_Window. With `timezone: 'UTC'` and a fixed window of
 * `[420, 1320)` (07:00–22:00), choosing a `Date` at a given UTC minute-of-day
 * deterministically places the instant inside or outside the window.
 *
 * Every external edge is an in-memory fake (gateway/STT/TTS/engine), so no real
 * audio, SIP, or native binary runs (Req 14.5). To isolate the quiet-hours gate
 * from the allowlist gate, the allowlist is empty and `defaultAccess: 'allow'`
 * so every generated caller passes the allowlist and only the time gate decides.
 */

const NUM_RUNS = 100;

/** Fixed Active_Window: 07:00–22:00 (minutes since midnight, UTC). */
const WINDOW: ActiveWindow = { startMinutes: 420, endMinutes: 1320 };

/** The three inbound Right-to-Disconnect policies under test (Req 8.3). */
const INBOUND_POLICIES: QuietHoursInboundPolicy[] = ['reject', 'answer_busy', 'take_message'];

/** A `Date` whose UTC wall-clock minute-of-day is exactly `m` in [0, 1439]. */
function dateAtMinuteOfDay(m: number): Date {
  return new Date(Date.UTC(2024, 0, 1, Math.floor(m / 60), m % 60, 0, 0));
}

/** Minutes-of-day strictly INSIDE the window [420, 1320): not Quiet_Hours. */
const minutesInsideWindow = fc.integer({ min: WINDOW.startMinutes, max: WINDOW.endMinutes - 1 });

/** Minutes-of-day OUTSIDE the window: Quiet_Hours (before start or at/after end). */
const minutesOutsideWindow = fc.oneof(
  fc.integer({ min: 0, max: WINDOW.startMinutes - 1 }),
  fc.integer({ min: WINDOW.endMinutes, max: 1439 }),
);

/** A non-empty caller identity; its content is irrelevant under `defaultAccess: 'allow'`. */
const callerIdentityArb = fc.string({ minLength: 1, maxLength: 24 });

/** A non-empty inbound call id. */
const callIdArb = fc.string({ minLength: 1, maxLength: 24 }).map((s) => `call-${s}`);

/** An in-memory {@link TelephonyGateway} fake recording every control-plane call. */
interface FakeGateway extends TelephonyGateway {
  inboundHandler: ((call: CallHandle) => Promise<void>) | null;
  originateCalls: string[];
  answerCalls: string[];
  onAudioCalls: string[];
  playCalls: string[];
  hangups: Array<{ callId: string; reason: string }>;
}

function createFakeGateway(): FakeGateway {
  const gw: FakeGateway = {
    inboundHandler: null,
    originateCalls: [],
    answerCalls: [],
    onAudioCalls: [],
    playCalls: [],
    hangups: [],
    async listen(onInboundCall) {
      gw.inboundHandler = onInboundCall;
    },
    async answer(callId) {
      gw.answerCalls.push(callId);
    },
    async originate(callerIdentity) {
      gw.originateCalls.push(callerIdentity);
      return { callId: `out-${callerIdentity}`, callerIdentity, direction: 'outbound' };
    },
    onAudio(callId) {
      gw.onAudioCalls.push(callId);
    },
    async playAudio(callId) {
      gw.playCalls.push(callId);
    },
    async hangup(callId, reason) {
      gw.hangups.push({ callId, reason });
    },
    onCallEnded() {
      // No out-of-band end events are driven in these properties.
    },
  };
  return gw;
}

/** A fake engine that records every turn submitted to it (it must never be reached here). */
interface FakeEngine {
  calls: HandleMessageInput[];
}

/** Build the connector + its fakes for a chosen instant and inbound policy. */
function makeHarness(opts: { minuteOfDay: number; quietHoursInbound: QuietHoursInboundPolicy }): {
  connector: ReturnType<typeof createVoiceConnector>;
  gateway: FakeGateway;
  engine: FakeEngine;
} {
  const gateway = createFakeGateway();

  const engineRec: FakeEngine = { calls: [] };
  const engine = {
    calls: engineRec.calls,
    async handleMessage(input: HandleMessageInput) {
      engineRec.calls.push(input);
      return { ok: true as const, reply: 'reply', conversationId: 'conv-1' };
    },
  };

  const stt: SttEngine = {
    async transcribe() {
      return '';
    },
    descriptor: { name: 'whisper.cpp', license: 'MIT', model: 'ggml-base.en' },
  };

  const tts: TtsEngine = {
    async synthesize(): Promise<AudioChunk> {
      return { format: TELEPHONY_PCM_8K, data: new Uint8Array() };
    },
    descriptor: { name: 'piper', license: 'MIT', voice: '' },
  };

  const turnDetector = (): TurnDetector => ({
    push: () => 'silence',
    reset: () => undefined,
  });

  const logger: Logger = { info: () => undefined, error: () => undefined };

  const cfg = makeVoiceConfig(opts.quietHoursInbound);

  const deps: VoiceConnectorDeps = {
    gateway,
    stt,
    tts,
    turnDetector,
    engine: engine as unknown as CognitiveEngine,
    cfg,
    window: WINDOW,
    timezone: 'UTC',
    now: () => dateAtMinuteOfDay(opts.minuteOfDay),
    logger,
  };

  return { connector: createVoiceConnector(deps), gateway, engine: engineRec };
}

/**
 * A structurally-complete {@link RozaConfig} with the voice channel enabled, an
 * EMPTY allowlist and `defaultAccess: 'allow'` (so the allowlist gate always
 * admits and only the quiet-hours gate is exercised), and the chosen inbound
 * Quiet_Hours policy.
 */
function makeVoiceConfig(quietHoursInbound: QuietHoursInboundPolicy): RozaConfig {
  return {
    rozaPrivateKey: 'test-private-key',
    openRouterApiKey: 'test-api-key',
    openRouterModel: 'openai/gpt-4o-mini',
    dataDir: '/tmp/roza-voice-quiethours-test',
    timezone: 'UTC',
    activeWindow: WINDOW,
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
      sip: { host: 'sip.example', port: 5060, user: 'u', password: 'p', realm: 'r' },
      allowlist: [],
      defaultAccess: 'allow',
      quietHoursInbound,
      tts: { engine: 'piper', voice: 'en_US-amy-medium', model: 'en_US-amy-medium' },
      stt: { engine: 'whisper.cpp', model: 'ggml-base.en' },
      maxReplyChars: 1000,
      latency: { ttsMs: 5000, sttMs: 5000, endToEndMs: 8000, ringTimeoutMs: 30000 },
    },
  };
}

describe('Right to disconnect — quiet-hours outbound block and inbound policy (Property 7)', () => {
  // Feature: roza-step3-voice-telephony, Property 7: Right to disconnect — quiet-hours outbound block and inbound policy
  // Validates: Requirements 8.1, 8.2
  it('blocks outbound origination during Quiet_Hours and never reaches the gateway', async () => {
    await fc.assert(
      fc.asyncProperty(minutesOutsideWindow, callerIdentityArb, async (minuteOfDay, callee) => {
        const { connector, gateway, engine } = makeHarness({
          minuteOfDay,
          quietHoursInbound: 'take_message',
        });

        const res = await connector.placeOutboundCall(callee);

        // Quiet_Hours → declined with the quiet_hours reason (Req 8.1, 8.2).
        expect(res).toEqual({ ok: false, reason: 'quiet_hours' });
        // The call is never originated and no audio/engine work happens.
        expect(gateway.originateCalls).toEqual([]);
        expect(gateway.onAudioCalls).toEqual([]);
        expect(engine.calls).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: roza-step3-voice-telephony, Property 7: Right to disconnect — quiet-hours outbound block and inbound policy
  // Validates: Requirements 8.1, 8.2
  it('originates an allowed outbound call INSIDE the window without quiet-hours deferral', async () => {
    await fc.assert(
      fc.asyncProperty(minutesInsideWindow, callerIdentityArb, async (minuteOfDay, callee) => {
        const { connector, gateway } = makeHarness({
          minuteOfDay,
          quietHoursInbound: 'take_message',
        });

        const res = await connector.placeOutboundCall(callee);

        // Inside the Active_Window an allowed callee reaches the gateway and the
        // call connects — no quiet-hours block (Req 8.1, 8.2).
        expect(res.ok).toBe(true);
        expect(res.reason).toBeUndefined();
        expect(gateway.originateCalls).toEqual([callee]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: roza-step3-voice-telephony, Property 7: Right to disconnect — quiet-hours outbound block and inbound policy
  // Validates: Requirements 8.3
  it('applies exactly the configured inbound policy for calls arriving during Quiet_Hours', async () => {
    await fc.assert(
      fc.asyncProperty(
        minutesOutsideWindow,
        fc.constantFrom(...INBOUND_POLICIES),
        callerIdentityArb,
        callIdArb,
        async (minuteOfDay, policy, callerIdentity, callId) => {
          const { connector, gateway, engine } = makeHarness({
            minuteOfDay,
            quietHoursInbound: policy,
          });

          await connector.start();
          const handler = gateway.inboundHandler;
          expect(handler).not.toBeNull();

          await handler!({ callId, callerIdentity, direction: 'inbound' });

          // Across every policy, a Quiet_Hours inbound call NEVER drives the
          // engine into a turn (no transcript is ever submitted) — Req 8.3.
          expect(engine.calls).toEqual([]);
          // And no turn loop is ever attached (no caller-audio subscription).
          expect(gateway.onAudioCalls).toEqual([]);

          if (policy === 'reject') {
            // reject → hang up without answering.
            expect(gateway.answerCalls).toEqual([]);
            expect(gateway.hangups).toHaveLength(1);
            expect(gateway.hangups[0]).toEqual({ callId, reason: 'quiet_hours_reject' });
          } else if (policy === 'answer_busy') {
            // answer_busy → signal busy by hanging up (busy reason); no answer.
            expect(gateway.answerCalls).toEqual([]);
            expect(gateway.hangups).toHaveLength(1);
            expect(gateway.hangups[0]).toEqual({ callId, reason: 'quiet_hours_busy' });
          } else {
            // take_message → answer to capture a message, but do NOT run the
            // engine turn loop and do NOT hang up.
            expect(gateway.answerCalls).toEqual([callId]);
            expect(gateway.hangups).toEqual([]);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
