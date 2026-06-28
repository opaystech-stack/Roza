/**
 * Active_Window math (Component 2) — Req 2.1, 2.2, 2.3.
 *
 * Pure, side-effect-free helpers that decide when the autonomous scheduler may
 * run. `Quiet_Hours` is simply the complement of the Active_Window (Req 2.2),
 * so no separate predicate is needed. All times are expressed as minutes since
 * midnight in the configured IANA timezone.
 */

/** A daily active range, expressed as minutes since midnight in [0, 1439]. */
export interface ActiveWindow {
  /** Inclusive start, minutes since midnight. */
  startMinutes: number;
  /** Exclusive end, minutes since midnight. */
  endMinutes: number;
}

/** Default Active_Window: 07:00–22:00 (Req 2.3). */
export const DEFAULT_WINDOW: ActiveWindow = {
  startMinutes: 7 * 60,
  endMinutes: 22 * 60,
};

/**
 * Is `now` within the half-open window `[start, end)` (Req 2.1)?
 *
 * Uses `start <= now && now < end` so the start minute is active and the end
 * minute is the first quiet minute. Handles non-wrapping windows (the only
 * shape produced by config validation).
 */
export function isWithinActiveWindow(now: number, w: ActiveWindow): boolean {
  return w.startMinutes <= now && now < w.endMinutes;
}

/**
 * Minutes since midnight for `date` rendered in the given IANA `timezone`.
 *
 * Uses `Intl.DateTimeFormat` with the target timezone to extract the local
 * hour and minute, so the result reflects wall-clock time in that zone rather
 * than the host's local time or UTC.
 */
export function minutesInTimezone(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  let hour = 0;
  let minute = 0;
  for (const part of formatter.formatToParts(date)) {
    if (part.type === 'hour') {
      hour = Number.parseInt(part.value, 10);
    } else if (part.type === 'minute') {
      minute = Number.parseInt(part.value, 10);
    }
  }

  return hour * 60 + minute;
}

/**
 * The cron expression for fixed 30-minute intervals (every :00 and :30).
 * The scheduler fires on every tick; the engine task gates on
 * `isWithinActiveWindow` so quiet-hours ticks are no-ops (Req 2.1, 2.2).
 */
export function cronExpressionEvery30Min(): string {
  return '0,30 * * * *';
}
