/**
 * Property-based test for Property 14 — "Missing or invalid fields fall back to
 * documented defaults" (roza-step2-channels, Task 6.5) — Req 1.6, 3.5.
 *
 * Design Correctness Property 14 (design.md):
 *   For any stored or in-memory profile with an arbitrary subset of required
 *   fields missing or failing validation, default substitution (at load time
 *   and at System_Prompt construction time) yields a fully valid profile in
 *   which exactly the missing/invalid fields take their documented default
 *   values while valid fields are preserved, names each defaulted field, and
 *   still produces a complete System_Prompt.
 *
 * Three behaviors are exercised, each at a minimum of 100 fast-check iterations:
 *
 *   1. PURE default substitution — `applyDefaults(candidate)` heals an
 *      arbitrary candidate (a random subset of fields missing/invalid, the rest
 *      already-normalized valid). The returned `value` always passes
 *      `validateProfile`; exactly the missing/invalid fields are reported in
 *      `defaulted` (by name); valid fields are preserved byte-for-byte; and each
 *      defaulted field equals DEFAULT_PROFILE's value.
 *
 *   2. LOAD time — the same partially-invalid candidate JSON is persisted via a
 *      REAL temp-DB `repo.upsertProfile`, then `loadProfileOrDefault(repo,
 *      logger)` returns a fully valid profile with the invalid fields healed to
 *      their documented defaults.
 *
 *   3. PROMPT-CONSTRUCTION time — `buildPersona(value)` never throws and always
 *      returns a non-empty, complete System_Prompt for the healed profile.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

import { openDatabase } from './db.js';
import { createRepository, type Repository } from './repository.js';
import {
  applyDefaults,
  DEFAULT_PROFILE,
  loadProfileOrDefault,
  validateProfile,
  type ProfileLang,
  type RozaProfile,
} from './profile.js';
import { buildPersona } from './persona.js';
import type { Logger } from './types.js';

const NUM_RUNS = 100;

/** A no-op logger — the properties assert on returned values, not on log lines. */
const noopLogger: Logger = {
  info(): void {},
  error(): void {},
};

let tempDir: string;
let db: Database.Database;
let repo: Repository;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roza-profile-defaults-test-'));
  db = openDatabase(tempDir, 'v1');
  repo = createRepository(db, { secret: 'test-secret', keyVersion: 'v1' });
});

afterEach(() => {
  db.close();
  // Best-effort teardown: a still-open SQLite handle can briefly hold a Windows
  // lock, so a removal failure must not fail the test.
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore — cleanup is best-effort.
  }
});

// ---------------------------------------------------------------------------
// Generators — only ALREADY-NORMALIZED valid values, so that validateProfile /
// applyDefaults (which trim strings and copy arrays) act as the identity on the
// valid fields and exact "preserved unchanged" equality can be asserted.
// ---------------------------------------------------------------------------

/** Characters safe to compose into trimmed, non-whitespace tokens. */
const tokenChar = fc.constantFrom(
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./@#'.split('')
);

/** A non-empty token with no surrounding (or any) whitespace — trim is the identity. */
const tokenArb = fc.array(tokenChar, { minLength: 1, maxLength: 24 }).map((chars) => chars.join(''));

/** A single profile language code. */
const langArb = fc.constantFrom<ProfileLang>('fr', 'en', 'sw', 'ln');

/** Lowercase alphanumeric part for a well-formed, already-trimmed email address. */
const emailPart = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
    minLength: 1,
    maxLength: 12,
  })
  .map((chars) => chars.join(''));

/** `local@domain.tld` — matches the module's pragmatic email shape, no whitespace. */
const emailArb = fc
  .record({
    local: emailPart,
    domain: emailPart,
    tld: fc.constantFrom('io', 'com', 'org', 'net', 'fr'),
  })
  .map(({ local, domain, tld }) => `${local}@${domain}.${tld}`);

/** A fully-valid, already-normalized RozaProfile — the source of the "valid" values. */
const validProfileArb: fc.Arbitrary<RozaProfile> = fc.record({
  displayName: tokenArb,
  roleTitles: fc.array(tokenArb, { minLength: 1, maxLength: 4 }),
  nativeLanguages: fc.array(langArb, { minLength: 1, maxLength: 4 }),
  learnableLanguages: fc.array(langArb, { minLength: 0, maxLength: 4 }),
  persona: fc.record({ tone: tokenArb, humor: tokenArb, formality: tokenArb }),
  telegramIdentity: tokenArb,
  emailIdentity: emailArb,
  avatarAssetPath: tokenArb,
  workingHours: fc.record({ timezoneRef: tokenArb }),
});

// ---------------------------------------------------------------------------
// Leaf-field descriptors — the eleven required leaves applyDefaults reports on,
// each with where it lives in the candidate object, the exact name it is
// reported under, a concrete invalid value, and accessors for its default and
// its valid value.
// ---------------------------------------------------------------------------

type Place = 'top' | 'persona' | 'workingHours';

interface Leaf {
  /** Stable action key (no dots) used in the generated actions record. */
  key: string;
  /** The field name applyDefaults / validateProfile reports (dotted for nested). */
  name: string;
  /** Where the leaf lives inside the candidate object. */
  place: Place;
  /** The object property key within its place. */
  prop: string;
  /** A concrete value that fails validation for this leaf. */
  invalidValue: unknown;
  /** Read this leaf's value from a (valid) RozaProfile. */
  read: (p: RozaProfile) => unknown;
}

const LEAVES: readonly Leaf[] = [
  { key: 'displayName', name: 'displayName', place: 'top', prop: 'displayName', invalidValue: '', read: (p) => p.displayName },
  { key: 'roleTitles', name: 'roleTitles', place: 'top', prop: 'roleTitles', invalidValue: [], read: (p) => p.roleTitles },
  { key: 'nativeLanguages', name: 'nativeLanguages', place: 'top', prop: 'nativeLanguages', invalidValue: ['xx'], read: (p) => p.nativeLanguages },
  { key: 'learnableLanguages', name: 'learnableLanguages', place: 'top', prop: 'learnableLanguages', invalidValue: ['xx'], read: (p) => p.learnableLanguages },
  { key: 'personaTone', name: 'persona.tone', place: 'persona', prop: 'tone', invalidValue: '', read: (p) => p.persona.tone },
  { key: 'personaHumor', name: 'persona.humor', place: 'persona', prop: 'humor', invalidValue: '', read: (p) => p.persona.humor },
  { key: 'personaFormality', name: 'persona.formality', place: 'persona', prop: 'formality', invalidValue: '', read: (p) => p.persona.formality },
  { key: 'telegramIdentity', name: 'telegramIdentity', place: 'top', prop: 'telegramIdentity', invalidValue: '', read: (p) => p.telegramIdentity },
  { key: 'emailIdentity', name: 'emailIdentity', place: 'top', prop: 'emailIdentity', invalidValue: 'not-an-email', read: (p) => p.emailIdentity },
  { key: 'avatarAssetPath', name: 'avatarAssetPath', place: 'top', prop: 'avatarAssetPath', invalidValue: '', read: (p) => p.avatarAssetPath },
  { key: 'timezoneRef', name: 'workingHours.timezoneRef', place: 'workingHours', prop: 'timezoneRef', invalidValue: '', read: (p) => p.workingHours.timezoneRef },
];

/** Read the documented-default value for a leaf, by name. */
function defaultFor(leaf: Leaf): unknown {
  return leaf.read(DEFAULT_PROFILE);
}

/** Per-field action: keep valid, omit the key entirely, or set an invalid value. */
type FieldAction = 'valid' | 'omit' | 'invalidValue';
const fieldActionArb = fc.constantFrom<FieldAction>('valid', 'omit', 'invalidValue');

/** A record assigning an independent action to each of the eleven leaves. */
const actionsArb = fc.record(
  Object.fromEntries(LEAVES.map((leaf) => [leaf.key, fieldActionArb])) as Record<
    string,
    fc.Arbitrary<FieldAction>
  >
);

type Actions = Record<string, FieldAction>;

/**
 * Build a candidate object from a valid baseline and a per-leaf action map.
 * `valid` leaves carry the baseline's normalized value; `omit` leaves have
 * their key deleted (modelling a missing field); `invalidValue` leaves carry a
 * concrete value that fails validation.
 */
function buildCandidate(valid: RozaProfile, actions: Actions): Record<string, unknown> {
  const top: Record<string, unknown> = {
    displayName: valid.displayName,
    roleTitles: [...valid.roleTitles],
    nativeLanguages: [...valid.nativeLanguages],
    learnableLanguages: [...valid.learnableLanguages],
    telegramIdentity: valid.telegramIdentity,
    emailIdentity: valid.emailIdentity,
    avatarAssetPath: valid.avatarAssetPath,
  };
  const persona: Record<string, unknown> = {
    tone: valid.persona.tone,
    humor: valid.persona.humor,
    formality: valid.persona.formality,
  };
  const workingHours: Record<string, unknown> = { timezoneRef: valid.workingHours.timezoneRef };

  const target = (place: Place): Record<string, unknown> =>
    place === 'top' ? top : place === 'persona' ? persona : workingHours;

  for (const leaf of LEAVES) {
    const action = actions[leaf.key];
    const obj = target(leaf.place);
    if (action === 'omit') {
      delete obj[leaf.prop];
    } else if (action === 'invalidValue') {
      obj[leaf.prop] = leaf.invalidValue;
    }
    // 'valid' leaves keep the baseline value already populated above.
  }

  top.persona = persona;
  top.workingHours = workingHours;
  return top;
}

/** The set of leaf names whose action makes them missing/invalid (i.e. defaulted). */
function expectedDefaultedNames(actions: Actions): Set<string> {
  return new Set(LEAVES.filter((leaf) => actions[leaf.key] !== 'valid').map((leaf) => leaf.name));
}

/** Assert a healed leaf equals either the preserved valid value or the documented default. */
function assertLeaf(leaf: Leaf, healed: RozaProfile, valid: RozaProfile, actions: Actions): void {
  const wasDefaulted = actions[leaf.key] !== 'valid';
  const expected = wasDefaulted ? defaultFor(leaf) : leaf.read(valid);
  expect(leaf.read(healed)).toEqual(expected);
}

// ---------------------------------------------------------------------------
// Property 14 — default substitution at load and prompt-construction time
// ---------------------------------------------------------------------------

describe('Property 14: Missing or invalid fields fall back to documented defaults', () => {
  // Feature: roza-step2-channels, Property 14: Missing or invalid fields fall back to documented defaults
  // Validates: Requirements 1.6, 3.5
  it('applyDefaults heals every missing/invalid field, preserves valid fields, and produces a complete prompt', () => {
    fc.assert(
      fc.property(validProfileArb, actionsArb, (valid, actions) => {
        const candidate = buildCandidate(valid, actions as Actions);

        const { value, defaulted } = applyDefaults(candidate);

        // The healed profile is ALWAYS fully valid (Req 1.6, 3.5).
        expect(validateProfile(value).ok).toBe(true);

        // Exactly the missing/invalid fields are reported as defaulted — by name.
        const reported = new Set(defaulted.map((e) => e.field));
        expect(reported).toEqual(expectedDefaultedNames(actions as Actions));

        // Each leaf is either preserved unchanged (valid) or equal to its default.
        for (const leaf of LEAVES) {
          assertLeaf(leaf, value, valid, actions as Actions);
        }

        // Prompt-construction time: buildPersona never throws and yields a
        // non-empty, complete System_Prompt for the healed profile (Req 3.5).
        const prompt = buildPersona(value);
        expect(typeof prompt).toBe('string');
        expect(prompt.trim().length).toBeGreaterThan(0);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  // Feature: roza-step2-channels, Property 14: Missing or invalid fields fall back to documented defaults
  // Validates: Requirements 1.6, 3.5
  it('loadProfileOrDefault heals a persisted partially-invalid profile to defaults over a real temp-DB repo', () => {
    fc.assert(
      fc.property(validProfileArb, actionsArb, (valid, actions) => {
        const candidate = buildCandidate(valid, actions as Actions);

        // Persist the partially-invalid candidate JSON into the single-row store.
        repo.upsertProfile(JSON.stringify(candidate));

        // Load time: the stored row is healed field-by-field and startup continues.
        const loaded = loadProfileOrDefault(repo, noopLogger);

        // The loaded profile is fully valid (Req 1.6).
        expect(validateProfile(loaded).ok).toBe(true);

        // Invalid/missing fields are healed to documented defaults; valid fields preserved.
        for (const leaf of LEAVES) {
          assertLeaf(leaf, loaded, valid, actions as Actions);
        }

        // And a complete System_Prompt is still produced from the healed profile.
        const prompt = buildPersona(loaded);
        expect(typeof prompt).toBe('string');
        expect(prompt.trim().length).toBeGreaterThan(0);
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
