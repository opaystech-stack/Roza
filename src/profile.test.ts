/**
 * Property-based tests for the Roza_Profile load/edit surface (`profile.ts`).
 *
 * Covers three design Correctness Properties, each run against a REAL, isolated
 * `better-sqlite3` database created per test under the OS temp dir and removed
 * in `afterEach` (no `:memory:`, no mocks — the round-trip and rejection
 * properties must exercise the actual single-row `roza_profile` store):
 *
 *   - 3.5 / Property 12 — Profile persistence round-trip (Req 1.3, 2.2).
 *   - 3.6 / Property 13 — Invalid edits are rejected wholesale and name each
 *                         invalid field (Req 2.3).
 *   - 3.7 / Property 11 — Channel credentials are never persisted (Req 2.5, 4.5).
 *
 * Every property runs a minimum of 100 fast-check iterations.
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
  DEFAULT_PROFILE,
  editProfile,
  loadProfileOrDefault,
  type ProfileLang,
  type RozaProfile,
} from './profile.js';
import type { Logger } from './types.js';

const NUM_RUNS = 100;

/** A logger that records nothing — the pure properties assert on values, not logs. */
const logger: Logger = {
  info(): void {},
  error(): void {},
};

let tempDir: string;
let db: Database.Database;
let repo: Repository;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roza-profile-test-'));
  db = openDatabase(tempDir, 'v1');
  repo = createRepository(db, { secret: 'test-secret', keyVersion: 'v1' });
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Generators — only ALREADY-NORMALIZED valid values, so a validateProfile pass
// (which trims strings and copies arrays) is the identity on what we generate
// and the round-trip can assert exact structural equality.
// ---------------------------------------------------------------------------

/** Characters safe to compose into trimmed, non-whitespace tokens. */
const tokenChar = fc.constantFrom(
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./@#'.split('')
);

/** A non-empty token with no surrounding (or any) whitespace — trim is the identity. */
const tokenArb = fc
  .array(tokenChar, { minLength: 1, maxLength: 24 })
  .map((chars) => chars.join(''));

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
  .record({ local: emailPart, domain: emailPart, tld: fc.constantFrom('io', 'com', 'org', 'net', 'fr') })
  .map(({ local, domain, tld }) => `${local}@${domain}.${tld}`);

/** A fully-valid, already-normalized RozaProfile. */
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
// 3.5 / Property 12 — Profile persistence round-trip
// ---------------------------------------------------------------------------

describe('Property 12: Profile persistence round-trip', () => {
  // Feature: roza-step2-channels, Property 12: Profile persistence round-trip
  // Validates: Requirements 1.3, 2.2
  it('persists an edited valid profile and loads back an equivalent profile', () => {
    fc.assert(
      fc.property(validProfileArb, (profile) => {
        // A full valid profile is itself a valid edit patch onto the default.
        const result = editProfile(repo, DEFAULT_PROFILE, profile);
        expect(result.ok).toBe(true);

        const loaded = loadProfileOrDefault(repo, logger);
        // Round-trip identity: what we stored is what we read back.
        expect(loaded).toEqual(profile);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  // Feature: roza-step2-channels, Property 12: Profile persistence round-trip
  // Validates: Requirements 1.3, 2.2
  it('persists DEFAULT_PROFILE when none exists and reloads it unchanged', () => {
    // Fresh DB (beforeEach): no profile row yet.
    expect(repo.getProfile()).toBeNull();

    const first = loadProfileOrDefault(repo, logger);
    expect(first).toEqual(DEFAULT_PROFILE);
    // The documented default was persisted as a side effect of the first load.
    expect(repo.getProfile()).not.toBeNull();

    const second = loadProfileOrDefault(repo, logger);
    expect(second).toEqual(DEFAULT_PROFILE);
  });
});

// ---------------------------------------------------------------------------
// 3.6 / Property 13 — Invalid edits are rejected wholesale and name each field
// ---------------------------------------------------------------------------

/** The invalid-edit scenarios, keyed by the exact field name validateProfile reports. */
type InvalidField =
  | 'displayName'
  | 'roleTitles'
  | 'nativeLanguages'
  | 'emailIdentity'
  | 'persona.tone'
  | 'workingHours.timezoneRef';

const INVALID_FIELDS: readonly InvalidField[] = [
  'displayName',
  'roleTitles',
  'nativeLanguages',
  'emailIdentity',
  'persona.tone',
  'workingHours.timezoneRef',
];

/** Apply each chosen invalid scenario onto a patch, returning the patch. */
function buildInvalidPatch(chosen: readonly InvalidField[]): Partial<RozaProfile> {
  // `any` because the whole point is to inject values the type system forbids.
  const patch: Record<string, unknown> = {};
  for (const field of chosen) {
    switch (field) {
      case 'displayName':
        patch.displayName = ''; // empty string — invalid
        break;
      case 'roleTitles':
        patch.roleTitles = []; // empty list — invalid
        break;
      case 'nativeLanguages':
        patch.nativeLanguages = ['xx']; // unknown language code — invalid
        break;
      case 'emailIdentity':
        patch.emailIdentity = 'nope'; // not an email — invalid
        break;
      case 'persona.tone':
        patch.persona = { ...(patch.persona as object | undefined), tone: '' };
        break;
      case 'workingHours.timezoneRef':
        patch.workingHours = { ...(patch.workingHours as object | undefined), timezoneRef: '' };
        break;
    }
  }
  return patch as Partial<RozaProfile>;
}

describe('Property 13: Invalid edits are rejected wholesale and name each invalid field', () => {
  // Feature: roza-step2-channels, Property 13: Invalid edits are rejected wholesale and name each invalid field
  // Validates: Requirements 2.3
  it('rejects the whole edit, names every invalid field, and leaves the store unchanged', () => {
    fc.assert(
      fc.property(
        validProfileArb,
        fc.subarray(INVALID_FIELDS as InvalidField[], { minLength: 1 }),
        (base, chosen) => {
          // Seed the store with a known-valid profile and snapshot it.
          repo.upsertProfile(JSON.stringify(base));
          const before = repo.getProfile();

          const patch = buildInvalidPatch(chosen);
          const result = editProfile(repo, base, patch);

          // The edit is rejected wholesale.
          expect(result.ok).toBe(false);
          if (result.ok) return;

          // Every invalid field is named — no more, no less.
          const reported = new Set(result.errors.map((e) => e.field));
          expect(reported).toEqual(new Set(chosen));

          // The stored profile is byte-for-byte unchanged.
          expect(repo.getProfile()).toBe(before);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});

// ---------------------------------------------------------------------------
// 3.7 / Property 11 — Channel credentials are never persisted
// ---------------------------------------------------------------------------

/** The known, complete key set of a serialized RozaProfile. */
const PROFILE_KEYS = [
  'displayName',
  'roleTitles',
  'nativeLanguages',
  'learnableLanguages',
  'persona',
  'telegramIdentity',
  'emailIdentity',
  'avatarAssetPath',
  'workingHours',
].sort();
const PERSONA_KEYS = ['tone', 'humor', 'formality'].sort();
const WORKING_HOURS_KEYS = ['timezoneRef'].sort();

/** Assert an object exposes ONLY the documented profile keys (no credential fields). */
function expectOnlyProfileKeys(obj: unknown): void {
  expect(obj && typeof obj === 'object').toBe(true);
  const record = obj as Record<string, unknown>;
  expect(Object.keys(record).sort()).toEqual(PROFILE_KEYS);
  expect(Object.keys(record.persona as object).sort()).toEqual(PERSONA_KEYS);
  expect(Object.keys(record.workingHours as object).sort()).toEqual(WORKING_HOURS_KEYS);
}

/** A distinctively-prefixed credential value so it can never collide with profile content. */
const credArb = fc.string({ maxLength: 24 }).map((s) => `CREDENTIAL-${s.replace(/\s/g, '')}`);

describe('Property 11: Channel credentials are never persisted', () => {
  // Feature: roza-step2-channels, Property 11: Channel credentials are never persisted
  // Validates: Requirements 2.5, 4.5
  it('strips injected credential-like fields and never writes a secret to the store', () => {
    fc.assert(
      fc.property(
        validProfileArb,
        fc.record({ botToken: credArb, password: credArb, token: credArb, credential: credArb }),
        (profile, creds) => {
          // Inject credential-like fields alongside the valid profile fields.
          const patch = { ...profile, ...creds } as unknown as Partial<RozaProfile>;

          const result = editProfile(repo, DEFAULT_PROFILE, patch);
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          // The returned profile carries only known fields.
          expectOnlyProfileKeys(result.value);

          // The serialized stored row carries only known fields — no credential keys.
          const storedRaw = repo.getProfile();
          expect(storedRaw).not.toBeNull();
          const stored = JSON.parse(storedRaw as string) as unknown;
          expectOnlyProfileKeys(stored);

          // A subsequent load also yields a credential-free profile.
          expectOnlyProfileKeys(loadProfileOrDefault(repo, logger));

          // No injected secret value survives anywhere in the persisted JSON.
          for (const secret of Object.values(creds)) {
            expect(storedRaw as string).not.toContain(secret);
          }
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});
