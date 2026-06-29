import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import { onTick, type SchedulerDeps } from './scheduler.js';
import { isWithinActiveWindow, minutesInTimezone, type ActiveWindow } from './window.js';
import type { Logger } from './types.js';

/**
 * Property test for the Quiet_Hours guard around the wired X autonomy run
 * (Phase 5 — Component 3 wiring). The Phase 1 Active_Window gate in
 * {@link onTick} short-circuits during Quiet_Hours before any work runs, so the
 * optional `runXAutonomy` dep — which performs the Timeline read and every
 * X_Action — is only ever invoked on an in-window tick. This property pins that
 * invariant across arbitrary instants and resolved Active_Windows.
 *
 * The instant maps deterministically to a minute-of-day because the timezone is
 * UTC and the probe Date is built from UTC hours/minutes, so the test's notion
 * of "in window" matches the scheduler's `minutesInTimezone`/`isWithinActiveWindow`
 * evaluation exactly.
 */

const MAX_MINUTE = 1439; // 23:59, last minute of the day
const TIMEZONE = 'UTC';

/** Build a fresh logger with spied methods. */
function makeLogger(): Logger & {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), error: vi.fn() };
}

/** A UTC Date whose wall-clock minute-of-day in UTC equals `minute`. */
function dateAtMinute(minute: number): Date {
  const hour = Math.floor(minute / 60);
  const min = minute % 60;
  return new Date(Date.UTC(2024, 0, 1, hour, min, 0));
}

describe('scheduler — Quiet_Hours blocks all X_Actions (Phase 5)', () => {
  // Feature: roza-step5-x-twitter, Property 5: Quiet_Hours blocks all X_Actions
  //
  // For any instant and resolved Active_Window: when the instant is in
  // Quiet_Hours the tick is a no-op so the wired `runXAutonomy` performs NO
  // Timeline read or X_Action (the dep is NOT invoked); an X_Action
  // (a `runXAutonomy` invocation) can occur ONLY within the Active_Window.
  // Validates: Requirements 4.3, 13.3
  it('Property 5: runXAutonomy is invoked iff the tick lands within the Active_Window', async () => {
    // Draw a valid non-wrapping window 0 <= start < end <= 1439 by ordering two
    // distinct minutes, plus a probe minute in [0, 1439] — covering both
    // in-window and Quiet_Hours instants.
    const windowAndMinute = fc
      .tuple(
        fc.integer({ min: 0, max: MAX_MINUTE }),
        fc.integer({ min: 0, max: MAX_MINUTE }),
        fc.integer({ min: 0, max: MAX_MINUTE }),
      )
      .filter(([a, b]) => a !== b)
      .map(([a, b, m]) => {
        const window: ActiveWindow = {
          startMinutes: Math.min(a, b),
          endMinutes: Math.max(a, b),
        };
        return { window, minute: m } as const;
      });

    await fc.assert(
      fc.asyncProperty(windowAndMinute, async ({ window, minute }) => {
        const now = dateAtMinute(minute);
        const runXAutonomy = vi.fn<() => Promise<void>>(() => Promise.resolve());
        const runAutonomousTask = vi.fn<() => Promise<void>>(() => Promise.resolve());
        const recordInvocation = vi.fn<(at: string) => void>();

        const deps: SchedulerDeps = {
          window,
          timezone: TIMEZONE,
          now: () => now,
          runAutonomousTask,
          recordInvocation,
          runXAutonomy,
          logger: makeLogger(),
        };

        await onTick(deps);

        // The scheduler's own evaluation of the instant against the window —
        // this is the single source of truth for in-window vs Quiet_Hours.
        const inWindow = isWithinActiveWindow(
          minutesInTimezone(now, TIMEZONE),
          window,
        );

        if (inWindow) {
          // In-window: the wired X autonomy run fires exactly once (the only
          // place a Timeline read / X_Action originates).
          expect(runXAutonomy).toHaveBeenCalledTimes(1);
        } else {
          // Quiet_Hours: the tick is a no-op — no Timeline read, no X_Action.
          expect(runXAutonomy).not.toHaveBeenCalled();
          // And nothing else ran either (full no-op, the right to disconnect).
          expect(runAutonomousTask).not.toHaveBeenCalled();
          expect(recordInvocation).not.toHaveBeenCalled();
        }

        // Biconditional, stated as the contrapositive too: an X_Action can occur
        // ONLY within the Active_Window — if runXAutonomy was invoked, the
        // instant must have been in-window.
        const xActionOccurred = runXAutonomy.mock.calls.length > 0;
        expect(xActionOccurred).toBe(inWindow);
        if (xActionOccurred) {
          expect(inWindow).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});
