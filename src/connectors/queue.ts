/**
 * Inbound queue + idempotency store (Component G) — Req 10, 11.
 *
 * A thin typed store over the two Phase 2 tables (`inbound_queue` and
 * `processed_messages`), exposed to the InboundRouter. It translates between the
 * transport-agnostic {@link InboundMessage} shape the connectors/router speak
 * and the relational rows the {@link Repository} persists, keeping all SQL and
 * column naming behind the repository boundary.
 *
 * Durability (Req 10.4, 11.4): both tables live in `roza_mind.sqlite`, so
 * enqueued messages and answered/unsent reply state survive a restart. The
 * drain runs every per-row delete inside a single `repo.tx`, so a crash
 * mid-drain leaves the undrained rows intact rather than losing messages
 * (Req 10.4).
 */

import type { InboundMessage, OperativeChannel } from './connector.js';
import type { InboundQueueRow, Repository } from '../repository.js';

/**
 * Idempotency state for a `(channel, external_id)` pair (Req 11):
 * - `none` — never processed; eligible for the engine.
 * - `answered_unsent` — a reply was generated and retained but not yet
 *   delivered; resend the stored reply without re-invoking the LLM (Req 11.5).
 * - `answered_sent` — a reply was delivered; do nothing further (Req 11.1).
 */
export type AnswerState = 'none' | 'answered_unsent' | 'answered_sent';

/** The durable inbound queue + idempotency store the router depends on. */
export interface InboundQueueStore {
  // Inbound queue (Req 10.2–10.4)
  /** Persist an inbound message for later FIFO draining (Req 10.2). */
  enqueue(msg: InboundMessage): void;
  /**
   * Drain every queued message in receipt order (FIFO by `received_at` then the
   * monotonic `seq`), removing the drained rows inside a single transaction so a
   * crash mid-drain leaves undrained rows intact (Req 10.3, 10.4).
   */
  dequeueInReceiptOrder(): InboundMessage[];

  // Idempotency store (Req 11)
  /** Current answer state for a `(channel, externalId)` pair (Req 11.1). */
  lookup(channel: OperativeChannel, externalId: string): AnswerState;
  /** Record a generated reply as `answered_unsent`, retaining its text (Req 11.3). */
  recordAnswered(channel: OperativeChannel, externalId: string, replyText: string): void;
  /** The retained reply text for a pair, or `null` if none (Req 11.5). */
  getStoredReply(channel: OperativeChannel, externalId: string): string | null;
  /** Mark a pair as `answered_sent` once delivery succeeds (Req 11). */
  markSent(channel: OperativeChannel, externalId: string): void;
}

/** Map a durable {@link InboundQueueRow} back to a transport-agnostic message. */
function rowToMessage(row: InboundQueueRow): InboundMessage {
  const msg: InboundMessage = {
    channel: row.channel,
    externalId: row.external_id,
    senderId: row.sender_id,
    text: row.text,
    receivedAt: row.received_at,
  };
  // Under exactOptionalPropertyTypes, only attach threadRef when present so the
  // optional key is genuinely absent (not `undefined`) for queue-only rows.
  if (row.thread_ref !== null) {
    msg.threadRef = row.thread_ref;
  }
  return msg;
}

/**
 * Build an {@link InboundQueueStore} over the given {@link Repository}. All
 * persistence is delegated to the repository; this factory only adapts shapes
 * and orchestrates the transactional drain.
 */
export function createInboundQueueStore(repo: Repository): InboundQueueStore {
  function enqueue(msg: InboundMessage): void {
    // Req 10.2: persist the normalized message; the repository assigns id + seq.
    repo.enqueueInbound({
      channel: msg.channel,
      external_id: msg.externalId,
      sender_id: msg.senderId,
      text: msg.text,
      thread_ref: msg.threadRef ?? null,
      received_at: msg.receivedAt,
    });
  }

  function dequeueInReceiptOrder(): InboundMessage[] {
    // Req 10.3: read in FIFO order. Req 10.4: delete each drained row inside a
    // single transaction so a crash mid-drain rolls back to leave every
    // undrained row intact (all-or-nothing within this drain).
    return repo.tx(() => {
      const rows = repo.listInboundInOrder();
      const messages = rows.map(rowToMessage);
      for (const row of rows) {
        repo.deleteInbound(row.id);
      }
      return messages;
    });
  }

  function lookup(channel: OperativeChannel, externalId: string): AnswerState {
    // Req 11.1: absence means never processed.
    const row = repo.getProcessed(channel, externalId);
    return row === null ? 'none' : row.answer_state;
  }

  function recordAnswered(
    channel: OperativeChannel,
    externalId: string,
    replyText: string,
  ): void {
    // Req 11.3: stored as `answered_unsent`, retaining the reply until sent.
    repo.recordAnswered(channel, externalId, replyText, new Date().toISOString());
  }

  function getStoredReply(channel: OperativeChannel, externalId: string): string | null {
    // Req 11.5: the retained reply, replayed on a send retry without the LLM.
    return repo.getProcessed(channel, externalId)?.reply_text ?? null;
  }

  function markSent(channel: OperativeChannel, externalId: string): void {
    // Req 11: flip to `answered_sent` once delivery succeeds.
    repo.markSent(channel, externalId, new Date().toISOString());
  }

  return {
    enqueue,
    dequeueInReceiptOrder,
    lookup,
    recordAnswered,
    getStoredReply,
    markSent,
  };
}
