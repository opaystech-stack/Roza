/**
 * X component license manifest (Component X6) — Req 2.1, 2.2, 2.3.
 *
 * A machine-readable, side-effect-free record of every component Roza's
 * X_Capability relies on, together with its SPDX license identifier, a
 * commercial-use permission flag, and a `paid` flag pinned to `false`.
 * Recording this in code makes the "no paid X/Twitter API, no paid social-media
 * SaaS" rule auditable (Req 2.2) and lets Property 12 assert that the manifest
 * is complete and carries no paid or non-commercially-licensed component
 * (Req 2.1, 2.2, 2.3).
 *
 * The single cross-cutting constraint inherited from Phases 1–4 — the golden
 * rule — is to prioritize lightweight, free, open-source, and self-hostable
 * tooling over paid subscription APIs. For Phase 5 this is sharpened into a
 * hard exclusion: **no paid Twitter/X API and no paid social-media SaaS**
 * (Req 2.2). The X connector uses only self-hosted browser automation built on
 * the existing open-source Playwright dependency (Apache-2.0), already present
 * from Phase 4's Google Meet automation. Phase 5 therefore introduces no new
 * runtime dependency and no paid social dependency (Req 2.1).
 *
 * The exclusion target is the paid class (the paid X/Twitter developer API, any
 * hosted social/identity SaaS): such a component can never appear in this
 * manifest by construction — `paid` is the literal `false`, and every `license`
 * is a member of the commercial-use allowlist.
 *
 * This module is pure: it performs no I/O and never throws.
 */

/**
 * The X-capability roles that must each have an auditable, commercial-use,
 * non-paid license entry: driving the X web UI via browser automation, and
 * persisting/restoring the X_Session_State.
 */
export type XComponentRole = 'browser_automation' | 'session_persistence';

/**
 * A single auditable license record for a selected X-capability component.
 */
export interface XComponentLicense {
  /** The X-capability role this component fills. */
  readonly role: XComponentRole;
  /** Non-empty human-readable component name (e.g. "Playwright"). */
  readonly component: string;
  /** SPDX license identifier the component is distributed under (e.g. "Apache-2.0"). */
  readonly license: string;
  /** True iff `license` permits the organization's intended commercial use. */
  readonly commercialUse: boolean;
  /** Phase 5 forbids any paid social dependency — pinned to `false` (Req 2.2). */
  readonly paid: false;
}

/**
 * Allowlist of SPDX license identifiers known to permit commercial use, used to
 * gate the manifest (Req 2.1, 2.2). It reuses the Phase 4 permissive set so the
 * X manifest's commercial-use classification stays consistent with the avatar
 * pipeline. Paid or non-commercial identifiers are deliberately absent, so any
 * such identifier fails {@link isCommercialUseLicense} — no paid X/Twitter API
 * and no paid social SaaS can ever appear with `commercialUse: true`.
 *
 * Comparison is case-insensitive, matching SPDX's case-insensitive identifier
 * semantics.
 */
export const X_COMMERCIAL_USE_LICENSE_ALLOWLIST: ReadonlySet<string> = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'MPL-2.0',
  'ISC',
  'CC0-1.0',
  'CC-BY-4.0',
  'BSL-1.0',
  // Copyleft, commercial-use-permitting (separate process / kernel module).
  'LGPL-2.1',
  'LGPL-3.0',
  'GPL-2.0',
  'GPL-3.0',
]);

/** Pre-folded lookup set so membership checks stay allocation-free and total. */
const X_COMMERCIAL_USE_LICENSE_LOOKUP: ReadonlySet<string> = new Set(
  [...X_COMMERCIAL_USE_LICENSE_ALLOWLIST].map((id) => id.toLowerCase()),
);

/**
 * True iff `license` is a commercial-use-safe SPDX identifier drawn from
 * {@link X_COMMERCIAL_USE_LICENSE_ALLOWLIST}. Pure and total: blank, unknown,
 * or non-commercial identifiers (e.g. "CC-BY-NC-4.0") return `false`.
 */
export function isCommercialUseLicense(license: string): boolean {
  return X_COMMERCIAL_USE_LICENSE_LOOKUP.has(license.trim().toLowerCase());
}

/**
 * The selected-component license manifest (Req 2.1, 2.2).
 *
 * Each entry pins a role to its chosen component and the SPDX license under
 * which it is distributed:
 *
 * - browser_automation — Playwright (Apache-2.0), driving Chromium to operate
 *   the X web interface; already present from Phase 4's Google Meet automation,
 *   so Phase 5 adds no new runtime dependency.
 * - session_persistence — Playwright `storageState` (Apache-2.0), the
 *   self-hosted cookies/origins file used to persist and restore the
 *   X_Session_State.
 *
 * Every `commercialUse` flag is `true`, every `license` is a member of the
 * commercial-use allowlist, and every `paid` flag is `false`; no paid
 * X/Twitter API and no paid social-media SaaS appears.
 */
export const X_COMPONENT_LICENSES: readonly XComponentLicense[] = [
  { role: 'browser_automation', component: 'Playwright', license: 'Apache-2.0', commercialUse: true, paid: false },
  { role: 'session_persistence', component: 'Playwright storageState', license: 'Apache-2.0', commercialUse: true, paid: false },
];
