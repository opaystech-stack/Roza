/**
 * Bootstrap (Component 0 / Startup layer) — Req 1.2, 1.3, 1.5, 1.7, 2.4, 5.4, 12.6.
 *
 * Wires the cooperating capabilities together in the deterministic, fail-fast
 * order mandated by the design's Startup Sequence (Phase 1 ordering preserved,
 * Phase 2 collaborators appended):
 *
 *   loadConfigOrExit              → cfg   (Req 1.7 + channel fail-fast for enabled channels)
 *     → initDatabaseOrExit        → db    (Req 1.3: DB initialized before any task)
 *       → createRepository        → repo
 *         → loadProfileOrDefault  → profileHolder { current } (Req 1.2: profile before any message)
 *           → new CognitiveEngine → engine (Req 3.1: live profile accessor)
 *             → createInboundQueueStore → queue
 *               → new InboundRouter     → router
 *                 → build enabled connectors → connectors Map (Req 5.4)
 *                   → initScheduler (+ drainInboundQueue) → scheduler (Req 10.3)
 *                     → start each enabled connector, fault-isolated (Req 12.6)
 *                       → ready log + operational state (Req 1.4)
 *
 * `config.ts` and `db.ts` already terminate startup with a non-zero exit and a
 * component/path-named error log on failure (their `*OrExit` wrappers); the
 * channel fail-fast for ENABLED channels with missing credentials lives inside
 * `loadConfigOrExit` (Req 4.2, 4.3). The remaining stage that can throw here is
 * scheduler initialization, which this module wraps so a failure emits a
 * component-named error log and exits non-zero (Req 1.5) — never executing an
 * autonomous task.
 *
 * Fault isolation (Req 12.6): each enabled connector is started in its own
 * try/catch; a connector that throws (synchronously) or rejects (asynchronously)
 * on `start` is logged via `logger.error` and SKIPPED — it is removed from the
 * connectors Map without aborting the other connector or the always-on Phase 1
 * `internal` channel.
 *
 * `start` stays SYNCHRONOUS and returns the {@link RozaHandle} directly. The
 * connectors' transports are started fire-and-forget with their failures
 * isolated, so the deterministic ordering and the fail-fast paths remain
 * synchronously assertable (preserving the Phase 1 bootstrap tests) and
 * `index.ts` needs no change. With every channel disabled the behavior is
 * byte-for-byte the Phase 1 startup (no connector is built or started).
 *
 * Every collaborator is injectable (config loader, DB init, repository factory,
 * profile loader, queue/router/connector factories, scheduler init, LLM client,
 * logger, clock, and the `exit` function) so the startup ordering and the
 * fault-isolation behavior can be asserted in tests (task 13.3) without spawning
 * a real process, opening a real database, touching a real network, or calling
 * the real `process.exit`.
 */

import type Database from 'better-sqlite3';
import type { ScheduledTask } from 'node-cron';

import { loadConfigOrExit, type RozaConfig } from './config.js';
import { initDatabaseOrExit } from './db.js';
import { createRepository, type Repository } from './repository.js';
import { initScheduler } from './scheduler.js';
import { CognitiveEngine } from './engine.js';
import { chatCompletion } from './llm.js';
import { DEFAULT_PROFILE, loadProfileOrDefault, type RozaProfile } from './profile.js';
import { createInboundQueueStore } from './connectors/queue.js';
import { InboundRouter, type InboundRouterDeps } from './connectors/router.js';
import {
  type BackoffOptions,
  type ChannelConnector,
  type InboundMessage,
  type OperativeChannel,
} from './connectors/connector.js';
import { createTelegramConnector } from './connectors/telegram.js';
import { createMailConnector } from './connectors/mail.js';
import type { Logger } from './types.js';

/**
 * Mutable holder for the currently-loaded Roza_Profile (Req 2.4). The engine and
 * connectors read `current` through accessors, so a successful `editProfile`
 * (admin entrypoint, task 13.2) can swap `current` and have the change apply to
 * subsequent System_Prompt construction and channel identities without a restart.
 */
export interface ProfileHolder {
  current: RozaProfile;
}

/**
 * The running service handle returned by {@link start} on success. Exposing the
 * constructed collaborators keeps the startup sequence testable (task 13.3) and
 * gives callers a `scheduler` handle they can stop during shutdown, plus the
 * `connectors` Map and `profileHolder` for the admin/profile-edit entrypoint.
 */
export interface RozaHandle {
  cfg: RozaConfig;
  db: Database.Database;
  repo: Repository;
  engine: CognitiveEngine;
  scheduler: ScheduledTask;
  /** The channel-agnostic inbound router shared by every connector (Phase 2). */
  router: InboundRouter;
  /** Connectors that started successfully, keyed by operative channel (Req 5.4, 12.6). */
  connectors: Map<OperativeChannel, ChannelConnector>;
  /** Mutable profile holder enabling restart-free profile edits (Req 2.4). */
  profileHolder: ProfileHolder;
}

/**
 * Injectable startup collaborators. Each defaults to the real module
 * implementation; tests override them to drive the ordering and the failure
 * paths deterministically.
 */
export interface BootstrapDeps {
  /** Validate config + self-exit on missing secrets (Req 1.7) and enabled-channel credentials (Req 4.2, 4.3). Default {@link loadConfigOrExit}. */
  loadConfig?: typeof loadConfigOrExit;
  /** Open/initialize the database + self-exit on storage/integrity faults. Default {@link initDatabaseOrExit}. */
  initDatabase?: typeof initDatabaseOrExit;
  /** Build the typed repository over the opened database. Default {@link createRepository}. */
  createRepo?: typeof createRepository;
  /** Load the Roza_Profile (or persist + return the documented default). Default {@link loadProfileOrDefault}. */
  loadProfile?: typeof loadProfileOrDefault;
  /** Build the durable inbound queue + idempotency store. Default {@link createInboundQueueStore}. */
  createQueue?: typeof createInboundQueueStore;
  /** Build the channel-agnostic inbound router. Default `new InboundRouter(deps)`. */
  createRouter?: (deps: InboundRouterDeps) => InboundRouter;
  /** Build the Telegram connector (real grammY transport by default). Default {@link createTelegramConnector}. */
  createTelegram?: typeof createTelegramConnector;
  /** Build the Mail connector (real imapflow/nodemailer transports by default). Default {@link createMailConnector}. */
  createMail?: typeof createMailConnector;
  /** Register the 30-minute cron scheduler. Default {@link initScheduler}. */
  initScheduler?: typeof initScheduler;
  /** OpenRouter chat-completion client passed to the engine. Default {@link chatCompletion}. */
  llm?: typeof chatCompletion;
  /** Structured logger; the default console logger never logs secret values. */
  logger?: Logger;
  /** Injectable clock shared by the engine, router, and scheduler. Default `() => new Date()`. */
  now?: () => Date;
  /** Injectable process exit (Req 1.5). Default `process.exit`. */
  exit?: (code: number) => never;
}

/**
 * Bounded retry/backoff tuning handed to the channel connectors for transport
 * reconnects and outbound sends (Req 12.1, 12.3). A modest exponential window
 * survives transient network faults and rate limits without blocking startup.
 */
const DEFAULT_CONNECTOR_BACKOFF: BackoffOptions = {
  baseMs: 500,
  maxMs: 30_000,
  maxAttempts: 5,
};

/**
 * A minimal console-backed {@link Logger}. It prints only the supplied message
 * and structured metadata; it never receives or echoes secret values (the
 * config/db layers surface variable NAMES only — Req 1.7, 4.4), so nothing
 * confidential is logged here.
 */
const defaultLogger: Logger = {
  info(message: string, meta?: Record<string, unknown>): void {
    if (meta === undefined) {
      console.log(message);
    } else {
      console.log(message, meta);
    }
  },
  error(message: string, meta?: Record<string, unknown>): void {
    if (meta === undefined) {
      console.error(message);
    } else {
      console.error(message, meta);
    }
  },
};

/**
 * Start one connector with fault isolation (Req 12.6).
 *
 * The connector's `start` is transport I/O and may either throw synchronously
 * (e.g. a transport factory rejecting an obviously bad credential) or reject
 * asynchronously (e.g. a network failure mid-handshake). Both are isolated: the
 * failure is logged via `logger.error` (never a credential value — Req 4.4,
 * 14.3) and the connector is removed from the shared Map so the router never
 * routes to a connector that failed to come up, while the other connector and
 * the Phase 1 `internal` channel keep running. `start` itself stays synchronous,
 * so the rejection path is handled with a `.catch` rather than `await`.
 */
function startConnectorIsolated(
  connector: ChannelConnector,
  onInbound: (msg: InboundMessage) => Promise<void>,
  connectors: Map<OperativeChannel, ChannelConnector>,
  logger: Logger,
): void {
  const onFailure = (err: unknown): void => {
    logger.error('[connector] startup failed; channel skipped (fault-isolated)', {
      channel: connector.channel,
      message: err instanceof Error ? err.message : String(err),
    });
    connectors.delete(connector.channel);
  };

  try {
    const started = connector.start(onInbound);
    // Isolate an asynchronous rejection without blocking the synchronous start().
    if (started !== undefined && typeof started.then === 'function') {
      started.catch(onFailure);
    }
  } catch (err) {
    // Isolate a synchronous throw from the connector's start.
    onFailure(err);
  }
}

/**
 * Run the fail-fast startup sequence and enter the operational state.
 *
 * Ordering (Req 1.3, 1.2): configuration → database → repository → profile →
 * engine → queue → router → connectors → scheduler → connector start. The
 * database is fully initialized before the scheduler is registered, the profile
 * is loaded before any message can be processed (Req 1.2), and the scheduler is
 * registered before any autonomous task or queue drain can run. On success a
 * startup-ready log entry is emitted and a {@link RozaHandle} is returned
 * (Req 1.4). On a scheduler-init failure a component-named error log is emitted
 * and the process exits non-zero, executing no autonomous task (Req 1.5).
 * Configuration (Req 1.7, 4.2, 4.3) and database (Req 3.9/3.10) failures are
 * handled inside their own `*OrExit` wrappers.
 *
 * `start` is synchronous: connectors are started fault-isolated (Req 12.6)
 * without awaiting, so the deterministic ordering and fail-fast paths stay
 * synchronously assertable and the always-on `internal` channel is never blocked
 * by a slow or failing transport.
 */
export function start(
  env: NodeJS.ProcessEnv = process.env,
  deps: BootstrapDeps = {},
): RozaHandle {
  const loadConfig = deps.loadConfig ?? loadConfigOrExit;
  const initDatabase = deps.initDatabase ?? initDatabaseOrExit;
  const createRepo = deps.createRepo ?? createRepository;
  const loadProfile = deps.loadProfile ?? loadProfileOrDefault;
  const createQueue = deps.createQueue ?? createInboundQueueStore;
  const createRouter = deps.createRouter ?? ((d: InboundRouterDeps): InboundRouter => new InboundRouter(d));
  const createTelegram = deps.createTelegram ?? createTelegramConnector;
  const createMail = deps.createMail ?? createMailConnector;
  const initSched = deps.initScheduler ?? initScheduler;
  const llm = deps.llm ?? chatCompletion;
  const logger = deps.logger ?? defaultLogger;
  const now = deps.now ?? ((): Date => new Date());
  const exit = deps.exit ?? (process.exit as (code: number) => never);

  // 1. Configuration — self-exits (non-zero) on missing/blank secrets (Req 1.7)
  //    and on an ENABLED channel with missing credentials (Req 4.2, 4.3).
  const cfg = loadConfig(env);

  // 2. Database — initialized BEFORE any task (Req 1.3); the wrapper self-exits
  //    on absent/unwritable storage or a corrupt/incomplete file (Req 3.9/3.10).
  const db = initDatabase(cfg.dataDir, cfg.keyVersion);

  // 3. Repository — typed gateway bound to the opened, schema-verified database.
  const repo = createRepo(db, {
    secret: cfg.rozaPrivateKey,
    keyVersion: cfg.keyVersion,
  });

  // 4. Profile — loaded BEFORE the engine can process any message (Req 1.2) into
  //    a MUTABLE holder so a future editProfile can swap it without a restart
  //    (Req 2.4). `loadProfileOrDefault` is contractually non-throwing and does
  //    its own structured logging (defaulted fields by name — Req 1.6); the
  //    try/catch is a last-resort safety net so a catastrophic load failure
  //    still leaves the always-on `internal` channel available with the
  //    documented defaults (Req 1.6 — continue startup).
  let loadedProfile: RozaProfile;
  try {
    loadedProfile = loadProfile(repo, logger);
  } catch {
    loadedProfile = DEFAULT_PROFILE;
  }
  const profileHolder: ProfileHolder = { current: loadedProfile };

  // 5. Cognitive Engine — wires repository + LLM client + config behind the
  //    autonomous-task and message entrypoints, reading the live profile through
  //    the holder accessor so profile edits apply without a restart (Req 3.1, 2.4).
  const engine = new CognitiveEngine({
    repo,
    llm,
    cfg,
    now,
    logger,
    profile: () => profileHolder.current,
  });

  // 6. Inbound queue + idempotency store — durable over the repository (Req 10, 11).
  const queue = createQueue(repo);

  // 7. Inbound router — the channel-agnostic heart. It holds a REFERENCE to the
  //    `connectors` Map populated in the next step, so connectors added after
  //    construction are visible to the router for reply delivery.
  const connectors = new Map<OperativeChannel, ChannelConnector>();
  const router = createRouter({
    engine,
    queue,
    cfg,
    window: cfg.activeWindow,
    timezone: cfg.timezone,
    now,
    connectors,
    logger,
  });

  // 8. Build a connector for each ENABLED channel using its real default
  //    transport (no mocks — production wiring). The Bot_Token and Mailbox
  //    credentials are passed only to the transport factories, never logged
  //    (Req 4.4, 14.3). Disabled channels stay inert (Req 5.1).
  if (cfg.telegram.enabled) {
    connectors.set(
      'telegram',
      createTelegram({
        botToken: cfg.telegram.botToken,
        profile: () => profileHolder.current,
        logger,
        backoff: DEFAULT_CONNECTOR_BACKOFF,
      }),
    );
  }
  if (cfg.mail.enabled) {
    connectors.set(
      'email',
      createMail({
        imap: cfg.mail.imap,
        smtp: cfg.mail.smtp,
        profile: () => profileHolder.current,
        logger,
        backoff: DEFAULT_CONNECTOR_BACKOFF,
      }),
    );
  }

  // 9. Scheduler — registered AFTER the database (Req 1.3) and wired with the
  //    queue drain so messages deferred during Quiet_Hours are processed on
  //    entry to the Active_Window in receipt order (Req 10.3). A failure here is
  //    the one remaining startup fault to guard: emit a component-named error
  //    log and exit non-zero, executing no autonomous task (Req 1.5).
  let scheduler: ScheduledTask;
  try {
    scheduler = initSched({
      window: cfg.activeWindow,
      timezone: cfg.timezone,
      now,
      runAutonomousTask: () => engine.runAutonomousTask(),
      recordInvocation: (at: string) => {
        repo.recordTaskInvocation(at);
      },
      drainInboundQueue: () => router.drainQueue(),
      logger,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      '[scheduler] Startup aborted: scheduler initialization failed.',
      { message },
    );
    return exit(1);
  }

  // 10. Start each enabled connector in its OWN fault-isolated try/catch
  //     (Req 12.6). A connector that throws/rejects on start is logged and
  //     SKIPPED (removed from the Map) without aborting the others or the
  //     always-on `internal` channel. The router's `handleInbound` is the
  //     `onInbound` callback every connector pushes inbound messages to.
  const onInbound = (msg: InboundMessage): Promise<void> => router.handleInbound(msg);
  for (const connector of connectors.values()) {
    startConnectorIsolated(connector, onInbound, connectors, logger);
  }

  // 11. Operational state — emit the startup-ready entry (Req 1.4).
  logger.info('[roza] roza-agent ready');

  return { cfg, db, repo, engine, scheduler, router, connectors, profileHolder };
}
