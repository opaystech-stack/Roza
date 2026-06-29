import { describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { ScheduledTask } from 'node-cron';

import { start, type BootstrapDeps } from './bootstrap.js';
import { CognitiveEngine } from './engine.js';
import type { RozaConfig } from './config.js';
import type { Repository } from './repository.js';
import type { SchedulerDeps } from './scheduler.js';
import type { Logger } from './types.js';

/**
 * Integration tests for the bootstrap startup sequence (Component 0) —
 * Req 1.3, 1.4, 1.5.
 *
 * These drive {@link start} with fully injected collaborators (config loader,
 * DB init, repository factory, scheduler init, LLM client, logger, clock, and
 * `exit`) so the deterministic startup ORDERING and the fail-fast behavior are
 * asserted without opening a real database, registering a real cron timer, or
 * calling the real `process.exit`:
 *
 *  - ordering    → config before db, db before scheduler (Req 1.3),
 *  - success     → ready log emitted + handle returned (Req 1.4),
 *  - db-before-task → repo/engine are built from the db handle, and the
 *    scheduler (which triggers tasks) is wired only afterwards (Req 1.3),
 *  - fail-fast   → a scheduler-init failure logs a component-named error and
 *    exits non-zero, executing no autonomous task (Req 1.5).
 */

/** A valid fake config matching the {@link RozaConfig} shape. */
const FAKE_CONFIG: RozaConfig = {
  rozaPrivateKey: 'fake-private-key',
  openRouterApiKey: 'fake-openrouter-key',
  openRouterModel: 'openai/gpt-4o-mini',
  dataDir: '/tmp/roza-test-data',
  timezone: 'UTC',
  activeWindow: { startMinutes: 420, endMinutes: 1320 },
  keyVersion: 'v1',
  // Phase 2 channels default to disabled (no credentials required).
  telegram: { enabled: false, botToken: '', allowlist: [] },
  mail: {
    enabled: false,
    imap: { host: '', port: 0, user: '', password: '' },
    smtp: { host: '', port: 0, user: '', password: '' },
    allowlist: [],
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

/** Build a fresh logger with spied methods. */
function makeLogger(): Logger & {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), error: vi.fn() };
}

/**
 * A fake {@link Repository}; only `recordTaskInvocation` is exercised by the
 * scheduler wiring, but every method is present so the cast is sound.
 */
function makeRepo(): Repository {
  return {
    getRelationshipByUserId: vi.fn(),
    createRelationship: vi.fn(),
    updateRelationship: vi.fn(),
    getOpenConversation: vi.fn(),
    createConversation: vi.fn(),
    touchConversation: vi.fn(),
    addMessage: vi.fn(),
    getRecentMessages: vi.fn(() => []),
    writeJournal: vi.fn(),
    readJournal: vi.fn(),
    recordTaskInvocation: vi.fn(),
    tx: vi.fn(<T>(fn: () => T): T => fn()),
  } as unknown as Repository;
}

/** Opaque fake db handle (never touched — createRepo is injected). */
function makeDb(): Database.Database {
  return { __fakeDb: true } as unknown as Database.Database;
}

/** Opaque fake scheduler handle. */
function makeScheduler(): ScheduledTask {
  return { stop: vi.fn(), start: vi.fn() } as unknown as ScheduledTask;
}

/**
 * Assemble a set of injected {@link BootstrapDeps} plus the shared call-order
 * array and the underlying spies/fakes the assertions inspect.
 */
function makeDeps(overrides: Partial<BootstrapDeps> = {}): {
  deps: BootstrapDeps;
  order: string[];
  db: Database.Database;
  repo: Repository;
  scheduler: ScheduledTask;
  logger: ReturnType<typeof makeLogger>;
  exit: ReturnType<typeof vi.fn>;
  loadConfig: ReturnType<typeof vi.fn>;
  initDatabase: ReturnType<typeof vi.fn>;
  createRepo: ReturnType<typeof vi.fn>;
  initScheduler: ReturnType<typeof vi.fn>;
} {
  const order: string[] = [];
  const db = makeDb();
  const repo = makeRepo();
  const scheduler = makeScheduler();
  const logger = makeLogger();

  const loadConfig = vi.fn((_env: NodeJS.ProcessEnv): RozaConfig => {
    order.push('config');
    return FAKE_CONFIG;
  });
  const initDatabase = vi.fn((_dataDir: string, _keyVersion: string): Database.Database => {
    order.push('db');
    return db;
  });
  const createRepo = vi.fn((): Repository => {
    order.push('repo');
    return repo;
  });
  const initScheduler = vi.fn((_d: SchedulerDeps): ScheduledTask => {
    order.push('scheduler');
    return scheduler;
  });
  const exit = vi.fn((_code: number): never => {
    // Halt execution the way the real process.exit would, via a sentinel.
    throw new Error('__exit__');
  });

  const deps: BootstrapDeps = {
    loadConfig: loadConfig as unknown as NonNullable<BootstrapDeps['loadConfig']>,
    initDatabase: initDatabase as unknown as NonNullable<BootstrapDeps['initDatabase']>,
    createRepo: createRepo as unknown as NonNullable<BootstrapDeps['createRepo']>,
    initScheduler: initScheduler as unknown as NonNullable<BootstrapDeps['initScheduler']>,
    llm: vi.fn() as unknown as NonNullable<BootstrapDeps['llm']>,
    logger,
    now: () => new Date('2024-06-01T12:00:00.000Z'),
    exit: exit as unknown as NonNullable<BootstrapDeps['exit']>,
  };
  Object.assign(deps, overrides);

  return {
    deps,
    order,
    db,
    repo,
    scheduler,
    logger,
    exit,
    loadConfig,
    initDatabase,
    createRepo,
    initScheduler,
  };
}

describe('bootstrap — start (startup ordering)', () => {
  // Req 1.3: configuration is loaded, then the database is initialized, and the
  // scheduler is registered only AFTER the database.
  it('initializes the database before the scheduler, and config before the database', () => {
    const { deps, order } = makeDeps();

    start({}, deps);

    const configIdx = order.indexOf('config');
    const dbIdx = order.indexOf('db');
    const schedulerIdx = order.indexOf('scheduler');

    expect(configIdx).toBeGreaterThanOrEqual(0);
    expect(dbIdx).toBeGreaterThanOrEqual(0);
    expect(schedulerIdx).toBeGreaterThanOrEqual(0);

    // config → db → scheduler (Req 1.3).
    expect(configIdx).toBeLessThan(dbIdx);
    expect(dbIdx).toBeLessThan(schedulerIdx);
  });
});

describe('bootstrap — start (success path)', () => {
  // Req 1.4: a fully-successful startup emits the ready log and returns the
  // operational handle.
  it('emits the ready log and returns a { cfg, db, repo, engine, scheduler } handle', () => {
    const { deps, db, repo, scheduler, logger } = makeDeps();

    const handle = start({}, deps);

    // Ready log entry (Req 1.4): logger.info called with a ready message.
    expect(logger.info).toHaveBeenCalledTimes(1);
    const [readyMessage] = logger.info.mock.calls[0]!;
    expect(typeof readyMessage).toBe('string');
    expect(readyMessage).toContain('roza-agent ready');

    // The handle exposes the constructed collaborators.
    expect(handle.cfg).toBe(FAKE_CONFIG);
    expect(handle.db).toBe(db);
    expect(handle.repo).toBe(repo);
    expect(handle.scheduler).toBe(scheduler);
    expect(handle.engine).toBeInstanceOf(CognitiveEngine);

    // No fatal exit on the success path.
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('bootstrap — start (DB before task)', () => {
  // Req 1.3: the repository/engine are built from the opened db handle, and the
  // scheduler (the thing that triggers autonomous tasks) is initialized only
  // after that db handle exists.
  it('builds repo/engine from the db handle and wires the scheduler afterwards', () => {
    const { deps, db, repo, order, createRepo, initScheduler } = makeDeps();

    start({}, deps);

    // The repository was constructed over the very db handle initDatabase returned.
    expect(createRepo).toHaveBeenCalledTimes(1);
    const [repoDbArg] = createRepo.mock.calls[0]!;
    expect(repoDbArg).toBe(db);

    // The scheduler was registered, and only after the db/repo existed.
    expect(initScheduler).toHaveBeenCalledTimes(1);
    expect(order.indexOf('db')).toBeLessThan(order.indexOf('scheduler'));
    expect(order.indexOf('repo')).toBeLessThan(order.indexOf('scheduler'));

    // The scheduler wiring's invocation recorder is bound to the repo built from
    // the db — i.e. the task path references db-derived state (Req 1.3).
    const schedDeps = initScheduler.mock.calls[0]![0] as SchedulerDeps;
    schedDeps.recordInvocation('2024-06-01 12:00:00');
    expect(repo.recordTaskInvocation).toHaveBeenCalledWith('2024-06-01 12:00:00');
  });
});

describe('bootstrap — start (fail-fast on scheduler init failure)', () => {
  // Req 1.5: a scheduler-init failure emits a component-named error log and
  // exits non-zero, executing no autonomous task.
  it('logs a scheduler-named error and exits with code 1 when scheduler init throws', () => {
    const failingScheduler = vi.fn((): ScheduledTask => {
      throw new Error('cron registration failed');
    });
    const { deps, logger, exit, initScheduler } = makeDeps({
      initScheduler: failingScheduler as unknown as NonNullable<BootstrapDeps['initScheduler']>,
    });

    // The injected exit throws a sentinel to halt execution like process.exit.
    expect(() => start({}, deps)).toThrow('__exit__');

    // The default order's initScheduler spy was replaced; the failing one ran.
    expect(initScheduler).not.toHaveBeenCalled();
    expect(failingScheduler).toHaveBeenCalledTimes(1);

    // Component-named error log mentioning the scheduler (Req 1.5).
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [errMessage] = logger.error.mock.calls[0]!;
    expect(typeof errMessage).toBe('string');
    expect(errMessage.toLowerCase()).toContain('scheduler');

    // Exited non-zero with code 1, and never reached the ready state (Req 1.5).
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.info).not.toHaveBeenCalled();
  });
});
