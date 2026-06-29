/**
 * Selected-component license manifest (Component A3) — Req 3.1, 3.2, 3.4, 3.5.
 *
 * A machine-readable, side-effect-free record of every avatar, virtual-device,
 * Meet, and streaming component Roza's Avatar_Channel relies on, together with
 * its SPDX license identifier, a commercial-use permission flag, and the
 * linkage (how the component runs relative to Roza's process). Recording this
 * in code makes the commercial-use permission auditable (Req 3.4) and lets
 * Property 8 assert that the manifest is complete and carries no
 * non-commercially-licensed component (Req 3.1, 3.2).
 *
 * The cross-cutting Phase 4 rule is hard and reaches the model weights and the
 * face-analysis dependency, not just the engine code: every selected component
 * must be licensed for Opays' intended commercial use. Strong avatar models
 * that ship permissive code but non-commercial weights or face-analysis
 * dependencies are therefore excluded from this manifest by construction — in
 * particular the Wav2Lip pretrained checkpoints (distributed non-commercial)
 * and the InsightFace stock models (non-commercial research license). LivePortrait's
 * MIT code is selected only in the configuration where its InsightFace
 * dependency is replaced by a commercially-licensed face-analysis component
 * (MediaPipe Face Landmarker, Apache-2.0) and the lip-sync weights are a
 * commercially-licensed checkpoint (Req 3.5).
 *
 * The allowlist extends the Phase 3 permissive set with copyleft licenses that
 * permit commercial use (LGPL/GPL): v4l2loopback (kernel module), ffmpeg /
 * GStreamer (CLI processes), and any RTMP relay all run as separate
 * processes/modules Roza orchestrates over device files, pipes, or the network,
 * so no copyleft obligation reaches Roza's code. The exclusion target is the
 * non-commercial class (CC-BY-NC, research-only), never copyleft-but-commercial
 * tooling.
 *
 * This module is pure: it performs no I/O and never throws.
 */

/**
 * The avatar/virtual-device/Meet/streaming roles that must each have an
 * auditable, commercial-use license entry: the animation engine (renderer), the
 * face-analysis dependency, the model weights, the Virtual_Camera, the
 * Virtual_Microphone, the Google Meet adapter, and the RTMP streaming path.
 */
export type AvatarComponentRole =
  | 'renderer'
  | 'face_analysis'
  | 'weights'
  | 'virtual_camera'
  | 'virtual_microphone'
  | 'meet'
  | 'stream';

/**
 * Where the component runs relative to Roza's process, which determines whether
 * any copyleft obligation could reach Roza's code (Req 3). Components that run
 * as a separate process, a kernel module, or model weights never link into
 * Roza, so their copyleft (if any) stays contained.
 */
export type ComponentLinkage = 'in_process' | 'separate_process' | 'kernel_module' | 'model_weights';

/**
 * A single auditable license record for a selected avatar-pipeline component.
 */
export interface AvatarComponentLicense {
  /** The avatar/virtual-device/Meet/streaming role this component fills. */
  readonly role: AvatarComponentRole;
  /** Non-empty human-readable component name (e.g. "LivePortrait (code)"). */
  readonly component: string;
  /** SPDX license identifier the component is distributed under (e.g. "MIT", "Apache-2.0", "GPL-2.0"). */
  readonly license: string;
  /** True iff `license` permits the organization's intended commercial use. */
  readonly commercialUse: boolean;
  /** How the component runs relative to Roza's process (copyleft reasoning). */
  readonly linkage: ComponentLinkage;
}

/**
 * Allowlist of SPDX license identifiers known to permit commercial use, used to
 * gate the manifest (Req 3.1, 3.2). It extends the Phase 3 permissive set with
 * copyleft licenses that permit commercial use (LGPL-2.1/3.0, GPL-2.0/3.0) for
 * components that run as separate processes or kernel modules. Non-commercial
 * licenses (for example, "CC-BY-NC-4.0" or any research-only weights license)
 * are deliberately absent, so any such identifier fails
 * {@link isCommercialUseLicense} — Wav2Lip checkpoints and InsightFace stock
 * models can never appear with `commercialUse: true`.
 *
 * Comparison is case-insensitive, matching SPDX's case-insensitive identifier
 * semantics.
 */
export const AVATAR_COMMERCIAL_USE_LICENSE_ALLOWLIST: ReadonlySet<string> = new Set([
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
const AVATAR_COMMERCIAL_USE_LICENSE_LOOKUP: ReadonlySet<string> = new Set(
  [...AVATAR_COMMERCIAL_USE_LICENSE_ALLOWLIST].map((id) => id.toLowerCase()),
);

/**
 * True iff `license` is a commercial-use-safe SPDX identifier drawn from
 * {@link AVATAR_COMMERCIAL_USE_LICENSE_ALLOWLIST}. Pure and total: blank,
 * unknown, or non-commercial identifiers (e.g. "CC-BY-NC-4.0") return `false`.
 */
export function isCommercialUseLicense(license: string): boolean {
  return AVATAR_COMMERCIAL_USE_LICENSE_LOOKUP.has(license.trim().toLowerCase());
}

/**
 * The selected-component license manifest (Req 3.4).
 *
 * Each entry pins a role to its chosen component, the SPDX license under which
 * it is distributed, and its linkage to Roza's process:
 *
 * - renderer — LivePortrait engine *code* (MIT), run as an external sidecar
 *   process; performs the ML inference outside Roza.
 * - face_analysis — MediaPipe Face Landmarker (Apache-2.0), the
 *   commercially-licensed substitute that replaces the non-commercial
 *   InsightFace default (Req 3.5).
 * - weights — a commercially-licensed lip-sync checkpoint (Apache-2.0),
 *   replacing the non-commercial Wav2Lip HD default (Req 3.5).
 * - virtual_camera — v4l2loopback + GStreamer (GPL-2.0), a separate kernel
 *   module / process Roza feeds frames to over a device file.
 * - virtual_microphone — PipeWire null sink (MIT), a separate process.
 * - meet — Playwright (Apache-2.0), the headless-browser Google Meet adapter.
 * - stream — ffmpeg + MediaMTX relay (MIT), the separate-process RTMP path.
 *
 * Every `commercialUse` flag is `true`, and every `license` is a member of the
 * commercial-use allowlist; no non-commercial component (no Wav2Lip checkpoint,
 * no InsightFace stock model) appears.
 */
export const AVATAR_COMPONENT_LICENSES: readonly AvatarComponentLicense[] = [
  { role: 'renderer', component: 'LivePortrait (code)', license: 'MIT', commercialUse: true, linkage: 'separate_process' },
  { role: 'face_analysis', component: 'MediaPipe Face Landmarker', license: 'Apache-2.0', commercialUse: true, linkage: 'separate_process' },
  { role: 'weights', component: 'commercial lip-sync checkpoint', license: 'Apache-2.0', commercialUse: true, linkage: 'model_weights' },
  { role: 'virtual_camera', component: 'v4l2loopback + GStreamer', license: 'GPL-2.0', commercialUse: true, linkage: 'kernel_module' },
  { role: 'virtual_microphone', component: 'PipeWire null sink', license: 'MIT', commercialUse: true, linkage: 'separate_process' },
  { role: 'meet', component: 'Playwright', license: 'Apache-2.0', commercialUse: true, linkage: 'in_process' },
  { role: 'stream', component: 'ffmpeg + MediaMTX relay', license: 'MIT', commercialUse: true, linkage: 'separate_process' },
];
