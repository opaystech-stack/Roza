// Feature: roza-step5-x-twitter, Property 12: X component manifest is open-source and free of any paid dependency
//
// Validates: Requirements 2.1, 2.2, 2.3
//
// Property 12 asserts two things about the X-capability license manifest:
//   1. The manifest is OPEN-SOURCE and FREE OF ANY PAID DEPENDENCY — every
//      entry has a non-empty component name, a license accepted by
//      `isCommercialUseLicense` with `commercialUse === true` and
//      `paid === false`, both X-capability roles ('browser_automation',
//      'session_persistence') are present, and no entry names a paid X/Twitter
//      API or a paid social-media SaaS (Req 2.1, 2.2, 2.3).
//   2. The `isCommercialUseLicense` gate that protects the manifest is sound —
//      it accepts every allowlist member regardless of case or surrounding
//      whitespace and rejects non-commercial identifiers (CC-BY-NC family) and
//      arbitrary unknown strings (Req 2.1, 2.2).

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  X_COMPONENT_LICENSES,
  X_COMMERCIAL_USE_LICENSE_ALLOWLIST,
  isCommercialUseLicense,
  type XComponentRole,
} from './licenses.js';

/** The exhaustive set of roles the manifest must cover (completeness). */
const ALL_ROLES: readonly XComponentRole[] = [
  'browser_automation',
  'session_persistence',
];

/** Allowlist as a plain array for generator use. */
const ALLOWLIST = [...X_COMMERCIAL_USE_LICENSE_ALLOWLIST];

/** Normalize the way `isCommercialUseLicense` does, for collision filtering. */
function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/** Set of normalized allowlist identifiers, for fast "is a member" checks. */
const NORMALIZED_ALLOWLIST = new Set(ALLOWLIST.map(normalize));

/**
 * Identifiers that are explicitly NOT commercial-use-safe and therefore must
 * never appear in the manifest and must be rejected by `isCommercialUseLicense`.
 */
const NON_COMMERCIAL_IDENTIFIERS: readonly string[] = [
  'CC-BY-NC-4.0',
  'CC-BY-NC-SA-4.0',
  'CC-BY-NC-ND-4.0',
  'research-only',
  '',
  '   ',
];

/**
 * Names of paid X/Twitter APIs and paid social SaaS that must never appear as a
 * component in the manifest. Phase 5 uses only self-hosted browser automation.
 */
const PAID_SOCIAL_SDKS: readonly string[] = [
  'twitter-api-v2',
  'twit',
  'node-twitter',
  'twitter',
  'tweepy',
  'hootsuite',
  'buffer',
  'sprout social',
];

/** Pattern matching obviously-paid or SaaS X/Twitter component names. */
const PAID_NAME_PATTERN = /twitter api|x api|tweepy|paid|saas/i;

/** Randomly perturb the case of each character of `s` given a parallel mask. */
function perturbCase(s: string, mask: readonly boolean[]): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    out += mask[i] ? ch.toUpperCase() : ch.toLowerCase();
  }
  return out;
}

describe('X_COMPONENT_LICENSES manifest (Property 12)', () => {
  it('covers both roles with a non-empty, commercial-safe, allowlisted, non-paid license', () => {
    // Completeness: both X-capability roles are present (Req 2.1).
    const seenRoles = new Set(X_COMPONENT_LICENSES.map((e) => e.role));
    for (const role of ALL_ROLES) {
      expect(seenRoles.has(role)).toBe(true);
    }

    // Every entry is well-formed, commercial-safe, and free (Req 2.1, 2.2, 2.3).
    for (const entry of X_COMPONENT_LICENSES) {
      // The role is one of the modelled X-capability roles.
      expect(ALL_ROLES).toContain(entry.role);

      // Non-empty component name (Req 2.1).
      expect(entry.component.trim().length).toBeGreaterThan(0);

      // License drawn from the commercial-use allowlist and accepted by the gate.
      expect(X_COMMERCIAL_USE_LICENSE_ALLOWLIST.has(entry.license)).toBe(true);
      expect(isCommercialUseLicense(entry.license)).toBe(true);

      // Explicit commercial-use permission flag (Req 2.2).
      expect(entry.commercialUse).toBe(true);

      // No paid dependency anywhere in the manifest (Req 2.2, 2.3).
      expect(entry.paid).toBe(false);
    }
  });

  it('names no paid X/Twitter API or paid social SaaS in any entry', () => {
    const paidNormalized = new Set(PAID_SOCIAL_SDKS.map(normalize));
    for (const entry of X_COMPONENT_LICENSES) {
      const name = normalize(entry.component);
      // No entry is a known paid social SDK / SaaS (Req 2.2, 2.3).
      expect(paidNormalized.has(name)).toBe(false);
      // No entry name matches the paid/SaaS pattern (Req 2.2, 2.3).
      expect(PAID_NAME_PATTERN.test(entry.component)).toBe(false);
    }
  });
});

describe('isCommercialUseLicense gate (Property 12)', () => {
  it('returns true for every allowlist member regardless of case or surrounding whitespace', () => {
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

  it('returns false for non-commercial / non-allowlist identifiers and arbitrary unknown strings', () => {
    const arbitrary = fc.oneof(
      // The named non-commercial identifiers (CC-BY-NC family, research-only).
      fc.constantFrom(...NON_COMMERCIAL_IDENTIFIERS),
      // Arbitrary strings that are NOT allowlist members after normalization.
      fc.string().filter((s) => !NORMALIZED_ALLOWLIST.has(normalize(s))),
    );

    fc.assert(
      fc.property(arbitrary, (license) => {
        expect(isCommercialUseLicense(license)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});
