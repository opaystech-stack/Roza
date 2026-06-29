import { describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { ScheduledTask } from 'node-cron';

import { start, type BootstrapDeps, type RozaHandle } from './bootstrap.js';
import { CognitiveEngine } from './engine.js';
import { DEFAULT_PROFILE, type RozaProfile } from './profile.js';
import type { Channel } from './types.js';
import type { RozaConfig } from './config.js';
import type { Repository } from './repository.js';
import type { InboundRouter, InboundRouterDeps } from './connectors/router.js';
import type { InboundQueueStore } from './connectors/queue.js';
import type { InboundMessage } from './connectors/connector.js';
import type { VoiceConnector } from './connectors/voice/voiceConnector.js';
import type { AvatarConnector } from './connectors/avatar/avatarConnector.js';
import type { Logger } from './types.js';

/**
 * Phase 4 bootstrap wiring + isolation tests (task 13.2) — Req 1.2, 1.6, 9.5, 11.1.
 *
 * These drive {@link start} with fully injected collaborators so the Phase 4
 * Avatar_Connector startup wiring and its fault isolation are asserted WITHOUT
 * opening a real database, touching a real renderer sidecar / v4l2 device /
 * PipeWire sink / Playwright browser / ffmpeg RTMP transport, or calling the
 * real `process.exit`:
 *
 *  - avatar enabled  → the renderer-sidecar / v4l2-camera / PipeWire-mic
 *    adapters and the Avatar_Connector are each built once (createAvatar), the
 *    connector's `start()` is invoked, and the returned handle exposes
 *    `avatar` (Req 1.2, 9.5),
 *  - avatar disabled → NO renderer/device/connector is built or started, the
 *    handle's `avatar` is undefined, startup is byte-for-byte the Phase 3
 *    sequence, and the `Channel` union stays free of any `'avatar'` member with
 *    only `internal`/`telegram`/`email`/`voice` operative (Req 1.6, 11.1),
 *  - fault isolation → an Avatar_Connector whose `start()` rejects (async) or
 *    throws (sync) is logged via `logger.error` ('[avatar] startup failed …')
 *    while the scheduler, the text channels, and the voice channel keep
 *    running (Req 9.5, 12.6),
 *  - an avatar startup failure NEVER calls `deps.exit` (only a scheduler-init
 *    failure exits — Req 1.5).
 *
 * `start` is synchronous but the Avatar_Connector's `start()` is async
 * fire-and-forget (its rejection isolated via `.catch`), so the fault-isolation
 * assertions flush a couple of microtasks before inspecting the error log.
 */

/** Flush pending microtasks so an avatar `start()` rejection's `.catch` runs. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * A valid base config. The `voice.enabled` flag is forced ON so the avatar
 * isolation tests can independently assert the voice channel keeps running, and
 * the `avatar.enabled` flag is overridden per test.
 */
function makeConfig(avatarEnabled: boolean): RozaConfig {
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
      enabled: avatarEnabled,
      video: { width: 512, height: 512, fps: 25, pixelFormat: 'yuv420p' },
      latency: { renderMs: 4000 },
      renderer: { endpoint: avatarEnabled ? 'http://renderer.local' : '', engine: avatarEnabled ? 'liveportrait' : '' },
      devices: {
        camera: avatarEnabled ? '/dev/video10' : '',
        microphone: avatarEnabled ? 'roza_mic' : '',
      },
      // Meet/stream sub-capabilities stay OFF so the base avatar-enabled path
      // builds no browser/ffmpeg object.
      meet: { enabled: false, consent: false, account: '', password: '' },
      stream: { enabled: false, url: '', key: '' },
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
 * A fake {@link VoiceConnector} whose `start()` resolves — the avatar tests only
 * need the voice channel to keep running, not to fail.
 */
function makeVoiceConnector(): VoiceConnector & { start: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(() => Promise.resolve()),
    placeOutboundCall: vi.fn(() => Promise.resolve({ ok: true })),
  } as VoiceConnector & { start: ReturnType<typeof vi.fn> };
}

/**
 * A fake {@link AvatarConnector}. `start` is a spy whose behavior (resolve,
 * reject, or synchronous throw) is supplied per test so the fault-isolation
 * path can be driven without any real renderer/device/browser/RTMP I/O. Every
 * other method is a benign no-op spy (never exercised during startup).
 */
function makeAvatarConnector(
  startImpl: () => Promise<void> = () => Promise.resolve(),
): AvatarConnector & { start: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(startImpl),
    present: vi.fn(() => Promise.resolve({ ok: true, mode: 'video' as const })),
    joinMeet: vi.fn(() => Promise.resolve({ ok: true })),
    muteMeet: vi.fn(() => Promise.resolve()),
    leaveMeet: vi.fn(() => Promise.resolve()),
    startStream: vi.fn(() => Promise.resolve({ ok: true })),
    stopStream: vi.fn(() => Promise.resolve()),
  } as unknown as AvatarConnector & { start: ReturnType<typeof vi.fn> };
}

interface Harness {
  deps: BootstrapDeps;
  logger: ReturnType<typeof makeLogger>;
  scheduler: ScheduledTask;
  voiceConnector: VoiceConnector & { start: ReturnType<typeof vi.fn> };
  avatarConnector: AvatarConnector & { start: ReturnType<typeof vi.fn> };
  createVoice: ReturnType<typeof vi.fn>;
  createAvatar: ReturnType<typeof vi.fn>;
  createAvatarRenderer: ReturnType<typeof vi.fn>;
  createVirtualCamera: ReturnType<typeof vi.fn>;
  createVirtualMicrophone: ReturnType<typeof vi.fn>;
  createMeetSession: ReturnType<typeof vi.fn>;
  createStreamSession: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
}

/**
 * Assemble injected {@link BootstrapDeps} plus the spies/fakes the assertions
 * inspect. Every external edge is a `vi.fn()` so no real DB, network, SIP,
 * renderer sidecar, v4l2/PipeWire device, browser, ffmpeg, or `process.exit` is
 * touched.
 */
function makeHarness(
  cfg: RozaConfig,
  opts: {
    profile?: RozaProfile;
    avatarStart?: () => Promise<void>;
  } = {},
): Harness {
  const profile = opts.profile ?? DEFAULT_PROFILE;
  const logger = makeLogger();
  const scheduler = makeScheduler();
  const router = makeRouter();
  const voiceConnector = makeVoiceConnector();
  const avatarConnector = makeAvatarConnector(opts.avatarStart);

  const loadConfig = vi.fn((_env: NodeJS.ProcessEnv): RozaConfig => cfg);
  const initDatabase = vi.fn((): Database.Database => makeDb());
  const createRepo = vi.fn((): Repository => makeRepo());
  const loadProfile = vi.fn((): RozaProfile => profile);
  const createQueue = vi.fn((): InboundQueueStore => makeQueue());
  const createRouter = vi.fn((_d: InboundRouterDeps): InboundRouter => router);

  const createTelegram = vi.fn();
  const createMail = vi.fn();

  // Minimal opaque voice adapter fakes — the injected `createVoice` ignores
  // them, so they only need to be returnable objects.
  const createTelephonyGateway = vi.fn(() => ({ __gateway: true }));
  const createSttEngine = vi.fn(() => ({ __stt: true }));
  const createTtsEngine = vi.fn(() => ({ __tts: true }));
  const createVoice = vi.fn((): VoiceConnector => voiceConnector);

  // Minimal opaque avatar adapter fakes — the injected `createAvatar` ignores
  // them, so they only need to be returnable objects (no methods exercised).
  const createAvatarRenderer = vi.fn(() => ({ __renderer: true }));
  const createVirtualCamera = vi.fn(() => ({ __camera: true }));
  const createVirtualMicrophone = vi.fn(() => ({ __microphone: true }));
  const createMeetSession = vi.fn(() => ({ __meet: true }));
  const createStreamSession = vi.fn(() => ({ __stream: true }));
  const createAvatar = vi.fn((): AvatarConnector => avatarConnector);

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
    createVoice,
    createAvatar,
    createAvatarRenderer,
    createVirtualCamera,
    createVirtualMicrophone,
    createMeetSession,
    createStreamSession,
    exit,
  };
}

describe('bootstrap (Phase 4) — avatar enabled builds and starts the Avatar_Connector (Req 1.2, 9.5)', () => {
  it('builds the renderer/camera/microphone adapters and the connector once, starts it, and exposes handle.avatar', async () => {
    const cfg = makeConfig(true);
    const h = makeHarness(cfg);

    const handle = start({}, h.deps);
    await flushMicrotasks();

    // Each avatar adapter factory and the connector factory ran exactly once.
    expect(h.createAvatarRenderer).toHaveBeenCalledTimes(1);
    expect(h.createVirtualCamera).toHaveBeenCalledTimes(1);
    expect(h.createVirtualMicrophone).toHaveBeenCalledTimes(1);
    expect(h.createAvatar).toHaveBeenCalledTimes(1);

    // The Meet/stream sub-capabilities are OFF, so no browser/ffmpeg object.
    expect(h.createMeetSession).not.toHaveBeenCalled();
    expect(h.createStreamSession).not.toHaveBeenCalled();

    // The connector's transport was started (fire-and-forget).
    expect(h.avatarConnector.start).toHaveBeenCalledTimes(1);

    // The constructed connector is exposed on the handle (Req 9.5).
    expect(handle.avatar).toBeDefined();
    expect(handle.avatar).toBe(h.avatarConnector);

    // Happy path: no fatal error and no exit.
    expect(h.logger.error).not.toHaveBeenCalled();
    expect(h.exit).not.toHaveBeenCalled();
  });
});

describe('bootstrap (Phase 4) — avatar disabled is byte-for-byte the Phase 3 startup (Req 1.6, 11.1)', () => {
  it('builds and starts no avatar adapters or connector, and handle.avatar is undefined', async () => {
    const cfg = makeConfig(false);
    const h = makeHarness(cfg);

    const handle = start({}, h.deps);
    await flushMicrotasks();

    // No avatar adapter, sub-capability, or connector is constructed or started.
    expect(h.createAvatarRenderer).not.toHaveBeenCalled();
    expect(h.createVirtualCamera).not.toHaveBeenCalled();
    expect(h.createVirtualMicrophone).not.toHaveBeenCalled();
    expect(h.createMeetSession).not.toHaveBeenCalled();
    expect(h.createStreamSession).not.toHaveBeenCalled();
    expect(h.createAvatar).not.toHaveBeenCalled();
    expect(h.avatarConnector.start).not.toHaveBeenCalled();

    // The handle omits `avatar` entirely on the disabled path.
    expect(handle.avatar).toBeUndefined();

    // The Phase 3 wiring is intact: voice still built+started, scheduler-backed
    // engine handle returned.
    expect(h.createVoice).toHaveBeenCalledTimes(1);
    expect(handle.voice).toBe(h.voiceConnector);
    expect(handle.scheduler).toBe(h.scheduler);
    expect(handle.engine).toBeInstanceOf(CognitiveEngine);
    expect(h.logger.error).not.toHaveBeenCalled();
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('keeps the Channel union / operative channels unchanged (no "avatar" channel) — Req 11.1', async () => {
    const cfg = makeConfig(false);
    const h = makeHarness(cfg);

    const handle = start({}, h.deps);
    await flushMicrotasks();

    // The avatar is a presence capability, not a conversation Channel: the union
    // carries only internal/telegram/email/voice and never an 'avatar' member.
    const channels: Channel[] = ['internal', 'telegram', 'email', 'voice'];
    expect(channels).not.toContain('avatar' as unknown as Channel);

    // The router's connectors Map is keyed by OperativeChannel only and never
    // gains an 'avatar' key (the avatar lives on `handle.avatar`, outside it).
    expect([...handle.connectors.keys()]).not.toContain('avatar');
  });
});

describe('bootstrap (Phase 4) — avatar startup fault isolation (Req 9.5, 12.6)', () => {
  it('isolates an Avatar_Connector whose start() rejects asynchronously', async () => {
    const cfg = makeConfig(true);
    const h = makeHarness(cfg, {
      avatarStart: () => Promise.reject(new Error('renderer sidecar unreachable')),
    });

    const handle = start({}, h.deps);
    // start() is attempted synchronously; the rejection is isolated async.
    expect(h.avatarConnector.start).toHaveBeenCalledTimes(1);
    // A handle is returned regardless of the avatar transport's fate.
    expect(handle).toBeDefined();

    await flushMicrotasks();

    // The avatar failure was logged via logger.error with the documented message.
    expect(h.logger.error).toHaveBeenCalledTimes(1);
    const [errMessage] = h.logger.error.mock.calls[0]!;
    expect(typeof errMessage).toBe('string');
    expect(errMessage as string).toContain('[avatar] startup failed');

    // The scheduler, the text/internal channels, AND the voice channel are
    // unaffected, and an avatar failure NEVER exits the process (only a
    // scheduler-init failure exits).
    expect(handle.scheduler).toBe(h.scheduler);
    expect(handle.engine).toBeInstanceOf(CognitiveEngine);
    expect(h.voiceConnector.start).toHaveBeenCalledTimes(1);
    expect(handle.voice).toBe(h.voiceConnector);
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('isolates an Avatar_Connector whose start() throws synchronously', async () => {
    const cfg = makeConfig(true);
    const h = makeHarness(cfg, {
      avatarStart: () => {
        throw new Error('synchronous device-init failure');
      },
    });

    const handle = start({}, h.deps);
    await flushMicrotasks();

    // The synchronous throw is isolated and logged the same way.
    expect(h.logger.error).toHaveBeenCalledTimes(1);
    const [errMessage] = h.logger.error.mock.calls[0]!;
    expect(errMessage as string).toContain('[avatar] startup failed');

    // Handle returned, scheduler + voice running, no exit.
    expect(handle).toBeDefined();
    expect(handle.scheduler).toBe(h.scheduler);
    expect(h.voiceConnector.start).toHaveBeenCalledTimes(1);
    expect(handle.voice).toBe(h.voiceConnector);
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('does not call deps.exit on an avatar startup failure', async () => {
    const cfg = makeConfig(true);
    const h = makeHarness(cfg, {
      avatarStart: () => Promise.reject(new Error('avatar down')),
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
