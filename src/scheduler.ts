/**
 * Scheduler (Component 3) — Req 1.3, 2.1, 2.2, 2.5, 2.6.
 *
 * A thin `node-cron` wiring around a guarded tick. The cron job fires on every
 * fixed 30-minute boundary (`cronExpressionEvery30Min`), but the actual work is
 * gated on the Active_Window inside {@link onTick} so quiet-hours ticks are
 * no-ops (Req 2.2 — the right to disconnect). Every in-window tick records its
 * invocation with a timezone-local timestamp (Req 2.5) before running the
 * engine's autonomous task, and any task failure is swallowed and logged so the
 * cron schedule survives to the next :00/:30 boundary (Req 2.6).
 *
 * The dependencies are injected (clock, callbacks, logger) so {@link onTick} is
 * unit-testable without a real timer, database, or LLM: tests can drive an
 * arbitrary `now`, assert the invocation record, and force the task to throw.
 */

import { schedule, type ScheduledTask } from 'node-cron';

import type { ActiveWindow } from './window.js';
import {
  cronExpressionEvery30Min,
  isWithinActiveWindow,
  minutesInTimezone,
} from './window.js';
import type { Logger } from './types.js';

/**
 * Everything the scheduler needs, injected for testability.
 *
 * `recordInvocation` is a simple callback rather than a repository handle so the
 * scheduler stays decoupled from persistence (Req 2.5): the bootstrap wires it
 * to `repository.recordTaskInvocation`. `now` is an injectable clock so tests
 * can place the tick inside or outside the Active_Window deterministically.
 */
export interface SchedulerDeps {
  /** The resolved Active_Window the tick gates on (Req 2.1, 2.2). */
  window: ActiveWindow;
  /** IANA timezone used to evaluate the window and stamp invocations. */
  timezone: string;
  /** Injectable clock (testability). */
  now: () => Date;
  /** Engine entrypoint for the autonomous reflection task. */
  runAutonomousTask: () => Promise<void>;
  /** Records an autonomous task invocation with a timezone timestamp (Req 2.5). */
  recordInvocation: (at: string) => void;
  /**
   * Optional drain of the durable inbound queue, run on entry to the
   * Active_Window before the autonomous task (Phase 2 — Req 10.3). When wired,
   * the bootstrap binds it to `InboundRouter.drainQueue`. Omitting it preserves
   * the exact Phase 1 tick behavior (backward compatible).
   */
  drainInboundQueue?: () => Promise<void>;
  /**
   * Optional autonomous X (Twitter) presence run, executed on the in-window
   * tick after the autonomous task (Phase 5 — Req 4.1). The Active_Window gate
   * in {@link onTick} already short-circuits during Quiet_Hours, so no X_Action
   * ever occurs then (Req 4.3) — no separate gate is needed here. When wired,
   * the bootstrap binds it to `XConnector.runXAutonomy`; its failures are
   * isolated and logged like the autonomous task so a failure neither aborts
   * the tick nor stops the cron (Req 4.5, 11.3). Omitting it preserves the
   * exact prior tick behavior (Req 4.1, backward compatible).
   */
  runXAutonomy?: () => Promise<void>;
  /** Structured logger; never receives secret values. */
  logger: Logger;
}

/**
 * Produce a readable, timezone-local timestamp string for the configured
 * timezone, e.g. `2024-01-15 14:30:00` rendered as wall-clock time in
 * `timezone`. Used for the invocation record (Req 2.5) so the audit trail
 * reflects Roza's local time rather than UTC or the host clock.
 */
export function timestampInTimezone(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') {
      parts[part.type] = part.value;
    }
  }

  // en-CA renders ISO-like date components; assemble a stable `YYYY-MM-DD HH:MM:SS`.
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/**
 * The guarded tick (Req 2.2, 2.5, 2.6):
 *
 * 1. Gate on the Active_Window — outside it, return immediately (Quiet_Hours
 *    no-op, the right to disconnect).
 * 2. Record the invocation with a timezone-local timestamp (Req 2.5).
 * 3. Drain the durable inbound queue, if wired, so messages deferred during
 *    Quiet_Hours are processed on entry to the Active_Window in receipt order
 *    (Phase 2 — Req 10.3); a drain failure is isolated and logged so it neither
 *    aborts the autonomous task nor crashes the tick (mirrors Req 2.6).
 * 4. Run the engine's autonomous task, swallowing and logging any failure so
 *    the schedule continues at the next interval (Req 2.6).
 * 5. Run the optional X autonomy presence, if wired, after the autonomous task;
 *    isolate failures like the task so an X failure neither aborts the tick nor
 *    stops the cron (Phase 5 — Req 4.1, 4.5, 11.3). The Active_Window gate in
 *    step 1 already prevents any X_Action during Quiet_Hours (Req 4.3).
 */
export async function onTick(deps: SchedulerDeps): Promise<void> {
  const now = deps.now();
  const nowMinutes = minutesInTimezone(now, deps.timezone);

  // Req 2.2: outside the Active_Window the scheduler does nothing (no drain,
  // no record, no task — deferral happens at ingress per Req 10.2).
  if (!isWithinActiveWindow(nowMinutes, deps.window)) {
    return;
  }

  // Req 2.5: every in-window invocation is recorded with a timezone timestamp.
  deps.recordInvocation(timestampInTimezone(now, deps.timezone));

  // Req 10.3: on entry to the Active_Window, drain queued inbound messages
  // before the autonomous task. Isolate failures like the task below so a drain
  // error neither prevents runAutonomousTask nor crashes the tick.
  if (deps.drainInboundQueue) {
    try {
      await deps.drainInboundQueue();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error('inbound queue drain failed', { message });
    }
  }

  // Req 2.6: isolate task failures so subsequent ticks keep firing.
  try {
    await deps.runAutonomousTask();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.logger.error('autonomous task failed', { message });
  }

  // Req 4.1: after the autonomous task, run the optional X autonomy presence.
  // The Active_Window gate above already prevents any X_Action during
  // Quiet_Hours (Req 4.3), so no separate gate is needed. Isolate failures like
  // the task above so an X failure neither aborts the tick nor stops the cron
  // (Req 4.5, 11.3). Omitting the dep preserves the exact prior tick behavior.
  if (deps.runXAutonomy) {
    try {
      await deps.runXAutonomy();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error('X autonomy run failed', { message });
    }
  }
}

/**
 * Register the 30-minute cron job and return its handle so the caller (the
 * bootstrap) can stop it during shutdown. The cron expression fires on every
 * :00 and :30 boundary; {@link onTick} performs the Active_Window gating, so the
 * cron itself is unconditional (Req 1.3, 2.1).
 *
 * The cron callback is synchronous (`node-cron` ignores returned promises), so
 * the async tick is invoked fire-and-forget with its rejection already handled
 * inside {@link onTick}.
 */
export function initScheduler(deps: SchedulerDeps): ScheduledTask {
  return schedule(
    cronExpressionEvery30Min(),
    () => {
      void onTick(deps);
    },
    { timezone: deps.timezone }
  );
}
