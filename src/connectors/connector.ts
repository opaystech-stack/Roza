/**
 * ChannelConnector abstraction (Component E) — Req 5, 6, 7, 12.
 *
 * One transport-agnostic contract so the Telegram and Mail connectors are
 * pluggable and fault-isolated behind a single interface. A connector knows
 * only how to talk to its own transport (Telegram Bot API, IMAP/SMTP); it never
 * touches the Cognitive_Engine or the Roza_Mind_Database directly. Everything
 * channel-agnostic — allowlist enforcement, idempotency, quiet-hours deferral,
 * sender mapping, and persistence — lives in the shared InboundRouter, so both
 * channels share one correctness story and the engine stays transport-blind.
 *
 * This module also defines the normalized message shapes exchanged between a
 * connector and the router ({@link InboundMessage} / {@link OutboundReply}),
 * the shared {@link withBackoff} retry helper used to survive transient network
 * faults and rate limits (Req 12.1, 12.3, 12.5), and the pure channel-identity
 * derivations that read straight off the loaded Roza_Profile (Req 3.2, 3.3).
 *
 * Security note: connectors and the router must never log a Channel_Credential
 * (Req 4.4, 14.3); {@link withBackoff} logs only attempt counts and error
 * messages, never the work being attempted.
 */

import type { Logger } from '../types.js';
import type { RozaProfile } from '../profile.js';

/**
 * The channels made operative in Phase 2 (Req 15.1). `voice` and the Phase 1
 * `internal` channel are intentionally excluded here: this type names only the
 * channels a {@link ChannelConnector} can serve.
 */
export type OperativeChannel = 'telegram' | 'email';

/**
 * A normalized inbound message handed from a connector to the router.
 *
 * The connector is responsible for reducing its transport-specific payload to
 * this transport-agnostic shape — in particular the mail connector flattens an
 * HTML-only body to plain text before constructing one of these (Req 7.6).
 */
export interface InboundMessage {
  /** Originating operative channel. */
  channel: OperativeChannel;
  /**
   * Stable per-message identifier used for idempotency (Req 11): the Telegram
   * update/message id, or the email `Message-ID`.
   */
  externalId: string;
  /** Raw channel identifier of the sender: chat/user id, or `From` address. */
  senderId: string;
  /** Plain-text message body (mail HTML→text already done by the connector). */
  text: string;
  /**
   * Reply-threading reference: the email `Message-ID` (for `In-Reply-To` /
   * `References`) or the Telegram chat id (Req 7.5).
   */
  threadRef?: string;
  /** ISO-8601 receipt instant, used for FIFO queue ordering (Req 10.3). */
  receivedAt: string;
}

/** A reply to deliver on the originating channel. */
export interface OutboundReply {
  /** Channel the reply must be delivered on (matches the inbound channel). */
  channel: OperativeChannel;
  /** Delivery target: chat id, or recipient email address. */
  to: string;
  /** Reply body produced by the Cognitive_Engine. */
  text: string;
  /** Threading reference; sets `In-Reply-To`/`References` for mail (Req 7.5). */
  threadRef?: string;
}

/**
 * The pluggable connector contract. Both the Telegram and Mail connectors
 * implement it, and the optional GramJS connector may implement it too.
 */
export interface ChannelConnector {
  /** The channel this connector serves. */
  readonly channel: OperativeChannel;
  /**
   * Begin receiving. Each inbound message is normalized and pushed to the
   * provided callback (the router's `handleInbound`). Resolves once the
   * transport is listening.
   */
  start(onInbound: (msg: InboundMessage) => Promise<void>): Promise<void>;
  /** Stop receiving and release transport resources. */
  stop(): Promise<void>;
  /** Deliver a reply; resolves on success, rejects on a (retryable) failure. */
  sendReply(reply: OutboundReply): Promise<void>;
}

/** Tuning for {@link withBackoff}. */
export interface BackoffOptions {
  /** Base delay in milliseconds for the first retry. */
  baseMs: number;
  /** Upper bound applied to every computed delay, in milliseconds. */
  maxMs: number;
  /** Total number of attempts before giving up (must be at least 1). */
  maxAttempts: number;
}

/** Pause for `ms` milliseconds; the default real-timer implementation. */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Run `fn`, retrying with exponential backoff and jitter on failure
 * (Req 12.1, 12.3, 12.5).
 *
 * Behavior:
 * - Attempts `fn` up to `opts.maxAttempts` times.
 * - On each failure (before another attempt remains) it logs the failed
 *   attempt — message and attempt count only, never the work or any
 *   credential — and waits before retrying.
 * - The wait is exponential (`baseMs * 2^(attempt-1)`) capped at `maxMs`, with
 *   uniform jitter applied across the computed delay to avoid thundering-herd
 *   reconnects.
 * - When a caller can extract a transport-signaled retry interval (e.g. a
 *   Telegram `429` `retry_after`, or an SMTP rate-limit hint), it may pass
 *   `computeDelay`; returning a non-null number overrides the computed backoff
 *   for that attempt (honoring the indicated interval per Req 12.3), while
 *   returning `null` falls back to the exponential-with-jitter delay.
 * - After the final attempt fails it throws the last error rather than
 *   crashing the surrounding loop, so the caller (connector/router) can keep
 *   the rest of the service running and retain the work for a later retry.
 *
 * `sleep` is injectable so tests run instantly without real timers.
 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts: BackoffOptions,
  logger: Logger,
  computeDelay?: (attempt: number, err: unknown) => number | null,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts));
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // No attempts left: surface the failure to the caller.
      if (attempt >= maxAttempts) {
        break;
      }

      // Prefer a transport-signaled retry interval when the caller supplies one.
      const signaled = computeDelay ? computeDelay(attempt, err) : null;
      let delayMs: number;
      if (signaled !== null && signaled !== undefined && Number.isFinite(signaled) && signaled >= 0) {
        delayMs = Math.min(signaled, opts.maxMs);
      } else {
        const exponential = Math.min(opts.baseMs * 2 ** (attempt - 1), opts.maxMs);
        // Uniform jitter across [0, exponential] keeps reconnects desynchronized.
        delayMs = Math.random() * exponential;
      }

      logger.error('operation failed; retrying after backoff', {
        attempt,
        maxAttempts,
        delayMs: Math.round(delayMs),
        error: err instanceof Error ? err.message : String(err),
      });

      await sleep(delayMs);
    }
  }

  throw lastError;
}

/**
 * Telegram sender identity Roza presents, derived purely from the loaded
 * profile (Req 3.2).
 */
export function telegramSenderIdentity(p: RozaProfile): string {
  return p.telegramIdentity;
}

/**
 * Mail sender identity Roza presents, derived purely from the loaded profile
 * (Req 3.3).
 */
export function mailSenderIdentity(p: RozaProfile): string {
  return p.emailIdentity;
}
