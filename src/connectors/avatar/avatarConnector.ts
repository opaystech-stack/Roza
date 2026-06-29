/**
 * Avatar_Connector (Component A2 — capability gate) — Req 1.4, 1.5, 11.4.
 *
 * The avatar is a configuration-gated presence/output capability, NOT a new
 * member of the conversation `Channel` union: `operativeChannels`,
 * `decideChannel`, and the `Channel` union in `engine.ts`/`types.ts` stay
 * unchanged in shape and behavior (design decision; Req 1.5, 11.4). A tiny
 * pure gate backs the "reject when disabled" requirement (Req 1.4) without
 * touching the conversation-channel model.
 *
 * This file is built bottom-up and will be EXTENDED in later waves:
 *   - Task 10.1 (THIS file, below the gate) adds the pure
 *     render/present/fallback `transition` state machine
 *     (`AvatarState`/`AvatarEvent`/`AvatarEffect`).
 *   - Task 11.1 adds the I/O shell orchestrator (`createAvatarConnector`,
 *     `AvatarConnectorDeps`/`AvatarConnector`) over the injected interfaces.
 * The pure capability gate and the pure `transition` state machine perform no
 * I/O and are total — they never throw for any input.
 */

import type { RozaConfig } from '../../config.js';

// ───────────────────────────────────────────────────────────────────────────
// Capability gate (Component A2) — pure, total, no I/O.
// ───────────────────────────────────────────────────────────────────────────

/**
 * The avatar capability (or one of its named sub-capabilities) a request can
 * target. `'avatar'` is the base synthesis/presence capability; `'meet'` and
 * `'stream'` are the Google Meet presence and RTMP streaming sub-capabilities,
 * each additionally gated by its own enable flag (Req 1.4).
 */
export type AvatarCapability = 'avatar' | 'meet' | 'stream';

/**
 * Outcome of classifying an avatar-capability request. `{ ok: true }` when the
 * requested capability is operative; otherwise a single machine-readable reason
 * the connector surfaces as an error without inspecting logs (Req 1.4).
 */
export type AvatarDecision = { ok: true } | { ok: false; reason: 'avatar_not_enabled' };

/**
 * Pure: is the requested avatar capability operative for this configuration?
 *
 * Returns `{ ok: true }` iff the requested capability is enabled:
 * - `'avatar'` iff `cfg.avatar.enabled`;
 * - `'meet'`   iff `cfg.avatar.enabled && cfg.avatar.meet.enabled`;
 * - `'stream'` iff `cfg.avatar.enabled && cfg.avatar.stream.enabled`.
 *
 * A sub-capability is never operative while the base avatar capability is
 * disabled. Any other case returns `{ ok: false, reason: 'avatar_not_enabled' }`
 * (Req 1.4). Total — never throws, performs no I/O. The conversation `Channel`
 * union, `operativeChannels`, and `decideChannel` are deliberately untouched:
 * `internal`/`telegram`/`email`/`voice` stay operative per their own config,
 * independent of the avatar capability (Req 1.5, 11.4).
 */
export function decideAvatar(capability: AvatarCapability, cfg: RozaConfig): AvatarDecision {
  const avatar = cfg.avatar;
  const enabled =
    capability === 'avatar'
      ? avatar.enabled
      : capability === 'meet'
        ? avatar.enabled && avatar.meet.enabled
        : avatar.enabled && avatar.stream.enabled;

  return enabled ? { ok: true } : { ok: false, reason: 'avatar_not_enabled' };
}

// ───────────────────────────────────────────────────────────────────────────
// Render/present/fallback state machine (Component A9 — pure core) —
// Req 2.7, 2.8, 5.5, 9.1, 9.2, 9.3, 9.4, 10.3.
//
// This is the side-effect-free core of the Avatar_Connector render/present
// turn loop, mirroring the Phase 3 `voiceConnector.ts` `transition` idiom
// exactly: a reducer over `(state, event)` that returns the next state plus a
// list of side-effect *intents* ({@link AvatarEffect}). It performs no I/O,
// reads no clock, and never throws — the I/O shell (task 11.1) is solely
// responsible for executing the returned effects.
//
// Every degradation path the design requires is encoded directly in the table
// so it is exhaustively testable in isolation (Property 6) without any GPU,
// renderer sidecar, virtual device, browser, or network:
// - `render_failed` (covering renderer failure / non-zero exit / latency
//   overrun) emits an `audioOnlyFallback` intent plus an error `log` and moves
//   to `audio_only`; the reply is never left blocked (Req 2.7, 2.8, 9.1, 9.2).
// - `device_failed` emits an error `log` that NAMES the failed device plus the
//   `audioOnlyFallback` intent rather than terminating — a virtual-device fault
//   degrades to audio-only, it never crashes the connector (Req 5.5, 9.2).
// - `activate_failed` / `error` / `deactivate` move toward `ended` via
//   `tearing_down` with a `releaseResources` effect and a log; the capability
//   is never torn down silently (Req 9.3, 9.4, 10.3).
// - Any unmodelled `(state, event)` pair is preserved defensively with a single
//   diagnostic log rather than crashing (mirrors the voiceConnector `defensive`
//   helper), keeping the machine total.
// ───────────────────────────────────────────────────────────────────────────

/**
 * The lifecycle states of the avatar render/present turn loop.
 *
 * - `inactive` — the capability exists but no devices are open yet; the gate
 *   has not been activated.
 * - `activating` — the Virtual_Camera/Virtual_Microphone are being opened
 *   (`initDevices`); awaiting confirmation before presenting.
 * - `idle` — devices are open and the connector is ready to present the next
 *   reply (no render in flight).
 * - `rendering` — the Avatar_Image + reply audio have been handed to the
 *   external Avatar_Renderer and a Video_Stream is being synthesized.
 * - `presenting` — a synthesized Video_Stream is being written to the camera
 *   and the paired reply audio to the microphone, synchronized at the
 *   configured fps.
 * - `audio_only` — a render or device failure degraded the capability to the
 *   audio-only fallback; replies are still delivered as audio via the operative
 *   Voice_Channel (never blocked) (Req 9.2).
 * - `tearing_down` — the capability is being released (resources freed);
 *   transitional, on the way to `ended`.
 * - `ended` — terminal; the avatar presence is over and no further work occurs.
 */
export type AvatarState =
  | 'inactive'
  | 'activating'
  | 'idle'
  | 'rendering'
  | 'presenting'
  | 'audio_only'
  | 'tearing_down'
  | 'ended';

/**
 * The events that drive the avatar render/present state machine. Each is
 * produced by the I/O shell in response to a device, renderer, or control
 * outcome.
 *
 * - `activate` — a request to bring the avatar presence online (open devices).
 * - `activated` — the Virtual_Camera/Virtual_Microphone opened successfully.
 * - `activate_failed` — activation failed before the devices were ready.
 * - `device_failed` — a virtual device faulted; carries the failed `device`
 *   (`'camera'` or `'microphone'`) so the fallback log can name it (Req 5.5).
 * - `reply` — reply speech audio is ready to present for this turn (Req 2.1).
 * - `render_ok` — the renderer produced a playable Video_Stream within budget.
 * - `render_failed` — the renderer failed, exited, or exceeded the latency
 *   budget (all collapse to one degradation path) (Req 2.8, 9.1).
 * - `presented` — presentation of the synthesized A/V completed for this turn.
 * - `deactivate` — a request to bring the avatar presence offline normally.
 * - `error` — an out-of-band fault that forces a clean teardown.
 */
export type AvatarEvent =
  | { kind: 'activate' }
  | { kind: 'activated' }
  | { kind: 'activate_failed' }
  | { kind: 'device_failed'; device: 'camera' | 'microphone' }
  | { kind: 'reply' }
  | { kind: 'render_ok' }
  | { kind: 'render_failed' }
  | { kind: 'presented' }
  | { kind: 'deactivate' }
  | { kind: 'error' };

/**
 * A side-effect *intent* returned by {@link transition}. The pure state machine
 * never performs these itself; the I/O shell (task 11.1) interprets each one
 * against the injected interfaces. They are deliberately coarse-grained so the
 * pure core stays device- and transport-agnostic.
 *
 * - `initDevices` — open the Virtual_Camera/Virtual_Microphone (Req 5.1, 5.2).
 * - `render` — hand the Avatar_Image + reply audio to the external renderer.
 * - `presentVideo` — write the synthesized Video_Stream frames to the camera.
 * - `presentAudio` — write the paired reply audio to the microphone.
 * - `audioOnlyFallback` — deliver the reply as audio-only via the operative
 *   Voice_Channel when rendering/devices fail; never terminates (Req 9.2).
 * - `releaseResources` — tear down the presence and release device/session
 *   resources (Req 9.3, 9.4).
 * - `log` — emit a diagnostic log entry at `info` or `error` level. The
 *   `message` never contains a credential, `Stream_Key`, or any private value.
 */
export type AvatarEffect =
  | { kind: 'initDevices' }
  | { kind: 'render' }
  | { kind: 'presentVideo' }
  | { kind: 'presentAudio' }
  | { kind: 'audioOnlyFallback' }
  | { kind: 'releaseResources' }
  | { kind: 'log'; level: 'info' | 'error'; message: string };

/** The result of one {@link transition}: the next state and the effects to run. */
export interface AvatarTransitionResult {
  next: AvatarState;
  effects: AvatarEffect[];
}

/** Convenience constructor for an `info`-level {@link AvatarEffect} log intent. */
function logInfo(message: string): AvatarEffect {
  return { kind: 'log', level: 'info', message };
}

/** Convenience constructor for an `error`-level {@link AvatarEffect} log intent. */
function logError(message: string): AvatarEffect {
  return { kind: 'log', level: 'error', message };
}

/**
 * Defensive handler for any `(state, event)` pair the table does not model.
 *
 * Keeps the machine total and crash-free: the state is preserved unchanged and
 * a single `info` log effect records the unhandled pair. This guarantees that
 * no input can throw and that a stray event never silently mutates the avatar
 * presence (mirrors the voiceConnector `defensive` helper).
 */
function defensive(state: AvatarState, event: AvatarEvent): AvatarTransitionResult {
  return {
    next: state,
    effects: [logInfo(`unhandled event '${event.kind}' in state '${state}'`)],
  };
}

/**
 * Pure, total, deterministic avatar render/present reducer.
 *
 * Given the current {@link AvatarState} and an incoming {@link AvatarEvent},
 * returns the next state and the ordered list of {@link AvatarEffect} intents
 * the I/O shell must execute. It performs no I/O, reads no clock or
 * environment, and never throws — identical inputs always yield identical
 * outputs.
 *
 * Degradation rules encoded (Req 2.7, 2.8, 5.5, 9.1–9.4, 10.3):
 * - `render_failed` from any active state emits `audioOnlyFallback` + an error
 *   log and moves to `audio_only`; the reply is delivered as audio, never
 *   blocked (Req 2.8, 9.2).
 * - `device_failed` from any active state emits `audioOnlyFallback` + an error
 *   log naming the failed device and moves to `audio_only`; a device fault
 *   degrades, it never crashes the connector (Req 5.5, 9.2).
 * - `activate_failed`/`error`/`deactivate` move to `tearing_down` with a
 *   `releaseResources` effect and a log, on the way to `ended`; teardown is
 *   never silent (Req 9.3, 9.4, 10.3).
 * - In `audio_only`, a `reply` still emits `audioOnlyFallback` so no reply is
 *   ever left blocked while degraded (Req 9.2).
 */
export function transition(state: AvatarState, event: AvatarEvent): AvatarTransitionResult {
  // Terminal state: an avatar presence that has ended absorbs any further event
  // defensively rather than re-running teardown or transitioning.
  if (state === 'ended') {
    return defensive(state, event);
  }

  // While tearing down, a deactivate completes the release into `ended`.
  // Everything else is preserved defensively until the shell finishes cleanup.
  if (state === 'tearing_down') {
    if (event.kind === 'deactivate') {
      return {
        next: 'ended',
        effects: [{ kind: 'releaseResources' }, logInfo('avatar teardown complete')],
      };
    }
    return defensive(state, event);
  }

  // From any active (non-terminal, non-tearing_down) state, a normal
  // deactivate, an out-of-band error, or an activation failure always begins a
  // clean teardown that releases resources and logs — never a silent
  // terminate (Req 9.3, 9.4, 10.3).
  if (event.kind === 'deactivate') {
    return {
      next: 'tearing_down',
      effects: [{ kind: 'releaseResources' }, logInfo('avatar deactivate requested; releasing resources')],
    };
  }
  if (event.kind === 'error') {
    return {
      next: 'tearing_down',
      effects: [{ kind: 'releaseResources' }, logError('avatar capability error; releasing resources')],
    };
  }
  if (event.kind === 'activate_failed') {
    return {
      next: 'tearing_down',
      effects: [{ kind: 'releaseResources' }, logError('avatar activation failed; releasing resources')],
    };
  }

  // A virtual-device fault degrades to the audio-only fallback rather than
  // crashing: emit the fallback intent and an error log that NAMES the failed
  // device, and move to `audio_only` (Req 5.5, 9.2).
  if (event.kind === 'device_failed') {
    return {
      next: 'audio_only',
      effects: [
        { kind: 'audioOnlyFallback' },
        logError(`virtual ${event.device} device failed; falling back to audio-only delivery`),
      ],
    };
  }

  // A renderer failure / non-zero exit / latency overrun all collapse to one
  // degradation path: emit the audio-only fallback + an error log and move to
  // `audio_only`; the reply is still delivered, never blocked (Req 2.8, 9.1, 9.2).
  if (event.kind === 'render_failed') {
    return {
      next: 'audio_only',
      effects: [
        { kind: 'audioOnlyFallback' },
        logError('avatar render failed/exited/exceeded latency budget; falling back to audio-only delivery'),
      ],
    };
  }

  // Normal per-state render/present flow.
  switch (state) {
    case 'inactive':
      // A request to bring the presence online opens the virtual devices.
      switch (event.kind) {
        case 'activate':
          return { next: 'activating', effects: [{ kind: 'initDevices' }, logInfo('activating avatar presence')] };
        default:
          return defensive(state, event);
      }

    case 'activating':
      // Devices opened; the connector is ready to present replies.
      switch (event.kind) {
        case 'activated':
          return { next: 'idle', effects: [logInfo('avatar presence active')] };
        default:
          return defensive(state, event);
      }

    case 'idle':
      // A reply is ready: synthesize a lip-synced Video_Stream from the
      // Avatar_Image + the reply audio (Req 2.1).
      switch (event.kind) {
        case 'reply':
          return { next: 'rendering', effects: [{ kind: 'render' }] };
        default:
          return defensive(state, event);
      }

    case 'rendering':
      // The renderer produced a playable Video_Stream within budget: present
      // the video on the camera and the paired audio on the microphone,
      // synchronized at the configured fps (Req 5.3).
      switch (event.kind) {
        case 'render_ok':
          return { next: 'presenting', effects: [{ kind: 'presentVideo' }, { kind: 'presentAudio' }] };
        default:
          return defensive(state, event);
      }

    case 'presenting':
      // Presentation finished; ready for the next reply turn.
      switch (event.kind) {
        case 'presented':
          return { next: 'idle', effects: [] };
        default:
          return defensive(state, event);
      }

    case 'audio_only':
      // Degraded path: keep delivering replies as audio-only so a reply is
      // never left blocked while the avatar is degraded (Req 9.2).
      switch (event.kind) {
        case 'reply':
          return { next: 'audio_only', effects: [{ kind: 'audioOnlyFallback' }] };
        case 'presented':
          return { next: 'audio_only', effects: [] };
        default:
          return defensive(state, event);
      }

    default:
      // Unreachable: `ended` and `tearing_down` are handled above and the switch
      // is exhaustive over the remaining states. Defensive for totality.
      return defensive(state, event);
  }
}

/* ==========================================================================
 * I/O shell — `createAvatarConnector` (Component A9) — Req 1.4, 2.1, 4.4, 5.1,
 * 5.2, 5.3, 6.2, 6.3, 6.4, 6.6, 7.1, 7.2, 8.4, 8.5, 8.6, 8.7, 9.2, 9.3, 9.4,
 * 9.5.
 *
 * This is the side-effecting orchestrator that drives the real
 * {@link AvatarRenderer}/{@link VirtualCamera}/{@link VirtualMicrophone}/
 * {@link MeetSession}/{@link StreamSession} interfaces through the
 * render → present → audio-only-fallback turn loop, enforcing every gate the
 * design requires. The pure {@link transition} core above stays untouched; this
 * shell uses it to drive the lifecycle state (and to emit the device-naming /
 * degradation logs) exactly the way the Phase 3 `createVoiceConnector` mirrors
 * its own pure `transition` semantics in the I/O shell.
 *
 * Security discipline (Req 8.4, 8.5, 8.6, 8.7): the `meetUrl` and the
 * `RTMP_Target` are UNTRUSTED — each is only ever passed as a delegation
 * argument, never executed as a command or interpreted as config. The
 * `Meet_Credentials` and the `Stream_Key` are handed ONLY to their adapter and
 * are NEVER logged, persisted, or surfaced; every log entry and every
 * `avatar_sessions` audit row carries identifiers/targets/reasons only — never
 * a credential or any private journal value.
 * ======================================================================== */

import { type AudioChunk, type AudioFormat, TELEPHONY_PCM_16K } from '../voice/audio.js';
import type { AvatarVideoFormat, AvatarStream } from './avatarFormat.js';
import type { AvatarRenderer, RenderResult } from './renderer.js';
import type { VirtualCamera } from './virtualCamera.js';
import type { VirtualMicrophone } from './virtualMicrophone.js';
import type { MeetSession } from './meetSession.js';
import type { StreamSession, StreamTarget } from './streamSession.js';
import type { Logger } from '../../types.js';
import type { AvatarOutcome, AvatarSessionKind, Repository } from '../../repository.js';

/**
 * The PCM audio format the Avatar_Connector opens the Virtual_Microphone with
 * and pairs into the combined {@link AvatarStream} it streams. Wideband 16 kHz
 * mono signed 16-bit little-endian PCM is the WebRTC/presence default; the
 * actual reply {@link AudioChunk} is written to the device verbatim in the
 * format the Voice_Channel produced it (Req 4.4).
 */
const AVATAR_AUDIO_FORMAT: AudioFormat = TELEPHONY_PCM_16K;

/**
 * The result of a single {@link AvatarConnector.present} turn.
 *
 * `mode` records how the reply was actually delivered: `'video'` when the
 * synthesized Video_Stream was presented on the camera with the paired audio on
 * the microphone, or `'audio_only'` when a render/device fault degraded the
 * turn to the audio-only fallback (the reply is still delivered — never blocked,
 * Req 9.2). `present` NEVER rejects: a fault always resolves to an
 * `audio_only` result (Req 2.8, 9.2).
 */
export interface AvatarPresentResult {
  ok: boolean;
  mode: 'video' | 'audio_only';
  reason?: string;
}

/**
 * Dependencies for {@link createAvatarConnector}. Every external edge is an
 * injected interface so the connector is driven by in-memory fakes in tests and
 * no real GPU, kernel module, browser, or RTMP endpoint runs in CI (Req 12.5).
 */
export interface AvatarConnectorDeps {
  /** External Avatar_Renderer sidecar (no in-process ML) — Component A5. */
  renderer: AvatarRenderer;
  /** Self-hosted Virtual_Camera the Video_Stream is presented on — Component A6. */
  camera: VirtualCamera;
  /** Self-hosted Virtual_Microphone the reply audio is presented on — Component A6. */
  microphone: VirtualMicrophone;
  /** Optional swappable Google Meet presence adapter — Component A7 (Req 6.1). */
  meet?: MeetSession;
  /** Optional swappable RTMP streaming adapter — Component A8 (Req 7.1). */
  stream?: StreamSession;
  /** Resolved configuration, including `cfg.avatar.{video,latency,meet,stream}`. */
  cfg: RozaConfig;
  /** Live accessor for the placeholder Avatar_Image portrait bytes (Req 2.1, 4.4). */
  avatarImage: () => Uint8Array;
  /** Clock accessor; injectable so tests run deterministically (audit timestamps). */
  now: () => Date;
  /** Structured logger; only identifiers/targets/reasons are ever logged (Req 8.4). */
  logger: Logger;
  /**
   * The audio-only fallback delivery path: convey the reply audio through the
   * already-operative Voice_Channel when rendering/devices fail so the reply is
   * never blocked (Req 9.2).
   */
  audioOnlyDeliver: (audio: AudioChunk) => Promise<void>;
  /** Optional `avatar_sessions` audit repository; never blocks the loop (Req 9.1). */
  repo?: Repository;
}

/**
 * The Avatar_Connector surface. `start()` opens the virtual devices;
 * `present(audio)` renders + presents one reply turn (with audio-only
 * fallback); `joinMeet`/`muteMeet`/`leaveMeet` drive the optional Meet
 * presence; `startStream`/`stopStream` drive the optional RTMP broadcast.
 */
export interface AvatarConnector {
  /** Open the Virtual_Camera + Virtual_Microphone; degrade to audio-only on a
   *  device-init failure rather than crashing (Req 5.1, 5.2, 5.5). */
  start(): Promise<void>;
  /** Render + present one reply turn, or fall back to audio-only; never rejects (Req 2.1, 2.8, 9.2). */
  present(audio: AudioChunk): Promise<AvatarPresentResult>;
  /** Join a Google Meet — gated by enablement + consent + credentials (Req 6.2, 6.4). */
  joinMeet(meetUrl: string): Promise<{ ok: boolean; reason?: string }>;
  /** Mute Roza's microphone in the meeting (Req 6.3). */
  muteMeet(): Promise<void>;
  /** Leave the meeting and release its resources (Req 6.3, 6.6). */
  leaveMeet(): Promise<void>;
  /** Start the optional RTMP broadcast — gated by enablement (Req 7.1). */
  startStream(): Promise<{ ok: boolean; reason?: string }>;
  /** Stop the RTMP broadcast and release resources (Req 7.2). */
  stopStream(): Promise<void>;
}

/** Extract a safe, credential-free message from an unknown thrown value. */
function avatarErrMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when a credential/string value is undefined, empty, or whitespace-only. */
function isBlankValue(raw: string | undefined): boolean {
  return raw === undefined || raw.trim().length === 0;
}

/**
 * Extract the host of an untrusted `meetUrl` for safe, non-sensitive logging.
 * Returns `'invalid'` when the value is not a parseable URL — the raw,
 * untrusted string is never logged verbatim.
 */
function avatarSafeHost(meetUrl: string): string {
  try {
    return new URL(meetUrl).host;
  } catch {
    return 'invalid';
  }
}

/**
 * Create the Avatar_Connector I/O shell over the injected interfaces.
 *
 * The render/present turn loop is: consult the `decideAvatar('avatar', cfg)`
 * gate → `renderer.render` the Avatar_Image + reply audio exactly once → on
 * success write the produced Video_Stream frames to the camera and the paired
 * reply audio to the microphone, synchronized → on a render failure/timeout (or
 * a presentation device fault) apply the audio-only fallback (present audio on
 * the mic + deliver via the operative Voice_Channel) and return an
 * `audio_only` result without ever rejecting (Req 2.8, 9.2). The Meet/stream
 * gates enforce enablement (and, for Meet, recorded consent + present
 * `Meet_Credentials`) before any delegation; every Meet/stream fault is
 * isolated (logged by identifier/target, its session released) so
 * `internal`/`telegram`/`email`/`voice` and the service keep running
 * (Req 6.6, 9.3, 9.4, 9.5).
 */
export function createAvatarConnector(deps: AvatarConnectorDeps): AvatarConnector {
  const { renderer, camera, microphone, meet, stream, cfg, avatarImage, now, logger, audioOnlyDeliver, repo } =
    deps;

  // The configured Avatar_Video_Format the renderer must emit and the camera
  // consumes (config's structural shape matches the format contract).
  const videoFormat = cfg.avatar.video as AvatarVideoFormat;

  // Lifecycle state driven by the pure `transition` reducer above. `dispatch`
  // advances it and emits only the reducer's diagnostic `log` effects (which
  // name the failed device on a `device_failed`, Req 5.5); the concrete I/O is
  // executed imperatively below, mirroring `createVoiceConnector`.
  let state: AvatarState = 'inactive';

  // Open Meet/stream audit session ids, held while the presence is live so they
  // can be closed on leave/stop. `null` when no audit repo / not live.
  let meetSessionId: string | null = null;
  let streamSessionId: string | null = null;

  /** Advance the lifecycle state and surface the reducer's log effects. */
  function dispatch(event: AvatarEvent): AvatarTransitionResult {
    const result = transition(state, event);
    state = result.next;
    for (const effect of result.effects) {
      if (effect.kind === 'log') {
        // The reducer's messages carry only the device kind + degradation
        // reason — never a credential or any private value (Req 8.4).
        logger[effect.level]('avatar.transition', { state, message: effect.message });
      }
    }
    return result;
  }

  /** Open an audit Avatar_Session if a repo is wired; never throws (Req 9.1).
   *  `target` is ONLY a meet URL / RTMP ingest URL — never a credential (Req 8.5). */
  function openAudit(kind: AvatarSessionKind, target: string | null): string | null {
    if (!repo) {
      return null;
    }
    try {
      return repo.startAvatarSession(kind, target).id;
    } catch (err: unknown) {
      logger.error('avatar.audit.start_failed', { kind, error: avatarErrMsg(err) });
      return null;
    }
  }

  /** Close an audit Avatar_Session non-blockingly; never throws (Req 9.1). */
  function closeAudit(sessionId: string | null, outcome: AvatarOutcome): void {
    if (!repo || sessionId === null) {
      return;
    }
    try {
      repo.endAvatarSession(sessionId, outcome, now().toISOString());
    } catch (err: unknown) {
      logger.error('avatar.audit.end_failed', { error: avatarErrMsg(err) });
    }
  }

  /**
   * The audio-only fallback (Req 9.2): present the reply audio on the
   * Virtual_Microphone (best-effort — the mic may not be open if it was the
   * failed device) and ALWAYS deliver the reply through the operative
   * Voice_Channel so it is never blocked. Faults here are logged, never thrown.
   */
  async function audioOnlyFallback(audio: AudioChunk): Promise<void> {
    try {
      await microphone.write(audio);
    } catch (err: unknown) {
      // The mic may be closed (it was the failed device) — degrade quietly.
      logger.error('avatar.fallback.mic_write_failed', { error: avatarErrMsg(err) });
    }
    try {
      await audioOnlyDeliver(audio);
    } catch (err: unknown) {
      logger.error('avatar.fallback.deliver_failed', { error: avatarErrMsg(err) });
    }
  }

  /**
   * Present a successful render: write the produced Video_Stream frames to the
   * Virtual_Camera and the paired reply audio to the Virtual_Microphone,
   * synchronized at the configured fps (Req 5.1, 5.2, 5.3). The audio write is
   * started alongside the frame stream so the A/V derive from one synthesized
   * turn rather than being re-timed independently.
   */
  async function presentSynchronized(result: RenderResult, audio: AudioChunk): Promise<void> {
    const micWrite = microphone.write(audio);
    try {
      for await (const frame of result.frames) {
        await camera.write(frame);
      }
    } finally {
      await micWrite;
    }
  }

  return {
    async start(): Promise<void> {
      // Begin bringing the presence online (idempotent on the pure machine).
      dispatch({ kind: 'activate' });

      // Open the Virtual_Camera with the configured Avatar_Video_Format. A
      // device-init failure NAMES the device and degrades to audio-only rather
      // than crashing the connector (Req 5.5, 9.2).
      try {
        await camera.open(videoFormat);
      } catch (err: unknown) {
        logger.error('avatar.start.camera_failed', {
          device: camera.descriptor.device,
          error: avatarErrMsg(err),
        });
        dispatch({ kind: 'device_failed', device: 'camera' });
        return;
      }

      // Open the Virtual_Microphone with the avatar audio format.
      try {
        await microphone.open(AVATAR_AUDIO_FORMAT);
      } catch (err: unknown) {
        logger.error('avatar.start.microphone_failed', {
          device: microphone.descriptor.device,
          error: avatarErrMsg(err),
        });
        dispatch({ kind: 'device_failed', device: 'microphone' });
        return;
      }

      dispatch({ kind: 'activated' });
      logger.info('avatar.connector.started', {});
    },

    async present(audio: AudioChunk): Promise<AvatarPresentResult> {
      // GATE — the avatar capability must be operative (Req 1.4). A disabled
      // capability never renders; the reply is the caller's responsibility.
      const decision = decideAvatar('avatar', cfg);
      if (!decision.ok) {
        logger.info('avatar.present.not_enabled', { reason: decision.reason });
        return { ok: false, mode: 'audio_only', reason: decision.reason };
      }

      // Already degraded to audio-only (e.g. a device failed at start): keep
      // delivering replies as audio-only so none is ever blocked (Req 9.2).
      if (state === 'audio_only') {
        dispatch({ kind: 'reply' });
        const sid = openAudit('render', null);
        await audioOnlyFallback(audio);
        closeAudit(sid, 'audio_only_fallback');
        return { ok: true, mode: 'audio_only' };
      }

      const sessionId = openAudit('render', null);

      // A reply is ready → synthesize the lip-synced Video_Stream (Req 2.1).
      dispatch({ kind: 'reply' });

      // Render the Avatar_Image + reply audio EXACTLY once (Req 2.1, 4.4).
      let result: RenderResult;
      try {
        result = await renderer.render({
          image: avatarImage(),
          audio,
          format: videoFormat,
          timeoutMs: cfg.avatar.latency.renderMs,
        });
      } catch (err: unknown) {
        // Render failure / non-zero exit / latency overrun → AUDIO-ONLY
        // FALLBACK. Never reject; the reply is still delivered (Req 2.8, 9.2).
        logger.error('avatar.render.failed', { error: avatarErrMsg(err) });
        dispatch({ kind: 'render_failed' });
        await audioOnlyFallback(audio);
        closeAudit(sessionId, 'audio_only_fallback');
        return { ok: true, mode: 'audio_only' };
      }

      // Render OK → present the synchronized A/V (Req 5.1, 5.2, 5.3).
      dispatch({ kind: 'render_ok' });
      try {
        await presentSynchronized(result, audio);
      } catch (err: unknown) {
        // A device write fault during presentation degrades to audio-only
        // rather than crashing the connector (Req 5.5, 9.2).
        logger.error('avatar.present.device_failed', { error: avatarErrMsg(err) });
        dispatch({ kind: 'device_failed', device: 'camera' });
        await audioOnlyFallback(audio);
        closeAudit(sessionId, 'audio_only_fallback');
        return { ok: true, mode: 'audio_only' };
      }

      dispatch({ kind: 'presented' });
      closeAudit(sessionId, 'presented');
      return { ok: true, mode: 'video' };
    },

    async joinMeet(meetUrl: string): Promise<{ ok: boolean; reason?: string }> {
      // GATE 1 — avatar + Meet sub-capability enabled (Req 1.4, 6.2).
      const decision = decideAvatar('meet', cfg);
      if (!decision.ok) {
        logger.info('avatar.meet.not_enabled', { reason: decision.reason });
        return { ok: false, reason: decision.reason };
      }

      // GATE 2 — recorded operator consent is mandatory before any join (Req 6.4).
      if (cfg.avatar.meet.consent !== true) {
        logger.info('avatar.meet.consent_required', {});
        return { ok: false, reason: 'consent_required' };
      }

      // GATE 3 — non-blank Meet_Credentials must be present (Req 6.2). The
      // values are never logged — only the fact that they are missing.
      const account = cfg.avatar.meet.account;
      const password = cfg.avatar.meet.password;
      if (isBlankValue(account) || isBlankValue(password)) {
        logger.error('avatar.meet.missing_credentials', {});
        return { ok: false, reason: 'missing_credentials' };
      }

      // GATE 4 — the swappable Meet adapter must be wired.
      if (!meet) {
        logger.error('avatar.meet.unavailable', {});
        return { ok: false, reason: 'meet_unavailable' };
      }

      // Audit the appearance with the meet URL as `target` — NEVER a credential
      // (Req 8.5). The URL is untrusted data, recorded only, never executed.
      const sessionId = openAudit('meet', meetUrl);
      try {
        // `meetUrl` is UNTRUSTED — passed ONLY as the delegation argument, never
        // executed as a command or interpreted as config (Req 8.7).
        await meet.join(meetUrl, { account, password });
      } catch (err: unknown) {
        // Isolate the fault: log by host, close the audit, keep the service and
        // every other channel running (Req 6.6, 9.3). The error never carries a
        // credential.
        logger.error('avatar.meet.join_failed', {
          host: avatarSafeHost(meetUrl),
          error: avatarErrMsg(err),
        });
        closeAudit(sessionId, 'failed');
        return { ok: false, reason: 'join_failed' };
      }

      meetSessionId = sessionId;
      logger.info('avatar.meet.joined', { host: avatarSafeHost(meetUrl) });
      return { ok: true };
    },

    async muteMeet(): Promise<void> {
      if (!meet) {
        return;
      }
      try {
        await meet.mute();
        logger.info('avatar.meet.muted', {});
      } catch (err: unknown) {
        // A mute fault is isolated — the service keeps running (Req 9.3, 9.5).
        logger.error('avatar.meet.mute_failed', { error: avatarErrMsg(err) });
      }
    },

    async leaveMeet(): Promise<void> {
      if (!meet) {
        return;
      }
      try {
        await meet.leave();
        logger.info('avatar.meet.left', {});
      } catch (err: unknown) {
        logger.error('avatar.meet.leave_failed', { error: avatarErrMsg(err) });
      } finally {
        // Always release the audit session so isolation never leaks a row.
        closeAudit(meetSessionId, 'stopped');
        meetSessionId = null;
      }
    },

    async startStream(): Promise<{ ok: boolean; reason?: string }> {
      // GATE 1 — avatar + stream sub-capability enabled (Req 1.4, 7.1).
      const decision = decideAvatar('stream', cfg);
      if (!decision.ok) {
        logger.info('avatar.stream.not_enabled', { reason: decision.reason });
        return { ok: false, reason: decision.reason };
      }

      // GATE 2 — the swappable stream adapter must be wired.
      if (!stream) {
        logger.error('avatar.stream.unavailable', {});
        return { ok: false, reason: 'stream_unavailable' };
      }

      // Audit with the RTMP ingest URL as `target` — NEVER the Stream_Key (Req 8.5).
      const sessionId = openAudit('stream', cfg.avatar.stream.url);

      // The RTMP_Target's key is handed ONLY to the transport (Req 7.3, 8.4); the
      // combined AvatarStream pairs the configured video format with the avatar
      // audio format.
      const target: StreamTarget = { url: cfg.avatar.stream.url, key: cfg.avatar.stream.key };
      const combined: AvatarStream = { video: videoFormat, audio: AVATAR_AUDIO_FORMAT };

      try {
        await stream.start(target, combined);
      } catch (err: unknown) {
        // Isolate the fault: the adapter's error never contains the key; log the
        // non-secret base URL only and release (Req 7.4, 8.4, 9.4).
        logger.error('avatar.stream.start_failed', {
          url: cfg.avatar.stream.url,
          error: avatarErrMsg(err),
        });
        closeAudit(sessionId, 'failed');
        return { ok: false, reason: 'start_failed' };
      }

      streamSessionId = sessionId;
      logger.info('avatar.stream.started', { url: cfg.avatar.stream.url });
      return { ok: true };
    },

    async stopStream(): Promise<void> {
      if (!stream) {
        return;
      }
      try {
        await stream.stop();
        logger.info('avatar.stream.stopped', {});
      } catch (err: unknown) {
        logger.error('avatar.stream.stop_failed', { error: avatarErrMsg(err) });
      } finally {
        closeAudit(streamSessionId, 'stopped');
        streamSessionId = null;
      }
    },
  };
}
