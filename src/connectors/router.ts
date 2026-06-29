/**
 * InboundRouter (Component F) — Req 8, 9, 10, 11, 12, 14.
 *
 * The channel-agnostic heart of the connector layer. Every inbound message from
 * any connector (Telegram or Mail) passes through the same ordered gates, so
 * all correctness properties hold identically regardless of transport and the
 * Cognitive_Engine stays transport-blind. A connector knows only how to talk to
 * its transport; the router owns allowlist enforcement, idempotency, the Right
 * to Disconnect (quiet-hours deferral), Sender_Mapping, and reply delivery.
 *
 * The ordered gates of {@link InboundRouter.handleInbound} (Req 9, 10, 11):
 *   1. ALLOWLIST   — reject a non-allowed sender BEFORE any engine call or DB
 *                    mutation (Req 9.2, 9.4, 14.5).
 *   2. IDEMPOTENCY — an already-sent reply is never re-sent; an answered-but-
 *                    unsent reply is re-delivered WITHOUT a new LLM call
 *                    (Req 11.1–11.5).
 *   3. RIGHT TO DISCONNECT — a message arriving in Quiet_Hours is durably
 *                    deferred to the inbound queue, never processed immediately
 *                    (Req 10.1, 10.2, 10.4).
 *   4. PROCESS NOW — map the sender to a `user_id`, run the Memory_Loop, store
 *                    the reply BEFORE delivery, deliver with bounded retry, then
 *                    mark it sent (Req 8, 11.3, 12.4, 12.5).
 *
 * Security note (Req 14.1–14.5): `msg.text` is untrusted data — it is only ever
 * passed to the engine as the user message, never interpreted as a command,
 * config change, or path. Replies are built solely from the engine's reply
 * string, and every log entry carries identifiers and reasons only, never a
 * Channel_Credential.
 */

import type { Logger } from '../types.js';
import type { CognitiveEngine } from '../engine.js';
import type { RozaConfig } from '../config.js';
import { type ActiveWindow, isWithinActiveWindow, minutesInTimezone } from '../window.js';
import {
  type BackoffOptions,
  type ChannelConnector,
  type InboundMessage,
  type OperativeChannel,
  type OutboundReply,
  withBackoff,
} from './connector.js';
import type { InboundQueueStore } from './queue.js';
import { normalizeEmail, normalizeTelegramId, userIdForEmail, userIdForTelegram } from './sender.js';

/** Constructor dependencies for the {@link InboundRouter}. */
export interface InboundRouterDeps {
  /** The Cognitive_Engine; its `handleMessage` runs the Phase 1 Memory_Loop. */
  engine: CognitiveEngine;
  /** Durable inbound queue + idempotency store (`queue.ts`). */
  queue: InboundQueueStore;
  /** Resolved configuration, including the per-channel allowlists (Req 9). */
  cfg: RozaConfig;
  /** Active_Window the Right to Disconnect gate checks against (Req 10). */
  window: ActiveWindow;
  /** IANA timezone used to render `now()` to minutes-since-midnight. */
  timezone: string;
  /** Clock accessor; injectable so tests run deterministically. */
  now: () => Date;
  /** The connectors keyed by channel, used to deliver replies. */
  connectors: Map<OperativeChannel, ChannelConnector>;
  /** Structured logger; only identifiers/reasons are ever logged (Req 14.3). */
  logger: Logger;
}

/**
 * Bounded retry/backoff tuning for outbound delivery (Req 12.3, 12.5). A small
 * exponential window keeps a transient transport fault from blocking the router
 * while still surfacing exhaustion so the reply is retained unsent (Req 12.5).
 */
const DELIVERY_BACKOFF: BackoffOptions = { baseMs: 200, maxMs: 5000, maxAttempts: 5 };

/**
 * The channel-agnostic inbound router. Construct it once with its dependencies
 * and pass {@link InboundRouter.handleInbound} as the `onInbound` callback to
 * every connector's `start()`; the scheduler calls
 * {@link InboundRouter.drainQueue} on entry to the Active_Window.
 */
export class InboundRouter {
  private readonly engine: CognitiveEngine;
  private readonly queue: InboundQueueStore;
  private readonly cfg: RozaConfig;
  private readonly window: ActiveWindow;
  private readonly timezone: string;
  private readonly now: () => Date;
  private readonly connectors: Map<OperativeChannel, ChannelConnector>;
  private readonly logger: Logger;

  constructor(deps: InboundRouterDeps) {
    this.engine = deps.engine;
    this.queue = deps.queue;
    this.cfg = deps.cfg;
    this.window = deps.window;
    this.timezone = deps.timezone;
    this.now = deps.now;
    this.connectors = deps.connectors;
    this.logger = deps.logger;
  }

  /**
   * The `onInbound` callback handed to every connector's `start()`. Runs the
   * ordered gates and either rejects, replays, defers, or processes the message.
   */
  async handleInbound(msg: InboundMessage): Promise<void> {
    // GATE 1 — Allowlist BEFORE any engine processing or DB mutation
    // (Req 9.2, 9.4, 14.5).
    if (!this.isAllowed(msg.channel, msg.senderId)) {
      this.logger.error('inbound rejected by allowlist', {
        channel: msg.channel,
        sender: msg.senderId,
      });
      return; // no engine call, no DB mutation (Req 9.4)
    }

    // GATE 2 — Idempotency (Req 11).
    const state = this.queue.lookup(msg.channel, msg.externalId);
    if (state === 'answered_sent') {
      // A reply was already delivered — never reply twice (Req 11.1–11.4).
      return;
    }
    if (state === 'answered_unsent') {
      // A reply was generated but not yet delivered: re-send the stored reply
      // WITHOUT re-invoking the LLM (Req 11.5).
      const replyText = this.queue.getStoredReply(msg.channel, msg.externalId);
      if (replyText === null) {
        // No retained reply despite the unsent marker: nothing to replay.
        return;
      }
      const reply = this.buildReply(msg, replyText);
      try {
        await this.deliverWithRetry(reply);
        this.queue.markSent(msg.channel, msg.externalId);
      } catch {
        // Delivery still failing: leave it answered_unsent for a later retry.
        this.logger.error('resend exhausted retries; reply retained unsent', {
          channel: msg.channel,
          externalId: msg.externalId,
        });
      }
      return;
    }

    // GATE 3 — Right to disconnect (Req 10). Outside the Active_Window the
    // message is durably deferred, never processed immediately (Req 10.1, 10.2).
    const nowMinutes = minutesInTimezone(this.now(), this.timezone);
    if (!isWithinActiveWindow(nowMinutes, this.window)) {
      this.queue.enqueue(msg); // durable defer (Req 10.2, 10.4)
      return;
    }

    // GATE 4 — Process now.
    await this.processNow(msg);
  }

  /**
   * Drain deferred messages in receipt order on Active_Window entry (Req 10.3).
   * Each dequeued message runs the same {@link processNow} path, FIFO by
   * `received_at` then insertion order.
   */
  async drainQueue(): Promise<void> {
    const messages = this.queue.dequeueInReceiptOrder();
    for (const msg of messages) {
      await this.processNow(msg);
    }
  }

  /**
   * Run the Memory_Loop for one message and deliver its reply (also used per
   * dequeued message by {@link drainQueue}).
   *
   * On engine error nothing is sent and no idempotency state is written, so the
   * message stays retry-eligible (Req 12.4). On success the reply is stored as
   * `answered_unsent` BEFORE delivery (Req 11.3, 11.5); delivery is retried with
   * bounded backoff (Req 12.3) and marked sent on success, or retained unsent on
   * exhaustion so it is re-delivered later without a new LLM call (Req 12.5).
   */
  private async processNow(msg: InboundMessage): Promise<void> {
    const userId =
      msg.channel === 'telegram' ? userIdForTelegram(msg.senderId) : userIdForEmail(msg.senderId);

    // `msg.text` is untrusted: it is only ever passed as the user message into
    // the Memory_Loop, never interpreted as a command (Req 14.1).
    const res = await this.engine.handleMessage({ userId, channel: msg.channel, text: msg.text });
    if (!res.ok) {
      // Engine error: send nothing, mutate no idempotency state, stay
      // retry-eligible (Req 12.4).
      this.logger.error('engine returned error; leaving message eligible', {
        channel: msg.channel,
        externalId: msg.externalId,
        reason: res.reason,
      });
      return;
    }

    const reply = this.buildReply(msg, res.reply);
    // Store the reply BEFORE attempting delivery so a crash or send failure
    // leaves it answered_unsent for a later resend (Req 11.3, 11.5).
    this.queue.recordAnswered(msg.channel, msg.externalId, reply.text);
    try {
      await this.deliverWithRetry(reply);
      this.queue.markSent(msg.channel, msg.externalId);
    } catch {
      // Retries exhausted: retain as answered_unsent → resent later without a
      // new LLM call (Req 11.5, 12.5).
      this.logger.error('send exhausted retries; reply retained unsent', {
        channel: msg.channel,
        externalId: msg.externalId,
      });
    }
  }

  /**
   * Decide whether a sender is allowed on a channel (Req 9.2, 9.3).
   *
   * The documented default is allow-all for an enabled channel that has no
   * configured allowlist (Req 9.3); the rejection path is active only once an
   * allowlist is present. Comparison is canonicalized per channel so a sender's
   * identity matches its allowlist entry regardless of incidental case or
   * whitespace (telegram: trimmed id; email: trimmed, lowercased address).
   */
  private isAllowed(channel: OperativeChannel, senderId: string): boolean {
    if (channel === 'telegram') {
      const allowlist = this.cfg.telegram.allowlist;
      if (allowlist.length === 0) {
        return true; // allow-all default (Req 9.3)
      }
      const sender = normalizeTelegramId(senderId);
      return allowlist.some((entry) => normalizeTelegramId(entry) === sender);
    }

    const allowlist = this.cfg.mail.allowlist;
    if (allowlist.length === 0) {
      return true; // allow-all default (Req 9.3)
    }
    const sender = normalizeEmail(senderId);
    return allowlist.some((entry) => normalizeEmail(entry) === sender);
  }

  /**
   * Build the {@link OutboundReply} for a message. The reply target is the
   * originating sender (the Telegram chat id, or the email From address), and
   * the threading reference is carried through verbatim (Req 7.5). Under
   * `exactOptionalPropertyTypes`, `threadRef` is attached only when present so
   * the optional key is genuinely absent rather than `undefined`.
   */
  private buildReply(msg: InboundMessage, text: string): OutboundReply {
    const reply: OutboundReply = {
      channel: msg.channel,
      to: msg.senderId,
      text,
    };
    if (msg.threadRef !== undefined) {
      reply.threadRef = msg.threadRef;
    }
    return reply;
  }

  /**
   * Deliver a reply on its originating channel with bounded retry/backoff
   * (Req 12.3, 12.5). Looks up the connector by `reply.channel` and calls its
   * `sendReply` inside {@link withBackoff}; exhausting the retry budget throws
   * so the caller retains the reply as `answered_unsent` for a later resend
   * (Req 12.5). A missing connector (mis-wired channel) is surfaced as a thrown
   * error the caller treats as a delivery failure.
   */
  private async deliverWithRetry(reply: OutboundReply): Promise<void> {
    const connector = this.connectors.get(reply.channel);
    if (connector === undefined) {
      throw new Error(`no connector registered for channel ${reply.channel}`);
    }
    await withBackoff(() => connector.sendReply(reply), DELIVERY_BACKOFF, this.logger);
  }
}
