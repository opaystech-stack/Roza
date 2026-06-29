// Feature: roza-step4-avatar-video, Property 8: Selected-component license manifest is complete and commercial-safe
//
// Validates: Requirements 3.1, 3.2, 3.3, 3.4, 12.3
//
// Property 8 asserts two things about the selected-component license manifest:
//   1. The manifest is COMPLETE and COMMERCIAL-SAFE — every avatar/virtual-device/
//      Meet/streaming role ('renderer','face_analysis','weights','virtual_camera',
//      'virtual_microphone','meet','stream') is present, each entry has a non-empty
//      component name, a license drawn from the commercial-use allowlist, and
//      `commercialUse === true`; and no entry carries a non-commercial license
//      (Req 3.1, 3.2, 3.4).
//   2. The `isCommercialUseLicense` gate that protects the manifest is sound — it
//      accepts every allowlist member regardless of case or surrounding whitespace
//      and rejects non-commercial identifiers (CC-BY-NC, research-only) and
//      arbitrary unknown strings (Req 3.1, 3.2, 3.3, 12.3).

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  AVATAR_COMPONENT_LICENSES,
  AVATAR_COMMERCIAL_USE_LICENSE_ALLOWLIST,
  isCommercialUseLicense,
  type AvatarComponentRole,
} from './licenses.js';

/** The exhaustive set of roles the manifest must cover (completeness). */
const ALL_ROLES: readonly AvatarComponentRole[] = [
  'renderer',
  'face_analysis',
  'weights',
  'virtual_camera',
  'virtual_microphone',
  'meet',
  'stream',
];

/** Allowlist as a plain array for generator use. */
const ALLOWLIST = [...AVATAR_COMMERCIAL_USE_LICENSE_ALLOWLIST];

/**
 * Identifiers that are explicitly NOT commercial-use-safe and therefore must
 * never appear in the manifest and must be rejected by `isCommercialUseLicense`.
 * Includes the non-commercial classes named in the design (CC-BY-NC family,
 * research-only weights such as the InsightFace/Wav2Lip checkpoints).
 */
const NON_COMMERCIAL_IDENTIFIERS: readonly string[] = [
  'CC-BY-NC-4.0',
  'CC-BY-NC-SA-4.0',
  'CC-BY-NC-ND-4.0',
  'research-only',
  'InsightFace non-commercial',
  'Wav2Lip HD (non-commercial)',
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

describe('AVATAR_COMPONENT_LICENSES manifest (Property 8)', () => {
  it('covers every required role with a non-empty, commercial-safe, allowlisted license', () => {
    // Completeness: all 7 required roles are present (Req 3.4).
    const seenRoles = new Set(AVATAR_COMPONENT_LICENSES.map((e) => e.role));
    for (const role of ALL_ROLES) {
      expect(seenRoles.has(role)).toBe(true);
    }

    // Every entry is well-formed and commercial-safe (Req 3.1, 3.2, 3.4).
    for (const entry of AVATAR_COMPONENT_LICENSES) {
      // The role is one of the modelled avatar roles.
      expect(ALL_ROLES).toContain(entry.role);

      // Non-empty component name (Req 3.4).
      expect(entry.component.trim().length).toBeGreaterThan(0);

      // License drawn from the commercial-use allowlist (Req 3.1, 3.2).
      expect(AVATAR_COMMERCIAL_USE_LICENSE_ALLOWLIST.has(entry.license)).toBe(true);
      expect(isCommercialUseLicense(entry.license)).toBe(true);

      // Explicit commercial-use permission flag (Req 3.2, 3.4).
      expect(entry.commercialUse).toBe(true);
    }
  });

  it('carries no non-commercial license in any entry', () => {
    // No manifest entry may use a non-commercial identifier — no Wav2Lip
    // checkpoint, no InsightFace stock model (Req 3.1, 3.2).
    const nonCommercialNormalized = new Set(
      NON_COMMERCIAL_IDENTIFIERS.map(normalize),
    );
    for (const entry of AVATAR_COMPONENT_LICENSES) {
      expect(nonCommercialNormalized.has(normalize(entry.license))).toBe(false);
      expect(entry.commercialUse).toBe(true);
      expect(isCommercialUseLicense(entry.license)).toBe(true);
    }
  });

  it('rejects every explicitly non-commercial identifier', () => {
    for (const id of NON_COMMERCIAL_IDENTIFIERS) {
      expect(isCommercialUseLicense(id)).toBe(false);
    }
  });
});

describe('isCommercialUseLicense gate (Property 8)', () => {
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
      // The named non-commercial identifiers (CC-BY-NC, research-only, ...).
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
