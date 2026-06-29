/**
 * Sender_Mapping (Component D) — Req 8.1, 8.2, 8.5.
 *
 * Pure, total, deterministic derivation of an opaque `user_id` from a
 * channel-specific identifier. The same External_Sender identifier on the same
 * channel always yields the same `user_id` (Req 8.5), and the channel prefix
 * guarantees that an identical raw string seen on two different channels never
 * collides. Downstream, the Phase 1 Memory_Loop performs create-if-absent then
 * reuse for the resolved `user_id` (Req 8.3, 8.4).
 *
 * These helpers are side-effect-free and never throw, matching the Phase 1
 * pure-logic core idiom.
 */

/**
 * Normalize an email address for use as a stable identity key.
 *
 * Trims surrounding whitespace, strips a single pair of surrounding angle
 * brackets (the `<addr>` form common in `From` headers), trims again to remove
 * any whitespace that sat inside the brackets, and lowercases the entire
 * address. As a result `"  <Bob@Opays.IO> "` and `"bob@opays.io"` normalize
 * identically (Req 8.2, 8.5).
 */
export function normalizeEmail(address: string): string {
  let result = address.trim();
  if (result.startsWith('<') && result.endsWith('>')) {
    result = result.slice(1, -1).trim();
  }
  return result.toLowerCase();
}

/**
 * Normalize a Telegram chat/user identifier.
 *
 * Coerces a numeric id to its string form and trims surrounding whitespace; the
 * numeric value itself is kept as-is. Telegram ids are case-irrelevant numeric
 * values, so no case folding is applied (Req 8.1, 8.5).
 */
export function normalizeTelegramId(id: string | number): string {
  return String(id).trim();
}

/**
 * Deterministic `user_id` for a Telegram External_Sender (Req 8.1, 8.5).
 * Channel-prefixed so the same raw id on a different channel never collides.
 */
export function userIdForTelegram(id: string | number): string {
  return `telegram:${normalizeTelegramId(id)}`;
}

/**
 * Deterministic `user_id` for a Mail External_Sender (Req 8.2, 8.5).
 * Channel-prefixed so the same raw address on a different channel never collides.
 */
export function userIdForEmail(address: string): string {
  return `email:${normalizeEmail(address)}`;
}
