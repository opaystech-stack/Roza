import { describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { ScheduledTask } from 'node-cron';

import { start, type BootstrapDeps, type RozaHandle } from './bootstrap.js';
import { CognitiveEngine } from './engine.js';
import { DEFAULT_PROFILE, type RozaProfile } from './profile.js';
import type { Channel, Logger } from './types.js';
import type { RozaConfig } from './config.js';
import type { Repository } from './repository.js';
import type { InboundRouter, InboundRouterDeps } from './connectors/router.js';
import type { InboundQueueStore } from './connectors/queue.js';
import type { InboundMessage } from './connectors/connector.js';
import type { VoiceConnector } from './connectors/voice/voiceConnector.js';
import type { AvatarConnector } from './connectors/avatar/avatarConnector.js';
import type { XConnector } from './connectors/x/xConnector.js';
import type { SchedulerDeps } from './scheduler.js';

/**
 * Phase 5 bootstrap wiring + isolation tests (task 10.4) — Req 1.2, 1.6, 11.3, 13.5.
 *
 * These drive {@link start} with fully injected collaborators so the Phase 5
 * X_Connector startup wiring and its fault isolation are asserted WITHOUT
 * opening a real database, touching a real Playwright browser / X network /
 * storageState file, or calling the real `process.exit`:
 *
 *  - X enabled  → the Playwright X session adapter (via the injected
 *    `createXSession`) and the X_Connector (via `createX`) are each built once,
 *    the connector's `start()` is invoked, the returned handle exposes `x`, AND
 *    its `runXAutonomy` is wired into the scheduler — the dep passed to the
 *    injected `initScheduler` carries a `runXAutonomy` that, when invoked, calls
 *    the connector's own `runXAutonomy` (Req 1.2, 4.1, 11.3),
 *  - X disabled → NO XSession/X_Connector is built or started, the handle's `x`
 *    is undefined, the scheduler receives NO `runXAutonomy` dep, startup is
 *    byte-for-byte the Phase 4 shape, and the `Channel` union / `connectors` Map
 *    stay free of any `'x'` member (Req 1.6),
 *  - fault isolation → an X_Connector whose `start()` throws (sync) or rejects
 *    (async) is logged via `logger.error` ('[x] startup failed …') while the
 *    scheduler, the text channels, the voice channel, and the avatar capability
 *    keep running (Req 11.3, 13.5),
 *  - an X startup failure NEVER calls `deps.exit` (only a scheduler-init failure
 *    exits — Req 1.5).
 *
 * `start` is synchronous but the X_Connector's `start()` is async
 * fire-and-forget (its rejection isolated via `.catch`), so the fault-isolation
 * assertions flush a couple of microtasks before inspecting the error log.
 */

/** Flush pending microtasks so an X `start()` rejection's `.catch` runs. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * A valid base config. The `voice.enabled` and `avatar.enabled` flags are forced
 * ON so the X isolation tests can independently assert those capabilities keep
 * running; the `x.enabled` flag is overridden per test.
 */
function makeConfig(xEnabled: boolean): RozaConfig {
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
      enabled: true,
      sip: { host: 'sip.example', port: 5060, user: 'roza', password: 'pw', realm: 'example' },
      allowlist: [],
      defaultAccess: 'reject',
      quietHoursInbound: 'take_message',
      tts: { engine: 'piper', voice: 'en_US-amy-medium', model: 'en_US-amy-medium' },
      stt: { engine: 'whisper.cpp', model: 'ggml-base.en' },
      maxReplyChars: 1000,
      latency: { ttsMs: 5000, sttMs: 5000, endToEndMs: 8000, ringTimeoutMs: 30000 },
    },
    avatar: {
      enabled: true,
      video: { width: 512, height: 512, fps: 25, pixelFormat: 'yuv420p' },
      latency: { renderMs: 4000 },
      renderer: { endpoint: 'http://renderer.local', engine: 'liveportrait' },
      devices: { camera: '/dev/video10', microphone: 'roza_mic' },
      meet: { enabled: false, consent: false, account: '', password: '' },
      stream: { enabled: false, url: '', key: '' },
    },
    x: {
      enabled: xEnabled,
      credentials: {
        username: xEnabled ? 'roza_handle' : '',
        password: xEnabled ? 'x-secret' : '',
      },
      storageStatePath: '/tmp/roza-test-data/x_storage_state.json',
      autonomyIntervalMinutes: 60,
      rateLimit: { dailyPostLimit: 10, actionSpacingMs: 600_000 },
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

/** A fake {@link VoiceConnector} whose `start()` resolves. */
function makeVoiceConnector(): VoiceConnector & { start: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(() => Promise.resolve()),
    placeOutboundCall: vi.fn(() => Promise.resolve({ ok: true })),
  } as VoiceConnector & { start: ReturnType<typeof vi.fn> };
}

/** A fake {@link AvatarConnector} whose `start()` resolves. */
function makeAvatarConnector(): AvatarConnector & { start: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(() => Promise.resolve()),
    present: vi.fn(() => Promise.resolve({ ok: true, mode: 'video' as const })),
    joinMeet: vi.fn(() => Promise.resolve({ ok: true })),
    muteMeet: vi.fn(() => Promise.resolve()),
    leaveMeet: vi.fn(() => Promise.resolve()),
    startStream: vi.fn(() => Promise.resolve({ ok: true })),
    stopStream: vi.fn(() => Promise.resolve()),
  } as unknown as AvatarConnector & { start: ReturnType<typeof vi.fn> };
}

/**
 * A fake {@link XConnector}. `start` is a spy whose behavior (resolve, reject, or
 * synchronous throw) is supplied per test so the fault-isolation path can be
 * driven without any real browser / X network / storageState I/O. `runXAutonomy`
 * is a benign spy so the scheduler-wiring assertion can confirm the captured dep
 * delegates to it. `stop` is a no-op spy.
 */
function makeXConnector(
  startImpl: () => Promise<void> = () => Promise.resolve(),
): XConnector & {
  start: ReturnType<typeof vi.fn>;
  runXAutonomy: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn(startImpl),
    runXAutonomy: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
  } as unknown as XConnector & {
    start: ReturnType<typeof vi.fn>;
    runXAutonomy: ReturnType<typeof vi.fn>;
  };
}

interface Harness {
  deps: BootstrapDeps;
  logger: ReturnType<typeof makeLogger>;
  scheduler: ScheduledTask;
  voiceConnector: VoiceConnector & { start: ReturnType<typeof vi.fn> };
  avatarConnector: AvatarConnector & { start: ReturnType<typeof vi.fn> };
  xConnector: XConnector & {
    start: ReturnType<typeof vi.fn>;
    runXAutonomy: ReturnType<typeof vi.fn>;
  };
  createVoice: ReturnType<typeof vi.fn>;
  createAvatar: ReturnType<typeof vi.fn>;
  createX: ReturnType<typeof vi.fn>;
  createXSession: ReturnType<typeof vi.fn>;
  initScheduler: ReturnType<typeof vi.fn>;
  /** The deps object captured from the single `initScheduler` call. */
  capturedSchedulerDeps(): SchedulerDeps;
  exit: ReturnType<typeof vi.fn>;
}

/**
 * Assemble injected {@link BootstrapDeps} plus the spies/fakes the assertions
 * inspect. Every external edge is a `vi.fn()` so no real DB, network, SIP,
 * renderer, device, browser, ffmpeg, X session, or `process.exit` is touched.
 */
function makeHarness(
  cfg: RozaConfig,
  opts: { profile?: RozaProfile; xStart?: () => Promise<void> } = {},
): Harness {
  const profile = opts.profile ?? DEFAULT_PROFILE;
  const logger = makeLogger();
  const scheduler = makeScheduler();
  const router = makeRouter();
  const voiceConnector = makeVoiceConnector();
  const avatarConnector = makeAvatarConnector();
  const xConnector = makeXConnector(opts.xStart);

  const loadConfig = vi.fn((_env: NodeJS.ProcessEnv): RozaConfig => cfg);
  const initDatabase = vi.fn((): Database.Database => makeDb());
  const createRepo = vi.fn((): Repository => makeRepo());
  const loadProfile = vi.fn((): RozaProfile => profile);
  const createQueue = vi.fn((): InboundQueueStore => makeQueue());
  const createRouter = vi.fn((_d: InboundRouterDeps): InboundRouter => router);

  const createTelegram = vi.fn();
  const createMail = vi.fn();

  // Minimal opaque voice adapter fakes — the injected `createVoice` ignores them.
  const createTelephonyGateway = vi.fn(() => ({ __gateway: true }));
  const createSttEngine = vi.fn(() => ({ __stt: true }));
  const createTtsEngine = vi.fn(() => ({ __tts: true }));
  const createVoice = vi.fn((): VoiceConnector => voiceConnector);

  // Minimal opaque avatar adapter fakes — the injected `createAvatar` ignores them.
  const createAvatarRenderer = vi.fn(() => ({ __renderer: true }));
  const createVirtualCamera = vi.fn(() => ({ __camera: true }));
  const createVirtualMicrophone = vi.fn(() => ({ __microphone: true }));
  const createMeetSession = vi.fn(() => ({ __meet: true }));
  const createStreamSession = vi.fn(() => ({ __stream: true }));
  const createAvatar = vi.fn((): AvatarConnector => avatarConnector);

  // The X session adapter is an opaque fake — the injected `createX` ignores it.
  const createXSession = vi.fn(() => ({ __xSession: true }));
  const createX = vi.fn((): XConnector => xConnector);

  // Capture the deps passed to the scheduler so the `runXAutonomy` wiring can be
  // asserted (presence when enabled, absence when disabled, delegation on call).
  let schedulerDeps: SchedulerDeps | undefined;
  const initScheduler = vi.fn((d: SchedulerDeps): ScheduledTask => {
    schedulerDeps = d;
    return scheduler;
  });

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
    createAvatar: createAvatar as unknown as NonNullable<BootstrapDeps['createAvatar']>,
    createAvatarRenderer:
      createAvatarRenderer as unknown as NonNullable<BootstrapDeps['createAvatarRenderer']>,
    createVirtualCamera:
      createVirtualCamera as unknown as NonNullable<BootstrapDeps['createVirtualCamera']>,
    createVirtualMicrophone:
      createVirtualMicrophone as unknown as NonNullable<BootstrapDeps['createVirtualMicrophone']>,
    createMeetSession: createMeetSession as unknown as NonNullable<BootstrapDeps['createMeetSession']>,
    createStreamSession:
      createStreamSession as unknown as NonNullable<BootstrapDeps['createStreamSession']>,
    createX: createX as unknown as NonNullable<BootstrapDeps['createX']>,
    createXSession: createXSession as unknown as NonNullable<BootstrapDeps['createXSession']>,
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
    avatarConnector,
    xConnector,
    createVoice,
    createAvatar,
    createX,
    createXSession,
    initScheduler,
    capturedSchedulerDeps(): SchedulerDeps {
      if (schedulerDeps === undefined) {
        throw new Error('initScheduler was not called');
      }
      return schedulerDeps;
    },
    exit,
  };
}

describe('bootstrap (Phase 5) — X enabled builds, starts, and wires the X_Connector (Req 1.2, 4.1, 11.3)', () => {
  it('builds the XSession + X_Connector once, starts it, and exposes handle.x', async () => {
    const cfg = makeConfig(true);
    const h = makeHarness(cfg);

    const handle = start({}, h.deps);
    await flushMicrotasks();

    // The session adapter and the connector factory each ran exactly once.
    expect(h.createXSession).toHaveBeenCalledTimes(1);
    expect(h.createX).toHaveBeenCalledTimes(1);

    // The connector's transport was started (fire-and-forget).
    expect(h.xConnector.start).toHaveBeenCalledTimes(1);

    // The constructed connector is exposed on the handle (Req 11.3).
    expect(handle.x).toBeDefined();
    expect(handle.x).toBe(h.xConnector);

    // Happy path: no fatal error and no exit.
    expect(h.logger.error).not.toHaveBeenCalled();
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('wires runXAutonomy into the scheduler; invoking the dep calls the connector (Req 4.1)', async () => {
    const cfg = makeConfig(true);
    const h = makeHarness(cfg);

    start({}, h.deps);
    await flushMicrotasks();

    const schedulerDeps = h.capturedSchedulerDeps();

    // The scheduler received a runXAutonomy dep (only when X is enabled).
    expect(schedulerDeps.runXAutonomy).toBeDefined();
    expect(typeof schedulerDeps.runXAutonomy).toBe('function');

    // Before the tick fires, the connector's runXAutonomy has not been called.
    expect(h.xConnector.runXAutonomy).not.toHaveBeenCalled();

    // Invoking the wired dep (as the in-window tick would) delegates to the
    // connector's own runXAutonomy.
    await schedulerDeps.runXAutonomy!();
    expect(h.xConnector.runXAutonomy).toHaveBeenCalledTimes(1);
  });
});

describe('bootstrap (Phase 5) — X disabled is byte-for-byte the Phase 4 startup (Req 1.6)', () => {
  it('builds and starts no XSession or X_Connector, and handle.x is undefined', async () => {
    const cfg = makeConfig(false);
    const h = makeHarness(cfg);

    const handle = start({}, h.deps);
    await flushMicrotasks();

    // No XSession or X_Connector is constructed or started.
    expect(h.createXSession).not.toHaveBeenCalled();
    expect(h.createX).not.toHaveBeenCalled();
    expect(h.xConnector.start).not.toHaveBeenCalled();

    // The handle omits `x` entirely on the disabled path.
    expect(handle.x).toBeUndefined();

    // The Phase 4 wiring is intact: voice + avatar still built+started, the
    // scheduler-backed engine handle is returned.
    expect(h.createVoice).toHaveBeenCalledTimes(1);
    expect(handle.voice).toBe(h.voiceConnector);
    expect(h.createAvatar).toHaveBeenCalledTimes(1);
    expect(handle.avatar).toBe(h.avatarConnector);
    expect(handle.scheduler).toBe(h.scheduler);
    expect(handle.engine).toBeInstanceOf(CognitiveEngine);
    expect(h.logger.error).not.toHaveBeenCalled();
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('omits the scheduler runXAutonomy dep when X is disabled (Req 1.6)', async () => {
    const cfg = makeConfig(false);
    const h = makeHarness(cfg);

    start({}, h.deps);
    await flushMicrotasks();

    const schedulerDeps = h.capturedSchedulerDeps();
    // The disabled-path scheduler wiring is byte-for-byte the Phase 4 shape:
    // no runXAutonomy dep is constructed at all.
    expect('runXAutonomy' in schedulerDeps).toBe(false);
    expect(schedulerDeps.runXAutonomy).toBeUndefined();
  });

  it('keeps the Channel union / connectors Map unchanged (no "x" channel) — Req 1.6', async () => {
    const cfg = makeConfig(false);
    const h = makeHarness(cfg);

    const handle = start({}, h.deps);
    await flushMicrotasks();

    // X is a presence/autonomy capability, not a conversation Channel: the union
    // carries only internal/telegram/email/voice and never an 'x' member.
    const channels: Channel[] = ['internal', 'telegram', 'email', 'voice'];
    expect(channels).not.toContain('x' as unknown as Channel);

    // The router's connectors Map is keyed by OperativeChannel only and never
    // gains an 'x' key (the X capability lives on `handle.x`, outside it).
    expect([...handle.connectors.keys()]).not.toContain('x');
  });
});

describe('bootstrap (Phase 5) — X startup fault isolation (Req 11.3, 13.5)', () => {
  it('isolates an X_Connector whose start() rejects asynchronously', async () => {
    const cfg = makeConfig(true);
    const h = makeHarness(cfg, {
      xStart: () => Promise.reject(new Error('anti-bot challenge on open')),
    });

    const handle = start({}, h.deps);
    // start() is attempted synchronously; the rejection is isolated async.
    expect(h.xConnector.start).toHaveBeenCalledTimes(1);
    // A handle is returned regardless of the X transport's fate.
    expect(handle).toBeDefined();

    await flushMicrotasks();

    // The X failure was logged via logger.error with the documented message.
    expect(h.logger.error).toHaveBeenCalledTimes(1);
    const [errMessage] = h.logger.error.mock.calls[0]!;
    expect(typeof errMessage).toBe('string');
    expect(errMessage as string).toContain('[x] startup failed');

    // The scheduler, the text/internal channels, the voice channel, AND the
    // avatar capability are unaffected, and an X failure NEVER exits the process.
    expect(handle.scheduler).toBe(h.scheduler);
    expect(handle.engine).toBeInstanceOf(CognitiveEngine);
    expect(h.voiceConnector.start).toHaveBeenCalledTimes(1);
    expect(handle.voice).toBe(h.voiceConnector);
    expect(h.avatarConnector.start).toHaveBeenCalledTimes(1);
    expect(handle.avatar).toBe(h.avatarConnector);
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('isolates an X_Connector whose start() throws synchronously', async () => {
    const cfg = makeConfig(true);
    const h = makeHarness(cfg, {
      xStart: () => {
        throw new Error('synchronous session-init failure');
      },
    });

    const handle = start({}, h.deps);
    await flushMicrotasks();

    // The synchronous throw is isolated and logged the same way.
    expect(h.logger.error).toHaveBeenCalledTimes(1);
    const [errMessage] = h.logger.error.mock.calls[0]!;
    expect(errMessage as string).toContain('[x] startup failed');

    // Handle returned, scheduler + voice + avatar running, no exit.
    expect(handle).toBeDefined();
    expect(handle.scheduler).toBe(h.scheduler);
    expect(h.voiceConnector.start).toHaveBeenCalledTimes(1);
    expect(handle.voice).toBe(h.voiceConnector);
    expect(h.avatarConnector.start).toHaveBeenCalledTimes(1);
    expect(handle.avatar).toBe(h.avatarConnector);
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('does not call deps.exit on an X startup failure', async () => {
    const cfg = makeConfig(true);
    const h = makeHarness(cfg, {
      xStart: () => Promise.reject(new Error('x down')),
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
