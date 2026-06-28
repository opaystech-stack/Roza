import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  cronExpressionEvery30Min,
  DEFAULT_WINDOW,
  isWithinActiveWindow,
  type ActiveWindow,
} from './window.js';

const MAX_MINUTE = 1439; // 23:59, last minute of the day

describe('window — Active_Window math', () => {
  // Feature: roza-agent, Property 7: Active_Window partitions the day — for any
  // window with 0 <= start < end <= 1439 and any minute m in [0, 1439],
  // isWithinActiveWindow(m, w) is true exactly when start <= m < end, and false
  // otherwise (the complement = Quiet_Hours). Every minute is classified as
  // exactly active OR quiet (mutually exclusive, exhaustive).
  // Validates: Requirements 2.1, 2.2
  it('Property 7: partitions every minute of the day into exactly active or quiet', () => {
    // Generate a valid non-wrapping window 0 <= start < end <= 1439 by drawing
    // two distinct minutes and ordering them, then a probe minute in [0, 1439].
    const windowAndMinute = fc
      .tuple(
        fc.integer({ min: 0, max: MAX_MINUTE }),
        fc.integer({ min: 0, max: MAX_MINUTE }),
        fc.integer({ min: 0, max: MAX_MINUTE }),
      )
      .filter(([a, b]) => a !== b)
      .map(([a, b, m]) => {
        const startMinutes = Math.min(a, b);
        const endMinutes = Math.max(a, b);
        const w: ActiveWindow = { startMinutes, endMinutes };
        return { w, m } as const;
      });

    fc.assert(
      fc.property(windowAndMinute, ({ w, m }) => {
        const active = isWithinActiveWindow(m, w);
        const expectedActive = w.startMinutes <= m && m < w.endMinutes;

        // Active iff start <= m < end (Req 2.1).
        expect(active).toBe(expectedActive);

        // Quiet_Hours is exactly the complement (Req 2.2): mutually exclusive
        // and exhaustive — the minute is classified as exactly one of the two.
        const quiet = !active;
        expect(active && quiet).toBe(false); // mutually exclusive
        expect(active || quiet).toBe(true); // exhaustive
      }),
      { numRuns: 500 },
    );
  });

  // Feature: roza-agent, Property 7 (boundary corollary): the start minute is
  // active and the end minute is the first quiet minute (half-open [start, end)).
  // Validates: Requirements 2.1, 2.2
  it('Property 7: treats the window as half-open [start, end)', () => {
    const windows = fc
      .tuple(
        fc.integer({ min: 0, max: MAX_MINUTE }),
        fc.integer({ min: 0, max: MAX_MINUTE }),
      )
      .filter(([a, b]) => a !== b)
      .map(([a, b]) => {
        const w: ActiveWindow = {
          startMinutes: Math.min(a, b),
          endMinutes: Math.max(a, b),
        };
        return w;
      });

    fc.assert(
      fc.property(windows, (w) => {
        // Start minute is active, end minute is quiet.
        expect(isWithinActiveWindow(w.startMinutes, w)).toBe(true);
        expect(isWithinActiveWindow(w.endMinutes, w)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('classifies minutes against the default 07:00–22:00 window', () => {
    expect(DEFAULT_WINDOW).toEqual({ startMinutes: 420, endMinutes: 1320 });
    expect(isWithinActiveWindow(420, DEFAULT_WINDOW)).toBe(true); // 07:00 active
    expect(isWithinActiveWindow(419, DEFAULT_WINDOW)).toBe(false); // 06:59 quiet
    expect(isWithinActiveWindow(1319, DEFAULT_WINDOW)).toBe(true); // 21:59 active
    expect(isWithinActiveWindow(1320, DEFAULT_WINDOW)).toBe(false); // 22:00 quiet
    expect(isWithinActiveWindow(0, DEFAULT_WINDOW)).toBe(false); // midnight quiet
  });

  it('cronExpressionEvery30Min returns the every-:00/:30 expression', () => {
    expect(cronExpressionEvery30Min()).toBe('0,30 * * * *');
  });
});
