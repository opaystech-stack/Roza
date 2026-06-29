/**
 * Voice_Connector — pure turn-loop state machine (Component V8) — Req 2.6, 4.6,
 * 9.1, 9.2, 9.3, 9.4.
 *
 * This file holds ONLY the side-effect-free core of the Voice_Connector: the
 * {@link CallState}/{@link CallEvent}/{@link CallEffect} model and the pure,
 * total, deterministic {@link transition} function. The I/O shell that drives
 * the real {@link TelephonyGateway}/{@link SttEngine}/{@link TtsEngine}
 * interfaces (`createVoiceConnector`) is added to this same file in a later
 * task; it is intentionally absent here so the state machine can be
 * property-tested in complete isolation (Property 9) without any audio, SIP, or
 * subprocess I/O.
 *
 * Design intent (mirrors the Phase 1/2 "pure logic core, thin I/O wrapper"
 * idiom): `transition` is a reducer over `(state, event)` that returns the next
 * state plus a list of side-effect *intents* ({@link CallEffect}). It performs
 * no I/O, reads no clock, and never throws — the shell is solely responsible
 * for executing the returned effects.
 *
 * Every degradation path required by the design is encoded directly in the
 * table so it is exhaustively testable:
 * - STT failure keeps the call alive and applies a per-turn fallback (never
 *   terminates the Call_Session) — Req 9.2.
 * - TTS failure emits a retry-then-text-channel-fallback intent and never a
 *   service-terminating effect — Req 2.6, 9.3.
 * - A Cognitive_Engine error plays no synthesized reply for that turn and the
 *   call continues — Req 9.4.
 * - A caller hangup or an audio/SIP drop always moves toward `ended` with a
 *   resource-release effect; the call is never torn down silently without a
 *   teardown/log effect — Req 4.6, 9.1.
 * - Any unmodelled `(state, event)` pair is handled defensively: the state is
 *   preserved and a single diagnostic log effect is emitted rather than
 *   crashing.
 */

/**
 * The lifecycle states of a single Call_Session as seen by the pure turn loop.
 *
 * - `ringing` — an inbound/outbound call exists but has not been admitted yet;
 *   the allowlist gate decides whether it is answered or rejected.
 * - `answered` — the call has been accepted and the gateway is opening the
 *   Audio_Stream; awaiting confirmation before listening.
 * - `listening` — the Audio_Stream is open and Roza is waiting for the caller
 *   to finish a speech turn (turn/endpoint detection).
 * - `transcribing` — the caller's turn audio is being transcribed by the STT
 *   engine.
 * - `thinking` — the transcript has been handed to the Cognitive_Engine and a
 *   reply is being generated.
 * - `speaking` — Roza's reply is being synthesized and played back to the
 *   caller.
 * - `tearing_down` — the call is being released (resources are being freed);
 *   transitional, on the way to `ended`.
 * - `ended` — terminal; the Call_Session is over and no further work occurs.
 */
export type CallState =
  | 'ringing'
  | 'answered'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'tearing_down'
  | 'ended';

/**
 * The events that drive the Call_Session state machine. Each is produced by the
 * I/O shell in response to a gateway, STT, engine, or TTS outcome.
 *
 * - `allowed` / `rejected` — the allowlist gate's decision for a ringing call.
 * - `answered` — the gateway confirmed the call is answered and the
 *   Audio_Stream is open.
 * - `turn_end` — turn/endpoint detection decided the caller finished speaking.
 * - `transcript` — the STT engine returned an (untrusted) transcript for the
 *   turn; carries the recognized `text`.
 * - `stt_failed` — the STT engine failed to transcribe the turn.
 * - `reply` — the Cognitive_Engine produced a reply; carries the reply `text`.
 * - `engine_failed` — the Cognitive_Engine returned an error for the turn.
 * - `tts_ok` — the TTS engine produced playable audio for the reply.
 * - `tts_failed` — the TTS engine failed to synthesize the reply.
 * - `played` — playback of the synthesized reply to the caller completed.
 * - `hangup` — the caller (or operator) ended the call normally.
 * - `drop` — the Audio_Stream or SIP connection dropped out-of-band.
 */
export type CallEvent =
  | { kind: 'allowed' }
  | { kind: 'rejected' }
  | { kind: 'answered' }
  | { kind: 'turn_end' }
  | { kind: 'transcript'; text: string }
  | { kind: 'stt_failed' }
  | { kind: 'reply'; text: string }
  | { kind: 'engine_failed' }
  | { kind: 'tts_ok' }
  | { kind: 'tts_failed' }
  | { kind: 'played' }
  | { kind: 'hangup' }
  | { kind: 'drop' };

/**
 * A side-effect *intent* returned by {@link transition}. The pure state machine
 * never performs these itself; the I/O shell interprets each one against the
 * injected interfaces. They are deliberately coarse-grained so the pure core
 * stays transport-agnostic.
 *
 * - `answer` — accept the ringing call and open the Audio_Stream
 *   (`gateway.answer`).
 * - `reject` — refuse the ringing call per the rejection policy
 *   (`gateway.hangup`/busy).
 * - `startListening` — begin turn/endpoint detection on the open Audio_Stream.
 * - `transcribe` — hand the accumulated turn audio to the STT engine
 *   (`stt.transcribe`).
 * - `generate` — submit the transcript `text` to the Cognitive_Engine on the
 *   `voice` channel (`engine.handleMessage`). Carries the untrusted transcript.
 * - `synthesize` — synthesize the reply `text` with the TTS engine
 *   (`tts.synthesize`). Carries the engine reply verbatim.
 * - `play` — play the synthesized audio to the caller (`gateway.playAudio`).
 * - `sttFallback` — apply the per-turn STT failure fallback (re-prompt/skip the
 *   turn); never terminates the call (Req 9.2).
 * - `ttsRetryThenText` — retry synthesis once and, if it still fails, convey
 *   the in-flight reply through an already-operative text channel
 *   (`textFallback`); never a service-terminating effect (Req 9.3). The shell
 *   supplies the reply text it was synthesizing — it is not re-derived here.
 * - `releaseResources` — tear down the Call_Session and release Audio_Stream
 *   resources (`gateway.hangup`/cleanup) (Req 4.6, 9.1).
 * - `log` — emit a diagnostic log entry at `info` or `error` level. The
 *   `message` never contains a credential or any caller secret.
 */
export type CallEffect =
  | { kind: 'answer' }
  | { kind: 'reject' }
  | { kind: 'startListening' }
  | { kind: 'transcribe' }
  | { kind: 'generate'; text: string }
  | { kind: 'synthesize'; text: string }
  | { kind: 'play' }
  | { kind: 'sttFallback' }
  | { kind: 'ttsRetryThenText' }
  | { kind: 'releaseResources' }
  | { kind: 'log'; level: 'info' | 'error'; message: string };

/** The result of one {@link transition}: the next state and the effects to run. */
export interface TransitionResult {
  next: CallState;
  effects: CallEffect[];
}

/** Convenience constructor for an `info`-level {@link CallEffect} log intent. */
function logInfo(message: string): CallEffect {
  return { kind: 'log', level: 'info', message };
}

/** Convenience constructor for an `error`-level {@link CallEffect} log intent. */
function logError(message: string): CallEffect {
  return { kind: 'log', level: 'error', message };
}

/**
 * Defensive handler for any `(state, event)` pair the table does not model.
 *
 * Keeps the machine total and crash-free: the state is preserved unchanged and
 * a single `info` log effect records the unhandled pair. This guarantees that
 * no input can throw and that a stray event never silently mutates the call.
 */
function defensive(state: CallState, event: CallEvent): TransitionResult {
  return {
    next: state,
    effects: [logInfo(`unhandled event '${event.kind}' in state '${state}'`)],
  };
}

/**
 * Pure, total, deterministic Call_Session reducer.
 *
 * Given the current {@link CallState} and an incoming {@link CallEvent}, returns
 * the next state and the ordered list of {@link CallEffect} intents the I/O
 * shell must execute. It performs no I/O, reads no clock or environment, and
 * never throws — identical inputs always yield identical outputs.
 *
 * Degradation rules encoded (Req 2.6, 4.6, 9.1–9.4):
 * - `stt_failed` keeps the call in `listening` with a per-turn `sttFallback`
 *   (plus an error log); the Call_Session is never crashed (Req 9.2).
 * - `engine_failed` returns to `listening` and emits no `synthesize`/`play`
 *   effect for that turn, leaving memory consistent (Req 9.4).
 * - `tts_failed` returns to `listening` and emits `ttsRetryThenText` — a
 *   retry-then-text-channel fallback that is never service-terminating
 *   (Req 2.6, 9.3).
 * - `hangup`/`drop` from any active state move to `tearing_down` with a
 *   `releaseResources` effect and a log; the call is never terminated silently
 *   (Req 4.6, 9.1).
 */
export function transition(state: CallState, event: CallEvent): TransitionResult {
  // Terminal state: a Call_Session that has ended absorbs any further event
  // defensively rather than re-running teardown or transitioning.
  if (state === 'ended') {
    return defensive(state, event);
  }

  // While tearing down, a hangup/drop completes the release into `ended`.
  // Everything else is preserved defensively until the shell finishes cleanup.
  if (state === 'tearing_down') {
    if (event.kind === 'hangup' || event.kind === 'drop') {
      return {
        next: 'ended',
        effects: [{ kind: 'releaseResources' }, logInfo('call teardown complete')],
      };
    }
    return defensive(state, event);
  }

  // From any active (non-terminal, non-tearing_down) state, a hangup or an
  // out-of-band drop always begins a clean teardown that releases resources and
  // logs — never a silent terminate (Req 4.6, 9.1).
  if (event.kind === 'hangup') {
    return {
      next: 'tearing_down',
      effects: [{ kind: 'releaseResources' }, logInfo('caller hangup; releasing call resources')],
    };
  }
  if (event.kind === 'drop') {
    return {
      next: 'tearing_down',
      effects: [
        { kind: 'releaseResources' },
        logError('audio/SIP connection dropped mid-call; releasing call resources'),
      ],
    };
  }

  // Normal per-state turn-loop flow.
  switch (state) {
    case 'ringing':
      // The allowlist gate admits or refuses the call before any engine work.
      switch (event.kind) {
        case 'allowed':
          return { next: 'answered', effects: [{ kind: 'answer' }] };
        case 'rejected':
          return { next: 'ended', effects: [{ kind: 'reject' }, { kind: 'releaseResources' }] };
        default:
          return defensive(state, event);
      }

    case 'answered':
      // Once the gateway confirms the answer, open the listen turn.
      switch (event.kind) {
        case 'answered':
          return { next: 'listening', effects: [{ kind: 'startListening' }] };
        default:
          return defensive(state, event);
      }

    case 'listening':
      // The caller finished a speech turn; transcribe it.
      switch (event.kind) {
        case 'turn_end':
          return { next: 'transcribing', effects: [{ kind: 'transcribe' }] };
        default:
          return defensive(state, event);
      }

    case 'transcribing':
      switch (event.kind) {
        case 'transcript':
          // Untrusted transcript flows on to the engine as plain text only.
          return { next: 'thinking', effects: [{ kind: 'generate', text: event.text }] };
        case 'stt_failed':
          // Per-turn fallback — stay in the call, never terminate (Req 9.2).
          return {
            next: 'listening',
            effects: [{ kind: 'sttFallback' }, logError('STT transcription failed; applying per-turn fallback')],
          };
        default:
          return defensive(state, event);
      }

    case 'thinking':
      switch (event.kind) {
        case 'reply':
          return { next: 'speaking', effects: [{ kind: 'synthesize', text: event.text }] };
        case 'engine_failed':
          // No reply is synthesized or played for this turn (Req 9.4); continue.
          return {
            next: 'listening',
            effects: [logError('Cognitive_Engine error on voice turn; no reply played this turn')],
          };
        default:
          return defensive(state, event);
      }

    case 'speaking':
      switch (event.kind) {
        case 'tts_ok':
          return { next: 'speaking', effects: [{ kind: 'play' }] };
        case 'tts_failed':
          // Retry-then-text-channel fallback; never service-terminating
          // (Req 2.6, 9.3). The turn ends and we return to listening.
          return {
            next: 'listening',
            effects: [{ kind: 'ttsRetryThenText' }, logError('TTS synthesis failed; retrying then falling back to text channel')],
          };
        case 'played':
          // Playback finished; ready for the next caller turn.
          return { next: 'listening', effects: [] };
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
 * I/O shell — `createVoiceConnector` (Component V8) — Req 4.1, 4.3, 4.4, 4.6,
 * 5.1, 5.2, 5.4, 5.5, 8.1, 8.2, 8.3, 9.1, 9.2, 9.3, 9.5, 10.5, 10.6, 11.1,
 * 11.2, 11.3, 11.5, 12.1.
 *
 * This is the side-effecting orchestrator that drives the real
 * {@link TelephonyGateway}/{@link SttEngine}/{@link TtsEngine} interfaces and
 * the Cognitive_Engine through the per-call turn loop, enforcing every gate the
 * design requires. The pure {@link transition} core above stays untouched; this
 * shell mirrors its degradation semantics (per-turn STT fallback, TTS
 * retry-then-text fallback, no playback on engine error, clean teardown on
 * drop) while wiring the push-based gateway callbacks.
 *
 * Security discipline (Req 7.4, 11.1–11.4): the transcript is only ever passed
 * as the engine `text` argument (untrusted data, never a command); the engine
 * reply is the only string handed to `tts.synthesize` (no concatenation of
 * credentials, journal, or out-of-band content into the spoken reply); every
 * log entry carries identifiers and reasons only — never a SIP credential.
 * ======================================================================== */

import { type AudioChunk, type AudioFormat, TELEPHONY_PCM_8K } from './audio.js';
import type { CallHandle, TelephonyGateway } from './telephony.asterisk.js';
import type { SttEngine, TurnDetector } from './stt.whisper.js';
import type { TtsEngine } from './tts.piper.js';
import type { CognitiveEngine } from '../../engine.js';
import type { RozaConfig, VoiceChannelConfig } from '../../config.js';
import { type ActiveWindow, isWithinActiveWindow, minutesInTimezone } from '../../window.js';
import type { Logger } from '../../types.js';
import type { CallOutcome, Repository } from '../../repository.js';
import { normalizeCallerIdentity, userIdForVoice } from '../sender.js';

/**
 * The telephony PCM format the connector requests from the TTS engine and plays
 * back to the caller. Narrowband 8 kHz mono is the classic telephony default
 * (Component V4); the gateway negotiates the wire transport in the same family.
 */
const PLAYBACK_FORMAT: AudioFormat = TELEPHONY_PCM_8K;

/**
 * Dependencies for {@link createVoiceConnector}. Every external edge is an
 * injected interface so the connector is driven by in-memory fakes in tests and
 * no real audio, SIP, or native binary runs in CI (Req 14.5).
 */
export interface VoiceConnectorDeps {
  /** Telephony control plane (place/answer/audio/hangup) — Component V7. */
  gateway: TelephonyGateway;
  /** Speech-to-text engine; its transcript is untrusted (Req 11.1) — Component V6. */
  stt: SttEngine;
  /** Text-to-speech engine for the engine reply (Req 11.2) — Component V5. */
  tts: TtsEngine;
  /** Factory for a fresh per-call {@link TurnDetector} (endpoint detection). */
  turnDetector: () => TurnDetector;
  /** The Cognitive_Engine; a transcribed turn becomes a plain `handleMessage`. */
  engine: CognitiveEngine;
  /** Resolved configuration, including `cfg.voice.{allowlist,defaultAccess,...}`. */
  cfg: RozaConfig;
  /** Active_Window the Right-to-Disconnect gate checks against (Req 8). */
  window: ActiveWindow;
  /** IANA timezone used to render `now()` to minutes-since-midnight. */
  timezone: string;
  /** Clock accessor; injectable so tests run deterministically. */
  now: () => Date;
  /** Structured logger; only identifiers/reasons are ever logged (Req 7.4, 11.4). */
  logger: Logger;
  /** Optional `call_sessions` audit repository; never blocks the turn loop (Req 9.1). */
  repo?: Repository;
  /**
   * Optional already-operative text channel used as the TTS-exhaustion fallback
   * (Req 9.3): convey the reply text to the caller out-of-band when synthesis
   * fails after a retry.
   */
  textFallback?: (to: string, text: string) => Promise<void>;
}

/**
 * The Voice_Connector surface. `start()` begins accepting inbound calls;
 * `placeOutboundCall` makes an autonomous outbound call subject to the
 * quiet-hours and allowlist gates.
 */
export interface VoiceConnector {
  /** Begin accepting inbound calls via `gateway.listen` (Req 4.1). */
  start(): Promise<void>;
  /**
   * Place an autonomous outbound call. Returns `{ ok: false, reason }` when the
   * call is blocked by quiet hours (`quiet_hours`), the allowlist
   * (`not_allowlisted`), or goes unanswered (`no_answer`); `{ ok: true }` once
   * the call connects (Req 5, 8).
   */
  placeOutboundCall(callerIdentity: string): Promise<{ ok: boolean; reason?: string }>;
}

/**
 * Decide whether a Caller_Identity is permitted on the voice channel, BEFORE
 * any engine work (Req 10.5, 10.6, 11.5, 5.5).
 *
 * Pure and total: an empty allowlist defers to `voiceCfg.defaultAccess` (an
 * enabled channel with no allowlist allows iff `defaultAccess === 'allow'`,
 * Req 10.6); a non-empty allowlist admits the caller iff a canonicalized entry
 * matches the canonicalized Caller_Identity. Canonicalization reuses the
 * Phase 3 {@link normalizeCallerIdentity} so a number/SIP-URI matches its
 * allowlist entry regardless of incidental formatting.
 */
export function isVoiceCallerAllowed(voiceCfg: VoiceChannelConfig, callerIdentity: string): boolean {
  if (voiceCfg.allowlist.length === 0) {
    return voiceCfg.defaultAccess === 'allow';
  }
  const caller = normalizeCallerIdentity(callerIdentity);
  return voiceCfg.allowlist.some((entry) => normalizeCallerIdentity(entry) === caller);
}

/** Concatenate accumulated PCM frames into a single buffer for transcription. */
function concatFrames(frames: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const f of frames) {
    total += f.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}

/**
 * Create the Voice_Connector I/O shell over the injected interfaces.
 *
 * The same per-turn loop serves inbound and outbound calls (Req 5.2): detect a
 * caller turn end → `stt.transcribe` → `engine.handleMessage` on the `voice`
 * channel → `tts.synthesize` the reply → `gateway.playAudio`. Gates enforced:
 * inbound allowlist before answer/engine (Req 10.5, 11.5); inbound quiet-hours
 * policy (Req 8.3); outbound quiet-hours block (Req 8.1, 8.2) then outbound
 * allowlist (Req 5.5); outbound ring timeout (Req 5.4). All call faults are
 * call-scoped and never crash the service (Req 9).
 */
export function createVoiceConnector(deps: VoiceConnectorDeps): VoiceConnector {
  const { gateway, stt, tts, engine, cfg, window, timezone, now, logger, repo, textFallback } = deps;
  const voiceCfg = cfg.voice;

  /** Per-call bookkeeping for audit teardown and to suppress post-end work. */
  interface ActiveCall {
    callerIdentity: string;
    sessionId: string | null;
    ended: boolean;
  }
  const activeCalls = new Map<string, ActiveCall>();

  /** Minutes since midnight in the configured zone for the current instant. */
  function nowMinutes(): number {
    return minutesInTimezone(now(), timezone);
  }

  /** Is the current instant inside the Active_Window (i.e. NOT Quiet_Hours)? */
  function inActiveWindow(): boolean {
    return isWithinActiveWindow(nowMinutes(), window);
  }

  /** Open an audit Call_Session if a repo is wired; never throws (Req 9.1). */
  function openAudit(handle: CallHandle): string | null {
    if (!repo) {
      return null;
    }
    try {
      const session = repo.startCallSession({
        userId: userIdForVoice(handle.callerIdentity),
        direction: handle.direction,
        callerIdentity: handle.callerIdentity,
      });
      return session.id;
    } catch (err: unknown) {
      logger.error('voice.audit.start_failed', { callId: handle.callId, error: errMsg(err) });
      return null;
    }
  }

  /** Close an audit Call_Session non-blockingly; never throws (Req 9.1). */
  function closeAudit(sessionId: string | null, outcome: CallOutcome): void {
    if (!repo || sessionId === null) {
      return;
    }
    try {
      repo.endCallSession(sessionId, outcome, now().toISOString());
    } catch (err: unknown) {
      logger.error('voice.audit.end_failed', { error: errMsg(err) });
    }
  }

  /** Bump the audit turn count non-blockingly; never throws (Req 9.1). */
  function bumpAudit(sessionId: string | null): void {
    if (!repo || sessionId === null) {
      return;
    }
    try {
      repo.incrementCallTurn(sessionId);
    } catch (err: unknown) {
      logger.error('voice.audit.turn_failed', { error: errMsg(err) });
    }
  }

  /**
   * Synthesize and play the engine reply, applying the Req 2.6/9.3 fallback:
   * retry synthesis once on failure, then convey the reply via the injected
   * text channel; never terminate the call/service. The engine reply is the
   * ONLY string handed to `tts.synthesize` (Req 11.2, 11.3).
   */
  async function speakReply(callId: string, callerIdentity: string, reply: string): Promise<void> {
    let chunk: AudioChunk;
    try {
      chunk = await tts.synthesize(reply, {
        voice: voiceCfg.tts.voice,
        format: PLAYBACK_FORMAT,
        timeoutMs: voiceCfg.latency.ttsMs,
      });
    } catch (firstErr: unknown) {
      logger.error('voice.tts.failed', { callId, attempt: 1, error: errMsg(firstErr) });
      try {
        // Retry synthesis exactly once before falling back (Req 9.3).
        chunk = await tts.synthesize(reply, {
          voice: voiceCfg.tts.voice,
          format: PLAYBACK_FORMAT,
          timeoutMs: voiceCfg.latency.ttsMs,
        });
      } catch (secondErr: unknown) {
        logger.error('voice.tts.exhausted', { callId, attempt: 2, error: errMsg(secondErr) });
        if (textFallback) {
          try {
            await textFallback(callerIdentity, reply);
            logger.info('voice.tts.text_fallback', { callId });
          } catch (fbErr: unknown) {
            logger.error('voice.tts.text_fallback_failed', { callId, error: errMsg(fbErr) });
          }
        }
        return;
      }
    }

    try {
      await gateway.playAudio(callId, chunk);
    } catch (err: unknown) {
      // A failed playback is call-scoped; log and continue the loop (Req 9.1).
      logger.error('voice.play.failed', { callId, error: errMsg(err) });
    }
  }

  /**
   * Process one completed caller turn: transcribe → engine → speak. Each
   * degradation path is contained so the Call_Session survives (Req 9.2, 9.4):
   * an STT failure logs and skips the turn; an empty transcript is ignored; an
   * engine error plays nothing this turn; only a successful reply is synthesized.
   */
  async function processTurn(call: ActiveCall, callId: string, audio: AudioChunk): Promise<void> {
    if (call.ended) {
      return;
    }

    let transcript: string;
    try {
      transcript = await stt.transcribe(audio, {
        model: voiceCfg.stt.model,
        timeoutMs: voiceCfg.latency.sttMs,
      });
    } catch (err: unknown) {
      // Per-turn STT fallback: stay in the call, skip this turn (Req 9.2).
      logger.error('voice.stt.failed', { callId, error: errMsg(err) });
      return;
    }

    if (transcript.trim().length === 0) {
      // Nothing was recognized for this turn; no engine call.
      return;
    }

    // The transcript is untrusted data — it is ONLY ever the engine `text`
    // argument, never parsed as a command or config change (Req 11.1).
    const res = await engine.handleMessage({
      channel: 'voice',
      userId: userIdForVoice(call.callerIdentity),
      text: transcript,
    });
    if (!res.ok) {
      // Engine error: no reply is synthesized or played this turn; memory is
      // left consistent by the Phase 1 Memory_Loop (Req 9.4). Continue the call.
      logger.error('voice.engine.failed', { callId, reason: res.reason });
      return;
    }

    // Audit the processed turn (non-blocking) and speak the reply.
    bumpAudit(call.sessionId);
    if (call.ended) {
      return;
    }
    await speakReply(callId, call.callerIdentity, res.reply);
  }

  /**
   * Attach the per-turn loop to an answered/connected call: subscribe to caller
   * audio, run turn/endpoint detection, and process each completed turn. Shared
   * by inbound and outbound so the loop is identical (Req 5.2).
   */
  function attachTurnLoop(handle: CallHandle): void {
    const call: ActiveCall = {
      callerIdentity: handle.callerIdentity,
      sessionId: openAudit(handle),
      ended: false,
    };
    activeCalls.set(handle.callId, call);

    const detector = deps.turnDetector();
    let frames: Uint8Array[] = [];
    let frameFormat: AudioFormat = PLAYBACK_FORMAT;
    let processing = false;

    gateway.onAudio(handle.callId, (chunk: AudioChunk) => {
      if (call.ended) {
        return;
      }
      const decision = detector.push(chunk, now().getTime());
      if (decision === 'speaking') {
        frames.push(chunk.data);
        frameFormat = chunk.format;
        return;
      }
      if (decision === 'turn_end') {
        // Serialize turns: ignore a new turn end while one is still processing.
        if (processing || frames.length === 0) {
          return;
        }
        processing = true;
        const audio: AudioChunk = { format: frameFormat, data: concatFrames(frames) };
        frames = [];
        detector.reset();
        void processTurn(call, handle.callId, audio).finally(() => {
          processing = false;
        });
      }
    });
  }

  /**
   * The `onInboundCall` callback handed to `gateway.listen`. Enforces the
   * allowlist gate BEFORE any answer or engine work (Req 10.5, 11.5), then the
   * inbound quiet-hours policy (Req 8.3), then answers and runs the turn loop.
   */
  async function onInboundCall(handle: CallHandle): Promise<void> {
    const { callId, callerIdentity } = handle;

    // GATE 1 — Allowlist BEFORE answering or any engine processing (Req 10.5,
    // 11.5). A rejected caller is hung up and logged; the engine is never
    // reached and no transcript is ever submitted.
    if (!isVoiceCallerAllowed(voiceCfg, callerIdentity)) {
      logger.error('voice.inbound.rejected_allowlist', { callId, callerIdentity });
      await safeHangup(callId, 'not_allowlisted');
      return;
    }

    // GATE 2 — Right to disconnect (inbound). A call arriving during Quiet_Hours
    // is handled per the configured policy rather than the full turn loop
    // (Req 8.3).
    if (!inActiveWindow()) {
      await applyInboundQuietHoursPolicy(handle);
      return;
    }

    // GATE 3 — Answer and run the per-turn loop (Req 4.1).
    try {
      await gateway.answer(callId);
    } catch (err: unknown) {
      logger.error('voice.inbound.answer_failed', { callId, error: errMsg(err) });
      await safeHangup(callId, 'answer_failed');
      return;
    }
    attachTurnLoop(handle);
    logger.info('voice.inbound.answered', { callId, callerIdentity });
  }

  /**
   * Apply the inbound Quiet_Hours policy (Req 8.3):
   * - `reject`      — hang up without answering; no engine work.
   * - `answer_busy` — signal busy by hanging up with a `busy` reason; no loop.
   * - `take_message`— answer and open an audit session to take a message, but do
   *   NOT run the engine turn loop (message capture/persistence is out of scope
   *   for the turn loop; the call is accepted passively and ends on hangup).
   */
  async function applyInboundQuietHoursPolicy(handle: CallHandle): Promise<void> {
    const { callId, callerIdentity } = handle;
    const policy = voiceCfg.quietHoursInbound;
    logger.info('voice.inbound.quiet_hours', { callId, callerIdentity, policy });

    if (policy === 'reject') {
      await safeHangup(callId, 'quiet_hours_reject');
      return;
    }
    if (policy === 'answer_busy') {
      await safeHangup(callId, 'quiet_hours_busy');
      return;
    }
    // take_message: answer + record (audit) without the full engine turn loop.
    try {
      await gateway.answer(callId);
    } catch (err: unknown) {
      logger.error('voice.inbound.answer_failed', { callId, error: errMsg(err) });
      await safeHangup(callId, 'answer_failed');
      return;
    }
    const sessionId = openAudit(handle);
    activeCalls.set(callId, { callerIdentity, sessionId, ended: false });
    logger.info('voice.inbound.taking_message', { callId, callerIdentity });
  }

  /** Hang up a call, swallowing+logging any transport error (call-scoped). */
  async function safeHangup(callId: string, reason: string): Promise<void> {
    try {
      await gateway.hangup(callId, reason);
    } catch (err: unknown) {
      logger.error('voice.hangup.failed', { callId, reason, error: errMsg(err) });
    }
  }

  // Register the out-of-band call-end handler once: clean up per-call state and
  // close the audit session on a caller hangup or network drop (Req 4.6, 9.1).
  gateway.onCallEnded((callId: string, reason: string) => {
    const call = activeCalls.get(callId);
    if (!call || call.ended) {
      return;
    }
    call.ended = true;
    activeCalls.delete(callId);
    closeAudit(call.sessionId, 'completed');
    logger.info('voice.call.ended', { callId, reason });
  });

  return {
    async start(): Promise<void> {
      await gateway.listen(onInboundCall);
      logger.info('voice.connector.started', {});
    },

    async placeOutboundCall(callerIdentity: string): Promise<{ ok: boolean; reason?: string }> {
      // GATE 1 — Right to disconnect: never place an autonomous call during
      // Quiet_Hours; log the deferral and decline (Req 8.1, 8.2).
      if (!inActiveWindow()) {
        logger.info('voice.outbound.quiet_hours_deferred', { callerIdentity });
        return { ok: false, reason: 'quiet_hours' };
      }

      // GATE 2 — Outbound allowlist: never originate to a non-allowed callee
      // (Req 5.5).
      if (!isVoiceCallerAllowed(voiceCfg, callerIdentity)) {
        logger.error('voice.outbound.rejected_allowlist', { callerIdentity });
        return { ok: false, reason: 'not_allowlisted' };
      }

      // GATE 3 — Originate. Resolves on answer; rejects on ring timeout (Req
      // 5.1, 5.4). A ring timeout (or any origination failure) is logged and
      // reported as unanswered without crashing the service.
      let handle: CallHandle;
      try {
        handle = await gateway.originate(callerIdentity, {
          ringTimeoutMs: voiceCfg.latency.ringTimeoutMs,
        });
      } catch (err: unknown) {
        logger.info('voice.outbound.no_answer', { callerIdentity, error: errMsg(err) });
        return { ok: false, reason: 'no_answer' };
      }

      // Connected: run the same per-turn loop as inbound (Req 5.2).
      attachTurnLoop(handle);
      logger.info('voice.outbound.connected', { callId: handle.callId, callerIdentity });
      return { ok: true };
    },
  };
}

/** Extract a safe, credential-free message from an unknown thrown value. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
