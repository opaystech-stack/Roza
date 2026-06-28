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
    tx,
  };
}
