/**
 * Bootstrap (Component 0 / Startup layer) — Req 1.3, 1.4, 1.5, 1.7.
 *
 * Wires the four cooperating capabilities together in the deterministic,
 * fail-fast order mandated by the design's Startup Sequence:
 *
 *   loadConfigOrExit            → cfg   (Req 1.7: missing/blank secrets self-exit)
 *     → initDatabaseOrExit      → db    (Req 1.3: DB initialized before any task;
 *                                        Req 3.9/3.10 storage/integrity self-exit)
 *       → createRepository      → repo
 *         → new CognitiveEngine → engine
 *           → initScheduler     → scheduler (Req 1.3: scheduler AFTER the DB)
 *             → ready log + operational state (Req 1.4)
 *
 * `config.ts` and `db.ts` already terminate startup with a non-zero exit and a
 * component/path-named error log on failure (their `*OrExit` wrappers). The only
 * remaining stage that can throw here is scheduler initialization, which this
 * module wraps so a failure emits a component-named error log and exits non-zero
 * (Req 1.5) — never executing an autonomous task.
 *
 * Every collaborator is injectable (config loader, DB init, repository factory,
 * scheduler init, LLM client, logger, clock, and the `exit` function) so the
 * startup ordering and the fail-fast behavior can be asserted in tests (task
 * 15.2) without spawning a real process, opening a real database, or calling the
 * real `process.exit`.
 */

import type Database from 'better-sqlite3';
import type { ScheduledTask } from 'node-cron';

import { loadConfigOrExit, type RozaConfig } from './config.js';
import { initDatabaseOrExit } from './db.js';
import { createRepository, type Repository } from './repository.js';
import { initScheduler } from './scheduler.js';
import { CognitiveEngine } from './engine.js';
import { chatCompletion } from './llm.js';
import type { Logger } from './types.js';

/**
 * The running service handle returned by {@link start} on success. Exposing the
 * constructed collaborators keeps the startup sequence testable (task 15.2) and
 * gives callers a `scheduler` handle they can stop during shutdown.
 */
export interface RozaHandle {
  cfg: RozaConfig;
  db: Database.Database;
  repo: Repository;
  engine: CognitiveEngine;
  scheduler: ScheduledTask;
}

/**
 * Injectable startup collaborators. Each defaults to the real module
 * implementation; tests override them to drive the ordering and the failure
 * paths deterministically.
 */
export interface BootstrapDeps {
  /** Validate config + self-exit on missing secrets (Req 1.7). Default {@link loadConfigOrExit}. */
  loadConfig?: typeof loadConfigOrExit;
  /** Open/initialize the database + self-exit on storage/integrity faults. Default {@link initDatabaseOrExit}. */
  initDatabase?: typeof initDatabaseOrExit;
  /** Build the typed repository over the opened database. Default {@link createRepository}. */
  createRepo?: typeof createRepository;
  /** Register the 30-minute cron scheduler. Default {@link initScheduler}. */
  initScheduler?: typeof initScheduler;
  /** OpenRouter chat-completion client passed to the engine. Default {@link chatCompletion}. */
  llm?: typeof chatCompletion;
  /** Structured logger; the default console logger never logs secret values. */
  logger?: Logger;
  /** Injectable clock shared by the engine and scheduler. Default `() => new Date()`. */
  now?: () => Date;
  /** Injectable process exit (Req 1.5). Default `process.exit`. */
  exit?: (code: number) => never;
}

/**
 * A minimal console-backed {@link Logger}. It prints only the supplied message
 * and structured metadata; it never receives or echoes secret values (the
 * config/db layers surface variable NAMES only — Req 1.7), so nothing
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
 * Run the fail-fast startup sequence and enter the operational state.
 *
 * Ordering (Req 1.3): configuration → database → repository → engine →
 * scheduler. The database is fully initialized before the scheduler is
 * registered, and the scheduler is registered before any autonomous task can
 * run. On success a startup-ready log entry is emitted and a {@link RozaHandle}
 * is returned (Req 1.4). On a scheduler-init failure a component-named error log
 * is emitted and the process exits non-zero, executing no autonomous task
 * (Req 1.5). Configuration (Req 1.7) and database (Req 3.9/3.10) failures are
 * handled inside their own `*OrExit` wrappers.
 */
export function start(
  env: NodeJS.ProcessEnv = process.env,
  deps: BootstrapDeps = {},
): RozaHandle {
  const loadConfig = deps.loadConfig ?? loadConfigOrExit;
  const initDatabase = deps.initDatabase ?? initDatabaseOrExit;
  const createRepo = deps.createRepo ?? createRepository;
  const initSched = deps.initScheduler ?? initScheduler;
  const llm = deps.llm ?? chatCompletion;
  const logger = deps.logger ?? defaultLogger;
  const now = deps.now ?? ((): Date => new Date());
  const exit = deps.exit ?? (process.exit as (code: number) => never);

  // 1. Configuration — self-exits (non-zero) on missing/blank secrets (Req 1.7).
  const cfg = loadConfig(env);

  // 2. Database — initialized BEFORE any task (Req 1.3); the wrapper self-exits
  //    on absent/unwritable storage or a corrupt/incomplete file (Req 3.9/3.10).
  const db = initDatabase(cfg.dataDir, cfg.keyVersion);

  // 3. Repository — typed gateway bound to the opened, schema-verified database.
  const repo = createRepo(db, {
    secret: cfg.rozaPrivateKey,
    keyVersion: cfg.keyVersion,
  });

  // 4. Cognitive Engine — wires repository + LLM client + config behind the
  //    autonomous-task and message entrypoints.
  const engine = new CognitiveEngine({
    repo,
    llm,
    cfg,
    now,
    logger,
  });

  // 5. Scheduler — registered AFTER the database (Req 1.3). A failure here is the
  //    one remaining startup fault to guard: emit a component-named error log and
  //    exit non-zero, executing no autonomous task (Req 1.5).
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

  // 6. Operational state — emit the startup-ready entry (Req 1.4).
  logger.info('[roza] roza-agent ready');

  return { cfg, db, repo, engine, scheduler };
}
