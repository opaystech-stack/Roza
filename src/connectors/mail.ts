/**
 * Mail connector (Component H) — Req 7, 12, 13.
 *
 * This module will host `createMailConnector` (IMAP read via imapflow, MIME
 * parse via mailparser, SMTP send via nodemailer) behind the shared
 * {@link ChannelConnector} contract. The full connector is built in a later
 * task; for now this file exposes only the pure {@link toPlainText} helper that
 * the connector uses to reduce a parsed inbound email to a plain-text body.
 *
 * The connector itself (`createMailConnector`, below) reads via imapflow
 * (connect + IDLE), parses MIME with mailparser, and sends via nodemailer —
 * all reached through narrow, injectable transport interfaces ({@link MailReader}
 * / {@link MailSender}) so every test runs against mocks with no real network.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createTransport } from 'nodemailer';
import type { Logger } from '../types.js';
import type { RozaProfile } from '../profile.js';
import {
  type BackoffOptions,
  type ChannelConnector,
  type InboundMessage,
  type OutboundReply,
  mailSenderIdentity,
  withBackoff,
} from './connector.js';

/**
 * Common named/numeric HTML entities decoded when flattening an HTML-only body.
 * Kept deliberately small and dependency-free — this is a pragmatic decode of
 * the entities that appear in ordinary email prose, not a full HTML parser.
 */
const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/**
 * Strip tags and decode entities from an HTML fragment into readable plain text.
 *
 * Total and dependency-free (simple regex stripping, no extra libraries):
 * - drops `<script>`/`<style>` blocks wholesale so their contents never leak
 *   into the text,
 * - turns `<br>` and block-level closing tags into newlines so structure is
 *   preserved as line breaks,
 * - removes every remaining tag,
 * - decodes the common HTML entities,
 * - collapses runs of spaces/tabs and excessive blank lines into a readable,
 *   trimmed result.
 */
function htmlToPlainText(html: string): string {
  let text = html;

  // Remove script/style blocks entirely (including their content).
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  // Convert line-breaking tags to newlines before stripping the rest.
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|table|ul|ol|blockquote)>/gi, '\n');

  // Strip all remaining tags.
  text = text.replace(/<[^>]+>/g, '');

  // Decode the common HTML entities.
  text = text.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/gi, (match) => {
    const decoded = HTML_ENTITIES[match] ?? HTML_ENTITIES[match.toLowerCase()];
    return decoded ?? match;
  });

  // Collapse horizontal whitespace, trim each line, and collapse blank-line runs.
  text = text
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

/**
 * Derive the plain-text body from a parsed inbound email (Req 7.6).
 *
 * Total and pure — never throws for any `{ text?, html? }` input:
 * - returns the plain-text part (right-trimmed) when it is a non-empty string,
 *   preserving its internal content;
 * - otherwise derives a tag-free plain-text representation from the HTML body;
 * - returns an empty string when neither a usable text nor HTML body is present.
 */
export function toPlainText(parsed: { text?: string; html?: string }): string {
  const text = parsed.text;
  if (typeof text === 'string' && text.trim() !== '') {
    // Preserve internal content; only trim trailing whitespace.
    return text.replace(/\s+$/, '');
  }

  const html = parsed.html;
  if (typeof html === 'string' && html.trim() !== '') {
    return htmlToPlainText(html);
  }

  return '';
}

// ---------------------------------------------------------------------------
// MailConnector (Component I) — Req 7.1, 7.2, 7.3, 7.5, 7.7, 12.1, 12.3, 13.2, 13.3.
//
// The connector is transport-only: it normalizes each new inbound email into an
// InboundMessage and hands it to the router-supplied `onInbound` callback, then
// marks the message `\Seen` ONLY after a successful hand-off (Req 7.7); and it
// delivers replies carrying the profile email identity and threading headers
// (Req 7.2, 7.5). All channel-agnostic concerns (allowlist, idempotency,
// quiet-hours deferral, persistence) live in the InboundRouter, not here.
//
// IMAP/SMTP are reached only through the narrow, injectable MailReader /
// MailSender interfaces below. Tests inject mock transports via
// `readerFactory` / `senderFactory` so no real network I/O is ever performed;
// the default factories adapt imapflow + mailparser and nodemailer respectively
// and are the only protocol-specific code in this module.
//
// Security note (Req 4.4, 4.5, 14.3): mailbox credentials are passed only to
// imapflow/nodemailer for the protocol handshake; they are NEVER logged.
// ---------------------------------------------------------------------------

/** Connection parameters for the IMAP read side. */
export interface ImapCredentials {
  host: string;
  port: number;
  user: string;
  password: string;
}

/** Connection parameters for the SMTP send side. */
export interface SmtpCredentials {
  host: string;
  port: number;
  user: string;
  password: string;
}

/** A raw inbound mail, already MIME-parsed, handed from a reader to the connector. */
export interface RawInboundMail {
  /** The email `Message-ID` (used for idempotency and threading). */
  messageId: string;
  /** The `From` address. */
  from: string;
  /** Plain-text body part, when present. */
  text?: string;
  /** HTML body part, when present. */
  html?: string;
}

/**
 * The minimal IMAP read transport the connector depends on — only the three
 * operations we actually use. Keeping the surface this small lets tests inject
 * a mock without any real network, and isolates all imapflow-specific wiring in
 * {@link defaultReaderFactory}.
 */
export interface MailReader {
  /**
   * Begin receiving. For each new message the transport MIME-parses it and
   * invokes `onMessage` with the normalized {@link RawInboundMail}. Resolves
   * once the mailbox is open and listening for new mail.
   */
  start(onMessage: (raw: RawInboundMail) => Promise<void>): Promise<void>;
  /** Mark the identified message `\Seen` so it is not read again as new (Req 7.7). */
  markSeen(messageId: string): Promise<void>;
  /** Stop receiving and release transport resources. */
  stop(): Promise<void>;
}

/**
 * The minimal SMTP send transport the connector depends on. Isolates all
 * nodemailer-specific wiring in {@link defaultSenderFactory}.
 */
export interface MailSender {
  /** Send one message; resolves on success, rejects on a (retryable) failure. */
  send(msg: {
    from: string;
    to: string;
    text: string;
    inReplyTo?: string;
    references?: string;
  }): Promise<void>;
}

/** A factory that builds a {@link MailReader} from IMAP credentials. */
export type MailReaderFactory = (imap: ImapCredentials) => MailReader;

/** A factory that builds a {@link MailSender} from SMTP credentials. */
export type MailSenderFactory = (smtp: SmtpCredentials) => MailSender;

/** Dependencies for {@link createMailConnector}. */
export interface MailConnectorDeps {
  /** IMAP credentials; used only to build the reader transport, never logged. */
  imap: ImapCredentials;
  /** SMTP credentials; used only to build the sender transport, never logged. */
  smtp: SmtpCredentials;
  /** Accessor for the currently-loaded profile (drives the From identity, Req 7.5). */
  profile: () => RozaProfile;
  /** Structured logger; must never receive a mailbox credential. */
  logger: Logger;
  /** Retry/backoff tuning for reconnects and outbound sends (Req 12.1, 12.3). */
  backoff: BackoffOptions;
  /** Injectable IMAP read transport factory; defaults to the real imapflow adapter. */
  readerFactory?: MailReaderFactory;
  /** Injectable SMTP send transport factory; defaults to the real nodemailer adapter. */
  senderFactory?: MailSenderFactory;
}

/**
 * Default {@link MailReaderFactory}: adapt a real imapflow `ImapFlow` client to
 * the narrow {@link MailReader} transport. This is the only imapflow/mailparser
 * code in the module, deliberately kept minimal.
 *
 * It opens the connection, selects INBOX, and listens for new mail via the
 * `exists` event; for each unseen message it fetches the source, parses it with
 * `simpleParser`, and reports the normalized {@link RawInboundMail}. `markSeen`
 * adds the `\Seen` flag for the message's tracked UID (Req 7.7). Mailbox
 * credentials reach only imapflow's auth handshake and are never logged.
 */
export function defaultReaderFactory(imap: ImapCredentials): MailReader {
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.port === 993,
    auth: { user: imap.user, pass: imap.password },
    // Disable imapflow's own logger so no protocol/credential data is emitted.
    logger: false,
  });

  // Track UID per Message-ID so markSeen can target the right message.
  const uidByMessageId = new Map<string, number>();

  let onMessageCb: ((raw: RawInboundMail) => Promise<void>) | null = null;

  async function drainUnseen(): Promise<void> {
    const cb = onMessageCb;
    if (cb === null) {
      return;
    }
    // Acquire a lock so the fetch does not race the background IDLE.
    const lock = await client.getMailboxLock('INBOX');
    try {
      for await (const msg of client.fetch({ seen: false }, { uid: true, source: true, envelope: true })) {
        const source = msg.source;
        if (source === undefined) {
          continue;
        }
        const parsed = await simpleParser(source);
        const messageId = parsed.messageId ?? String(msg.uid);
        const fromAddress = parsed.from?.value?.[0]?.address ?? '';
        const text = parsed.text;
        const html = typeof parsed.html === 'string' ? parsed.html : undefined;
        const raw: RawInboundMail = {
          messageId,
          from: fromAddress,
          ...(typeof text === 'string' ? { text } : {}),
          ...(html !== undefined ? { html } : {}),
        };
        uidByMessageId.set(messageId, msg.uid);
        await cb(raw);
      }
    } finally {
      lock.release();
    }
  }

  return {
    async start(onMessage: (raw: RawInboundMail) => Promise<void>): Promise<void> {
      onMessageCb = onMessage;
      await client.connect();
      await client.mailboxOpen('INBOX');
      // New mail arriving while connected fires `exists`; drain on each signal.
      client.on('exists', () => {
        void drainUnseen();
      });
      // Process any messages already unseen at startup.
      await drainUnseen();
    },

    async markSeen(messageId: string): Promise<void> {
      const uid = uidByMessageId.get(messageId);
      if (uid === undefined) {
        return;
      }
      await client.messageFlagsAdd([uid], ['\\Seen'], { uid: true });
      uidByMessageId.delete(messageId);
    },

    async stop(): Promise<void> {
      await client.logout();
    },
  };
}

/**
 * Default {@link MailSenderFactory}: adapt a real nodemailer transport to the
 * narrow {@link MailSender}. This is the only nodemailer code in the module.
 * SMTP credentials reach only the transport's auth config and are never logged.
 */
export function defaultSenderFactory(smtp: SmtpCredentials): MailSender {
  const transport = createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.password },
  });

  return {
    async send(msg): Promise<void> {
      await transport.sendMail({
        from: msg.from,
        to: msg.to,
        text: msg.text,
        ...(msg.inReplyTo !== undefined ? { inReplyTo: msg.inReplyTo } : {}),
        ...(msg.references !== undefined ? { references: msg.references } : {}),
      });
    },
  };
}

/**
 * Create the Mail {@link ChannelConnector} (Req 7.1, 7.2, 7.3, 7.5, 7.7).
 *
 * - `start(onInbound)` builds the reader from `deps.imap` and begins listening.
 *   For each new mail it constructs an {@link InboundMessage} (`externalId` and
 *   `threadRef` = Message-ID, `senderId` = From address, `text` = plain-text
 *   body via {@link toPlainText}), hands it to `onInbound`, and only AFTER a
 *   successful hand-off marks the message `\Seen` (Req 7.7). The reader start is
 *   wrapped in {@link withBackoff} for reconnect resilience (Req 12.1).
 * - `sendReply(reply)` builds the sender lazily, then delivers via the
 *   transport with `from` = the profile's mail identity and
 *   `In-Reply-To`/`References` set to the thread ref, retried with
 *   {@link withBackoff} for transient/rate-limit SMTP failures (Req 7.2, 7.5,
 *   12.3).
 * - `stop()` stops the reader.
 *
 * Mailbox credentials are passed only to the transport factories and are never
 * logged (Req 4.4, 14.3).
 */
export function createMailConnector(deps: MailConnectorDeps): ChannelConnector {
  const { logger, backoff } = deps;
  const readerFactory = deps.readerFactory ?? defaultReaderFactory;
  const senderFactory = deps.senderFactory ?? defaultSenderFactory;

  let reader: MailReader | null = null;
  let sender: MailSender | null = null;

  // Build the SMTP sender lazily on first use (or in start), reusing it after.
  function ensureSender(): MailSender {
    if (sender === null) {
      sender = senderFactory(deps.smtp);
    }
    return sender;
  }

  return {
    channel: 'email',

    async start(onInbound: (msg: InboundMessage) => Promise<void>): Promise<void> {
      const transport = readerFactory(deps.imap);
      reader = transport;
      // Construct the sender up front so a reply never pays first-use latency.
      ensureSender();

      logger.info('mail connector starting', { channel: 'email' });

      // Wrap start in backoff so a transient connect/reconnect failure retries
      // rather than crashing the process (Req 12.1).
      await withBackoff(
        () =>
          transport.start(async (raw: RawInboundMail) => {
            const msg: InboundMessage = {
              channel: 'email',
              externalId: raw.messageId,
              senderId: raw.from,
              text: toPlainText({
                ...(raw.text !== undefined ? { text: raw.text } : {}),
                ...(raw.html !== undefined ? { html: raw.html } : {}),
              }),
              threadRef: raw.messageId,
              receivedAt: new Date().toISOString(),
            };
            // Hand off first; only mark \Seen after a successful hand-off (Req 7.7).
            await onInbound(msg);
            await transport.markSeen(raw.messageId);
          }),
        backoff,
        logger,
      );
    },

    async sendReply(reply: OutboundReply): Promise<void> {
      const transport = ensureSender();
      const from = mailSenderIdentity(deps.profile());
      await withBackoff(
        () =>
          transport.send({
            from,
            to: reply.to,
            text: reply.text,
            ...(reply.threadRef !== undefined ? { inReplyTo: reply.threadRef, references: reply.threadRef } : {}),
          }),
        backoff,
        logger,
      );
    },

    async stop(): Promise<void> {
      const transport = reader;
      if (transport === null) {
        return;
      }
      await transport.stop();
      reader = null;
      logger.info('mail connector stopped', { channel: 'email' });
    },
  };
}
