import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  decideAction,
  type RateLimitConfig,
  type XActionRecord,
} from './rateLimit.js';

// Feature: roza-step5-x-twitter, Property 4: Rate_Limit enforcement over arbitrary action histories
// Validates: Requirements 8.2, 8.3, 8.4, 13.3
//
// decideAction is a pure, total reducer over an arbitrary X_Action history. For
// any history, candidate `now`, Daily_Post_Limit, Action_Spacing, and timezone
// the decision must be:
//   - `deny_daily_limit` IFF the count of actions whose timezone-local calendar
//     day equals `now`'s local day is >= dailyPostLimit (Req 8.2, 8.4);
//   - else `defer` with a positive `waitMs` IFF the most recent action is closer
//     than Action_Spacing before `now`, with waitMs == actionSpacingMs - elapsed
//     (Req 8.3);
//   - else `allow`.
// It must never throw and the decision kind is always one of the three.

/**
 * Independent reference oracle for the timezone-local calendar day key. Mirrors
 * the spec's `Intl.DateTimeFormat('en-CA', ...)`-in-timezone approach exactly so
 * the test's day-bucket semantics match the implementation under test.
 */
function refLocalDayKey(epochMs: number, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') {
      parts[part.type] = part.value;
    }
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Fixed IANA timezones for deterministic day-boundary math: Africa/Kinshasa is
// Roza's home zone (UTC+1, no DST) and UTC anchors a control case.
const TIMEZONES = ['Africa/Kinshasa', 'UTC'] as const;

// A base instant in 2024 (epoch ms); actions are generated relative to `now` so
// same-day collisions and spacing boundaries are exercised frequently.
const BASE_MS = Date.UTC(2024, 0, 1, 0, 0, 0);
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

describe('rateLimit — Rate_Limit reducer', () => {
  it('Property 4: enforces daily-limit / spacing / allow over arbitrary histories', () => {
    const scenario = fc
      .record({
        nowMs: fc.integer({ min: BASE_MS, max: BASE_MS + YEAR_MS }),
        // Offsets (ms) of prior actions relative to `now`. Mostly in the recent
        // past (clustered around the spacing/day boundaries) with a few future
        // values to probe the negative-elapsed edge.
        offsets: fc.array(
          fc.integer({ min: -THREE_DAYS_MS, max: 60 * 60 * 1000 }),
          { minLength: 0, maxLength: 25 },
        ),
        dailyPostLimit: fc.integer({ min: 0, max: 12 }),
        actionSpacingMs: fc.integer({ min: 1, max: 60 * 60 * 1000 }),
        timezone: fc.constantFrom(...TIMEZONES),
      })
      .map(({ nowMs, offsets, dailyPostLimit, actionSpacingMs, timezone }) => {
        const history: XActionRecord[] = offsets.map((off) => ({
          atMs: nowMs + off,
        }));
        const cfg: RateLimitConfig = { dailyPostLimit, actionSpacingMs, timezone };
        return { history, nowMs, cfg } as const;
      });

    fc.assert(
      fc.property(scenario, ({ history, nowMs, cfg }) => {
        let decision: ReturnType<typeof decideAction>;
        // Never throws (Req 8.1 totality).
        expect(() => {
          decision = decideAction(history, nowMs, cfg);
        }).not.toThrow();
        decision = decideAction(history, nowMs, cfg);

        // Decision kind is always one of the three.
        expect(['allow', 'defer', 'deny_daily_limit']).toContain(decision.kind);

        // Reference computation mirroring the spec.
        const today = refLocalDayKey(nowMs, cfg.timezone);
        const todayCount = history.filter(
          (r) => refLocalDayKey(r.atMs, cfg.timezone) === today,
        ).length;

        let mostRecentMs: number | undefined;
        for (const r of history) {
          if (mostRecentMs === undefined || r.atMs > mostRecentMs) {
            mostRecentMs = r.atMs;
          }
        }
        const elapsed =
          mostRecentMs === undefined ? undefined : nowMs - mostRecentMs;
        const expectDefer =
          elapsed !== undefined && elapsed < cfg.actionSpacingMs;

        if (todayCount >= cfg.dailyPostLimit) {
          // deny_daily_limit IFF the day's count has reached the limit.
          expect(decision.kind).toBe('deny_daily_limit');
        } else if (expectDefer) {
          // defer IFF spacing not yet elapsed, with the exact remaining wait.
          expect(decision.kind).toBe('defer');
          if (decision.kind === 'defer') {
            const expectedWait = cfg.actionSpacingMs - (elapsed as number);
            expect(decision.waitMs).toBe(expectedWait);
            expect(decision.waitMs).toBeGreaterThan(0);
          }
        } else {
          // Both gates satisfied.
          expect(decision.kind).toBe('allow');
        }
      }),
      { numRuns: 200 },
    );
  });
});
