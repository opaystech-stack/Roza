import { describe, expect, it, vi } from 'vitest';

import { onTick, type SchedulerDeps } from './scheduler.js';
import type { ActiveWindow } from './window.js';
import type { Logger } from './types.js';

/**
 * Integration tests for the Phase 2 queue-drain step in the guarded scheduler
 * tick (Component 3) — Req 10.3, 10.5.
 *
 * Task 12.1 added an optional `drainInboundQueue` callback to {@link onTick}
 * that runs on entry to the Active_Window, after the in-window guard and the
 * invocation record, but before the unchanged Phase 1 `runAutonomousTask`. The
 * queue is drained so messages deferred during Quiet_Hours are processed in
 * receipt order when Roza comes back online (Req 10.3), and the drain must be a
 * strict no-op outside the Active_Window (Req 10.5).
 *
 * These tests exercise {@link onTick} directly with injected `vi.fn()` deps so
 * the ordering and failure-isolation guarantees are verified without a real
 * `node-cron` timer, queue, database, or LLM. They are kept separate from the
 * Phase 1 `scheduler.test.ts` so the original tick behavior remains untouched.
 */

/** Default Active_Window 07:00–22:00, identical to the Phase 1 fixtures. */
const WINDOW: ActiveWindow = { startMinutes: 420, endMinutes: 1320 };

/** Evaluate the window in UTC so the chosen Date maps predictably. */
const TIMEZONE = 'UTC';

/** 2024-06-01 12:00:00 UTC → 720 minutes, comfortably inside [420, 1320). */
const IN_WINDOW = new Date('2024-06-01T12:00:00.000Z');

/** 2024-06-01 03:00:00 UTC → 180 minutes, outside the window (Quiet_Hours). */
const QUIET_HOURS = new Date('2024-06-01T03:00:00.000Z');

/** Build a fresh logger with spied methods. */
function makeLogger(): Logger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), error: vi.fn() };
}

/** Assemble SchedulerDeps with the supplied overrides. */
function makeDeps(overrides: Partial<SchedulerDeps> = {}): SchedulerDeps {
  return {
    window: WINDOW,
    timezone: TIMEZONE,
    now: () => IN_WINDOW,
    runAutonomousTask: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    recordInvocation: vi.fn<(at: string) => void>(),
    logger: makeLogger(),
    ...overrides,
  };
}

describe('scheduler — onTick queue drain (Phase 2)', () => {
  // Req 10.3: an in-window tick records the invocation, then drains the inbound
  // queue, then runs the autonomous task — drain strictly before the task. The
  // shared `order` array captures the real invocation sequence.
  it('in-window tick drains the queue before the autonomous task (record → drain → task)', async () => {
    const order: string[] = [];

    const recordInvocation = vi.fn<(at: string) => void>(() => {
      order.push('record');
    });
    const drainInboundQueue = vi.fn<() => Promise<void>>(() => {
      order.push('drain');
      return Promise.resolve();
    });
    const runAutonomousTask = vi.fn<() => Promise<void>>(() => {
      order.push('task');
      return Promise.resolve();
    });

    const deps = makeDeps({
      now: () => IN_WINDOW,
      recordInvocation,
      drainInboundQueue,
      runAutonomousTask,
    });

    await onTick(deps);

    // Each step ran exactly once.
    expect(recordInvocation).toHaveBeenCalledTimes(1);
    expect(drainInboundQueue).toHaveBeenCalledTimes(1);
    expect(runAutonomousTask).toHaveBeenCalledTimes(1);

    // Ordering: record → drain → task. The drain runs strictly before the task.
    expect(order).toEqual(['record', 'drain', 'task']);
  });

  // Req 10.5: outside the Active_Window the tick is a no-op — the queue is NOT
  // drained, the task does NOT run, and nothing is recorded (the right to
  // disconnect; deferral happens at ingress, not here).
  it('quiet-hours tick performs neither drain nor task nor record', async () => {
    const recordInvocation = vi.fn<(at: string) => void>();
    const drainInboundQueue = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const runAutonomousTask = vi.fn<() => Promise<void>>(() => Promise.resolve());

    const deps = makeDeps({
      now: () => QUIET_HOURS,
      recordInvocation,
      drainInboundQueue,
      runAutonomousTask,
    });

    await onTick(deps);

    expect(drainInboundQueue).not.toHaveBeenCalled();
    expect(runAutonomousTask).not.toHaveBeenCalled();
    expect(recordInvocation).not.toHaveBeenCalled();
  });

  // Req 10.3 (failure isolation, mirrors Req 2.6): a rejected drain is isolated
  // — onTick still resolves (does not throw), logs via logger.error, and still
  // proceeds to the autonomous task so a queue hiccup never blocks reflection.
  it('isolates a rejected drain: resolves, logs the error, and still runs the task', async () => {
    const failure = new Error('drain boom');
    const drainInboundQueue = vi.fn<() => Promise<void>>(() => Promise.reject(failure));
    const runAutonomousTask = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const logger = makeLogger();

    const deps = makeDeps({
      now: () => IN_WINDOW,
      drainInboundQueue,
      runAutonomousTask,
      logger,
    });

    // Must not reject — a drain failure cannot crash the tick.
    await expect(onTick(deps)).resolves.toBeUndefined();

    // The drain was attempted and the task still ran after it failed.
    expect(drainInboundQueue).toHaveBeenCalledTimes(1);
    expect(runAutonomousTask).toHaveBeenCalledTimes(1);

    // The drain failure was logged (and never re-thrown).
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message, meta] = logger.error.mock.calls[0]!;
    expect(message).toBe('inbound queue drain failed');
    expect(meta).toEqual({ message: 'drain boom' });
  });

  // Req 10.5 (backward compatibility): when `drainInboundQueue` is omitted from
  // deps, an in-window tick behaves exactly like Phase 1 — it records the
  // invocation and runs the task — proving the drain step is purely optional.
  it('omitting drainInboundQueue preserves exact Phase 1 behavior (record + task)', async () => {
    const recordInvocation = vi.fn<(at: string) => void>();
    const runAutonomousTask = vi.fn<() => Promise<void>>(() => Promise.resolve());

    // No `drainInboundQueue` override → the key is absent from deps.
    const deps = makeDeps({ now: () => IN_WINDOW, recordInvocation, runAutonomousTask });
    expect(deps.drainInboundQueue).toBeUndefined();

    await onTick(deps);

    expect(recordInvocation).toHaveBeenCalledTimes(1);
    expect(runAutonomousTask).toHaveBeenCalledTimes(1);
  });
});
