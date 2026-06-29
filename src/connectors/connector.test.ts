/**
 * Example tests for the shared `withBackoff` retry helper in `connector.ts`
 * (task 2.5 of the roza-step2-channels plan).
 *
 * These are concrete, deterministic example tests (not the numbered
 * fast-check properties) covering the three resilience behaviors required of
 * the helper:
 *   - Req 12.1: a lost connection is retried with bounded backoff and the
 *     operation eventually succeeds once a transient fault clears.
 *   - Req 12.3: a transport-signaled retry interval (e.g. a Telegram `429`
 *     `retry_after`) is honored over the computed backoff, capped at `maxMs`;
 *     when no interval is signaled the exponential-with-jitter delay is used.
 *   - Req 12.5: when every attempt fails the helper throws the last error
 *     after exactly `maxAttempts` tries rather than crashing the caller.
 *
 * The injected `sleep` is a no-op `vi.fn` wrapper so the test never waits on a
 * real timer; the delays handed to it are captured for assertion. The logger
 * is a spy so we can count one error log per retry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { withBackoff, type BackoffOptions } from './connector.js';
import type { Logger } from '../types.js';

/** A spy logger matching the minimal {@link Logger} contract. */
function makeLogger(): Logger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), error: vi.fn() };
}

/**
 * An instant, no-op sleep that records every delay it was asked to wait. The
 * returned `delays` array lets a test assert exactly which intervals the
 * backoff computed without ever pausing the run.
 */
function makeSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  const sleep = vi.fn((ms: number) => {
    delays.push(ms);
    return Promise.resolve();
  });
  return { sleep, delays };
}

const OPTS: BackoffOptions = { baseMs: 100, maxMs: 1000, maxAttempts: 5 };

describe('withBackoff', () => {
  beforeEach(() => {
    // Pin jitter to its maximum so the exponential path is deterministic:
    // delayMs = Math.random() * exponential === exponential.
    vi.spyOn(Math, 'random').mockReturnValue(1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reconnects after transient failures and returns the resolved value (Req 12.1)', async () => {
    const logger = makeLogger();
    const { sleep } = makeSleep();

    // Reject the first two attempts (transient faults), succeed on the third.
    let attempts = 0;
    const fn = vi.fn(() => {
      attempts += 1;
      if (attempts < 3) {
        return Promise.reject(new Error(`transient ${attempts}`));
      }
      return Promise.resolve('connected');
    });

    const result = await withBackoff(fn, OPTS, logger, undefined, sleep);

    expect(result).toBe('connected');
    // Exactly three attempts: two failures then a success.
    expect(fn).toHaveBeenCalledTimes(3);
    expect(attempts).toBe(3);
    // One error log per retry (two retries before the successful third attempt).
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('honors a signaled retry interval, capped at maxMs (Req 12.3)', async () => {
    const logger = makeLogger();
    const { sleep, delays } = makeSleep();

    // Fail the first two attempts, then succeed.
    let attempts = 0;
    const fn = vi.fn(() => {
      attempts += 1;
      if (attempts < 3) {
        return Promise.reject(new Error('rate limited'));
      }
      return Promise.resolve('ok');
    });

    // Signal a fixed 250ms for the first failure and a huge interval for the
    // second so we can prove the cap at maxMs (1000ms) is applied.
    const computeDelay = vi.fn((attempt: number): number | null => {
      if (attempt === 1) {
        return 250;
      }
      return 999_999;
    });

    const result = await withBackoff(fn, OPTS, logger, computeDelay, sleep);

    expect(result).toBe('ok');
    // The signaled value is used verbatim, then capped at maxMs.
    expect(delays).toEqual([250, OPTS.maxMs]);
    expect(computeDelay).toHaveBeenCalledTimes(2);
  });

  it('falls back to exponential-with-jitter when computeDelay returns null (Req 12.3)', async () => {
    const logger = makeLogger();
    const { sleep, delays } = makeSleep();

    // Fail four times, succeed on the fifth (the last allowed attempt).
    let attempts = 0;
    const fn = vi.fn(() => {
      attempts += 1;
      if (attempts < 5) {
        return Promise.reject(new Error('down'));
      }
      return Promise.resolve('ok');
    });

    // Always defer to the computed backoff path.
    const computeDelay = vi.fn((): number | null => null);

    const result = await withBackoff(fn, OPTS, logger, computeDelay, sleep);

    expect(result).toBe('ok');

    // Four retries → four recorded delays, each within [0, min(base*2^(n-1), maxMs)].
    expect(delays).toHaveLength(4);
    delays.forEach((delay, idx) => {
      const attempt = idx + 1;
      const cap = Math.min(OPTS.baseMs * 2 ** (attempt - 1), OPTS.maxMs);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(cap);
    });

    // With Math.random pinned to 1 the jitter resolves to the cap exactly:
    // 100, 200, 400, 800 — all under maxMs (1000), so none is clamped.
    expect(delays).toEqual([100, 200, 400, 800]);
  });

  it('throws the last error after exactly maxAttempts without crashing (Req 12.5)', async () => {
    const logger = makeLogger();
    const { sleep } = makeSleep();

    // Every attempt fails; the final rejection carries a distinct message.
    let attempts = 0;
    const fn = vi.fn(() => {
      attempts += 1;
      return Promise.reject(new Error(`fail ${attempts}`));
    });

    await expect(withBackoff(fn, OPTS, logger, undefined, sleep)).rejects.toThrow(
      `fail ${OPTS.maxAttempts}`,
    );

    // Exactly maxAttempts tries were made — no more, no fewer.
    expect(fn).toHaveBeenCalledTimes(OPTS.maxAttempts);
    expect(attempts).toBe(OPTS.maxAttempts);
    // One error log per retry: maxAttempts - 1 (the final failure is thrown, not retried).
    expect(logger.error).toHaveBeenCalledTimes(OPTS.maxAttempts - 1);
  });

  it('does not sleep or log when the operation succeeds on the first attempt', async () => {
    const logger = makeLogger();
    const { sleep, delays } = makeSleep();

    const fn = vi.fn(() => Promise.resolve(42));

    const result = await withBackoff(fn, OPTS, logger, undefined, sleep);

    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
    expect(sleep).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
