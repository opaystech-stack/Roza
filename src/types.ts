/**
 * Shared domain types for the Roza agent.
 *
 * These mirror the canonical Roza_Mind_Database schema (Req 3.5–3.8) and the
 * forward-compatible channel set (Req 9). They are pure type declarations with
 * no runtime dependencies so every other module can import them freely.
 */

/**
 * Conversation channels. Only `internal` is operative in Phase 1 (Req 9.1, 9.3);
 * the remaining values exist for forward compatibility so later phases extend
 * without a schema migration (Req 9.2).
 */
export type Channel = 'telegram' | 'email' | 'voice' | 'internal';

/** Author of a stored message (Req 3.8). */
export type SenderType = 'user' | 'roza';

/**
 * Relational memory profile for a person Roza interacts with (Req 3.6).
 * `user_id` is an opaque reference to an Opays HQ user identifier and creates
 * no live coupling. `last_language` is the Phase-1 extension column backing the
 * language fallback (Req 7.2).
 */
export interface HumanRelationship {
  id: string;
  user_id: string;
  full_name: string | null;
  role: string | null;
  affinity_score: number;
  personality_notes: string;
  last_language: 'fr' | 'en' | null;
  last_interaction: string | null;
}

/** A conversation session grouped by channel and user (Req 3.7). */
export interface Conversation {
  id: string;
  channel: Channel;
  user_id: string;
  created_at: string;
  last_message_at: string | null;
}

/** A single message exchanged within a conversation (Req 3.8). */
export interface Message {
  id: string;
  conversation_id: string;
  sender_type: SenderType;
  content: string;
  created_at: string;
}

/**
 * A private journal entry (Req 3.5, 4). `thought` holds only the AES-256-GCM
 * ciphertext envelope (`keyVersion:ivHex:tagHex:cipherHex`); plaintext is never
 * persisted.
 */
export interface JournalEntry {
  id: string;
  created_at: string;
  thought: string;
  mood: string | null;
  encryption_key_version: string;
}

/**
 * Minimal structured logger used across the scheduler, bootstrap, and engine.
 * Implementations must never log secret values (Req 1.7, 5.x).
 */
export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}
