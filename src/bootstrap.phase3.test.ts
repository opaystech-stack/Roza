import { describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { ScheduledTask } from 'node-cron';

import { start, type BootstrapDeps, type RozaHandle } from './bootstrap.js';
import { CognitiveEngine } from './engine.js';
import { DEFAULT_PROFILE, type RozaProfile } from './profile.js';
import type { RozaConfig } from './config.js';
import type { Repository } from './repository.js';
import type { InboundRouter, InboundRouterDeps } from './connectors/router.js';
import type { InboundQueueStore } from './connectors/queue.js';
import type { InboundMessage } from './connectors/connector.js';
import type { VoiceConnector } from './connectors/voice/voiceConnector.js';
import type { Logger } from './types.js';

/**
 * Phase 3 bootstrap wiring + isolation tests (task 14.2) — Req 1.2, 9.5, 12.6.
 *
 * These drive {@link start} with fully injected collaborators so the Phase 3
 * Voice_Connector startup wiring and its fault isolation are asserted WITHOUT
 * opening a real database, touching a real telephony/SIP transport, spawning a
 * native STT/TTS binary, or calling the real `process.exit`:
 *
 *  - voice enabled  → the Asterisk gateway / whisper STT / Piper TTS adapters
 *    and the Voice_Connector are each built once, the connector's `start()` is
 *    invoked, and the returned handle exposes `voice` (Req 1.2, 9.5),
 *  - voice disabled → NO gateway/STT/TTS/connector is built or started and the
 *    handle's `voice` is undefined (byte-for-byte the Phase 2 startup),
 *  - fault isolation → a Voice_Connector whose `start()` rejects (async) or
 *    throws (sync) is logged via `logger.error` ('[voice] startup failed …')
 *    while the scheduler and the always-on channels keep running (Req 12.6),
 *  - a voice startup failure NEVER calls `deps.exit` (only a scheduler-init
 *    failure exits — Req 1.5).
 *
 * `start` is synchronous but the Voice_Connector's `start()` is async
 * fire-and-forget (its rejection isolated via `.catch`), so the fault-isolation
 * assertions flush a couple of microtasks before inspecting the error log.
 */

/** Flush pending microtasks so a voice `start()` rejection's `.catch` runs. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** A valid base config; the `voice.enabled` flag is overridden per test. */
function makeConfig(voiceEnabled: boolean): RozaConfig {
  return {
    rozaPrivateKey: 'fake-private-key',
    openRouterApiKey: 'fake-openrouter-key',
    openRouterModel: 'openai/gpt-4o-mini',
    dataDir: '/tmp/roza-test-data',
    timezone: 'UTC',
    activeWindow: { startMinutes: 420, endMinutes: 1320 },
    keyVersion: 'v1',
    telegram: { enabled: false, botToken: '', allowlist: [] },
    mail: {
      enabled: false,
      imap: { host: '', port: 0, user: '', password: '' },
      smtp: { host: '', port: 0, user: '', password: '' },
      allowlist: [],
    },
    voice: {
      enabled: voiceEnabled,
      // A valid SIP block so the enabled path has complete credentials.
      sip: voiceEnabled
        ? { host: 'sip.example', port: 5060, user: 'roza', password: 'pw', realm: 'example' }
        : { host: '', port: 0, user: '', password: '', realm: '' },
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

/** Build a fresh logger with spied methods. */
function makeLogger(): Logger & {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), error: vi.fn() };
}

/** Minimal opaque fakes; the injected factories never exercise their methods. */
function makeRepo(): Repository {
  return { recordTaskInvocation: vi.fn(), tx: vi.fn(<T>(fn: () => T): T => fn()) } as unknown as Repository;
}
function makeDb(): Database.Database {
  return { __fakeDb: true } as unknown as Database.Database;
}
function makeScheduler(): ScheduledTask {
  return { stop: vi.fn(), start: vi.fn() } as unknown as ScheduledTask;
}
function makeQueue(): InboundQueueStore {
  return {
    enqueue: vi.fn(),
    dequeueInReceiptOrder: vi.fn(() => []),
    lookup: vi.fn(() => 'none' as const),
    recordAnswered: vi.fn(),
    getStoredReply: vi.fn(() => null),
    markSent: vi.fn(),
  };
}

/** A fake {@link InboundRouter}; only `drainQueue`/`handleInbound` are wired. */
function makeRouter(): InboundRouter {
  return {
    drainQueue: vi.fn(() => Promise.resolve()),
    handleInbound: vi.fn((_msg: InboundMessage) => Promise.resolve()),
  } as unknown as InboundRouter;
}

/**
 * A fake {@link VoiceConnector}. `start` is a spy whose behavior (resolve,
 * reject, or synchronous throw) is supplied per test so the fault-isolation
 * path can be driven without any real telephony I/O.
 */
function makeVoiceConnector(
  startImpl: () => Promise<void> = () => Promise.resolve(),
): VoiceConnector & { start: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(startImpl),
    placeOutboundCall: vi.fn(() => Promise.resolve({ ok: true })),
  } as VoiceConnector & { start: ReturnType<typeof vi.fn> };
}

interface Harness {
  deps: BootstrapDeps;
  logger: ReturnType<typeof makeLogger>;
  scheduler: ScheduledTask;
  voiceConnector: VoiceConnector & { start: ReturnType<typeof vi.fn> };
  createVoice: ReturnType<typeof vi.fn>;
  createTelephonyGateway: ReturnType<typeof vi.fn>;
  createSttEngine: ReturnType<typeof vi.fn>;
  createTtsEngine: ReturnType<typeof vi.fn>;
  createTelegram: ReturnType<typeof vi.fn>;
  createMail: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
}

/**
 * Assemble injected {@link BootstrapDeps} plus the spies/fakes the assertions
 * inspect. Every external edge is a `vi.fn()` so no real DB, network, SIP,
 * native binary, or `process.exit` is touched.
 */
function makeHarness(
  cfg: RozaConfig,
  opts: {
    profile?: RozaProfile;
    voiceStart?: () => Promise<void>;
  } = {},
): Harness {
  const profile = opts.profile ?? DEFAULT_PROFILE;
  const logger = makeLogger();
  const scheduler = makeScheduler();
  const router = makeRouter();
  const voiceConnector = makeVoiceConnector(opts.voiceStart);

  const loadConfig = vi.fn((_env: NodeJS.ProcessEnv): RozaConfig => cfg);
  const initDatabase = vi.fn((): Database.Database => makeDb());
  const createRepo = vi.fn((): Repository => makeRepo());
  const loadProfile = vi.fn((): RozaProfile => profile);
  const createQueue = vi.fn((): InboundQueueStore => makeQueue());
  const createRouter = vi.fn((_d: InboundRouterDeps): InboundRouter => router);

  const createTelegram = vi.fn();
  const createMail = vi.fn();

  // Minimal opaque adapter fakes — the injected `createVoice` ignores them, so
  // they only need to be returnable objects (no methods are exercised).
  const createTelephonyGateway = vi.fn(() => ({ __gateway: true }));
  const createSttEngine = vi.fn(() => ({ __stt: true }));
  const createTtsEngine = vi.fn(() => ({ __tts: true }));
  const createVoice = vi.fn((): VoiceConnector => voiceConnector);

  const initScheduler = vi.fn((): ScheduledTask => scheduler);

  const exit = vi.fn((_code: number): never => {
    throw new Error('__exit__');
  });

  const deps: BootstrapDeps = {
    loadConfig: loadConfig as unknown as NonNullable<BootstrapDeps['loadConfig']>,
    initDatabase: initDatabase as unknown as NonNullable<BootstrapDeps['initDatabase']>,
    createRepo: createRepo as unknown as NonNullable<BootstrapDeps['createRepo']>,
    loadProfile: loadProfile as unknown as NonNullable<BootstrapDeps['loadProfile']>,
    createQueue: createQueue as unknown as NonNullable<BootstrapDeps['createQueue']>,
    createRouter: createRouter as unknown as NonNullable<BootstrapDeps['createRouter']>,
    createTelegram: createTelegram as unknown as NonNullable<BootstrapDeps['createTelegram']>,
    createMail: createMail as unknown as NonNullable<BootstrapDeps['createMail']>,
    createVoice: createVoice as unknown as NonNullable<BootstrapDeps['createVoice']>,
    createTelephonyGateway:
      createTelephonyGateway as unknown as NonNullable<BootstrapDeps['createTelephonyGateway']>,
    createSttEngine: createSttEngine as unknown as NonNullable<BootstrapDeps['createSttEngine']>,
    createTtsEngine: createTtsEngine as unknown as NonNullable<BootstrapDeps['createTtsEngine']>,
    initScheduler: initScheduler as unknown as NonNullable<BootstrapDeps['initScheduler']>,
    llm: vi.fn() as unknown as NonNullable<BootstrapDeps['llm']>,
    logger,
    now: () => new Date('2024-06-01T12:00:00.000Z'),
    exit: exit as unknown as NonNullable<BootstrapDeps['exit']>,
  };

  return {
    deps,
    logger,
    scheduler,
    voiceConnector,
    createVoice,
    createTelephonyGateway,
    createSttEngine,
    createTtsEngine,
    createTelegram,
    createMail,
    exit,
  };
}

describe('bootstrap (Phase 3) — voice enabled builds and starts the Voice_Connector (Req 1.2, 9.5)', () => {
  it('builds the gateway/STT/TTS adapters and the connector once, starts it, and exposes handle.voice', async () => {
    const cfg = makeConfig(true);
    const h = makeHarness(cfg);

    const handle = start({}, h.deps);
    await flushMicrotasks();

    // Each voice adapter factory and the connector factory ran exactly once.
    expect(h.createTelephonyGateway).toHaveBeenCalledTimes(1);
    expect(h.createSttEngine).toHaveBeenCalledTimes(1);
    expect(h.createTtsEngine).toHaveBeenCalledTimes(1);
    expect(h.createVoice).toHaveBeenCalledTimes(1);

    // The connector's transport was started (fire-and-forget).
    expect(h.voiceConnector.start).toHaveBeenCalledTimes(1);

    // The constructed connector is exposed on the handle (Req 9.5).
    expect(handle.voice).toBeDefined();
    expect(handle.voice).toBe(h.voiceConnector);

    // Happy path: no fatal error and no exit.
    expect(h.logger.error).not.toHaveBeenCalled();
    expect(h.exit).not.toHaveBeenCalled();
  });
});

describe('bootstrap (Phase 3) — voice disabled is byte-for-byte the Phase 2 startup (Req 1.2)', () => {
  it('builds and starts no voice adapters or connector, and handle.voice is undefined', async () => {
    const cfg = makeConfig(false);
    const h = makeHarness(cfg);

    const handle = start({}, h.deps);
    await flushMicrotasks();

    // No voice adapter or connector is constructed or started.
    expect(h.createTelephonyGateway).not.toHaveBeenCalled();
    expect(h.createSttEngine).not.toHaveBeenCalled();
    expect(h.createTtsEngine).not.toHaveBeenCalled();
    expect(h.createVoice).not.toHaveBeenCalled();
    expect(h.voiceConnector.start).not.toHaveBeenCalled();

    // The handle omits `voice` entirely on the disabled path.
    expect(handle.voice).toBeUndefined();

    // The Phase 2 wiring is intact: a scheduler-backed engine handle is returned.
    expect(handle.scheduler).toBe(h.scheduler);
    expect(handle.engine).toBeInstanceOf(CognitiveEngine);
    expect(h.logger.error).not.toHaveBeenCalled();
    expect(h.exit).not.toHaveBeenCalled();
  });
});

describe('bootstrap (Phase 3) — voice startup fault isolation (Req 9.5, 12.6)', () => {
  it('isolates a Voice_Connector whose start() rejects asynchronously', async () => {
    const cfg = makeConfig(true);
    const h = makeHarness(cfg, {
      voiceStart: () => Promise.reject(new Error('SIP/ARI handshake failed')),
    });

    const handle = start({}, h.deps);
    // start() is attempted synchronously; the rejection is isolated async.
    expect(h.voiceConnector.start).toHaveBeenCalledTimes(1);
    // A handle is returned regardless of the voice transport's fate.
    expect(handle).toBeDefined();

    await flushMicrotasks();

    // The voice failure was logged via logger.error with the documented message.
    expect(h.logger.error).toHaveBeenCalledTimes(1);
    const [errMessage] = h.logger.error.mock.calls[0]!;
    expect(typeof errMessage).toBe('string');
    expect(errMessage as string).toContain('[voice] startup failed');

    // The scheduler and the text/internal channels are unaffected, and a voice
    // failure NEVER exits the process (only a scheduler-init failure exits).
    expect(handle.scheduler).toBe(h.scheduler);
    expect(handle.engine).toBeInstanceOf(CognitiveEngine);
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('isolates a Voice_Connector whose start() throws synchronously', async () => {
    const cfg = makeConfig(true);
    const h = makeHarness(cfg, {
      voiceStart: () => {
        throw new Error('synchronous telephony failure');
      },
    });

    const handle = start({}, h.deps);
    await flushMicrotasks();

    // The synchronous throw is isolated and logged the same way.
    expect(h.logger.error).toHaveBeenCalledTimes(1);
    const [errMessage] = h.logger.error.mock.calls[0]!;
    expect(errMessage as string).toContain('[voice] startup failed');

    // Handle returned, scheduler running, no exit.
    expect(handle).toBeDefined();
    expect(handle.scheduler).toBe(h.scheduler);
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('does not call deps.exit on a voice startup failure', async () => {
    const cfg = makeConfig(true);
    const h = makeHarness(cfg, {
      voiceStart: () => Promise.reject(new Error('voice down')),
    });

    let handle: RozaHandle | undefined;
    expect(() => {
      handle = start({}, h.deps);
    }).not.toThrow();
    await flushMicrotasks();

    expect(handle).toBeDefined();
    expect(h.exit).not.toHaveBeenCalled();
  });
});
