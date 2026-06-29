/**
 * Property-based tests for the pure Sender_Mapping helpers in `sender.ts`
 * (Property 1 of the roza-step2-channels design).
 *
 * These exercise ONLY the side-effect-free, total helpers — `normalizeEmail`,
 * `normalizeTelegramId`, `userIdForTelegram`, and `userIdForEmail`. They perform
 * no I/O and are expected never to throw. Each property runs a minimum of 100
 * fast-check iterations.
 *
 * Property 1 consolidates the three sender-mapping acceptance criteria:
 *   - determinism (Req 8.5): same identifier on the same channel → same user_id
 *   - channel namespacing (Req 8.1, 8.2): `telegram:` vs `email:` prefixes so the
 *     same raw string on different channels never collides
 *   - email canonicalization (Req 8.2, 8.5): case/whitespace/angle-bracket
 *     variants of one address map to one identical user_id
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  normalizeTelegramId,
  userIdForTelegram,
  userIdForEmail,
} from './sender.js';

const NUM_RUNS = 200;

/** Lowercase characters safe to compose into a canonical email local/domain part. */
const lcChar = fc.constantFrom(
  ...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')
);

/** A canonical (already lowercased, trimmed, bracket-free) email address. */
const canonicalEmail: fc.Arbitrary<string> = fc
  .record({
    local: fc.array(lcChar, { minLength: 1, maxLength: 12 }).map((a) => a.join('')),
    domain: fc.array(lcChar, { minLength: 1, maxLength: 10 }).map((a) => a.join('')),
    tld: fc.constantFrom('io', 'com', 'org', 'net', 'fr'),
  })
  .map(({ local, domain, tld }) => `${local}@${domain}.${tld}`);

/** Whitespace runs (space/tab/newline/carriage-return) for surrounding/inner padding. */
const whitespace = fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r'), { maxLength: 4 });

/** A per-character case mask, applied cyclically to produce mixed-case variants. */
const caseMask = fc.array(fc.boolean(), { minLength: 1, maxLength: 40 });

/** Toggle the case of each character using the mask cyclically. */
function applyCase(s: string, mask: boolean[]): string {
  return s
    .split('')
    .map((ch, i) => (mask[i % mask.length] ? ch.toUpperCase() : ch.toLowerCase()))
    .join('');
}

/** An arbitrary raw Telegram identifier — numeric id or a string handle/id. */
const rawTelegramId: fc.Arbitrary<string | number> = fc.oneof(
  fc.integer(),
  fc.string({ maxLength: 16 })
);

describe('sender mapping (Sender_Mapping)', () => {
  // Feature: roza-step2-channels, Property 1: Sender-mapping determinism and canonicalization
  // Validates: Requirements 8.1, 8.2, 8.5

  it('Property 1: user_id derivation is deterministic across repeated calls', () => {
    fc.assert(
      fc.property(rawTelegramId, canonicalEmail, (tgId, email) => {
        // Same identifier on the same channel always yields the same user_id (Req 8.5).
        expect(userIdForTelegram(tgId)).toBe(userIdForTelegram(tgId));
        expect(userIdForEmail(email)).toBe(userIdForEmail(email));
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 1: user_ids are namespaced by channel and never collide across channels', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 32 }), (raw) => {
        const tg = userIdForTelegram(raw);
        const mail = userIdForEmail(raw);

        // Each channel stamps its own prefix (Req 8.1, 8.2).
        expect(tg.startsWith('telegram:')).toBe(true);
        expect(mail.startsWith('email:')).toBe(true);

        // The same raw string fed to both channels never produces equal user_ids.
        expect(tg).not.toBe(mail);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 1: email addresses canonicalize over case, whitespace, and angle brackets', () => {
    fc.assert(
      fc.property(
        canonicalEmail,
        caseMask,
        whitespace,
        whitespace,
        whitespace,
        fc.boolean(),
        (base, mask, lead, trail, inner, wrapBrackets) => {
          // Mixed-case rendering of the same address.
          const cased = applyCase(base, mask);

          // Optionally wrap in a single pair of surrounding angle brackets with
          // arbitrary inner padding, then pad with surrounding whitespace.
          const inner1 = wrapBrackets ? inner : '';
          const wrapped = wrapBrackets ? `<${inner1}${cased}${inner1}>` : cased;
          const variant = `${lead}${wrapped}${trail}`;

          const expected = `email:${base}`;

          // Every case/whitespace/bracket variant maps to the one canonical user_id (Req 8.2, 8.5).
          expect(userIdForEmail(variant)).toBe(expected);
          expect(userIdForEmail(variant)).toBe(userIdForEmail(base));
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 1: numeric and equivalent string Telegram ids map identically', () => {
    fc.assert(
      fc.property(fc.integer(), (n) => {
        // A numeric id and its string form resolve to the same user_id (Req 8.1, 8.5).
        expect(userIdForTelegram(n)).toBe(userIdForTelegram(String(n)));
        expect(normalizeTelegramId(n)).toBe(normalizeTelegramId(String(n)));
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 1: surrounding whitespace on a Telegram id is trimmed', () => {
    fc.assert(
      fc.property(rawTelegramId, whitespace, whitespace, (id, lead, trail) => {
        const idStr = String(id);
        const padded = `${lead}${idStr}${trail}`;

        // Surrounding whitespace does not change the derived user_id (Req 8.1, 8.5).
        expect(userIdForTelegram(padded)).toBe(userIdForTelegram(idStr.trim()));
        expect(normalizeTelegramId(padded)).toBe(idStr.trim());
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
