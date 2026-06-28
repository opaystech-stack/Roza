/**
 * Property-based tests for the pure language helpers in `language.ts`
 * (Properties 15 and 16 of the roza-agent design).
 *
 * These exercise ONLY the side-effect-free helpers — `resolveResponseLanguage`,
 * `appendTaughtTerm`, and `extractTaughtTerms`. The module performs no I/O and
 * is expected never to throw on malformed stored data. Each property runs a
 * minimum of 100 fast-check iterations.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  resolveResponseLanguage,
  appendTaughtTerm,
  extractTaughtTerms,
  CONFIDENCE_THRESHOLD,
  MAX_TAUGHT_TERMS,
  type Lang,
  type TaughtTerm,
} from './language.js';

const NUM_RUNS = 200;

/** A detection result: language in {fr, en, null} with a confidence in [0,1]. */
const detection = fc.record({
  lang: fc.constantFrom<Lang | null>('fr', 'en', null),
  confidence: fc.double({ min: 0, max: 1, noNaN: true }),
});

/** The user's remembered (last detected) language, in {fr, en, null}. */
const lastDetected = fc.constantFrom<Lang | null>('fr', 'en', null);

/** A taught Swahili/Lingala term/meaning pair. */
const taughtTerm: fc.Arbitrary<TaughtTerm> = fc.record({
  term: fc.string({ minLength: 1 }),
  meaning: fc.string({ minLength: 1 }),
  lang: fc.constantFrom<'sw' | 'ln'>('sw', 'ln'),
});

describe('language helpers', () => {
  // Feature: roza-agent, Property 15: Response language resolution
  // Validates: Requirements 7.1, 7.2
  it('Property 15: resolves via the confident-detection → last-detected → French fallback chain', () => {
    fc.assert(
      fc.property(detection, lastDetected, (detected, last) => {
        const result = resolveResponseLanguage(detected, last);

        // The result is always a concrete language directive (never null).
        expect(result === 'fr' || result === 'en').toBe(true);

        // Tier 1: a confident, non-null detection wins outright.
        if (detected.lang !== null && detected.confidence >= CONFIDENCE_THRESHOLD) {
          expect(result).toBe(detected.lang);
          return;
        }

        // Tier 2: otherwise fall back to the last detected language when known.
        if (last !== null) {
          expect(result).toBe(last);
          return;
        }

        // Tier 3: with neither a confident detection nor a remembered language,
        // default to French.
        expect(result).toBe('fr');
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 15: detections below the confidence threshold never override remembered state', () => {
    const lowConfidence = fc.record({
      lang: fc.constantFrom<Lang | null>('fr', 'en', null),
      confidence: fc.double({ min: 0, max: CONFIDENCE_THRESHOLD, noNaN: true, maxExcluded: true }),
    });

    fc.assert(
      fc.property(lowConfidence, lastDetected, (detected, last) => {
        // Below threshold, the fresh detection is ignored entirely.
        expect(resolveResponseLanguage(detected, last)).toBe(last ?? 'fr');
      }),
      { numRuns: NUM_RUNS }
    );
  });

  // Feature: roza-agent, Property 16: Taught-term round-trip
  // Validates: Requirements 7.3
  it('Property 16: extracts the most-recent min(count, max) appended terms in order, fields intact', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.array(taughtTerm, { minLength: 0, maxLength: 80 }),
        fc.integer({ min: 1, max: 100 }),
        (initialNotes, terms, max) => {
          // Append every term in sequence, threading the serialized blob.
          let notes = initialNotes;
          for (const term of terms) {
            notes = appendTaughtTerm(notes, term);
          }

          const extracted = extractTaughtTerms(notes, max);

          const expectedCount = Math.min(terms.length, max);
          expect(extracted).toHaveLength(expectedCount);

          // The extracted slice is the trailing (most-recent) `expectedCount`
          // terms, preserving order and every field exactly.
          const expected = terms.slice(terms.length - expectedCount);
          expect(extracted).toEqual(
            expected.map((t) => ({ term: t.term, meaning: t.meaning, lang: t.lang }))
          );
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 16: a single appended term round-trips intact through extraction', () => {
    fc.assert(
      fc.property(fc.string(), taughtTerm, (initialNotes, term) => {
        const notes = appendTaughtTerm(initialNotes, term);
        const [extracted] = extractTaughtTerms(notes, MAX_TAUGHT_TERMS);

        expect(extracted).toEqual({ term: term.term, meaning: term.meaning, lang: term.lang });
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 16: appendTaughtTerm preserves free-form notes text across appends', () => {
    fc.assert(
      fc.property(
        // Start from a well-formed notes blob carrying free-form text so the
        // preserved field is observable across serialization round-trips.
        fc.string(),
        fc.array(taughtTerm, { minLength: 1, maxLength: 20 }),
        (freeText, terms) => {
          let notes = JSON.stringify({ notes: freeText, taughtTerms: [] });
          for (const term of terms) {
            notes = appendTaughtTerm(notes, term);
          }

          // The free-form notes text survives every append intact.
          const parsed = JSON.parse(notes) as { notes: string };
          expect(parsed.notes).toBe(freeText);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 16: malformed JSON is treated defensively — no throw, empty terms', () => {
    // Arbitrary strings that are (almost surely) not the expected notes shape.
    const malformed = fc.oneof(
      fc.string(),
      fc.constant('{ not json'),
      fc.constant('null'),
      fc.constant('[]'),
      fc.constant('42'),
      fc.constant('"a string"'),
      fc.constant('{"taughtTerms": "nope"}'),
      fc.constant('{"taughtTerms": [{"term": 1, "meaning": 2, "lang": "xx"}]}')
    );

    fc.assert(
      fc.property(malformed, fc.integer({ min: 1, max: 100 }), (notes, max) => {
        expect(() => extractTaughtTerms(notes, max)).not.toThrow();
        // Malformed / non-conforming JSON yields no recoverable taught terms.
        expect(extractTaughtTerms(notes, max)).toEqual([]);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 16: appendTaughtTerm never throws on malformed prior notes and still stores the term', () => {
    const malformed = fc.oneof(
      fc.string(),
      fc.constant('{ not json'),
      fc.constant('null'),
      fc.constant('[1,2,3]')
    );

    fc.assert(
      fc.property(malformed, taughtTerm, (notes, term) => {
        let updated = '';
        expect(() => {
          updated = appendTaughtTerm(notes, term);
        }).not.toThrow();

        const [extracted] = extractTaughtTerms(updated, MAX_TAUGHT_TERMS);
        expect(extracted).toEqual({ term: term.term, meaning: term.meaning, lang: term.lang });
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
