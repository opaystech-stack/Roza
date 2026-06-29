/**
 * Voice_Connector example/integration tests over in-memory fakes — Req 4.1,
 * 4.2, 4.4, 5.1, 5.4, 10.2, 10.3, 12.4.
 *
 * These are concrete, example-based (NOT property-based) tests that wire
 * `createVoiceConnector` to fully in-memory fakes for the
 * gateway / STT / TTS / Cognitive_Engine and a scripted {@link TurnDetector}.
 * No real audio, SIP, STT, or TTS process ever runs (Req 14.5).
 *
 * They assert the end-to-end establish → transcribe → reply → play sequence for
 * an inbound call (Req 4.1, 4.2, 4.4), the outbound place-on-answer turn loop
 * (Req 5.1), the outbound ring-timeout decline (Req 5.4), and that two
 * consecutive voice turns route to the SAME relationship `user_id` so the
 * relationship is created once then reused (Req 10.2, 10.3).
 */

import { describe, expect, it } from 'vitest';

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

/** An always-open Active_Window so `now()` is never in Quiet_Hours. */
const ALWAYS_OPEN: ActiveWindow = { startMinutes: 0, endMinutes: 1440 };

/** A fixed instant; with {@link ALWAYS_OPEN} the connector is always in-window. */
const FIXED_NOW = new Date('2024-06-01T12:00:00.000Z');

/** A non-empty PCM frame; its bytes are irrelevant — the turn end is scripted. */
const SPEECH_FRAME: AudioChunk = { format: TELEPHONY_PCM_8K, data: new Uint8Array([1, 2, 3, 4]) };

/** A frame that triggers the scripted turn end. */
const END_FRAME: AudioChunk = { format: TELEPHONY_PCM_8K, data: new Uint8Array([0, 0]) };

/** The canned synthesized audio the TTS fake returns for every reply. */
const SYNTH_CHUNK: AudioChunk = { format: TELEPHONY_PCM_8K, data: new Uint8Array([9, 9, 9]) };

/**
 * Build a voice-enabled config that admits any caller: an empty allowlist with
 * `defaultAccess: 'allow'` permits every Caller_Identity (Req 10.6).
 */
function makeConfig(): RozaConfig {
  return {
    rozaPrivateKey: 'test-private-key',
    openRouterApiKey: 'test-api-key',
    openRouterModel: 'openai/gpt-4o-mini',
    dataDir: '/tmp/roza-voice-integration-test',
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

/** A structured logger fake that records every entry for assertions. */
function makeLogger(): { logger: Logger; entries: Array<{ level: 'info' | 'error'; message: string }> } {
  const entries: Array<{ level: 'info' | 'error'; message: string }> = [];
  const logger: Logger = {
    info: (message) => entries.push({ level: 'info', message }),
    error: (message) => entries.push({ level: 'error', message }),
  };
  return { logger, entries };
}

/**
 * A scripted {@link TurnDetector}: the first frame after each reset is
 * `'speaking'` (accumulated) and the next frame is `'turn_end'` (closes the
 * turn). The connector calls `reset()` after every turn end, so this fires one
 * complete turn per `speaking` + `turn_end` frame pair.
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

/** An STT fake that returns the supplied transcript verbatim and records calls. */
function makeStt(
  transcript: string,
  events: string[],
): SttEngine {
  return {
    async transcribe(): Promise<string> {
      events.push('transcribe');
      return transcript;
    },
    descriptor: { name: 'whisper.cpp', license: 'MIT', model: 'ggml-base.en' },
  };
}

/** A recording engine fake; satisfies the nominal `CognitiveEngine` via a cast. */
function makeRecordingEngine(
  reply: string,
  events: string[],
): { engine: CognitiveEngine; calls: HandleMessageInput[] } {
  const calls: HandleMessageInput[] = [];
  const fake = {
    async handleMessage(input: HandleMessageInput): Promise<HandleMessageResult> {
      events.push('generate');
      calls.push(input);
      return { ok: true, reply, conversationId: 'conv-1' };
    },
  };
  return { engine: fake as unknown as CognitiveEngine, calls };
}

/** A TTS fake returning a canned chunk and recording each `synthesize` text. */
function makeTts(events: string[]): { tts: TtsEngine; synthTexts: string[] } {
  const synthTexts: string[] = [];
  const tts: TtsEngine = {
    async synthesize(text: string): Promise<AudioChunk> {
      events.push('synthesize');
      synthTexts.push(text);
      return SYNTH_CHUNK;
    },
    descriptor: { name: 'piper', license: 'MIT', voice: 'en_US-amy-medium' },
  };
  return { tts, synthTexts };
}

/**
 * An in-memory {@link TelephonyGateway} fake. It captures the `onInboundCall`
 * handler from `listen` and the per-call audio handler from `onAudio`, records
 * `answer`/`originate`/`playAudio` invocations into a shared `events` log, and
 * lets the test emit audio frames to drive the turn loop. When `originateFails`
 * is set, `originate` rejects to simulate a ring timeout (Req 5.4).
 */
function makeGateway(
  events: string[],
  opts: { originateHandle?: CallHandle; originateFails?: boolean } = {},
): {
  gateway: TelephonyGateway;
  invokeInbound: (handle: CallHandle) => Promise<void>;
  emit: (callId: string, chunk: AudioChunk) => void;
  playedChunks: AudioChunk[];
} {
  let inboundHandler: ((call: CallHandle) => Promise<void>) | null = null;
  const audioHandlers = new Map<string, (chunk: AudioChunk) => void>();
  const playedChunks: AudioChunk[] = [];

  const gateway: TelephonyGateway = {
    async listen(onInboundCall): Promise<void> {
      inboundHandler = onInboundCall;
    },
    async answer(): Promise<void> {
      events.push('answer');
    },
    async originate(): Promise<CallHandle> {
      events.push('originate');
      if (opts.originateFails) {
        throw new Error('ring timeout');
      }
      if (!opts.originateHandle) {
        throw new Error('originateHandle not configured');
      }
      return opts.originateHandle;
    },
    onAudio(callId, onFrame): void {
      audioHandlers.set(callId, onFrame);
    },
    async playAudio(_callId, chunk): Promise<void> {
      events.push('play');
      playedChunks.push(chunk);
    },
    async hangup(): Promise<void> {
      // No-op teardown for the fake.
    },
    onCallEnded(): void {
      // No out-of-band end is driven by these tests.
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
    playedChunks,
  };
}

/** Yield to the event loop a few times so the async turn fully completes. */
async function flushTurn(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('Voice_Connector integration (in-memory fakes)', () => {
  // Validates: Requirements 4.1, 4.2, 4.4
  it('inbound happy path: establish → transcribe → reply → play', async () => {
    const events: string[] = [];
    const callerIdentity = '+243990001111';
    const callId = 'call-inbound-1';
    const handle: CallHandle = { callId, callerIdentity, direction: 'inbound' };

    const { gateway, invokeInbound, emit, playedChunks } = makeGateway(events, {});
    const { engine, calls } = makeRecordingEngine('Bonjour, je vous écoute.', events);
    const { tts, synthTexts } = makeTts(events);

    const connector = createVoiceConnector({
      gateway,
      stt: makeStt('Bonjour Roza', events),
      tts,
      turnDetector: makeScriptedTurnDetector,
      engine,
      cfg: makeConfig(),
      window: ALWAYS_OPEN,
      timezone: 'UTC',
      now: () => FIXED_NOW,
      logger: makeLogger().logger,
    });

    await connector.start();
    await invokeInbound(handle);

    // One 'speaking' frame is accumulated, then a 'turn_end' frame closes the turn.
    emit(callId, SPEECH_FRAME);
    emit(callId, END_FRAME);
    await flushTurn();

    // The full establish → transcribe → reply → play sequence, in order.
    expect(events).toEqual(['answer', 'transcribe', 'generate', 'synthesize', 'play']);

    // The transcript was routed to the engine on the voice channel (Req 4.2).
    expect(calls).toHaveLength(1);
    expect(calls[0]!.channel).toBe('voice');
    expect(calls[0]!.userId).toBe(userIdForVoice(callerIdentity));
    expect(calls[0]!.text).toBe('Bonjour Roza');

    // The engine reply (and only that) was handed to TTS (Req 4.4).
    expect(synthTexts).toEqual(['Bonjour, je vous écoute.']);

    // The synthesized chunk was the one played back to the caller (Req 4.4).
    expect(playedChunks).toEqual([SYNTH_CHUNK]);
  });

  // Validates: Requirements 5.1, 5.2
  it('outbound place-on-answer: originate then run the transcribe → reply → play loop', async () => {
    const events: string[] = [];
    const callerIdentity = '+243990002222';
    const callId = 'call-outbound-1';
    const originateHandle: CallHandle = { callId, callerIdentity, direction: 'outbound' };

    const { gateway, emit, playedChunks } = makeGateway(events, { originateHandle });
    const { engine, calls } = makeRecordingEngine('Je vous rappelle.', events);
    const { tts, synthTexts } = makeTts(events);

    const connector = createVoiceConnector({
      gateway,
      stt: makeStt('Allo', events),
      tts,
      turnDetector: makeScriptedTurnDetector,
      engine,
      cfg: makeConfig(),
      window: ALWAYS_OPEN,
      timezone: 'UTC',
      now: () => FIXED_NOW,
      logger: makeLogger().logger,
    });

    // In-window + allow-all allowlist: the call connects on answer (Req 5.1).
    const res = await connector.placeOutboundCall(callerIdentity);
    expect(res).toEqual({ ok: true });

    emit(callId, SPEECH_FRAME);
    emit(callId, END_FRAME);
    await flushTurn();

    // Same per-turn loop as inbound: originate, then transcribe → reply → play.
    expect(events).toEqual(['originate', 'transcribe', 'generate', 'synthesize', 'play']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe('Allo');
    expect(synthTexts).toEqual(['Je vous rappelle.']);
    expect(playedChunks).toEqual([SYNTH_CHUNK]);
  });

  // Validates: Requirements 5.4
  it('outbound ring timeout: originate rejects → { ok: false, reason: "no_answer" } and logs', async () => {
    const events: string[] = [];
    const callerIdentity = '+243990003333';

    const { gateway } = makeGateway(events, { originateFails: true });
    const { engine, calls } = makeRecordingEngine('unused', events);
    const { tts } = makeTts(events);
    const { logger, entries } = makeLogger();

    const connector = createVoiceConnector({
      gateway,
      stt: makeStt('unused', events),
      tts,
      turnDetector: makeScriptedTurnDetector,
      engine,
      cfg: makeConfig(),
      window: ALWAYS_OPEN,
      timezone: 'UTC',
      now: () => FIXED_NOW,
      logger,
    });

    const res = await connector.placeOutboundCall(callerIdentity);

    // The unanswered call is reported, not crashed (Req 5.4).
    expect(res).toEqual({ ok: false, reason: 'no_answer' });
    // It was an origination attempt that failed; no turn loop ran.
    expect(events).toEqual(['originate']);
    expect(calls).toHaveLength(0);
    // The decline is logged (no SIP credential is present in the message).
    expect(entries.some((e) => e.message === 'voice.outbound.no_answer')).toBe(true);
  });

  // Validates: Requirements 10.2, 10.3
  it('two consecutive turns route to the same relationship user_id (create-then-reuse)', async () => {
    const events: string[] = [];
    const callerIdentity = '+243990004444';
    const callId = 'call-inbound-2';
    const handle: CallHandle = { callId, callerIdentity, direction: 'inbound' };

    const { gateway, invokeInbound, emit } = makeGateway(events, {});
    const { engine, calls } = makeRecordingEngine('D’accord.', events);
    const { tts } = makeTts(events);

    const connector = createVoiceConnector({
      gateway,
      stt: makeStt('encore une question', events),
      tts,
      turnDetector: makeScriptedTurnDetector,
      engine,
      cfg: makeConfig(),
      window: ALWAYS_OPEN,
      timezone: 'UTC',
      now: () => FIXED_NOW,
      logger: makeLogger().logger,
    });

    await connector.start();
    await invokeInbound(handle);

    // First turn.
    emit(callId, SPEECH_FRAME);
    emit(callId, END_FRAME);
    await flushTurn();

    // Second turn on the same call (the detector resets between turns).
    emit(callId, SPEECH_FRAME);
    emit(callId, END_FRAME);
    await flushTurn();

    // Both turns reached the engine, keyed on the SAME derived user_id, so the
    // relationship is created once then reused (Req 10.2, 10.3).
    expect(calls).toHaveLength(2);
    const expectedUserId = userIdForVoice(callerIdentity);
    expect(calls[0]!.userId).toBe(expectedUserId);
    expect(calls[1]!.userId).toBe(expectedUserId);
  });
});
