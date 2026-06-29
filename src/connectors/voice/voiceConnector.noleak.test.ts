// Feature: roza-step3-voice-telephony, Property 4: SIP credentials never appear in errors or logs
//
// Property-based test for the no-leak guarantee on the SIP_Trunk_Credentials
// (Req 7.4, 11.4). It drives BOTH layers that touch those secrets — each at a
// minimum of 100 fast-check iterations, entirely through in-memory fakes (no
// real audio, SIP, STT/TTS, or native binary ever runs — Req 14.5):
//
//   1. CONNECTOR LAYER — a structurally complete RozaConfig is built with the
//      voice channel ENABLED and SIP host/port/user/password/realm set to
//      distinctive sentinel VALUES (each non-numeric field embeds a unique
//      `SECRETVALUE<token>` marker). The connector is then driven through every
//      logging-heavy path: an outbound call rejected by the allowlist; an
//      outbound call the gateway rejects with a *credential-shaped* transport
//      error (decoy creds only — never the real ones); an inbound call rejected
//      by the allowlist; a normal allowed inbound turn; plus engine-error and
//      TTS-exhaustion turns. A SPY logger captures every `(message, meta)` pair,
//      and the test asserts NO captured log line contains any real SIP
//      credential VALUE (Req 7.4, 11.4).
//
//   2. CONFIG LAYER — Property 4 extends to startup config errors: for an
//      ENABLED voice channel with some SIP variables missing, `resolveVoiceConfig`
//      reports each missing variable by NAME only, and the WHOLE serialized
//      result contains none of the credential VALUES that WERE provided (Req 7.2
//      reinforces 7.4).
//
// Validates: Requirements 7.4, 11.4

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  createVoiceConnector,
  type VoiceConnector,
} from './voiceConnector.js';
import { TELEPHONY_PCM_8K, type AudioChunk } from './audio.js';
import type { CallHandle, TelephonyGateway } from './telephony.asterisk.js';
import type { SttEngine, TurnDetector } from './stt.whisper.js';
import type { TtsEngine } from './tts.piper.js';
import type { CognitiveEngine, HandleMessageInput, HandleMessageResult } from '../../engine.js';
import type { ActiveWindow } from '../../window.js';
import type { Logger } from '../../types.js';
import {
  resolveVoiceConfig,
  type MissingVoiceVar,
  type RozaConfig,
  type VoiceChannelConfig,
} from '../../config.js';

/** Minimum fast-check iterations mandated for the property tests. */
const NUM_RUNS = 100;

/** A fixed instant; with the all-day window below it is ALWAYS inside the
 *  Active_Window, so the Right-to-Disconnect gate never blocks outbound calls. */
const FIXED_DATE = new Date('2024-06-01T12:00:00.000Z');
const now = (): Date => FIXED_DATE;
const TIMEZONE = 'UTC';
/** Whole-day Active_Window: every minute-of-day is "active" (no quiet hours). */
const WINDOW: ActiveWindow = { startMinutes: 0, endMinutes: 1440 };

/* -------------------------------------------------------------------------- *
 * The five SIP_Trunk_Credentials VALUES under test, generated per iteration.
 * Each non-numeric field embeds a unique `SECRETVALUE<token>` marker so a leak
 * is unambiguous; the port is a distinctive 5-digit integer in a range chosen
 * so it can never be a coincidental substring of any controlled log content
 * (callIds and caller identities below are purely alphabetic; decoy errors use
 * only 3/4-digit numbers).
 * -------------------------------------------------------------------------- */
interface SipSecrets {
  host: string;
  port: number;
  user: string;
  password: string;
  realm: string;
}

/** Lowercase-alphanumeric token used to make each secret value unique. */
const tokenArb = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
    minLength: 6,
    maxLength: 10,
  })
  .map((a) => a.join(''));

const sipSecretsArb: fc.Arbitrary<SipSecrets> = fc
  .record({
    h: tokenArb,
    u: tokenArb,
    p: tokenArb,
    r: tokenArb,
    // 5-digit port, well clear of the 3/4-digit decoy numbers used in errors.
    port: fc.integer({ min: 10000, max: 60000 }),
  })
  .map(({ h, u, p, r, port }) => ({
    host: `sip-host-SECRETVALUE${h}.trunk.example.com`,
    port,
    user: `sipuser-SECRETVALUE${u}`,
    password: `sippass-SECRETVALUE${p}`,
    realm: `siprealm-SECRETVALUE${r}`,
  }));

/** The list of credential VALUES (as strings) that must never be logged. */
function credentialValues(s: SipSecrets): string[] {
  return [s.host, String(s.port), s.user, s.password, s.realm];
}

/* -------------------------------------------------------------------------- *
 * Config fixture — a structurally complete RozaConfig whose `voice` channel is
 * ENABLED and carries the generated SIP secrets. The allowlist/defaultAccess
 * are parameterized so each scenario can force an allow or a reject decision.
 * -------------------------------------------------------------------------- */
function makeConfig(
  sip: SipSecrets,
  access: { allowlist: string[]; defaultAccess: 'allow' | 'reject' },
): RozaConfig {
  const voice: VoiceChannelConfig = {
    enabled: true,
    sip: { ...sip },
    allowlist: access.allowlist,
    defaultAccess: access.defaultAccess,
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
 * In-memory FAKES (no real I/O — Req 14.5).
 * -------------------------------------------------------------------------- */

interface FakeGatewayOpts {
  /** When set, `originate` rejects with this (credential-SHAPED, decoy) error. */
  originateError?: Error;
}

interface FakeGateway extends TelephonyGateway {
  emitInbound(handle: CallHandle): Promise<void>;
  emitAudio(callId: string, chunk: AudioChunk): void;
}

function makeFakeGateway(opts: FakeGatewayOpts = {}): FakeGateway {
  const audioHandlers = new Map<string, (chunk: AudioChunk) => void>();
  let inboundHandler: ((call: CallHandle) => Promise<void>) | null = null;

  return {
    listen(onInboundCall) {
      inboundHandler = onInboundCall;
      return Promise.resolve();
    },
    answer() {
      return Promise.resolve();
    },
    originate(callerIdentity) {
      if (opts.originateError) {
        return Promise.reject(opts.originateError);
      }
      // Alphabetic callId so no digit can collide with the numeric port secret.
      const handle: CallHandle = {
        callId: 'outboundcallid',
        callerIdentity,
        direction: 'outbound',
      };
      return Promise.resolve(handle);
    },
    onAudio(callId, onFrame) {
      audioHandlers.set(callId, onFrame);
    },
    playAudio() {
      return Promise.resolve();
    },
    hangup() {
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

/** A fake engine; `ok=false` exercises the engine-error log path (Req 9.4). */
function makeFakeEngine(result: HandleMessageResult): { engine: CognitiveEngine; calls: HandleMessageInput[] } {
  const calls: HandleMessageInput[] = [];
  const engine = {
    handleMessage(input: HandleMessageInput) {
      calls.push(input);
      return Promise.resolve(result);
    },
  };
  return { engine: engine as unknown as CognitiveEngine, calls };
}

/** A fake STT engine returning a fixed (alphabetic, non-empty) transcript. */
function makeFakeStt(transcript: string): SttEngine {
  return {
    transcribe: () => Promise.resolve(transcript),
    descriptor: { name: 'whisper.cpp', license: 'MIT', model: 'ggml-base.en' },
  };
}

/** A fake TTS engine; `fail=true` exercises the TTS-exhaustion log path. */
function makeFakeTts(fail = false): TtsEngine {
  return {
    synthesize: () =>
      fail
        ? Promise.reject(new Error('tts synthesis unavailable'))
        : Promise.resolve<AudioChunk>({ format: TELEPHONY_PCM_8K, data: new Uint8Array([0, 0]) }),
    descriptor: { name: 'piper', license: 'MIT', voice: 'en_US-amy-medium' },
  };
}

/** A TurnDetector factory: first frame `speaking`, next `turn_end` (one turn). */
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

/** A spy logger capturing every `(level, message, meta)` triple. */
interface CapturedLog {
  level: 'info' | 'error';
  message: string;
  meta?: Record<string, unknown>;
}
interface SpyLogger extends Logger {
  readonly entries: CapturedLog[];
}
function makeSpyLogger(): SpyLogger {
  const entries: CapturedLog[] = [];
  return {
    entries,
    info: (message, meta) => {
      entries.push(meta === undefined ? { level: 'info', message } : { level: 'info', message, meta });
    },
    error: (message, meta) => {
      entries.push(meta === undefined ? { level: 'error', message } : { level: 'error', message, meta });
    },
  };
}

/** Flush the microtask/timer queue so fire-and-forget turn loops settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeConnector(
  gateway: FakeGateway,
  engine: CognitiveEngine,
  stt: SttEngine,
  tts: TtsEngine,
  cfg: RozaConfig,
  logger: Logger,
): VoiceConnector {
  return createVoiceConnector({
    gateway,
    stt,
    tts,
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
 * Controlled, purely-alphabetic identities (no digits → cannot coincidentally
 * contain the numeric port secret) used to drive the connector paths.
 * -------------------------------------------------------------------------- */
const CALLEE = 'sip:calleeuser@callee.example.org';
const CALLER = 'sip:calleruser@caller.example.org';
/** A credential-SHAPED transport error containing ONLY decoy secrets — proving
 *  that even when the connector echoes `err.message` it never echoes the REAL
 *  SIP secrets (which are not present in this string). */
const DECOY_ORIGINATE_ERROR = new Error(
  'SIP REGISTER failed: 401 Unauthorized for sip:decoyuser:decoypass@decoy.example.net:9999',
);

describe('SIP credentials never appear in errors or logs (Property 4)', () => {
  // Feature: roza-step3-voice-telephony, Property 4: SIP credentials never appear in errors or logs
  // Validates: Requirements 7.4, 11.4
  it('drives every logging-heavy connector path and leaks no SIP credential value', async () => {
    await fc.assert(
      fc.asyncProperty(sipSecretsArb, async (sip) => {
        const logger = makeSpyLogger();
        const secrets = credentialValues(sip);

        // --- Path 1: outbound call rejected by the allowlist (rejection log) ---
        {
          const cfg = makeConfig(sip, { allowlist: [], defaultAccess: 'reject' });
          const gateway = makeFakeGateway();
          const { engine } = makeFakeEngine({ ok: false, reason: 'channel_not_operative' });
          const c = makeConnector(gateway, engine, makeFakeStt('unused'), makeFakeTts(), cfg, logger);
          const res = await c.placeOutboundCall(CALLEE);
          expect(res).toEqual({ ok: false, reason: 'not_allowlisted' });
        }

        // --- Path 2: outbound call the gateway rejects with a credential-shaped
        //     transport error (no_answer log echoing err.message) ---
        {
          const cfg = makeConfig(sip, { allowlist: [], defaultAccess: 'allow' });
          const gateway = makeFakeGateway({ originateError: DECOY_ORIGINATE_ERROR });
          const { engine } = makeFakeEngine({ ok: true, reply: 'unused', conversationId: 'c' });
          const c = makeConnector(gateway, engine, makeFakeStt('unused'), makeFakeTts(), cfg, logger);
          const res = await c.placeOutboundCall(CALLEE);
          expect(res).toEqual({ ok: false, reason: 'no_answer' });
        }

        // --- Path 3: inbound call rejected by the allowlist (hangup log) ---
        {
          const cfg = makeConfig(sip, { allowlist: [], defaultAccess: 'reject' });
          const gateway = makeFakeGateway();
          const { engine, calls } = makeFakeEngine({ ok: true, reply: 'unused', conversationId: 'c' });
          const c = makeConnector(gateway, engine, makeFakeStt('unused'), makeFakeTts(), cfg, logger);
          await c.start();
          await gateway.emitInbound({ callId: 'inboundrejectid', callerIdentity: CALLER, direction: 'inbound' });
          expect(calls).toHaveLength(0);
        }

        // --- Path 4: a normal allowed inbound turn (answer + transcribe +
        //     engine + synthesize + play) ---
        {
          const cfg = makeConfig(sip, { allowlist: [], defaultAccess: 'allow' });
          const gateway = makeFakeGateway();
          const { engine, calls } = makeFakeEngine({ ok: true, reply: 'a friendly spoken reply', conversationId: 'c' });
          const c = makeConnector(gateway, engine, makeFakeStt('hello roza'), makeFakeTts(), cfg, logger);
          await c.start();
          const callId = 'inboundokid';
          await gateway.emitInbound({ callId, callerIdentity: CALLER, direction: 'inbound' });
          const frame: AudioChunk = { format: TELEPHONY_PCM_8K, data: new Uint8Array([1, 2, 3, 4]) };
          gateway.emitAudio(callId, frame); // speaking
          gateway.emitAudio(callId, frame); // turn_end
          await flush();
          expect(calls).toHaveLength(1);
        }

        // --- Path 5: an allowed inbound turn where the engine errors
        //     (engine-failed log; no reply played) ---
        {
          const cfg = makeConfig(sip, { allowlist: [], defaultAccess: 'allow' });
          const gateway = makeFakeGateway();
          const { engine } = makeFakeEngine({ ok: false, reason: 'llm_failed' });
          const c = makeConnector(gateway, engine, makeFakeStt('hello roza'), makeFakeTts(), cfg, logger);
          await c.start();
          const callId = 'inbounderrid';
          await gateway.emitInbound({ callId, callerIdentity: CALLER, direction: 'inbound' });
          const frame: AudioChunk = { format: TELEPHONY_PCM_8K, data: new Uint8Array([5, 6, 7, 8]) };
          gateway.emitAudio(callId, frame);
          gateway.emitAudio(callId, frame);
          await flush();
        }

        // --- Path 6: an allowed inbound turn where TTS fails twice
        //     (tts-failed + tts-exhausted logs) ---
        {
          const cfg = makeConfig(sip, { allowlist: [], defaultAccess: 'allow' });
          const gateway = makeFakeGateway();
          const { engine } = makeFakeEngine({ ok: true, reply: 'a reply that cannot be synthesized', conversationId: 'c' });
          const c = makeConnector(gateway, engine, makeFakeStt('hello roza'), makeFakeTts(true), cfg, logger);
          await c.start();
          const callId = 'inboundttsid';
          await gateway.emitInbound({ callId, callerIdentity: CALLER, direction: 'inbound' });
          const frame: AudioChunk = { format: TELEPHONY_PCM_8K, data: new Uint8Array([9, 9, 9, 9]) };
          gateway.emitAudio(callId, frame);
          gateway.emitAudio(callId, frame);
          await flush();
        }

        // We actually exercised the intended logging-heavy paths.
        const messages = new Set(logger.entries.map((e) => e.message));
        expect(messages.has('voice.outbound.rejected_allowlist')).toBe(true);
        expect(messages.has('voice.outbound.no_answer')).toBe(true);
        expect(messages.has('voice.inbound.rejected_allowlist')).toBe(true);
        expect(messages.has('voice.inbound.answered')).toBe(true);
        expect(messages.has('voice.engine.failed')).toBe(true);
        expect(messages.has('voice.tts.exhausted')).toBe(true);

        // The core assertion: NO captured log line — message OR meta — contains
        // any real SIP credential VALUE (Req 7.4, 11.4).
        expect(logger.entries.length).toBeGreaterThan(0);
        for (const entry of logger.entries) {
          const serialized = JSON.stringify({ message: entry.message, meta: entry.meta });
          for (const secret of secrets) {
            expect(serialized).not.toContain(secret);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: roza-step3-voice-telephony, Property 4: SIP credentials never appear in errors or logs
  // Validates: Requirements 7.4, 11.4
  it('resolveVoiceConfig reports missing SIP variables by NAME only and leaks no provided value', () => {
    const ALL_NAMES: MissingVoiceVar[] = ['SIP_HOST', 'SIP_PORT', 'SIP_USER', 'SIP_PASSWORD', 'SIP_REALM'];

    // Which SIP vars are provided this run; filtered so at least one is missing
    // (so an ENABLED channel resolution fails and the names-only error is built).
    const provideArb = fc
      .record({
        host: fc.boolean(),
        port: fc.boolean(),
        user: fc.boolean(),
        password: fc.boolean(),
        realm: fc.boolean(),
      })
      .filter((p) => !(p.host && p.port && p.user && p.password && p.realm));

    fc.assert(
      fc.property(sipSecretsArb, provideArb, (sip, provide) => {
        const env: NodeJS.ProcessEnv = { VOICE_ENABLED: 'true' };
        // Track the credential VALUES we actually supplied to the resolver.
        const providedValues: string[] = [];
        if (provide.host) {
          env.SIP_HOST = sip.host;
          providedValues.push(sip.host);
        }
        if (provide.port) {
          env.SIP_PORT = String(sip.port);
          providedValues.push(String(sip.port));
        }
        if (provide.user) {
          env.SIP_USER = sip.user;
          providedValues.push(sip.user);
        }
        if (provide.password) {
          env.SIP_PASSWORD = sip.password;
          providedValues.push(sip.password);
        }
        if (provide.realm) {
          env.SIP_REALM = sip.realm;
          providedValues.push(sip.realm);
        }

        const result = resolveVoiceConfig(env);

        // At least one var is missing → an ENABLED channel resolution fails.
        expect(result.ok).toBe(false);
        if (result.ok) {
          return;
        }

        // The missing list contains only valid variable NAMES, and exactly the
        // ones we omitted (never anything derived from a value).
        const expectedMissing = ALL_NAMES.filter((name) => {
          switch (name) {
            case 'SIP_HOST':
              return !provide.host;
            case 'SIP_PORT':
              return !provide.port;
            case 'SIP_USER':
              return !provide.user;
            case 'SIP_PASSWORD':
              return !provide.password;
            case 'SIP_REALM':
              return !provide.realm;
          }
        });
        for (const name of result.missing) {
          expect(ALL_NAMES).toContain(name);
        }
        expect([...result.missing].sort()).toEqual([...expectedMissing].sort());

        // The WHOLE serialized result leaks none of the VALUES that were
        // provided — only names ever surface (Req 7.4 reinforced by 7.2).
        const serialized = JSON.stringify(result);
        for (const value of providedValues) {
          expect(serialized).not.toContain(value);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
