/**
 * Repository (Component 4) — typed CRUD over the Roza_Mind_Database plus a
 * transaction wrapper — Req 2.5, 3.7, 4.1, 4.2, 6.1, 6.2, 6.4–6.7, 9.1, 9.2.
 *
 * The repository is the single typed gateway the Cognitive Engine uses to read
 * and write relational, conversational, and journal memory. It owns no schema
 * (that is `db.ts`) and no crypto primitives (that is `crypto.ts`) — it wires
 * those together behind the `Repository` interface from the design:
 *
 *  - Human_Relationships get/create/update (Req 6.1, 6.5, 6.6, 6.8).
 *  - Conversations get-open/create/touch, defaulting an unspecified channel to
 *    `internal` (Req 9.1) while still persisting the forward-compatible
 *    `voice`/`telegram`/`email` values without rejection (Req 9.2).
 *  - Messages add + bounded, time-ordered retrieval (Req 6.2, 6.4).
 *  - Private_Journal write (encrypt before insert, Req 4.1) and read (decrypt +
 *    verify, Req 4.2) delegating to `crypto.ts`.
 *  - `recordTaskInvocation` for the autonomous task audit trail (Req 2.5).
 *  - `tx` wrapping `better-sqlite3`'s `db.transaction` so memory updates are
 *    atomic / all-or-nothing.
 *
 * All identifiers are RFC 4122 v4 UUIDs from `crypto.randomUUID()`. Timestamps
 * are caller-supplied (so the engine/scheduler control the configured-timezone
 * clock) and fall back to an ISO-8601 UTC instant when omitted.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import type {
  Channel,
  Conversation,
  HumanRelationship,
  JournalEntry,
  Message,
  SenderType,
} from './types.js';
import { decryptThought, encryptThought } from './crypto.js';

/** Input for {@link Repository.createRelationship} (Req 6.8). `userId` is the only required field. */
export interface NewRelationship {
  userId: string;
  fullName?: string | null;
  role?: string | null;
  affinityScore?: number;
  personalityNotes?: string;
  lastLanguage?: 'fr' | 'en' | null;
  lastInteraction?: string | null;
}

/**
 * Partial update for {@link Repository.updateRelationship} (Req 6.5, 6.6, 7.3).
 * Uses the column names of {@link HumanRelationship}; only the provided fields
 * are written.
 */
export interface RelationshipPatch {
  full_name?: string | null;
  role?: string | null;
  affinity_score?: number;
  personality_notes?: string;
  last_language?: 'fr' | 'en' | null;
  last_interaction?: string | null;
}

/** Input for {@link Repository.addMessage} (Req 6.4). */
export interface NewMessage {
  conversationId: string;
  senderType: SenderType;
  content: string;
  /** Optional explicit timestamp; defaults to the current ISO-8601 instant. */
  createdAt?: string;
}

/** Input for {@link Repository.writeJournal} (Req 4.1). `thought` is plaintext and is encrypted before insert. */
export interface NewJournalEntry {
  thought: string;
  mood?: string | null;
  /** Optional explicit timestamp; defaults to the current ISO-8601 instant. */
  createdAt?: string;
}

/** The two operative external channels Phase 2 persists rows for (Req 10, 11). */
export type OperativeChannel = 'telegram' | 'email';

/**
 * A durable `inbound_queue` row (Req 10.2–10.4). Inbound messages received
 * during Quiet_Hours are persisted here and drained FIFO — ordered by
 * `received_at` then the monotonic `seq` tiebreak — on the first in-window tick.
 */
export interface InboundQueueRow {
  id: string;
  channel: OperativeChannel;
  external_id: string;
  sender_id: string;
  text: string;
  thread_ref: string | null;
  received_at: string;
  seq: number;
}

/**
 * A `processed_messages` idempotency row keyed by `(channel, external_id)`
 * (Req 11). `answer_state` is `answered_unsent` once a reply is generated and
 * retained, transitioning to `answered_sent` after successful delivery; the
 * `reply_text` is kept until the send succeeds so a failed send is retried
 * without re-invoking the LLM (Req 11.5).
 */
export interface ProcessedRow {
  channel: OperativeChannel;
  external_id: string;
  answer_state: 'answered_unsent' | 'answered_sent';
  reply_text: string | null;
  answered_at: string;
  sent_at: string | null;
}

/** Input for {@link Repository.enqueueInbound} (Req 10.2). `id` and `seq` are assigned by the repository. */
export interface NewInboundQueueRow {
  channel: OperativeChannel;
  external_id: string;
  sender_id: string;
  text: string;
  thread_ref: string | null;
  received_at: string;
}

/** Direction of a Call_Session on the `voice` channel (Phase 3 — Req 5.4, 9.1). */
export type CallDirection = 'inbound' | 'outbound';

/**
 * Lifecycle outcome of a Call_Session (Phase 3 — Req 5.4). A session opens as
 * `in_progress` and is later closed with a terminal outcome.
 */
export type CallOutcome =
  | 'in_progress'
  | 'completed'
  | 'rejected'
  | 'no_answer'
  | 'dropped'
  | 'error';

/**
 * A `call_sessions` audit row (Phase 3 — Req 4.6, 5.4, 7.5, 9.1). This is an
 * additive, audit-only log on the `voice` channel: it holds NO
 * SIP_Trunk_Credentials value (Req 7.5), only the Caller_Identity-derived
 * identifiers, direction, outcome, timestamps, and a running turn count.
 */
export interface CallSession {
  id: string;
  user_id: string;
  direction: CallDirection;
  caller_identity: string;
  outcome: CallOutcome;
  started_at: string;
  ended_at: string | null;
  turns: number;
}

/**
 * Input for {@link Repository.startCallSession} (Req 5.4, 9.1). The `id` is
 * assigned by the repository; `outcome` opens as `in_progress` and `turns` at 0.
 * `callerIdentity` is a Caller_Identity-derived identifier — never a credential.
 */
export interface NewCallSession {
  userId: string;
  direction: CallDirection;
  callerIdentity: string;
  /** Optional explicit start timestamp; defaults to the current ISO-8601 instant. */
  startedAt?: string;
}

/** Typed CRUD gateway used by the Cognitive Engine (design Component 4). */
export interface Repository {
  // Human_Relationships (Req 6.1, 6.5, 6.6, 6.8, 7.3)
  getRelationshipByUserId(userId: string): HumanRelationship | null;
  createRelationship(input: NewRelationship): HumanRelationship;
  updateRelationship(id: string, patch: RelationshipPatch): HumanRelationship;

  // Conversations (Req 3.7, 6.7, 6.9, 9.1, 9.2)
  getOpenConversation(userId: string, channel: Channel): Conversation | null;
  createConversation(userId: string, channel?: Channel): Conversation;
  touchConversation(id: string, at: string): void;

  // Messages (Req 3.8, 6.2, 6.4)
  addMessage(input: NewMessage): Message;
  getRecentMessages(conversationId: string, limit: number): Message[];

  // Private_Journal (Req 4)
  writeJournal(entry: NewJournalEntry): JournalEntry;
  readJournal(id: string): { plaintext: string; mood: string | null };

  // Task log (Req 2.5)
  recordTaskInvocation(at: string): void;

  // Roza_Profile (Req 1.4, 2.2): single-row identity store
  getProfile(): string | null;
  upsertProfile(profileJson: string): void;

  // Inbound queue (Req 10.2–10.4): durable defer store, drained FIFO
  enqueueInbound(row: NewInboundQueueRow): void;
  listInboundInOrder(): InboundQueueRow[];
  deleteInbound(id: string): void;

  // Idempotency / unsent-reply retention (Req 11.3, 11.5)
  getProcessed(channel: OperativeChannel, externalId: string): ProcessedRow | null;
  recordAnswered(
    channel: OperativeChannel,
    externalId: string,
    replyText: string,
    at: string
  ): void;
  markSent(channel: OperativeChannel, externalId: string, at: string): void;

  // Call_Session audit log (Phase 3 — Req 4.6, 5.4, 7.5, 9.1): additive,
  // audit-only; the voice turn loop never blocks on these writes.
  startCallSession(input: NewCallSession): CallSession;
  incrementCallTurn(id: string): void;
  endCallSession(id: string, outcome: CallOutcome, at: string): void;
  getCallSession(id: string): CallSession | null;

  // Transactions
  tx<T>(fn: () => T): T;
}

/** Options for {@link createRepository}: the journal secret and active key version. */
export interface RepositoryOptions {
  secret: string;
  keyVersion: string;
}

/** Current instant as an ISO-8601 UTC string, used when a caller omits a timestamp. */
function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Build a {@link Repository} bound to an already-opened, schema-verified
 * `better-sqlite3` database (see `db.ts`). Prepared statements are created once
 * and reused; the journal secret/key version are captured in the closure and
 * never persisted in plaintext.
 */
export function createRepository(
  db: Database.Database,
  opts: RepositoryOptions
): Repository {
  const { secret, keyVersion } = opts;

  // --- Prepared statements (compiled once) -------------------------------

  const selectRelationshipByUser = db.prepare(
    'SELECT * FROM human_relationships WHERE user_id = ?'
  );
  const selectRelationshipById = db.prepare(
    'SELECT * FROM human_relationships WHERE id = ?'
  );
  const insertRelationship = db.prepare(
    `INSERT INTO human_relationships
       (id, user_id, full_name, role, affinity_score, personality_notes, last_language, last_interaction)
     VALUES
       (@id, @user_id, @full_name, @role, @affinity_score, @personality_notes, @last_language, @last_interaction)`
  );

  const selectOpenConversation = db.prepare(
    `SELECT * FROM conversations
       WHERE user_id = ? AND channel = ?
       ORDER BY COALESCE(last_message_at, created_at) DESC, created_at DESC
       LIMIT 1`
  );
  const insertConversation = db.prepare(
    `INSERT INTO conversations (id, channel, user_id, created_at, last_message_at)
     VALUES (@id, @channel, @user_id, @created_at, @last_message_at)`
  );
  const selectConversationById = db.prepare(
    'SELECT * FROM conversations WHERE id = ?'
  );
  const updateConversationLastMessage = db.prepare(
    'UPDATE conversations SET last_message_at = ? WHERE id = ?'
  );

  const insertMessage = db.prepare(
    `INSERT INTO messages (id, conversation_id, sender_type, content, created_at)
     VALUES (@id, @conversation_id, @sender_type, @content, @created_at)`
  );
  const selectMessageById = db.prepare('SELECT * FROM messages WHERE id = ?');
  const selectRecentMessages = db.prepare(
    `SELECT * FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
  );

  const insertJournal = db.prepare(
    `INSERT INTO private_journal (id, created_at, thought, mood, encryption_key_version)
     VALUES (@id, @created_at, @thought, @mood, @encryption_key_version)`
  );
  const selectJournalById = db.prepare(
    'SELECT * FROM private_journal WHERE id = ?'
  );

  const insertTaskInvocation = db.prepare(
    'INSERT INTO task_invocations (id, invoked_at) VALUES (?, ?)'
  );

  // --- Phase 2 prepared statements (Req 1.4, 2.2, 10, 11) ----------------

  const selectProfile = db.prepare(
    'SELECT profile_json FROM roza_profile WHERE id = 1'
  );
  const upsertProfileStmt = db.prepare(
    `INSERT INTO roza_profile (id, profile_json, updated_at)
       VALUES (1, @profile_json, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       profile_json = excluded.profile_json,
       updated_at   = excluded.updated_at`
  );

  const insertInbound = db.prepare(
    `INSERT INTO inbound_queue
       (id, channel, external_id, sender_id, text, thread_ref, received_at, seq)
     VALUES
       (@id, @channel, @external_id, @sender_id, @text, @thread_ref, @received_at, @seq)`
  );
  const selectNextInboundSeq = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM inbound_queue'
  );
  const selectInboundInOrder = db.prepare(
    'SELECT * FROM inbound_queue ORDER BY received_at, seq'
  );
  const deleteInboundStmt = db.prepare(
    'DELETE FROM inbound_queue WHERE id = ?'
  );

  const selectProcessed = db.prepare(
    'SELECT * FROM processed_messages WHERE channel = ? AND external_id = ?'
  );
  const insertAnswered = db.prepare(
    `INSERT INTO processed_messages
       (channel, external_id, answer_state, reply_text, answered_at, sent_at)
     VALUES
       (@channel, @external_id, 'answered_unsent', @reply_text, @answered_at, NULL)
     ON CONFLICT(channel, external_id) DO UPDATE SET
       reply_text  = excluded.reply_text,
       answered_at = excluded.answered_at
     WHERE processed_messages.answer_state = 'answered_unsent'`
  );
  const updateSent = db.prepare(
    `UPDATE processed_messages
        SET answer_state = 'answered_sent', sent_at = @sent_at
      WHERE channel = @channel AND external_id = @external_id`
  );

  // --- Phase 3 prepared statements (Req 4.6, 5.4, 7.5, 9.1) --------------

  const insertCallSession = db.prepare(
    `INSERT INTO call_sessions
       (id, user_id, direction, caller_identity, outcome, started_at, ended_at, turns)
     VALUES
       (@id, @user_id, @direction, @caller_identity, 'in_progress', @started_at, NULL, 0)`
  );
  const selectCallSessionById = db.prepare(
    'SELECT * FROM call_sessions WHERE id = ?'
  );
  const incrementCallTurnStmt = db.prepare(
    'UPDATE call_sessions SET turns = turns + 1 WHERE id = ?'
  );
  const updateCallSessionEnd = db.prepare(
    'UPDATE call_sessions SET outcome = @outcome, ended_at = @ended_at WHERE id = @id'
  );

  // --- Human_Relationships ----------------------------------------------

  function getRelationshipByUserId(userId: string): HumanRelationship | null {
    const row = selectRelationshipByUser.get(userId) as HumanRelationship | undefined;
    return row ?? null;
  }

  function createRelationship(input: NewRelationship): HumanRelationship {
    const id = randomUUID();
    insertRelationship.run({
      id,
      user_id: input.userId,
      full_name: input.fullName ?? null,
      role: input.role ?? null,
      affinity_score: input.affinityScore ?? 0.5,
      personality_notes: input.personalityNotes ?? '{}',
      last_language: input.lastLanguage ?? null,
      last_interaction: input.lastInteraction ?? null,
    });
    return selectRelationshipById.get(id) as HumanRelationship;
  }

  function updateRelationship(id: string, patch: RelationshipPatch): HumanRelationship {
    const columns: Array<keyof RelationshipPatch> = [
      'full_name',
      'role',
      'affinity_score',
      'personality_notes',
      'last_language',
      'last_interaction',
    ];

    const assignments: string[] = [];
    const params: Record<string, unknown> = { id };
    for (const column of columns) {
      const value = patch[column];
      if (value !== undefined) {
        assignments.push(`${column} = @${column}`);
        params[column] = value;
      }
    }

    if (assignments.length > 0) {
      db.prepare(
        `UPDATE human_relationships SET ${assignments.join(', ')} WHERE id = @id`
      ).run(params);
    }

    const row = selectRelationshipById.get(id) as HumanRelationship | undefined;
    if (!row) {
      throw new Error(`updateRelationship: no human_relationships row with id "${id}"`);
    }
    return row;
  }

  // --- Conversations -----------------------------------------------------

  function getOpenConversation(userId: string, channel: Channel): Conversation | null {
    const row = selectOpenConversation.get(userId, channel) as Conversation | undefined;
    return row ?? null;
  }

  function createConversation(userId: string, channel?: Channel): Conversation {
    // Req 9.1: an unspecified channel defaults to `internal`. Req 9.2: explicit
    // forward-compatible channels (voice/telegram/email) are persisted as-is.
    const resolvedChannel: Channel = channel ?? 'internal';
    const id = randomUUID();
    insertConversation.run({
      id,
      channel: resolvedChannel,
      user_id: userId,
      created_at: isoNow(),
      last_message_at: null,
    });
    return selectConversationById.get(id) as Conversation;
  }

  function touchConversation(id: string, at: string): void {
    updateConversationLastMessage.run(at, id);
  }

  // --- Messages ----------------------------------------------------------

  function addMessage(input: NewMessage): Message {
    const id = randomUUID();
    insertMessage.run({
      id,
      conversation_id: input.conversationId,
      sender_type: input.senderType,
      content: input.content,
      created_at: input.createdAt ?? isoNow(),
    });
    return selectMessageById.get(id) as Message;
  }

  function getRecentMessages(conversationId: string, limit: number): Message[] {
    // Req 6.2: bounded by `limit` and ordered most-recent-first.
    return selectRecentMessages.all(conversationId, limit) as Message[];
  }

  // --- Private_Journal ---------------------------------------------------

  function writeJournal(entry: NewJournalEntry): JournalEntry {
    // Req 4.1: encrypt the plaintext thought before insert; store only the
    // ciphertext envelope. A blank secret makes encryptThought throw, so no row
    // is ever written with plaintext (Req 4.6).
    const envelope = encryptThought(entry.thought, secret, keyVersion);
    const id = randomUUID();
    insertJournal.run({
      id,
      created_at: entry.createdAt ?? isoNow(),
      thought: envelope,
      mood: entry.mood ?? null,
      encryption_key_version: keyVersion,
    });
    return selectJournalById.get(id) as JournalEntry;
  }

  function readJournal(id: string): { plaintext: string; mood: string | null } {
    // Req 4.2: decrypt + verify the auth tag; decryptThought throws
    // DecryptionError on tamper/wrong key rather than returning bytes.
    const row = selectJournalById.get(id) as JournalEntry | undefined;
    if (!row) {
      throw new Error(`readJournal: no private_journal row with id "${id}"`);
    }
    const plaintext = decryptThought(row.thought, secret);
    return { plaintext, mood: row.mood };
  }

  // --- Task log ----------------------------------------------------------

  function recordTaskInvocation(at: string): void {
    // Req 2.5: audit each autonomous task invocation with a timezone timestamp.
    insertTaskInvocation.run(randomUUID(), at);
  }

  // --- Roza_Profile (Req 1.4, 2.2) ---------------------------------------

  function getProfile(): string | null {
    // Single-row store: the only profile lives at id = 1 (Req 1.4).
    const row = selectProfile.get() as { profile_json: string } | undefined;
    return row?.profile_json ?? null;
  }

  function upsertProfile(profileJson: string): void {
    // Req 2.2: idempotent single-row upsert; the CHECK (id = 1) plus ON CONFLICT
    // guarantees exactly one profile row that is overwritten in place.
    upsertProfileStmt.run({
      profile_json: profileJson,
      updated_at: isoNow(),
    });
  }

  // --- Inbound queue (Req 10.2–10.4) -------------------------------------

  function enqueueInbound(row: NewInboundQueueRow): void {
    // Assign a UUID and a monotonic seq inside a transaction so the
    // MAX(seq)+1 read and the insert cannot interleave with another enqueue.
    tx(() => {
      const { next_seq } = selectNextInboundSeq.get() as { next_seq: number };
      insertInbound.run({
        id: randomUUID(),
        channel: row.channel,
        external_id: row.external_id,
        sender_id: row.sender_id,
        text: row.text,
        thread_ref: row.thread_ref,
        received_at: row.received_at,
        seq: next_seq,
      });
    });
  }

  function listInboundInOrder(): InboundQueueRow[] {
    // Req 10.3: FIFO by received_at then the seq tiebreak for identical instants.
    return selectInboundInOrder.all() as InboundQueueRow[];
  }

  function deleteInbound(id: string): void {
    // Drained rows are removed (inside the caller's tx) so a crash mid-drain
    // leaves undrained rows intact (Req 10.4).
    deleteInboundStmt.run(id);
  }

  // --- Idempotency / unsent-reply retention (Req 11) ---------------------

  function getProcessed(
    channel: OperativeChannel,
    externalId: string
  ): ProcessedRow | null {
    const row = selectProcessed.get(channel, externalId) as ProcessedRow | undefined;
    return row ?? null;
  }

  function recordAnswered(
    channel: OperativeChannel,
    externalId: string,
    replyText: string,
    at: string
  ): void {
    // Req 11.3, 11.5: record the generated reply as `answered_unsent`, retaining
    // the text until it is sent. The ON CONFLICT update only refreshes an
    // existing `answered_unsent` row; an already `answered_sent` row is never
    // downgraded (the WHERE guard makes the upsert a no-op in that case).
    insertAnswered.run({
      channel,
      external_id: externalId,
      reply_text: replyText,
      answered_at: at,
    });
  }

  function markSent(channel: OperativeChannel, externalId: string, at: string): void {
    // Req 11: flip to `answered_sent` once delivery succeeds, stamping sent_at.
    updateSent.run({ channel, external_id: externalId, sent_at: at });
  }

  // --- Call_Session audit log (Phase 3 — Req 4.6, 5.4, 7.5, 9.1) ---------

  function startCallSession(input: NewCallSession): CallSession {
    // Req 5.4, 9.1: open an audit-only voice Call_Session as `in_progress` with
    // a fresh UUID and zero turns. Stores only the Caller_Identity-derived
    // identifier — never a SIP_Trunk_Credentials value (Req 7.5).
    const id = randomUUID();
    insertCallSession.run({
      id,
      user_id: input.userId,
      direction: input.direction,
      caller_identity: input.callerIdentity,
      started_at: input.startedAt ?? isoNow(),
    });
    return selectCallSessionById.get(id) as CallSession;
  }

  function incrementCallTurn(id: string): void {
    // Audit-only running turn count; the voice turn loop never blocks on this.
    incrementCallTurnStmt.run(id);
  }

  function endCallSession(id: string, outcome: CallOutcome, at: string): void {
    // Req 5.4: close the session with a terminal outcome and ended_at stamp.
    updateCallSessionEnd.run({ id, outcome, ended_at: at });
  }

  function getCallSession(id: string): CallSession | null {
    const row = selectCallSessionById.get(id) as CallSession | undefined;
    return row ?? null;
  }

  // --- Transactions ------------------------------------------------------

  function tx<T>(fn: () => T): T {
    // Wrap better-sqlite3's synchronous transaction so a thrown error rolls back
    // every write, preserving prior state (Req 6.10 / 7.4 rely on this).
    return db.transaction(fn)();
  }

  return {
    getRelationshipByUserId,
    createRelationship,
    updateRelationship,
    getOpenConversation,
    createConversation,
    touchConversation,
    addMessage,
    getRecentMessages,
    writeJournal,
    readJournal,
    recordTaskInvocation,
    getProfile,
    upsertProfile,
    enqueueInbound,
    listInboundInOrder,
    deleteInbound,
    getProcessed,
    recordAnswered,
    markSent,
    startCallSession,
    incrementCallTurn,
    endCallSession,
    getCallSession,
    tx,
  };
}
