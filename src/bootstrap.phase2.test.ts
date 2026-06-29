import { describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { ScheduledTask } from 'node-cron';

import { start, type BootstrapDeps, type RozaHandle } from './bootstrap.js';
import { CognitiveEngine } from './engine.js';
import { DEFAULT_PROFILE, type RozaProfile } from './profile.js';
import type { RozaConfig } from './config.js';
import type { Repository } from './repository.js';
import type { SchedulerDeps } from './scheduler.js';
import type { InboundRouter, InboundRouterDeps } from './connectors/router.js';
import type { InboundQueueStore } from './connectors/queue.js';
import type {
  ChannelConnector,
  InboundMessage,
  OperativeChannel,
  OutboundReply,
} from './connectors/connector.js';
import type { Logger } from './types.js';

/**
 * Phase 2 bootstrap wiring + isolation tests (task 13.3) — Req 1.2, 2.4, 5.4, 12.6.
 *
 * These drive {@link start} with fully injected collaborators (config loader,
 * DB init, repository factory, profile loader, queue/router/connector factories,
 * scheduler init, LLM client, logger, clock, and `exit`) so the Phase 2 startup
 * wiring and the connector fault isolation are asserted WITHOUT opening a real
 * database, touching the network, registering a real cron timer, or calling the
 * real `process.exit`:
 *
 *  - profile-before-engine/connectors → the profile is loaded before the engine
 *    is constructed and before any connector is built/started (Req 1.2, 2.4),
 *  - both channels enabled → both connectors are built and started, and the Map
 *    handed to the router holds them (Req 5.4),
 *  - both channels disabled → no connector is built or started; the internal
 *    channel still works (Phase 1 backward compatibility),
 *  - fault isolation → a connector whose `start` rejects is logged and removed
 *    while the other connector and the scheduler/handle survive (Req 12.6),
 *  - scheduler wiring → `initScheduler` receives a `drainInboundQueue` bound to
 *    the router's `drainQueue` (Req 10.3),
 *  - isolation → the disabled-channel path returns the Phase 1 handle fields and
 *    never throws.
 *
 * `start` is synchronous but each connector's `start` is async fire-and-forget
 * (its rejection isolated via `.catch`), so the fault-isolation assertions flush
 * a couple of microtasks before inspecting the connectors Map / error log.
 */

/** Flush pending microtasks so a connector `start` rejection's `.catch` runs. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** A valid base config; channel flags are overridden per test. */
function makeConfig(overrides: {
  telegram?: Partial<RozaConfig['telegram']>;
  mail?: Partial<RozaConfig['mail']>;
} = {}): RozaConfig {
  return {
    rozaPrivateKey: 'fake-private-key',
    openRouterApiKey: 'fake-openrouter-key',
    openRouterModel: 'openai/gpt-4o-mini',
    dataDir: '/tmp/roza-test-data',
    timezone: 'UTC',
    activeWindow: { startMinutes: 420, endMinutes: 1320 },
    keyVersion: 'v1',
    telegram: {
      enabled: false,
      botToken: '',
      allowlist: [],
      ...overrides.telegram,
    },
    mail: {
      enabled: false,
      imap: { host: '', port: 0, user: '', password: '' },
      smtp: { host: '', port: 0, user: '', password: '' },
      allowlist: [],
      ...overrides.mail,
    },
    voice: {
      enabled: false,
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

/**
 * A fake {@link ChannelConnector}. `start` is a spy whose behavior (resolve or
 * reject) is supplied per test so the fault-isolation path can be driven without
 * any real transport.
 */
function makeConnector(
  channel: OperativeChannel,
  startImpl: () => Promise<void> = () => Promise.resolve(),
): ChannelConnector & { start: ReturnType<typeof vi.fn> } {
  return {
    channel,
    start: vi.fn(startImpl),
    stop: vi.fn(() => Promise.resolve()),
    sendReply: vi.fn((_reply: OutboundReply) => Promise.resolve()),
  } as ChannelConnector & { start: ReturnType<typeof vi.fn> };
}

/** A fake {@link InboundRouter}; only `drainQueue`/`handleInbound` are wired. */
function makeRouter(): InboundRouter & {
  drainQueue: ReturnType<typeof vi.fn>;
  handleInbound: ReturnType<typeof vi.fn>;
} {
  return {
    drainQueue: vi.fn(() => Promise.resolve()),
    handleInbound: vi.fn((_msg: InboundMessage) => Promise.resolve()),
  } as unknown as InboundRouter & {
    drainQueue: ReturnType<typeof vi.fn>;
    handleInbound: ReturnType<typeof vi.fn>;
  };
}

interface Harness {
  deps: BootstrapDeps;
  order: string[];
  profile: RozaProfile;
  logger: ReturnType<typeof makeLogger>;
  scheduler: ScheduledTask;
  telegramConnector: ChannelConnector & { start: ReturnType<typeof vi.fn> };
  mailConnector: ChannelConnector & { start: ReturnType<typeof vi.fn> };
  createTelegram: ReturnType<typeof vi.fn>;
  createMail: ReturnType<typeof vi.fn>;
  loadProfile: ReturnType<typeof vi.fn>;
  initScheduler: ReturnType<typeof vi.fn>;
  router: ReturnType<typeof makeRouter>;
  routerDeps: () => InboundRouterDeps;
  schedDeps: () => SchedulerDeps;
}

/**
 * Assemble injected {@link BootstrapDeps} plus the spies/fakes the assertions
 * inspect. A shared `order` array records the relative call order of profile
 * load, router construction, and connector construction so "profile before
 * engine/connectors" can be asserted (Req 1.2).
 */
function makeHarness(
  cfg: RozaConfig,
  opts: {
    profile?: RozaProfile;
    telegramStart?: () => Promise<void>;
    mailStart?: () => Promise<void>;
  } = {},
): Harness {
  const order: string[] = [];
  const profile = opts.profile ?? DEFAULT_PROFILE;
  const logger = makeLogger();
  const scheduler = makeScheduler();
  const router = makeRouter();

  const telegramConnector = makeConnector('telegram', opts.telegramStart);
  const mailConnector = makeConnector('email', opts.mailStart);

  const loadConfig = vi.fn((_env: NodeJS.ProcessEnv): RozaConfig => cfg);
  const initDatabase = vi.fn((): Database.Database => makeDb());
  const createRepo = vi.fn((): Repository => makeRepo());
  const loadProfile = vi.fn((): RozaProfile => {
    order.push('profile');
    return profile;
  });
  const createQueue = vi.fn((): InboundQueueStore => makeQueue());

  let capturedRouterDeps: InboundRouterDeps | undefined;
  const createRouter = vi.fn((d: InboundRouterDeps): InboundRouter => {
    order.push('router');
    capturedRouterDeps = d;
    return router;
  });

  const createTelegram = vi.fn((): ChannelConnector => {
    order.push('telegram');
    return telegramConnector;
  });
  const createMail = vi.fn((): ChannelConnector => {
    order.push('mail');
    return mailConnector;
  });

  let capturedSchedDeps: SchedulerDeps | undefined;
  const initScheduler = vi.fn((d: SchedulerDeps): ScheduledTask => {
    order.push('scheduler');
    capturedSchedDeps = d;
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
    initScheduler: initScheduler as unknown as NonNullable<BootstrapDeps['initScheduler']>,
    llm: vi.fn() as unknown as NonNullable<BootstrapDeps['llm']>,
    logger,
    now: () => new Date('2024-06-01T12:00:00.000Z'),
    exit: exit as unknown as NonNullable<BootstrapDeps['exit']>,
  };

  return {
    deps,
    order,
    profile,
    logger,
    scheduler,
    telegramConnector,
    mailConnector,
    createTelegram,
    createMail,
    loadProfile,
    initScheduler,
    router,
    routerDeps: (): InboundRouterDeps => {
      if (capturedRouterDeps === undefined) throw new Error('router was not constructed');
      return capturedRouterDeps;
    },
    schedDeps: (): SchedulerDeps => {
      if (capturedSchedDeps === undefined) throw new Error('scheduler was not initialized');
      return capturedSchedDeps;
    },
  };
}

describe('bootstrap (Phase 2) — profile is loaded before the engine and connectors (Req 1.2, 2.4)', () => {
  it('loads the profile before building the router/engine and before any connector, and exposes it on profileHolder', () => {
    const cfg = makeConfig({
      telegram: { enabled: true, botToken: 'tg-token', allowlist: [] },
      mail: {
        enabled: true,
        imap: { host: 'imap.example', port: 993, user: 'roza', password: 'pw' },
        smtp: { host: 'smtp.example', port: 465, user: 'roza', password: 'pw' },
        allowlist: [],
      },
    });
    const customProfile: RozaProfile = { ...DEFAULT_PROFILE, displayName: 'Roza-Test' };
    const h = makeHarness(cfg, { profile: customProfile });

    const handle = start({}, h.deps);

    // The profile loader ran, and the loaded profile is exposed on the holder.
    expect(h.loadProfile).toHaveBeenCalledTimes(1);
    expect(handle.profileHolder).toBeDefined();
    expect(handle.profileHolder.current).toBe(customProfile);

    // The engine handed to the router was constructed (Req 3.1) after the
    // profile load, and both connectors were built after it too (Req 1.2).
    expect(h.routerDeps().engine).toBeInstanceOf(CognitiveEngine);
    const profileIdx = h.order.indexOf('profile');
    const routerIdx = h.order.indexOf('router');
    const telegramIdx = h.order.indexOf('telegram');
    const mailIdx = h.order.indexOf('mail');
    expect(profileIdx).toBeGreaterThanOrEqual(0);
    expect(profileIdx).toBeLessThan(routerIdx);
    expect(profileIdx).toBeLessThan(telegramIdx);
    expect(profileIdx).toBeLessThan(mailIdx);
  });
});

describe('bootstrap (Phase 2) — both channels enabled (Req 5.4)', () => {
  it('builds and starts both connectors and registers them in the router connectors Map', async () => {
    const cfg = makeConfig({
      telegram: { enabled: true, botToken: 'tg-token', allowlist: [] },
      mail: {
        enabled: true,
        imap: { host: 'imap.example', port: 993, user: 'roza', password: 'pw' },
        smtp: { host: 'smtp.example', port: 465, user: 'roza', password: 'pw' },
        allowlist: [],
      },
    });
    const h = makeHarness(cfg);

    const handle = start({}, h.deps);
    await flushMicrotasks();

    // Both connectors were constructed (Req 5.4).
    expect(h.createTelegram).toHaveBeenCalledTimes(1);
    expect(h.createMail).toHaveBeenCalledTimes(1);

    // Each connector's start was invoked with the router's onInbound callback.
    expect(h.telegramConnector.start).toHaveBeenCalledTimes(1);
    expect(h.mailConnector.start).toHaveBeenCalledTimes(1);
    expect(typeof h.telegramConnector.start.mock.calls[0]![0]).toBe('function');
    expect(typeof h.mailConnector.start.mock.calls[0]![0]).toBe('function');

    // The connectors Map the router holds is the very Map exposed on the handle,
    // and it contains both started connectors.
    expect(h.routerDeps().connectors).toBe(handle.connectors);
    expect(handle.connectors.get('telegram')).toBe(h.telegramConnector);
    expect(handle.connectors.get('email')).toBe(h.mailConnector);
    expect(handle.connectors.size).toBe(2);

    // No fatal error on the happy path.
    expect(h.logger.error).not.toHaveBeenCalled();
  });
});

describe('bootstrap (Phase 2) — both channels disabled (Phase 1 backward compatibility)', () => {
  it('builds and starts no connector while the internal channel keeps working', async () => {
    const cfg = makeConfig(); // both disabled
    const h = makeHarness(cfg);

    const handle = start({}, h.deps);
    await flushMicrotasks();

    // No connector built or started (byte-for-byte Phase 1 startup).
    expect(h.createTelegram).not.toHaveBeenCalled();
    expect(h.createMail).not.toHaveBeenCalled();
    expect(h.telegramConnector.start).not.toHaveBeenCalled();
    expect(h.mailConnector.start).not.toHaveBeenCalled();
    expect(handle.connectors.size).toBe(0);

    // The internal channel still works: a scheduler-backed handle is returned.
    expect(handle.scheduler).toBe(h.scheduler);
    expect(handle.engine).toBeInstanceOf(CognitiveEngine);
    expect(h.logger.error).not.toHaveBeenCalled();
  });
});

describe('bootstrap (Phase 2) — connector fault isolation (Req 12.6)', () => {
  it('logs and removes a connector whose start rejects while the other connector and the handle survive', async () => {
    const cfg = makeConfig({
      telegram: { enabled: true, botToken: 'tg-token', allowlist: [] },
      mail: {
        enabled: true,
        imap: { host: 'imap.example', port: 993, user: 'roza', password: 'pw' },
        smtp: { host: 'smtp.example', port: 465, user: 'roza', password: 'pw' },
        allowlist: [],
      },
    });
    const h = makeHarness(cfg, {
      // Telegram transport fails to come up; mail starts cleanly.
      telegramStart: () => Promise.reject(new Error('telegram transport down')),
      mailStart: () => Promise.resolve(),
    });

    const handle = start({}, h.deps);
    // Both starts are attempted synchronously; the rejection is isolated async.
    expect(h.telegramConnector.start).toHaveBeenCalledTimes(1);
    expect(h.mailConnector.start).toHaveBeenCalledTimes(1);

    await flushMicrotasks();

    // The failed connector was logged via logger.error and removed from the Map.
    expect(h.logger.error).toHaveBeenCalledTimes(1);
    const [errMessage, errMeta] = h.logger.error.mock.calls[0]!;
    expect(typeof errMessage).toBe('string');
    expect((errMeta as { channel?: string }).channel).toBe('telegram');
    expect(handle.connectors.has('telegram')).toBe(false);

    // The other connector and the scheduler/handle remain operational.
    expect(handle.connectors.get('email')).toBe(h.mailConnector);
    expect(handle.connectors.size).toBe(1);
    expect(handle.scheduler).toBe(h.scheduler);
  });

  it('isolates a connector whose start throws synchronously', async () => {
    const cfg = makeConfig({
      telegram: { enabled: true, botToken: 'tg-token', allowlist: [] },
    });
    const h = makeHarness(cfg, {
      telegramStart: () => {
        throw new Error('synchronous transport failure');
      },
    });

    const handle = start({}, h.deps);
    await flushMicrotasks();

    expect(h.logger.error).toHaveBeenCalledTimes(1);
    expect(handle.connectors.has('telegram')).toBe(false);
    expect(handle.scheduler).toBe(h.scheduler);
  });
});

describe('bootstrap (Phase 2) — scheduler queue-drain wiring (Req 10.3)', () => {
  it('wires initScheduler with a drainInboundQueue bound to router.drainQueue', async () => {
    const cfg = makeConfig();
    const h = makeHarness(cfg);

    start({}, h.deps);

    expect(h.initScheduler).toHaveBeenCalledTimes(1);
    const schedDeps = h.schedDeps();
    expect(typeof schedDeps.drainInboundQueue).toBe('function');

    // Invoking the wired drain delegates to the router's drainQueue.
    expect(h.router.drainQueue).not.toHaveBeenCalled();
    await schedDeps.drainInboundQueue!();
    expect(h.router.drainQueue).toHaveBeenCalledTimes(1);
  });
});

describe('bootstrap (Phase 2) — isolation: disabled-channel path returns the Phase 1 handle (Req 5.4)', () => {
  it('does not throw and returns { cfg, db, repo, engine, scheduler } on the disabled path', () => {
    const cfg = makeConfig();
    const h = makeHarness(cfg);

    let handle: RozaHandle | undefined;
    expect(() => {
      handle = start({}, h.deps);
    }).not.toThrow();

    expect(handle).toBeDefined();
    expect(handle!.cfg).toBe(cfg);
    expect(handle!.db).toBeDefined();
    expect(handle!.repo).toBeDefined();
    expect(handle!.engine).toBeInstanceOf(CognitiveEngine);
    expect(handle!.scheduler).toBe(h.scheduler);
  });
});
