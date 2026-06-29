/**
 * Telegram connector (Component H) — Req 6.1, 6.2, 6.3, 6.5, 6.6, 12.1, 12.3, 13.1.
 *
 * Makes the `telegram` channel operative end-to-end over the free Telegram Bot
 * API using grammY (Req 13.1). The connector is transport-only: it normalizes
 * each inbound Telegram text update into an {@link InboundMessage} and hands it
 * to the router-supplied `onInbound` callback, and it delivers replies via
 * `sendMessage`. All channel-agnostic concerns (allowlist, idempotency,
 * quiet-hours deferral, persistence) live in the InboundRouter, not here.
 *
 * The grammY `Bot` is reached only through a narrow injectable
 * {@link TelegramBot} transport interface capturing exactly the operations we
 * use. Tests inject a mock transport via `botFactory` so no real network I/O is
 * ever performed; the default {@link defaultBotFactory} adapts a real grammY
 * `Bot` to that interface and is the only grammY-specific code in the module.
 *
 * Security note (Req 4.4, 14.3): the Bot_Token is read from the environment by
 * the caller and passed in as `botToken`. It is used solely to construct the
 * transport and is NEVER written to any log entry.
 */

import { Bot } from 'grammy';
import type { Logger } from '../types.js';
import type { RozaProfile } from '../profile.js';
import {
  type BackoffOptions,
  type ChannelConnector,
  type InboundMessage,
  type OutboundReply,
  withBackoff,
} from './connector.js';

/**
 * The minimal Telegram transport the connector depends on — only the four
 * operations we actually use. Keeping the surface this small lets tests inject
 * a mock without any real network, and isolates all grammY-specific wiring in
 * {@link defaultBotFactory}.
 */
export interface TelegramBot {
  /**
   * Register the handler invoked for each inbound text message. The transport
   * is responsible for firing this only on text updates (non-text updates are
   * ignored, Req 6.6).
   */
  onText(
    handler: (msg: { messageId: string | number; chatId: string | number; text: string }) => Promise<void>,
  ): void;
  /** Begin receiving updates (long-polling). */
  start(): Promise<void>;
  /** Stop receiving updates and release transport resources. */
  stop(): Promise<void>;
  /** Send a text message to the given chat. */
  sendMessage(chatId: string | number, text: string): Promise<void>;
}

/** A factory that builds a {@link TelegramBot} transport from a bot token. */
export type TelegramBotFactory = (token: string) => TelegramBot;

/** Dependencies for {@link createTelegramConnector}. */
export interface TelegramConnectorDeps {
  /** Bot_Token from the environment; used only to build the transport, never logged. */
  botToken: string;
  /** Accessor for the currently-loaded profile (drives the presented identity). */
  profile: () => RozaProfile;
  /** Structured logger; must never receive the Bot_Token. */
  logger: Logger;
  /** Retry/backoff tuning for outbound sends (Req 12.1, 12.3). */
  backoff: BackoffOptions;
  /** Injectable transport factory; defaults to the real grammY adapter. */
  botFactory?: TelegramBotFactory;
}

/**
 * Read a Telegram-signaled `retry_after` (seconds) from a rejected send error
 * and convert it to milliseconds, defensively (Req 12.3).
 *
 * grammY surfaces a `429` as a `GrammyError` whose `parameters.retry_after`
 * carries the server-indicated wait in seconds. We read it structurally rather
 * than by type so any error shape exposing the same field is honored, and fall
 * back to the exponential backoff (by returning `null`) when it is absent or
 * not a finite non-negative number.
 */
function retryAfterMs(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) {
    return null;
  }
  const params = (err as { parameters?: unknown }).parameters;
  if (typeof params !== 'object' || params === null) {
    return null;
  }
  const retryAfter = (params as { retry_after?: unknown }).retry_after;
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return retryAfter * 1000;
  }
  return null;
}

/**
 * Default {@link TelegramBotFactory}: adapt a real grammY `Bot` to the narrow
 * {@link TelegramBot} transport. This is the only grammY-specific code in the
 * module, deliberately kept minimal.
 */
export function defaultBotFactory(token: string): TelegramBot {
  const bot = new Bot(token);
  return {
    onText(handler) {
      // grammY fires `message:text` only for text messages, so non-text
      // attachments (voice, video, documents) are ignored (Req 6.6).
      bot.on('message:text', async (ctx) => {
        await handler({
          messageId: ctx.message.message_id,
          chatId: ctx.chat.id,
          text: ctx.message.text,
        });
      });
    },
    start() {
      return bot.start();
    },
    stop() {
      return bot.stop();
    },
    sendMessage(chatId, text) {
      return bot.api.sendMessage(chatId, text).then(() => undefined);
    },
  };
}

/**
 * Create the Telegram {@link ChannelConnector} (Req 6.1–6.6).
 *
 * - `start(onInbound)` builds the transport from `botToken`, registers a
 *   text-only handler that normalizes each update into an {@link InboundMessage}
 *   and awaits `onInbound(msg)`, then begins long-polling. The Bot_Token is
 *   never logged.
 * - `sendReply(reply)` delivers via the transport's `sendMessage`, wrapped in
 *   {@link withBackoff} and honoring a Telegram `429` `retry_after` when present
 *   (Req 12.1, 12.3).
 * - `stop()` stops the transport.
 */
export function createTelegramConnector(deps: TelegramConnectorDeps): ChannelConnector {
  const { botToken, logger, backoff } = deps;
  const botFactory = deps.botFactory ?? defaultBotFactory;
  let bot: TelegramBot | null = null;

  return {
    channel: 'telegram',

    async start(onInbound: (msg: InboundMessage) => Promise<void>): Promise<void> {
      const transport = botFactory(botToken);
      bot = transport;

      transport.onText(async ({ messageId, chatId, text }) => {
        const senderId = String(chatId);
        const msg: InboundMessage = {
          channel: 'telegram',
          externalId: `${chatId}:${messageId}`,
          senderId,
          text,
          threadRef: senderId,
          receivedAt: new Date().toISOString(),
        };
        await onInbound(msg);
      });

      logger.info('telegram connector starting', { channel: 'telegram' });
      await transport.start();
    },

    async sendReply(reply: OutboundReply): Promise<void> {
      const transport = bot;
      if (transport === null) {
        throw new Error('telegram connector not started');
      }
      await withBackoff(
        () => transport.sendMessage(reply.to, reply.text),
        backoff,
        logger,
        (_attempt, err) => retryAfterMs(err),
      );
    },

    async stop(): Promise<void> {
      const transport = bot;
      if (transport === null) {
        return;
      }
      await transport.stop();
      bot = null;
      logger.info('telegram connector stopped', { channel: 'telegram' });
    },
  };
}
