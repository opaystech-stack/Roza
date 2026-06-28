import { describe, expect, it, vi } from 'vitest';

import { onTick, timestampInTimezone, type SchedulerDeps } from './scheduler.js';
import type { ActiveWindow } from './window.js';
import type { Logger } from './types.js';

/**
 * Integration tests for the guarded scheduler tick (Component 3) — Req 2.5, 2.6.
 *
 * These exercise {@link onTick} directly with injected dependencies (clock,
 * callbacks, logger) so the behavior is verified without a real `node-cron`
 * timer, database, or LLM. We drive `now()` to land inside or outside the
 * Active_Window and assert the resulting effects:
 *
 *  - in-window  → records exactly one invocation AND awaits the task once,
 *  - quiet-hours → no-op (no record, no task),
 *  - task failure → swallowed + logged, but the invocation was still recorded
 *    so the schedule survives to the next interval (Req 2.6).
 */

/** Default Active_Window 07:00–22:00 used across these tests. */
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

describe('scheduler — onTick (guarded 30-minute tick)', () => {
  // Req 2.5: an in-window tick records exactly one invocation with a timezone
  // timestamp and runs the autonomous task exactly once.
  it('in-window tick records one invocation and runs the task once', async () => {
    const runAutonomousTask = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const recordInvocation = vi.fn<(at: string) => void>();
    const deps = makeDeps({ now: () => IN_WINDOW, runAutonomousTask, recordInvocation });

    await onTick(deps);

    expect(recordInvocation).toHaveBeenCalledTimes(1);
    expect(runAutonomousTask).toHaveBeenCalledTimes(1);

    // The recorded value is a timezone-local timestamp string (Req 2.5).
    const recordedAt = recordInvocation.mock.calls[0]![0];
    expect(typeof recordedAt).toBe('string');
    expect(recordedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(recordedAt).toBe('2024-06-01 12:00:00');
  });

  // Req 2.2: outside the Active_Window the tick is a no-op — neither the
  // invocation record nor the task runs (the right to disconnect).
  it('quiet-hours tick is a no-op (no record, no task)', async () => {
    const runAutonomousTask = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const recordInvocation = vi.fn<(at: string) => void>();
    const deps = makeDeps({ now: () => QUIET_HOURS, runAutonomousTask, recordInvocation });

    await onTick(deps);

    expect(recordInvocation).not.toHaveBeenCalled();
    expect(runAutonomousTask).not.toHaveBeenCalled();
  });

  // Req 2.6: a thrown/rejected task is isolated — onTick resolves (does not
  // throw), logs via logger.error, and the invocation was still recorded so the
  // schedule continues to the next interval.
  it('isolates a failing task: resolves, logs the error, and still records the invocation', async () => {
    const failure = new Error('engine boom');
    const runAutonomousTask = vi.fn<() => Promise<void>>(() => Promise.reject(failure));
    const recordInvocation = vi.fn<(at: string) => void>();
    const logger = makeLogger();
    const deps = makeDeps({ now: () => IN_WINDOW, runAutonomousTask, recordInvocation, logger });

    // Must not reject — the schedule survives task failures (Req 2.6).
    await expect(onTick(deps)).resolves.toBeUndefined();

    // The task was attempted and the invocation recorded before it failed.
    expect(runAutonomousTask).toHaveBeenCalledTimes(1);
    expect(recordInvocation).toHaveBeenCalledTimes(1);

    // The failure was logged (and never re-thrown).
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message, meta] = logger.error.mock.calls[0]!;
    expect(message).toBe('autonomous task failed');
    expect(meta).toEqual({ message: 'engine boom' });
  });

  // Req 2.6: a synchronously-thrown rejection is handled identically.
  it('isolates a non-Error rejection and logs its string form', async () => {
    const runAutonomousTask = vi.fn<() => Promise<void>>(() => Promise.reject('plain string'));
    const logger = makeLogger();
    const deps = makeDeps({ now: () => IN_WINDOW, runAutonomousTask, logger });

    await expect(onTick(deps)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [, meta] = logger.error.mock.calls[0]!;
    expect(meta).toEqual({ message: 'plain string' });
  });
});

describe('scheduler — timestampInTimezone', () => {
  // Req 2.5: timestamps are rendered as wall-clock time in the configured zone.
  it('formats a known date as YYYY-MM-DD HH:MM:SS in the given timezone', () => {
    expect(timestampInTimezone(IN_WINDOW, 'UTC')).toBe('2024-06-01 12:00:00');
    expect(timestampInTimezone(IN_WINDOW, 'UTC')).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );
  });

  it('renders the same instant differently across timezones (wall-clock local time)', () => {
    // Africa/Kinshasa is UTC+1 (no DST), so 12:00 UTC is 13:00 local.
    expect(timestampInTimezone(IN_WINDOW, 'Africa/Kinshasa')).toBe('2024-06-01 13:00:00');
  });
});
