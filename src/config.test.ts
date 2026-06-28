/**
 * Property-based tests for the pure configuration validators in `config.ts`
 * (Properties 5, 6, 8 of the roza-agent design).
 *
 * These exercise ONLY the side-effect-free validators — `validateRequiredEnv`,
 * `parseHHMM`, and `resolveActiveWindow`. The imperative `loadConfigOrExit`
 * wrapper is intentionally NOT called here because it performs logging and
 * `process.exit`. Each property runs a minimum of 100 fast-check iterations.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { parseHHMM, resolveActiveWindow, validateRequiredEnv } from './config.js';
import { DEFAULT_WINDOW } from './window.js';

const NUM_RUNS = 200;

/** Build a typed env object from a plain record (values may be undefined). */
function makeEnv(record: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return record as NodeJS.ProcessEnv;
}

/** Two-digit zero-padded string for 0..99. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Format minutes-since-midnight (0..1439) as a valid 24-hour HH:MM string. */
function formatHHMM(minutes: number): string {
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

/** Reference predicate: is `s` a valid 24-hour HH:MM value (after trimming)? */
function isValidHHMM(s: string): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(s.trim());
  if (m === null) {
    return false;
  }
  const h = Number(m[1]);
  const mm = Number(m[2]);
  return h >= 0 && h <= 23 && mm >= 0 && mm <= 59;
}

// A value that should count as "missing": undefined, empty, or whitespace-only.
const blankValue = fc.oneof(
  fc.constant(undefined),
  fc.constant(''),
  fc
    .array(fc.constantFrom(' ', '\t', '\n', '\r', '\v', '\f'), { minLength: 1, maxLength: 8 })
    .map((parts) => parts.join(''))
);

// A value that should count as "present": non-empty after trimming.
const presentValue = fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0);

// A value that is either present or blank.
const blankOrPresent = fc.oneof(blankValue, presentValue);

// Valid HH:MM strings paired with their expected minutes-since-midnight.
const validHHMM = fc
  .tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
  .map(([h, m]) => ({ text: `${pad2(h)}:${pad2(m)}`, expected: h * 60 + m }));

// Strings that are NOT valid HH:MM values (wrong shape, out of range, garbage).
const invalidHHMM = fc
  .oneof(
    // Well-shaped but out of range (e.g. 24:00, 12:75, 99:99).
    fc
      .tuple(fc.integer({ min: 0, max: 99 }), fc.integer({ min: 0, max: 99 }))
      .map(([h, m]) => `${pad2(h)}:${pad2(m)}`),
    // Wrong number of digits / wrong shape.
    fc
      .tuple(fc.integer({ min: 0, max: 9999 }), fc.integer({ min: 0, max: 9999 }))
      .map(([h, m]) => `${h}:${m}`),
    // Arbitrary garbage.
    fc.string()
  )
  .filter((s) => !isValidHHMM(s));

describe('config validators', () => {
  // Feature: roza-agent, Property 5: Required environment validation names the missing variable
  // Validates: Requirements 1.7
  it('Property 5: reports ENV_MISSING naming the missing variable, never its value', () => {
    fc.assert(
      fc.property(blankOrPresent, blankOrPresent, (privateKey, apiKey) => {
        const env = makeEnv({
          ROZA_PRIVATE_KEY: privateKey,
          OPENROUTER_API_KEY: apiKey,
        });

        const privBlank = privateKey === undefined || privateKey.trim().length === 0;
        const apiBlank = apiKey === undefined || apiKey.trim().length === 0;

        const result = validateRequiredEnv(env);

        if (privBlank) {
          // ROZA_PRIVATE_KEY is checked first.
          expect(result.ok).toBe(false);
          if (result.ok) {
            return;
          }
          expect(result.error.kind).toBe('ENV_MISSING');
          expect(result.error.name).toBe('ROZA_PRIVATE_KEY');
          // The error object carries ONLY {kind, name} — no value field leaks.
          expect(Object.keys(result.error).sort()).toEqual(['kind', 'name']);
        } else if (apiBlank) {
          expect(result.ok).toBe(false);
          if (result.ok) {
            return;
          }
          expect(result.error.kind).toBe('ENV_MISSING');
          expect(result.error.name).toBe('OPENROUTER_API_KEY');
          expect(Object.keys(result.error).sort()).toEqual(['kind', 'name']);
        } else {
          // Both present and non-blank.
          expect(result.ok).toBe(true);
        }

        // The error object exposes ONLY {kind, name}: it structurally cannot
        // carry the offending variable's value (no value field exists).
        if (!result.ok) {
          expect(Object.keys(result.error).sort()).toEqual(['kind', 'name']);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  // Feature: roza-agent, Property 6: HH:MM parsing correctness
  // Validates: Requirements 2.3
  it('Property 6: parses valid HH:MM to minutes since midnight', () => {
    fc.assert(
      fc.property(validHHMM, ({ text, expected }) => {
        expect(parseHHMM(text)).toBe(expected);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 6: returns null for any non-HH:MM string', () => {
    fc.assert(
      fc.property(invalidHHMM, (garbage) => {
        expect(parseHHMM(garbage)).toBeNull();
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 6: returns null for undefined input', () => {
    expect(parseHHMM(undefined)).toBeNull();
  });

  // Feature: roza-agent, Property 8: Invalid window configuration falls back to defaults
  // Validates: Requirements 2.4
  it('Property 8: valid ordered window is parsed with usedDefault false', () => {
    const orderedWindow = fc
      .integer({ min: 0, max: 1438 })
      .chain((start) =>
        fc.integer({ min: start + 1, max: 1439 }).map((end) => ({ start, end }))
      );

    fc.assert(
      fc.property(orderedWindow, ({ start, end }) => {
        const env = makeEnv({
          ACTIVE_WINDOW_START: formatHHMM(start),
          ACTIVE_WINDOW_END: formatHHMM(end),
        });

        const result = resolveActiveWindow(env);

        expect(result.usedDefault).toBe(false);
        expect(result.window).toEqual({ startMinutes: start, endMinutes: end });
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 8: missing or invalid window falls back to DEFAULT_WINDOW with usedDefault true', () => {
    const invalidWindowEnv = fc.oneof(
      // Well-formed but not strictly ordered (start >= end).
      fc
        .integer({ min: 0, max: 1439 })
        .chain((end) =>
          fc.integer({ min: end, max: 1439 }).map((start) =>
            makeEnv({
              ACTIVE_WINDOW_START: formatHHMM(start),
              ACTIVE_WINDOW_END: formatHHMM(end),
            })
          )
        ),
      // Invalid start, valid end.
      fc.tuple(invalidHHMM, fc.integer({ min: 0, max: 1439 })).map(([bad, end]) =>
        makeEnv({ ACTIVE_WINDOW_START: bad, ACTIVE_WINDOW_END: formatHHMM(end) })
      ),
      // Valid start, invalid end.
      fc.tuple(fc.integer({ min: 0, max: 1439 }), invalidHHMM).map(([start, bad]) =>
        makeEnv({ ACTIVE_WINDOW_START: formatHHMM(start), ACTIVE_WINDOW_END: bad })
      ),
      // Missing start.
      fc
        .integer({ min: 0, max: 1439 })
        .map((end) => makeEnv({ ACTIVE_WINDOW_END: formatHHMM(end) })),
      // Missing end.
      fc
        .integer({ min: 0, max: 1439 })
        .map((start) => makeEnv({ ACTIVE_WINDOW_START: formatHHMM(start) })),
      // Both missing.
      fc.constant(makeEnv({}))
    );

    fc.assert(
      fc.property(invalidWindowEnv, (env) => {
        const result = resolveActiveWindow(env);

        expect(result.usedDefault).toBe(true);
        expect(result.window).toEqual(DEFAULT_WINDOW);
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
