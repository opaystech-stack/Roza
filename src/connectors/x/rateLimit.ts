/**
 * Rate_Limit reducer (Component X4) — Req 8.1, 8.2, 8.3, 8.4.
 *
 * The pure heart of Phase 5's rate discipline: a total reducer over an
 * arbitrary X_Action history that decides whether the next X_Action may be
 * published now (`allow`), must wait for the minimum Action_Spacing to elapse
 * (`defer`), or is denied because the Daily_Post_Limit for the current
 * timezone-local calendar day has been reached (`deny_daily_limit`).
 *
 * This module performs NO I/O, reads NO clock, and never throws: the I/O shell
 * supplies `nowMs` (epoch milliseconds) and the `history` it read from the
 * `x_actions` audit table, and the reducer is a pure function of its inputs.
 * It is the prime property-based-testing target.
 *
 * Day-boundary math reuses the Phase 1 `Intl.DateTimeFormat`-in-timezone
 * approach (see `window.ts` `minutesInTimezone` / `scheduler.ts`
 * `timestampInTimezone`): each timestamp is rendered to its `YYYY-MM-DD`
 * calendar day in the configured IANA timezone, so the daily count reflects
 * Roza's local wall-clock day rather than UTC or the host clock.
 */

/** One prior X_Action's timestamp, in epoch milliseconds (Req 8.4). */
export interface XActionRecord {
  /** Epoch milliseconds at which the X_Action was published. */
  atMs: number;
}

/**
 * Rate_Limit settings (from `cfg.x.rateLimit`) plus the IANA timezone used for
 * the day-boundary math (Req 8.1).
 */
export interface RateLimitConfig {
  /** Maximum X_Actions permitted per timezone-local calendar day (Req 8.2). */
  dailyPostLimit: number;
  /** Minimum spacing, in milliseconds, required between X_Actions (Req 8.3). */
  actionSpacingMs: number;
  /** IANA timezone used to derive each action's local calendar day. */
  timezone: string;
}

/** The decision for the next candidate X_Action. */
export type RateDecision =
  /** Both gates satisfied — publish now (Req 8 happy path). */
  | { kind: 'allow' }
  /** Spacing not yet elapsed — wait `waitMs` before publishing (Req 8.3). */
  | { kind: 'defer'; waitMs: number }
  /** The Daily_Post_Limit has been reached for `now`'s local day (Req 8.2). */
  | { kind: 'deny_daily_limit' };

/**
 * The timezone-local calendar day (`YYYY-MM-DD`) for `epochMs` rendered in the
 * given IANA `timezone`.
 *
 * Mirrors the Phase 1 `Intl.DateTimeFormat`-in-timezone approach used by
 * `window.ts`/`scheduler.ts`: `en-CA` renders ISO-like date components, which
 * are reassembled into a stable `YYYY-MM-DD` key. Two timestamps share a day
 * iff their keys are string-equal.
 */
function localDayKey(epochMs: number, timezone: string): string {
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

/**
 * Pure, total: decide the next X_Action against the history (Req 8.2–8.4).
 *
 * 1. Count actions whose timezone-local calendar day equals `now`'s day; if that
 *    count is `>= dailyPostLimit` → `deny_daily_limit` (Req 8.2, 8.4). The daily
 *    count "resets" naturally as the calendar day advances in `cfg.timezone`.
 * 2. Else if the most recent action is `< actionSpacingMs` before `now` →
 *    `defer` with the remaining positive `waitMs` (Req 8.3).
 * 3. Else `allow`.
 *
 * No I/O, no clock read (`nowMs` is passed in), never throws.
 */
export function decideAction(
  history: readonly XActionRecord[],
  nowMs: number,
  cfg: RateLimitConfig
): RateDecision {
  // Req 8.2, 8.4: deny when the day's count has reached the Daily_Post_Limit.
  const today = localDayKey(nowMs, cfg.timezone);
  let todayCount = 0;
  for (const record of history) {
    if (localDayKey(record.atMs, cfg.timezone) === today) {
      todayCount += 1;
    }
  }
  if (todayCount >= cfg.dailyPostLimit) {
    return { kind: 'deny_daily_limit' };
  }

  // Req 8.3: defer when the most recent action is closer than the spacing.
  let mostRecentMs: number | undefined;
  for (const record of history) {
    if (mostRecentMs === undefined || record.atMs > mostRecentMs) {
      mostRecentMs = record.atMs;
    }
  }
  if (mostRecentMs !== undefined) {
    const elapsed = nowMs - mostRecentMs;
    if (elapsed < cfg.actionSpacingMs) {
      const waitMs = cfg.actionSpacingMs - elapsed;
      if (waitMs > 0) {
        return { kind: 'defer', waitMs };
      }
    }
  }

  // Both gates satisfied.
  return { kind: 'allow' };
}
