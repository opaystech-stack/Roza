/**
 * Property-based tests for the voice Sender_Mapping helpers in `sender.ts`
 * (Property 5 of the roza-step3-voice-telephony design).
 *
 * These exercise ONLY the side-effect-free, total helpers added for the voice
 * channel — `normalizeCallerIdentity` and `userIdForVoice` — alongside the
 * Phase 2 `userIdForTelegram`/`userIdForEmail` helpers used to prove
 * cross-channel non-collision. They perform no I/O and are expected never to
 * throw. Each property runs a minimum of 100 fast-check iterations.
 *
 * Property 5 consolidates the voice sender-mapping acceptance criteria:
 *   - determinism (Req 10.1): the same Caller_Identity always derives the same
 *     `user_id`
 *   - channel namespacing (Req 10.1, 14.2): the `voice:` prefix guarantees a
 *     voice `user_id` can never equal a `telegram:` or `email:` one
 *   - normalization (Req 10.1): identities differing only by surrounding
 *     whitespace collapse to one `user_id`, and SIP URIs normalize
 *     case-insensitively
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  normalizeCallerIdentity,
  userIdForVoice,
  userIdForTelegram,
  userIdForEmail,
} from './sender.js';

const NUM_RUNS = 200;

/** Whitespace runs (space/tab/newline/carriage-return) for surrounding padding. */
const whitespace = fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r'), {
  maxLength: 4,
});

/**
 * A phone-number-like raw identity: an optional leading `+`, then digits
 * interleaved with formatting noise (spaces, dashes, parentheses, dots) common
 * in dialed/displayed numbers.
 */
const phoneLikeIdentity: fc.Arbitrary<string> = fc
  .record({
    plus: fc.boolean(),
    parts: fc.array(
      fc.oneof(
        fc.constantFrom(' ', '-', '(', ')', '.', '  ', ') '),
        fc
          .array(fc.constantFrom(...'0123456789'.split('')), {
            minLength: 1,
            maxLength: 4,
          })
          .map((d) => d.join(''))
      ),
      { minLength: 1, maxLength: 8 }
    ),
  })
  .map(({ plus, parts }) => `${plus ? '+' : ''}${parts.join('')}`);

/** A user part for a SIP URI (lowercase letters/digits/dots/dashes). */
const sipUser: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789.-'.split('')), {
    minLength: 1,
    maxLength: 12,
  })
  .map((a) => a.join(''));

/** A host part for a SIP URI. */
const sipHost: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789.'.split('')), {
    minLength: 1,
    maxLength: 12,
  })
  .map((a) => a.join(''));

/** Optional SIP parameters appended after a `;`. */
const sipParams: fc.Arbitrary<string> = fc.oneof(
  fc.constant(''),
  fc.constantFrom(';transport=udp', ';transport=tcp', ';user=phone', ';lr')
);

/**
 * A SIP-URI-like raw identity, e.g. `sip:user@host;param`. The scheme casing is
 * varied to exercise case-insensitive scheme detection.
 */
const sipUriIdentity: fc.Arbitrary<string> = fc
  .record({
    scheme: fc.constantFrom('sip', 'SIP', 'Sip', 'sips', 'SIPS'),
    user: sipUser,
    host: sipHost,
    params: sipParams,
  })
  .map(({ scheme, user, host, params }) => `${scheme}:${user}@${host}${params}`);

/** Any caller identity — phone-number-like or SIP-URI-like. */
const callerIdentity: fc.Arbitrary<string> = fc.oneof(
  phoneLikeIdentity,
  sipUriIdentity
);

/** A per-character case mask, applied cyclically to produce mixed-case variants. */
const caseMask = fc.array(fc.boolean(), { minLength: 1, maxLength: 40 });

/** Toggle the case of each character using the mask cyclically. */
function applyCase(s: string, mask: boolean[]): string {
  return s
    .split('')
    .map((ch, i) => (mask[i % mask.length] ? ch.toUpperCase() : ch.toLowerCase()))
    .join('');
}

describe('voice sender mapping (Sender_Mapping)', () => {
  // Feature: roza-step3-voice-telephony, Property 5: Voice Sender_Mapping determinism and cross-channel non-collision
  // Validates: Requirements 10.1, 14.2

  it('Property 5: userIdForVoice is deterministic across repeated calls', () => {
    fc.assert(
      fc.property(callerIdentity, (identity) => {
        // The same Caller_Identity always derives the same user_id (Req 10.1).
        expect(userIdForVoice(identity)).toBe(userIdForVoice(identity));
        expect(normalizeCallerIdentity(identity)).toBe(
          normalizeCallerIdentity(identity)
        );
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 5: every voice user_id carries the voice: prefix', () => {
    fc.assert(
      fc.property(callerIdentity, (identity) => {
        // The channel stamps its own prefix (Req 10.1, 14.2).
        expect(userIdForVoice(identity).startsWith('voice:')).toBe(true);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 5: a voice user_id never collides with a telegram or email user_id', () => {
    fc.assert(
      fc.property(
        callerIdentity,
        fc.string({ maxLength: 32 }),
        fc.string({ maxLength: 32 }),
        (identity, anyTelegram, anyEmail) => {
          const voice = userIdForVoice(identity);
          const telegram = userIdForTelegram(anyTelegram);
          const email = userIdForEmail(anyEmail);

          // Distinct channel prefixes guarantee disjoint namespaces (Req 14.2):
          // the `voice:` prefix can never match `telegram:` or `email:`, so no
          // generated x, y can make the user_ids equal.
          expect(voice.startsWith('voice:')).toBe(true);
          expect(telegram.startsWith('telegram:')).toBe(true);
          expect(email.startsWith('email:')).toBe(true);

          expect(voice).not.toBe(telegram);
          expect(voice).not.toBe(email);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 5: surrounding whitespace does not change the derived user_id', () => {
    fc.assert(
      fc.property(callerIdentity, whitespace, whitespace, (identity, lead, trail) => {
        const padded = `${lead}${identity}${trail}`;

        // Identities differing only by surrounding whitespace map identically (Req 10.1).
        expect(userIdForVoice(padded)).toBe(userIdForVoice(identity));
        expect(normalizeCallerIdentity(padded)).toBe(
          normalizeCallerIdentity(identity)
        );
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 5: SIP URIs normalize case-insensitively', () => {
    fc.assert(
      fc.property(sipUriIdentity, caseMask, (uri, mask) => {
        // A mixed-case rendering of the same SIP URI must collapse to the same
        // user_id as its canonical (lowercased) form (Req 10.1).
        const cased = applyCase(uri, mask);
        expect(userIdForVoice(cased)).toBe(userIdForVoice(uri.toLowerCase()));
        expect(userIdForVoice(cased)).toBe(userIdForVoice(uri));
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
