/**
 * Voice_Connector turn-loop routing property test (Property 8) — Req 4.3, 5.2,
 * 11.1.
 *
 * Drives `createVoiceConnector` over fully in-memory fakes (no real audio, SIP,
 * STT, or TTS process runs — Req 14.5) and asserts that one completed caller
 * turn routes the transcribed text to the Cognitive_Engine on the `voice`
 * channel EXACTLY once, with the channel-prefixed `user_id` derived from the
 * Caller_Identity and the transcript passed through VERBATIM as the engine
 * `text` (the untrusted transcript is only ever data — Req 11.1). The identical
 * routing is asserted for an inbound call and for an outbound call, since the
 * same per-turn loop serves both (Req 5.2).
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createVoiceConnector } from './voiceConnector.js';
import { userIdForVoice } from '../sender.js';
import { type AudioChunk, TELEPHONY_PCM_8K } from './audio.js';
import type { CallHandle, TelephonyGateway } from './telephony.asterisk.js';
import type { SttEngine, TurnDetector } from './stt.whisper.js';
import type { TtsEngine } from './tts.piper.js';
import type { CognitiveEngine, HandleMessageInput, HandleMessageResult } from '../../engine.js';
import type { RozaConfig } from '../../config.js';
import type { ActiveWindow } from '../../window.js';
import type { Logger } from '../../types.js';

// Feature: roza-step3-voice-telephony, Property 8: Turn loop routes the transcript to the engine on the voice channel

/** Every property runs at least 100 generated examples. */
const NUM_RUNS = 100;

/** An always-open Active_Window so `now()` is never in Quiet_Hours. */
const ALWAYS_OPEN: ActiveWindow = { startMinutes: 0, endMinutes: 1440 };

/** A fixed instant; with {@link ALWAYS_OPEN} the connector is always in-window. */
const FIXED_NOW = new Date('2024-06-01T12:00:00.000Z');

/** A non-empty PCM frame; its content is irrelevant — routing is transcript-driven. */
const SPEECH_FRAME: AudioChunk = { format: TELEPHONY_PCM_8K, data: new Uint8Array([1, 2, 3, 4]) };

/** A silent_ish frame used to trigger the scripted turn end. */
const END_FRAME: AudioChunk = { format: TELEPHONY_PCM_8K, data: new Uint8Array([0, 0]) };

/** A discardable structured logger (the connector logs identifiers/reasons only). */
const SILENT_LOGGER: Logger = { info: () => undefined, error: () => undefined };

/**
 * Build a voice-enabled config that admits any caller: an empty allowlist with
 * `defaultAccess: 'allow'` means every Caller_Identity is permitted (Req 10.6).
 */
function makeConfig(): RozaConfig {
  return {
    rozaPrivateKey: 'test-private-key',
    openRouterApiKey: 'test-api-key',
    openRouterModel: 'openai/gpt-4o-mini',
    dataDir: '/tmp/roza-voice-routing-test',
    timezone: 'UTC',
    activeWindow: ALWAYS_OPEN,
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
      sip: { host: 'sip.test', port: 5060, user: 'u', password: 'p', realm: 'r' },
      allowlist: [],
      defaultAccess: 'allow',
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

/**
 * A scripted {@link TurnDetector}: the first frame is `'speaking'` (accumulated)
 * and the second frame is `'turn_end'` (closes the turn). This makes exactly one
 * turn fire per inbound/outbound call the test drives.
 */
function makeScriptedTurnDetector(): TurnDetector {
  let calls = 0;
  return {
    push(): 'speaking' | 'turn_end' | 'silence' {
      calls += 1;
      return calls === 1 ? 'speaking' : 'turn_end';
    },
    reset(): void {
      calls = 0;
    },
  };
}

/** An STT fake that returns the supplied transcript verbatim, ignoring the audio. */
function makeStt(transcript: string): SttEngine {
  return {
    async transcribe(): Promise<string> {
      return transcript;
    },
    descriptor: { name: 'whisper.cpp', license: 'MIT', model: 'ggml-base.en' },
  };
}

/** A recording engine fake; satisfies the nominal `CognitiveEngine` via a cast. */
function makeRecordingEngine(): { engine: CognitiveEngine; calls: HandleMessageInput[] } {
  const calls: HandleMessageInput[] = [];
  const fake = {
    async handleMessage(input: HandleMessageInput): Promise<HandleMessageResult> {
      calls.push(input);
      return { ok: true, reply: 'reponse', conversationId: 'conv-1' };
    },
  };
  return { engine: fake as unknown as CognitiveEngine, calls };
}

/** A TTS fake returning a canned chunk and recording each `synthesize` call. */
function makeTts(): { tts: TtsEngine; synthArgs: Array<{ text: string }> } {
  const synthArgs: Array<{ text: string }> = [];
  const tts: TtsEngine = {
    async synthesize(text: string): Promise<AudioChunk> {
      synthArgs.push({ text });
      return { format: TELEPHONY_PCM_8K, data: new Uint8Array([9, 9]) };
    },
    descriptor: { name: 'piper', license: 'MIT', voice: 'en_US-amy-medium' },
  };
  return { tts, synthArgs };
}

/**
 * An in-memory {@link TelephonyGateway} fake. It captures the `onInboundCall`
 * handler from `listen`, the per-call audio handler from `onAudio`, and answers
 * the originate request with a connected outbound {@link CallHandle}; it lets
 * the test emit audio frames to drive the turn loop.
 */
function makeGateway(originateHandle: CallHandle): {
  gateway: TelephonyGateway;
  invokeInbound: (handle: CallHandle) => Promise<void>;
  emit: (callId: string, chunk: AudioChunk) => void;
} {
  let inboundHandler: ((call: CallHandle) => Promise<void>) | null = null;
  const audioHandlers = new Map<string, (chunk: AudioChunk) => void>();

  const gateway: TelephonyGateway = {
    async listen(onInboundCall): Promise<void> {
      inboundHandler = onInboundCall;
    },
    async answer(): Promise<void> {
      // Accepting the call is a no-op for the in-memory transport.
    },
    async originate(): Promise<CallHandle> {
      return originateHandle;
    },
    onAudio(callId, onFrame): void {
      audioHandlers.set(callId, onFrame);
    },
    async playAudio(): Promise<void> {
      // Playback is a no-op; routing is asserted on the engine call, not audio.
    },
    async hangup(): Promise<void> {
      // No-op teardown for the fake.
    },
    onCallEnded(): void {
      // The routing property never drives an out-of-band end.
    },
  };

  return {
    gateway,
    async invokeInbound(handle): Promise<void> {
      if (!inboundHandler) {
        throw new Error('listen() was not called before invokeInbound');
      }
      await inboundHandler(handle);
    },
    emit(callId, chunk): void {
      const handler = audioHandlers.get(callId);
      if (!handler) {
        throw new Error(`no audio handler registered for call ${callId}`);
      }
      handler(chunk);
    },
  };
}

/** Yield to the event loop a few times so the async turn fully completes. */
async function flushTurn(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Drive exactly one completed turn through the connector for the given
 * direction and return the recorded engine calls. The same fakes back both
 * directions so the loop is exercised identically (Req 5.2).
 */
async function runOneTurn(
  direction: 'inbound' | 'outbound',
  callerIdentity: string,
  transcript: string,
): Promise<HandleMessageInput[]> {
  const callId = `call-${direction}-1`;
  const handle: CallHandle = { callId, callerIdentity, direction };
  const { gateway, invokeInbound, emit } = makeGateway(handle);
  const { engine, calls } = makeRecordingEngine();
  const { tts } = makeTts();

  const connector = createVoiceConnector({
    gateway,
    stt: makeStt(transcript),
    tts,
    turnDetector: makeScriptedTurnDetector,
    engine,
    cfg: makeConfig(),
    window: ALWAYS_OPEN,
    timezone: 'UTC',
    now: () => FIXED_NOW,
    logger: SILENT_LOGGER,
  });

  if (direction === 'inbound') {
    await connector.start();
    await invokeInbound(handle);
  } else {
    const res = await connector.placeOutboundCall(callerIdentity);
    expect(res.ok).toBe(true);
  }

  // One 'speaking' frame is accumulated, then a 'turn_end' frame closes the turn.
  emit(callId, SPEECH_FRAME);
  emit(callId, END_FRAME);
  await flushTurn();

  return calls;
}

describe('Voice_Connector turn-loop routing (Property 8)', () => {
  // Validates: Requirements 4.3, 5.2, 11.1
  it('routes the transcript to the engine exactly once on the voice channel (inbound and outbound)', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Any Caller_Identity (allowed because the allowlist is empty + allow).
        fc.string(),
        // Any non-blank transcript (a blank one is intentionally skipped upstream).
        fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
        async (callerIdentity, transcript) => {
          const expectedUserId = userIdForVoice(callerIdentity);

          for (const direction of ['inbound', 'outbound'] as const) {
            const calls = await runOneTurn(direction, callerIdentity, transcript);

            // EXACTLY one engine call for the single completed turn (Req 4.3).
            expect(calls).toHaveLength(1);
            const call = calls[0]!;
            // Routed on the voice channel with the channel-prefixed user_id.
            expect(call.channel).toBe('voice');
            expect(call.userId).toBe(expectedUserId);
            // The untrusted transcript passes through verbatim as data (Req 11.1).
            expect(call.text).toBe(transcript);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
