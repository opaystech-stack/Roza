import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  buildMessages,
  MAX_PROMPT_MESSAGES,
  MAX_PROMPT_TAUGHT_TERMS,
  type PromptContext,
} from './prompt.js';
import { SYSTEM_PROMPT } from './persona.js';
import type { HumanRelationship, Message } from './types.js';
import type { Lang, TaughtTerm } from './language.js';

/**
 * Generators
 *
 * Every injected text fragment is a fixed-length, prefix-tagged sentinel token
 * so that (a) inclusion assertions are unambiguous substring checks and (b)
 * exclusion assertions are sound: distinct same-length tokens can never be a
 * substring of one another, and distinct prefixes (M/T/G/N/R) never collide
 * across the relationship profile, history, and taught-term blocks.
 */

/** A 13-char token `<prefix><12 hex>` — unique per draw, never a substring of a sibling. */
function token(prefix: string): fc.Arbitrary<string> {
  return fc.hexaString({ minLength: 12, maxLength: 12 }).map((h) => prefix + h);
}

/** ISO timestamp built from a bounded epoch so `toISOString()` never throws. */
const isoTimestampArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 4_102_444_800_000 }) // 1970-01-01 .. ~2100
  .map((n) => new Date(n).toISOString());

const relationshipArb: fc.Arbitrary<HumanRelationship> = fc.record({
  id: fc.uuid(),
  user_id: fc.uuid(),
  full_name: fc.option(token('N'), { nil: null }),
  role: fc.option(token('R'), { nil: null }),
  affinity_score: fc.double({ min: 0, max: 1, noNaN: true }),
  personality_notes: fc.string(),
  last_language: fc.constantFrom<Lang | null>('fr', 'en', null),
  last_interaction: fc.option(isoTimestampArb, { nil: null }),
});

/** Messages keyed unique by their sentinel content; sized to straddle the 20 cap. */
const recentMessagesArb: fc.Arbitrary<Message[]> = fc.uniqueArray(
  fc.record({
    id: fc.uuid(),
    conversation_id: fc.uuid(),
    sender_type: fc.constantFrom('user', 'roza') as fc.Arbitrary<Message['sender_type']>,
    content: token('M'),
    created_at: isoTimestampArb,
  }),
  { selector: (m) => m.content, minLength: 0, maxLength: 30 },
);

/** Taught terms keyed unique by their sentinel term; sized to straddle the 50 cap. */
const taughtTermsArb: fc.Arbitrary<TaughtTerm[]> = fc.uniqueArray(
  fc.record({
    term: token('T'),
    meaning: token('G'),
    lang: fc.constantFrom('sw', 'ln') as fc.Arbitrary<TaughtTerm['lang']>,
  }),
  { selector: (t) => t.term, minLength: 0, maxLength: 70 },
);

const contextArb: fc.Arbitrary<PromptContext> = fc.record({
  relationship: relationshipArb,
  recentMessages: recentMessagesArb,
  taughtTerms: taughtTermsArb,
  targetLanguage: fc.constantFrom<Lang>('fr', 'en'),
});

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('prompt — System_Prompt assembly', () => {
  // Feature: roza-agent, Property 13: System prompt carries persona and injected memory —
  // for any prompt context, the constructed system prompt declares Roza's persona
  // verbatim (Co-founder/CTO/COO, empathetic-but-rigorous peer, no sales jargon /
  // corporate marketing speech, FR/EN native + Swahili/Lingala learning) and injects
  // the relationship profile, the most-recent recent messages (capped at 20), and the
  // most-recent taught terms (capped at 50), then ends with the user turn.
  // Validates: Requirements 5.3, 5.4, 5.5, 6.3, 7.6
  it('Property 13: carries persona verbatim and the capped injected memory', () => {
    fc.assert(
      fc.property(contextArb, fc.string(), (ctx, userMessage) => {
        const messages = buildMessages(ctx, userMessage);

        // Shape: leading system message, trailing user-role turn carrying the message.
        expect(messages.length).toBe(2);
        const systemMessage = messages[0];
        const last = messages[messages.length - 1];
        if (!systemMessage || !last) {
          throw new Error('buildMessages must return a system message and a user turn');
        }
        expect(systemMessage.role).toBe('system');
        expect(last.role).toBe('user');
        expect(last.content).toBe(userMessage);

        const system = systemMessage.content;

        // Persona invariants (role, peer, no sales jargon / marketing speech, FR/EN +
        // Swahili/Lingala) hold because the static persona appears verbatim (5.3-5.5).
        expect(system).toContain(SYSTEM_PROMPT);

        // Relationship profile is injected (6.3).
        const rel = ctx.relationship;
        const name = rel.full_name && rel.full_name.trim() ? rel.full_name.trim() : 'Unknown';
        const role = rel.role && rel.role.trim() ? rel.role.trim() : 'Unknown';
        expect(system).toContain(`- Name: ${name}`);
        expect(system).toContain(`- Role: ${role}`);
        expect(system).toContain(`- Affinity score (0.0-1.0): ${rel.affinity_score}`);
        expect(system).toContain(`- Last interaction: ${rel.last_interaction ?? 'never'}`);

        // Recent messages: the most-recent MAX_PROMPT_MESSAGES are injected, older ones
        // are dropped (6.3). Sentinel tokens make both directions exact.
        const msgs = ctx.recentMessages;
        const msgCut = Math.max(0, msgs.length - MAX_PROMPT_MESSAGES);
        for (const m of msgs.slice(msgCut)) {
          expect(system.includes(m.content)).toBe(true);
        }
        for (const m of msgs.slice(0, msgCut)) {
          expect(system.includes(m.content)).toBe(false);
        }

        // Taught terms: the most-recent MAX_PROMPT_TAUGHT_TERMS are injected (7.6).
        const terms = ctx.taughtTerms;
        const termCut = Math.max(0, terms.length - MAX_PROMPT_TAUGHT_TERMS);
        for (const t of terms.slice(termCut)) {
          expect(system.includes(t.term)).toBe(true);
        }
        for (const t of terms.slice(0, termCut)) {
          expect(system.includes(t.term)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  // Feature: roza-agent, Property 14: Exactly one language directive — for any prompt
  // context, the assembled system message contains exactly one language directive, and
  // that directive names exactly one target response language: French XOR English,
  // never both and never neither.
  // Validates: Requirements 7.5
  it('Property 14: emits exactly one directive naming exactly one language', () => {
    fc.assert(
      fc.property(contextArb, fc.string(), (ctx, userMessage) => {
        const messages = buildMessages(ctx, userMessage);
        const systemMessage = messages[0];
        if (!systemMessage) {
          throw new Error('buildMessages must return a leading system message');
        }
        const system = systemMessage.content;

        const marker = 'LANGUAGE DIRECTIVE:';
        // Exactly one directive in the whole system message.
        expect(countOccurrences(system, marker)).toBe(1);

        const directiveLine = system.split('\n').find((line) => line.includes(marker));
        expect(directiveLine).toBeDefined();

        const expectedLabel = ctx.targetLanguage === 'fr' ? 'French' : 'English';
        const otherLabel = ctx.targetLanguage === 'fr' ? 'English' : 'French';
        // Names exactly the resolved language and not the other (XOR).
        expect(directiveLine).toContain(expectedLabel);
        expect(directiveLine).not.toContain(otherLabel);
      }),
      { numRuns: 200 },
    );
  });
});
