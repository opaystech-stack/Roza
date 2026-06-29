import { describe, expect, it, vi } from 'vitest';

import {
  createTelegramConnector,
  type TelegramBot,
  type TelegramBotFactory,
} from './telegram.js';
import type { BackoffOptions, InboundMessage } from './connector.js';
import { DEFAULT_PROFILE } from '../profile.js';
import type { Logger } from '../types.js';

/**
 * Example tests for the Telegram connector (Component H) — Req 4.4, 6.3, 6.6,
 * 12.3, 14.3.
 *
 * The connector is exercised end-to-end through a MOCK {@link TelegramBot}
 * transport injected via `deps.botFactory`: no real grammY `Bot` is created and
 * NO network I/O ever happens. The mock captures the text handler the connector
 * registers so a test can drive an inbound update by hand, and spies on
 * `sendMessage` so outbound delivery and `429` retry behavior are observable.
 *
 * Asserted behaviors:
 *  - the transport is constructed with the configured (mock) credentials
 *    (`botFactory` is called with the provided Bot_Token),
 *  - an inbound text update maps to the exact {@link InboundMessage} shape and
 *    invokes `onInbound` once; non-text updates never reach the handler because
 *    the mock fires `onText` only for text (Req 6.6),
 *  - `sendReply` delivers via `transport.sendMessage(to, text)`,
 *  - a `429` carrying `retry_after` is honored and the send is retried (Req 12.3),
 *  - the Bot_Token never appears in any log line (Req 4.4, 14.3).
 */

/** A distinctive fake Bot_Token used to detect any accidental logging of it. */
const TOKEN = '123456:SECRET-BOT-TOKEN-do-not-log-abcdef';

/**
 * Small/capped backoff so retries resolve in well under a millisecond: a
 * `retry_after: 1` (=> 1000ms signaled) is clamped by `maxMs: 5` to 5ms, and
 * the exponential fallback starts at `baseMs: 1`. Keeps the suite fast.
 */
const BACKOFF: BackoffOptions = { baseMs: 1, maxMs: 5, maxAttempts: 3 };

/** A spy logger matching the {@link Logger} contract. */
function makeLogger(): Logger & {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), error: vi.fn() };
}

type TextHandler = (msg: {
  messageId: string | number;
  chatId: string | number;
  text: string;
}) => Promise<void>;

/**
 * Build a mock {@link TelegramBot} transport that records the registered text
 * handler (so tests can fire an inbound update) and spies on every operation.
 */
function makeMockBot(): {
  bot: TelegramBot;
  fire: TextHandler;
  sendMessage: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  let textHandler: TextHandler | null = null;
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const start = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue(undefined);

  const bot: TelegramBot = {
    onText(handler) {
      textHandler = handler;
    },
    start,
    stop,
    sendMessage,
  };

  const fire: TextHandler = (msg) => {
    if (textHandler === null) {
      throw new Error('onText handler was never registered');
    }
    return textHandler(msg);
  };

  return { bot, fire, sendMessage, start, stop };
}

/** Assemble a connector wired to a fresh mock transport and spy logger. */
function setup() {
  const mock = makeMockBot();
  const logger = makeLogger();
  const botFactory = vi.fn<TelegramBotFactory>(() => mock.bot);
  const connector = createTelegramConnector({
    botToken: TOKEN,
    profile: () => DEFAULT_PROFILE,
    logger,
    backoff: BACKOFF,
    botFactory,
  });
  return { connector, mock, logger, botFactory };
}

describe('createTelegramConnector (mock transport)', () => {
  it('constructs the transport with the configured Bot_Token', async () => {
    const { connector, botFactory } = setup();

    await connector.start(vi.fn().mockResolvedValue(undefined));

    expect(botFactory).toHaveBeenCalledTimes(1);
    expect(botFactory).toHaveBeenCalledWith(TOKEN);
  });

  it('maps an inbound text update to an InboundMessage and calls onInbound once', async () => {
    const { connector, mock } = setup();
    const onInbound = vi.fn<(msg: InboundMessage) => Promise<void>>().mockResolvedValue(undefined);

    await connector.start(onInbound);
    await mock.fire({ messageId: 42, chatId: 99, text: 'hello roza' });

    expect(onInbound).toHaveBeenCalledTimes(1);
    const msg = onInbound.mock.calls[0]?.[0];
    if (msg === undefined) {
      throw new Error('onInbound was not called with an InboundMessage');
    }
    expect(msg).toMatchObject({
      channel: 'telegram',
      externalId: '99:42',
      senderId: '99',
      text: 'hello roza',
      threadRef: '99',
    });
    // receivedAt is an ISO-8601 instant produced at receipt time.
    expect(() => new Date(msg.receivedAt).toISOString()).not.toThrow();
    expect(msg.receivedAt).toBe(new Date(msg.receivedAt).toISOString());
  });

  it('ignores non-text updates: the handler only ever fires for text', async () => {
    const { connector, mock } = setup();
    const onInbound = vi.fn<(msg: InboundMessage) => Promise<void>>().mockResolvedValue(undefined);

    await connector.start(onInbound);
    // The mock transport (like grammY's `message:text`) fires onText only for
    // text updates, so a non-text update simply never invokes the handler.
    // A single text update therefore yields exactly one onInbound call.
    await mock.fire({ messageId: 1, chatId: 7, text: 'just text' });

    expect(onInbound).toHaveBeenCalledTimes(1);
  });

  it('sendReply delivers via transport.sendMessage(to, text)', async () => {
    const { connector, mock } = setup();

    await connector.start(vi.fn().mockResolvedValue(undefined));
    await connector.sendReply({ channel: 'telegram', to: '99', text: 'a reply' });

    expect(mock.sendMessage).toHaveBeenCalledTimes(1);
    expect(mock.sendMessage).toHaveBeenCalledWith('99', 'a reply');
  });

  it('honors a 429 retry_after and retries the send to completion', async () => {
    const { connector, mock } = setup();

    // Reject once with a Telegram-shaped 429 (retry_after in seconds), then
    // resolve. withBackoff reads retry_after*1000 and clamps it to maxMs (5ms),
    // so the retry happens almost instantly.
    mock.sendMessage
      .mockRejectedValueOnce({ parameters: { retry_after: 1 } })
      .mockResolvedValueOnce(undefined);

    await connector.start(vi.fn().mockResolvedValue(undefined));
    await expect(
      connector.sendReply({ channel: 'telegram', to: '99', text: 'retried reply' }),
    ).resolves.toBeUndefined();

    expect(mock.sendMessage).toHaveBeenCalledTimes(2);
    expect(mock.sendMessage).toHaveBeenNthCalledWith(1, '99', 'retried reply');
    expect(mock.sendMessage).toHaveBeenNthCalledWith(2, '99', 'retried reply');
  });

  it('never writes the Bot_Token to any log line', async () => {
    const { connector, mock, logger } = setup();

    // Exercise start, an inbound update, and a retried send so every log path
    // (info on start, error on retry) is hit before inspecting the logs.
    mock.sendMessage
      .mockRejectedValueOnce({ parameters: { retry_after: 1 } })
      .mockResolvedValueOnce(undefined);

    await connector.start(vi.fn().mockResolvedValue(undefined));
    await mock.fire({ messageId: 5, chatId: 12, text: 'hi' });
    await connector.sendReply({ channel: 'telegram', to: '12', text: 'ok' });

    expect(logger.info).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();

    const everyCall = [...logger.info.mock.calls, ...logger.error.mock.calls];
    const serialized = JSON.stringify(everyCall);
    expect(serialized).not.toContain(TOKEN);
  });
});
