/**
 * Selected-component license manifest (Component V3) — Req 3.1, 3.2, 3.4.
 *
 * A machine-readable, side-effect-free record of every voice/telephony
 * component Roza relies on, together with its SPDX license identifier and an
 * explicit commercial-use permission flag. Recording this in code makes the
 * commercial-use permission auditable (Req 3.4) and lets Property 12 assert
 * that the manifest is complete and carries no non-commercially-licensed
 * component (Req 3.1, 3.2).
 *
 * The cross-cutting Phase 3 rule is hard: every selected engine and its model
 * weights must be licensed for Opays' intended commercial use. Strong local
 * models that ship under non-commercial terms (for example, Coqui XTTS-v2
 * under the Coqui Public Model License, or any "CC-BY-NC" weights) are
 * therefore excluded from this manifest by construction.
 *
 * This module is pure: it performs no I/O and never throws.
 */

/**
 * The voice/telephony roles that must each have an auditable, commercial-use
 * license entry: the Text-to-Speech engine, the Speech-to-Text engine, and the
 * telephony gateway client library Roza links into its own process.
 */
export type VoiceComponentRole = 'tts' | 'stt' | 'telephony';

/**
 * A single auditable license record for a selected voice/telephony component.
 */
export interface ComponentLicense {
  /** The voice/telephony role this component fills. */
  readonly role: VoiceComponentRole;
  /** Non-empty human-readable component name (e.g. "Piper"). */
  readonly component: string;
  /** SPDX license identifier the component is distributed under (e.g. "MIT"). */
  readonly license: string;
  /** True iff `license` permits the organization's intended commercial use. */
  readonly commercialUse: boolean;
}

/**
 * Allowlist of SPDX license identifiers known to permit commercial use, used to
 * gate the manifest (Req 3.1, 3.2). Non-commercial licenses (for example,
 * "CC-BY-NC-4.0" or the "Coqui Public Model License") are deliberately absent,
 * so any such identifier fails {@link isCommercialUseLicense}.
 *
 * Comparison is case-insensitive, matching SPDX's case-insensitive identifier
 * semantics.
 */
export const COMMERCIAL_USE_LICENSE_ALLOWLIST: ReadonlySet<string> = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'MPL-2.0',
  'CC0-1.0',
  'CC-BY-4.0',
  'ISC',
]);

/** Pre-folded lookup set so membership checks stay allocation-free and total. */
const COMMERCIAL_USE_LICENSE_LOOKUP: ReadonlySet<string> = new Set(
  [...COMMERCIAL_USE_LICENSE_ALLOWLIST].map((id) => id.toLowerCase()),
);

/**
 * True iff `license` is a permissive, commercial-use-safe SPDX identifier drawn
 * from {@link COMMERCIAL_USE_LICENSE_ALLOWLIST}. Pure and total: blank,
 * unknown, or non-commercial identifiers (e.g. "CC-BY-NC-4.0") return `false`.
 */
export function isCommercialUseLicense(license: string): boolean {
  return COMMERCIAL_USE_LICENSE_LOOKUP.has(license.trim().toLowerCase());
}

/**
 * The selected-component license manifest (Req 3.4).
 *
 * Each entry pins a role to its chosen component and the SPDX license under
 * which both the engine code and (for the voice/STT engines) its model weights
 * are distributed:
 *
 * - TTS_Engine — Piper (rhasspy), MIT engine + permissive (MIT/CC0/CC-BY) voice
 *   models.
 * - STT_Engine — whisper.cpp, MIT engine + MIT ggml model weights.
 * - Telephony gateway client — ari-client, Apache-2.0 (Asterisk itself runs as
 *   a separate GPL process and is not linked into Roza's code).
 *
 * Every `commercialUse` flag is `true`, and every `license` is a member of the
 * commercial-use allowlist; no non-commercial component appears.
 */
export const VOICE_COMPONENT_LICENSES: readonly ComponentLicense[] = [
  { role: 'tts', component: 'Piper', license: 'MIT', commercialUse: true },
  { role: 'stt', component: 'whisper.cpp', license: 'MIT', commercialUse: true },
  { role: 'telephony', component: 'ari-client', license: 'Apache-2.0', commercialUse: true },
];

/**
 * Record view of {@link VOICE_COMPONENT_LICENSES} keyed by role, for callers
 * that want direct role lookup rather than scanning the array.
 */
export const VOICE_COMPONENT_LICENSE_BY_ROLE: Readonly<Record<VoiceComponentRole, ComponentLicense>> = {
  tts: VOICE_COMPONENT_LICENSES[0]!,
  stt: VOICE_COMPONENT_LICENSES[1]!,
  telephony: VOICE_COMPONENT_LICENSES[2]!,
};
