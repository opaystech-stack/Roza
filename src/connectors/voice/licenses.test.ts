// Feature: roza-step3-voice-telephony, Property 12: Selected-component license manifest is complete and commercial-safe
//
// Validates: Requirements 3.1, 3.2, 3.3, 3.4
//
// Property 12 asserts two things about the selected-component license manifest:
//   1. The manifest is COMPLETE and COMMERCIAL-SAFE — every voice/telephony
//      role ('tts','stt','telephony') has exactly one entry, each with a
//      non-empty component name, a license drawn from the commercial-use
//      allowlist, and `commercialUse === true`; and no entry carries a
//      non-commercial license (Req 3.1, 3.2, 3.4).
//   2. The `isCommercialUseLicense` gate that protects the manifest is sound —
//      it rejects non-commercial identifiers and arbitrary unknown strings, and
//      accepts allowlist members regardless of case or surrounding whitespace
//      (Req 3.1, 3.2, 3.3).

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  VOICE_COMPONENT_LICENSES,
  VOICE_COMPONENT_LICENSE_BY_ROLE,
  COMMERCIAL_USE_LICENSE_ALLOWLIST,
  isCommercialUseLicense,
  type VoiceComponentRole,
} from './licenses.js';

/** The exhaustive set of roles the manifest must cover. */
const ALL_ROLES: readonly VoiceComponentRole[] = ['tts', 'stt', 'telephony'];

/** Allowlist as a plain array for generator use. */
const ALLOWLIST = [...COMMERCIAL_USE_LICENSE_ALLOWLIST];

/**
 * Identifiers that are explicitly NOT commercial-use-safe and therefore must
 * never appear in the manifest and must be rejected by `isCommercialUseLicense`.
 * Includes the two named in the design (Coqui XTTS-v2 non-commercial weights and
 * the CC-BY-NC family).
 */
const NON_COMMERCIAL_IDENTIFIERS: readonly string[] = [
  'CC-BY-NC-4.0',
  'CC-BY-NC-SA-4.0',
  'CC-BY-NC-ND-4.0',
  'Coqui Public Model License',
  '',
  '   ',
];

/** Normalize the way `isCommercialUseLicense` does, for collision filtering. */
function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/** Set of normalized allowlist identifiers, for fast "is a member" checks. */
const NORMALIZED_ALLOWLIST = new Set(ALLOWLIST.map(normalize));

/** Randomly perturb the case of each character of `s` given a parallel mask. */
function perturbCase(s: string, mask: readonly boolean[]): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    out += mask[i] ? ch.toUpperCase() : ch.toLowerCase();
  }
  return out;
}

describe('VOICE_COMPONENT_LICENSES manifest (Property 12)', () => {
  it('covers every role exactly once with a non-empty, commercial-safe, allowlisted license', () => {
    // Exactly one entry per required role — no missing roles, no duplicates,
    // and no unexpected roles. (Req 3.4 completeness.)
    expect(VOICE_COMPONENT_LICENSES).toHaveLength(ALL_ROLES.length);
    const seenRoles = VOICE_COMPONENT_LICENSES.map((e) => e.role).sort();
    expect(seenRoles).toEqual([...ALL_ROLES].sort());

    for (const role of ALL_ROLES) {
      const entries = VOICE_COMPONENT_LICENSES.filter((e) => e.role === role);
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;

      // Non-empty component name (Req 3.4).
      expect(entry.component.trim().length).toBeGreaterThan(0);

      // License drawn from the commercial-use allowlist (Req 3.1, 3.2).
      expect(COMMERCIAL_USE_LICENSE_ALLOWLIST.has(entry.license)).toBe(true);
      expect(isCommercialUseLicense(entry.license)).toBe(true);

      // Explicit commercial-use permission flag (Req 3.2, 3.4).
      expect(entry.commercialUse).toBe(true);

      // The by-role view agrees with the array (Req 3.4 auditability).
      expect(VOICE_COMPONENT_LICENSE_BY_ROLE[role]).toEqual(entry);
    }
  });

  it('records the telephony gateway client as ari-client under Apache-2.0', () => {
    // Phase 3 links node-ari-client (Apache-2.0) into Roza's own process; the
    // GPL Asterisk daemon runs as a separate service and is not in the manifest.
    const telephony = VOICE_COMPONENT_LICENSE_BY_ROLE.telephony;
    expect(telephony.component).toBe('ari-client');
    expect(telephony.license).toBe('Apache-2.0');
    expect(telephony.commercialUse).toBe(true);
  });

  it('carries no non-commercial license in any entry', () => {
    // No manifest entry may use a non-commercial identifier (Req 3.1, 3.2).
    const nonCommercialNormalized = new Set(
      NON_COMMERCIAL_IDENTIFIERS.map(normalize),
    );
    for (const entry of VOICE_COMPONENT_LICENSES) {
      expect(nonCommercialNormalized.has(normalize(entry.license))).toBe(false);
      expect(isCommercialUseLicense(entry.license)).toBe(true);
    }
  });

  it('rejects every explicitly non-commercial identifier', () => {
    for (const id of NON_COMMERCIAL_IDENTIFIERS) {
      expect(isCommercialUseLicense(id)).toBe(false);
    }
  });
});

describe('isCommercialUseLicense gate (Property 12)', () => {
  it('returns false for non-commercial identifiers and arbitrary unknown strings', () => {
    const arbitrary = fc.oneof(
      // The named non-commercial identifiers.
      fc.constantFrom(...NON_COMMERCIAL_IDENTIFIERS),
      // Arbitrary strings that are NOT allowlist members after normalization.
      fc
        .string()
        .filter((s) => !NORMALIZED_ALLOWLIST.has(normalize(s))),
    );

    fc.assert(
      fc.property(arbitrary, (license) => {
        expect(isCommercialUseLicense(license)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('returns true for allowlist members regardless of case or surrounding whitespace', () => {
    const padding = fc.constantFrom('', ' ', '  ', '\t', '\n', ' \t ');

    fc.assert(
      fc.property(
        fc.constantFrom(...ALLOWLIST),
        fc.array(fc.boolean(), { minLength: 0, maxLength: 64 }),
        padding,
        padding,
        (license, caseMask, left, right) => {
          const perturbed = left + perturbCase(license, caseMask) + right;
          expect(isCommercialUseLicense(perturbed)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});
