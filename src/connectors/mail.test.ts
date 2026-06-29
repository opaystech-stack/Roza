import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import {
  createMailConnector,
  toPlainText,
  type ImapCredentials,
  type MailReader,
  type MailReaderFactory,
  type MailSender,
  type MailSenderFactory,
  type RawInboundMail,
  type SmtpCredentials,
} from './mail.js';
import type { BackoffOptions, InboundMessage } from './connector.js';
import { DEFAULT_PROFILE } from '../profile.js';
import type { Logger } from '../types.js';

/**
 * Mail connector tests (Component I) — Req 4.4, 7.3, 7.5, 7.6, 7.7, 14.3.
 *
 * The connector is exercised end-to-end through MOCK transports injected via
 * `deps.readerFactory` / `deps.senderFactory`: no real `ImapFlow`,
 * `nodemailer`, or `simpleParser` is ever constructed, and NO network I/O ever
 * happens. The pure {@link toPlainText} helper is tested directly.
 *
 * Property 16 (9.3) — `toPlainText` reduces any parsed email to a non-empty
 * plain-text body: a non-empty text part is returned verbatim (trailing
 * whitespace trimmed) and an HTML-only body is flattened to a non-empty,
 * tag-free representation; the function is total (never throws).
 *
 * Property 17 (9.4) — a reply built for an inbound bearing a Message-ID sets
 * `from` to the profile email identity and sets both `In-Reply-To` and
 * `References` to the thread ref.
 *
 * Example 9.5 — the connector constructs its transports with the configured
 * (mock) credentials, marks a submitted message `\Seen` only AFTER a successful
 * hand-off to the router, and never writes a mailbox credential to any log line.
 */

/** Minimum fast-check iterations mandated for the property tests. */
const RUNS = 100;

/**
 * Small/capped backoff so any retry resolves in well under a millisecond and
 * the suite stays fast. With healthy mocks `withBackoff` succeeds first try.
 */
const BACKOFF: BackoffOptions = { baseMs: 1, maxMs: 5, maxAttempts: 3 };

/** Distinctive fake credentials used to detect any accidental logging. */
const IMAP_CREDS: ImapCredentials = {
  host: 'imap.example.test',
  port: 993,
  user: 'roza-imap-user',
  password: 'IMAP-SECRET-PASSWORD-do-not-log-1234',
};
const SMTP_CREDS: SmtpCredentials = {
  host: 'smtp.example.test',
  port: 465,
  user: 'roza-smtp-user',
  password: 'SMTP-SECRET-PASSWORD-do-not-log-5678',
};

/** A spy logger matching the {@link Logger} contract. */
function makeLogger(): Logger & {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), error: vi.fn() };
}

type OnMessage = (raw: RawInboundMail) => Promise<void>;

/**
 * Build a mock {@link MailReader} that records the registered `onMessage`
 * callback (so a test can drive an inbound mail by hand) and spies on every
 * operation. `fire` invokes the captured callback exactly as the real reader
 * would for a newly-arrived message.
 */
function makeMockReader(): {
  reader: MailReader;
  fire: OnMessage;
  start: ReturnType<typeof vi.fn>;
  markSeen: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  let onMessage: OnMessage | null = null;
  const start = vi.fn(async (cb: OnMessage) => {
    onMessage = cb;
  });
  const markSeen = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue(undefined);

  const reader: MailReader = {
    start,
    markSeen,
    stop,
  };

  const fire: OnMessage = (raw) => {
    if (onMessage === null) {
      throw new Error('reader.start was never called to register onMessage');
    }
    return onMessage(raw);
  };

  return { reader, fire, start, markSeen, stop };
}

/** Build a mock {@link MailSender} spying on `send`. */
function makeMockSender(): {
  sender: MailSender;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockResolvedValue(undefined);
  const sender: MailSender = { send };
  return { sender, send };
}

/** Assemble a connector wired to fresh mock transports and a spy logger. */
function setup() {
  const mockReader = makeMockReader();
  const mockSender = makeMockSender();
  const logger = makeLogger();
  const readerFactory = vi.fn<MailReaderFactory>(() => mockReader.reader);
  const senderFactory = vi.fn<MailSenderFactory>(() => mockSender.sender);

  const connector = createMailConnector({
    imap: IMAP_CREDS,
    smtp: SMTP_CREDS,
    profile: () => DEFAULT_PROFILE,
    logger,
    backoff: BACKOFF,
    readerFactory,
    senderFactory,
  });

  return { connector, mockReader, mockSender, logger, readerFactory, senderFactory };
}

// ---------------------------------------------------------------------------
// Property 16 (9.3)
// ---------------------------------------------------------------------------

// Feature: roza-step2-channels, Property 16: Inbound email is reduced to a non-empty plain-text body
// Validates: Requirements 7.6
describe('Property 16: inbound email reduces to a non-empty plain-text body', () => {
  it('returns the plain-text part (trailing-trimmed) for any non-empty text body', () => {
    fc.assert(
      fc.property(
        // A text body guaranteed to contain at least one non-whitespace char.
        fc.string({ minLength: 1 }).filter((s) => s.trim() !== ''),
        fc.option(fc.string(), { nil: undefined }),
        (text, html) => {
          const result = toPlainText({ text, ...(html !== undefined ? { html } : {}) });
          // The text part wins and is returned with only trailing whitespace trimmed.
          expect(result).toBe(text.replace(/\s+$/, ''));
          // It is non-empty because the source had a non-whitespace character.
          expect(result.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('derives a non-empty, tag-free body from an HTML-only email', () => {
    // Safe alphanumeric words (no '<','>','&') so the only angle brackets in the
    // generated HTML come from the tags we wrap around them. After stripping the
    // tags the visible words must survive and no markup may remain.
    const word = fc
      .string({ minLength: 1, maxLength: 8 })
      .map((s) => s.replace(/[^a-zA-Z0-9]/g, ''))
      .filter((s) => s.length > 0);
    const blockTag = fc.constantFrom('p', 'div', 'li', 'h1', 'blockquote');

    fc.assert(
      fc.property(fc.array(word, { minLength: 1, maxLength: 6 }), blockTag, (words, tag) => {
        const html = words.map((w) => `<${tag}>${w}</${tag}>`).join('');
        const result = toPlainText({ html });
        // Tag-free: no residual markup delimiters survive.
        expect(result).not.toContain('<');
        expect(result).not.toContain('>');
        // Non-empty and every word's visible content is preserved.
        expect(result.trim().length).toBeGreaterThan(0);
        for (const w of words) {
          expect(result).toContain(w);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('is total: never throws for any { text?, html? } shape', () => {
    fc.assert(
      fc.property(
        fc.option(fc.string(), { nil: undefined }),
        fc.option(fc.string(), { nil: undefined }),
        (text, html) => {
          const parsed: { text?: string; html?: string } = {
            ...(text !== undefined ? { text } : {}),
            ...(html !== undefined ? { html } : {}),
          };
          const result = toPlainText(parsed);
          // Always a string; never throws regardless of input.
          expect(typeof result).toBe('string');
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 17 (9.4)
// ---------------------------------------------------------------------------

// Feature: roza-step2-channels, Property 17: Reply emails carry the profile identity and correct threading headers
// Validates: Requirements 7.5
describe('Property 17: reply emails carry the profile identity and threading headers', () => {
  it('sets From to the profile email identity and In-Reply-To/References to the thread ref', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A recipient address, a reply body, and an inbound Message-ID thread ref.
        fc.string({ minLength: 1 }).filter((s) => s.trim() !== ''),
        fc.string(),
        fc.string({ minLength: 1 }).filter((s) => s.trim() !== ''),
        async (to, text, threadRef) => {
          const { connector, mockSender } = setup();

          await connector.sendReply({ channel: 'email', to, text, threadRef });

          expect(mockSender.send).toHaveBeenCalledTimes(1);
          const sent = mockSender.send.mock.calls[0]?.[0];
          if (sent === undefined) {
            throw new Error('sender.send was not called with a message');
          }
          // From is the profile's email identity (Req 7.5).
          expect(sent.from).toBe(DEFAULT_PROFILE.emailIdentity);
          // Threading headers both set to the inbound Message-ID / thread ref.
          expect(sent.inReplyTo).toBe(threadRef);
          expect(sent.references).toBe(threadRef);
          // Body and recipient are carried through unchanged.
          expect(sent.to).toBe(to);
          expect(sent.text).toBe(text);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Example 9.5
// ---------------------------------------------------------------------------

describe('createMailConnector (mock transports) — \\Seen ordering and credential safety', () => {
  it('constructs both transports with the configured (mock) credentials', async () => {
    const { connector, readerFactory, senderFactory } = setup();

    await connector.start(vi.fn().mockResolvedValue(undefined));

    expect(readerFactory).toHaveBeenCalledTimes(1);
    expect(readerFactory).toHaveBeenCalledWith(IMAP_CREDS);
    // The sender is constructed up front during start so a reply pays no first-use cost.
    expect(senderFactory).toHaveBeenCalledTimes(1);
    expect(senderFactory).toHaveBeenCalledWith(SMTP_CREDS);
  });

  it('marks a submitted message \\Seen only AFTER a successful hand-off to onInbound', async () => {
    const { connector, mockReader } = setup();

    const events: string[] = [];
    const onInbound = vi
      .fn<(msg: InboundMessage) => Promise<void>>()
      .mockImplementation(async () => {
        events.push('onInbound');
      });
    mockReader.markSeen.mockImplementation(async () => {
      events.push('markSeen');
    });

    await connector.start(onInbound);
    await mockReader.fire({
      messageId: '<msg-123@example.test>',
      from: 'sender@example.test',
      text: 'hello roza',
    });

    // Hand-off happened exactly once and reduced to the expected InboundMessage.
    expect(onInbound).toHaveBeenCalledTimes(1);
    const msg = onInbound.mock.calls[0]?.[0];
    if (msg === undefined) {
      throw new Error('onInbound was not called with an InboundMessage');
    }
    expect(msg).toMatchObject({
      channel: 'email',
      externalId: '<msg-123@example.test>',
      senderId: 'sender@example.test',
      text: 'hello roza',
      threadRef: '<msg-123@example.test>',
    });

    // \Seen is applied to the same message, strictly after the hand-off.
    expect(mockReader.markSeen).toHaveBeenCalledTimes(1);
    expect(mockReader.markSeen).toHaveBeenCalledWith('<msg-123@example.test>');
    expect(events).toEqual(['onInbound', 'markSeen']);
  });

  it('does NOT mark a message \\Seen when the hand-off to onInbound fails', async () => {
    const { connector, mockReader } = setup();

    const onInbound = vi
      .fn<(msg: InboundMessage) => Promise<void>>()
      .mockRejectedValue(new Error('router rejected the message'));

    await connector.start(onInbound);
    await expect(
      mockReader.fire({
        messageId: '<msg-fail@example.test>',
        from: 'sender@example.test',
        text: 'will not be seen',
      }),
    ).rejects.toThrow();

    expect(onInbound).toHaveBeenCalledTimes(1);
    // A failed hand-off must leave the message unread (not \Seen) for retry (Req 7.7).
    expect(mockReader.markSeen).not.toHaveBeenCalled();
  });

  it('never writes a mailbox credential to any log line', async () => {
    const { connector, mockReader, logger } = setup();

    // Exercise start, an inbound hand-off + \Seen, a reply send, and stop so
    // every log path is hit before inspecting the captured log calls.
    await connector.start(vi.fn().mockResolvedValue(undefined));
    await mockReader.fire({
      messageId: '<msg-log@example.test>',
      from: 'sender@example.test',
      html: '<p>html only body</p>',
    });
    await connector.sendReply({
      channel: 'email',
      to: 'sender@example.test',
      text: 'a reply',
      threadRef: '<msg-log@example.test>',
    });
    await connector.stop();

    expect(logger.info).toHaveBeenCalled();

    const everyCall = [...logger.info.mock.calls, ...logger.error.mock.calls];
    const serialized = JSON.stringify(everyCall);
    // No IMAP or SMTP credential value may surface in any log line (Req 4.4, 14.3).
    expect(serialized).not.toContain(IMAP_CREDS.password);
    expect(serialized).not.toContain(SMTP_CREDS.password);
    expect(serialized).not.toContain(IMAP_CREDS.user);
    expect(serialized).not.toContain(SMTP_CREDS.user);
  });
});
