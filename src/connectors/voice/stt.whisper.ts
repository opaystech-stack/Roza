/**
 * SttEngine interface + whisper.cpp adapter, plus the pure TurnDetector
 * (Component V6) — Req 4.2, 5.2, 9.2, 11.1, 12.1.
 *
 * Two concerns live here, kept strictly separated so the testable logic never
 * touches I/O:
 *
 * 1. {@link TurnDetector} — pure, deterministic endpoint detection. Given a
 *    stream of PCM frames and a clock value it decides whether the caller is
 *    `'speaking'`, has just reached a `'turn_end'`, or is in `'silence'`. It
 *    uses frame RMS energy and a silence-duration threshold; it performs no I/O
 *    and is the property-based-testing target for endpointing. The Voice
 *    Connector uses a `'turn_end'` to know when to hand the accumulated turn
 *    audio to the {@link SttEngine}.
 *
 * 2. {@link SttEngine} — the speech-to-text boundary. The real
 *    {@link createWhisperSttEngine} adapter spawns the bundled, MIT-licensed
 *    `whisper.cpp` binary against an MIT ggml model and returns the transcript.
 *    The returned transcript is **untrusted** (Req 11.1): it is only ever
 *    passed as the `text` argument to `handleMessage`, never interpreted as a
 *    command. The `spawn` dependency is injectable so tests run against a mock
 *    and **no real whisper.cpp process runs in CI** (Req 14.5). Transcript
 *    content and credentials are never logged.
 */

import { spawn as defaultSpawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AudioChunk } from './audio.js';
import type { Logger } from '../../types.js';

/**
 * The speech-to-text boundary: turn one caller turn's accumulated audio into
 * text. The returned string is untrusted caller-supplied content (Req 11.1).
 */
export interface SttEngine {
  /** Transcribe one caller turn's audio into text. Rejects on engine failure. */
  transcribe(audio: AudioChunk, opts: { model: string; timeoutMs: number }): Promise<string>;
  /** Static descriptor for the license manifest + logs (no secrets). */
  readonly descriptor: { name: 'whisper.cpp' | 'faster-whisper'; license: string; model: string };
}

/**
 * Pure turn/endpoint detection over an audio stream (energy + silence-duration
 * based). Deterministic given its inputs and internal state; performs no I/O.
 */
export interface TurnDetector {
  /** Feed a frame; returns 'speaking' | 'turn_end' | 'silence'. Pure given internal state. */
  push(frame: AudioChunk, now: number): 'speaking' | 'turn_end' | 'silence';
  /** Clear all accumulated speaking state so the detector can be reused. */
  reset(): void;
}

/** Bytes per `pcm_s16le` sample (16-bit = 2 bytes). */
const BYTES_PER_SAMPLE = 2;
/** Maximum magnitude of a signed 16-bit sample, used to normalise RMS to [0, 1]. */
const INT16_SCALE = 32768;

/** Default normalised RMS energy (0..1) at or above which a frame is "speech". */
const DEFAULT_ENERGY_THRESHOLD = 0.02;
/** Default trailing-silence duration (ms) that closes a turn. */
const DEFAULT_SILENCE_MS = 700;

/**
 * Compute the normalised root-mean-square energy of a `pcm_s16le` frame.
 *
 * Pure and total: reads only whole little-endian 16-bit samples (a trailing odd
 * byte is ignored), returns `0` for an empty or sub-sample frame, and the
 * result is always a finite number in `[0, 1]` (RMS divided by the int16 scale,
 * clamped). Never throws regardless of buffer length.
 */
function frameRmsEnergy(chunk: AudioChunk): number {
  const data = chunk.data;
  const sampleCount = Math.floor(data.length / BYTES_PER_SAMPLE);
  if (sampleCount <= 0) {
    return 0;
  }
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const lo = data[i * BYTES_PER_SAMPLE]!;
    const hi = data[i * BYTES_PER_SAMPLE + 1]!;
    // Reconstruct the signed 16-bit little-endian sample.
    let sample = (hi << 8) | lo;
    if (sample >= INT16_SCALE) {
      sample -= INT16_SCALE * 2;
    }
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / sampleCount);
  const normalised = rms / INT16_SCALE;
  if (!Number.isFinite(normalised) || normalised <= 0) {
    return 0;
  }
  return normalised > 1 ? 1 : normalised;
}

/**
 * Create a pure, deterministic energy/silence-based {@link TurnDetector}.
 *
 * Decision rule for each `push(frame, now)`:
 * - Compute the frame's normalised RMS energy.
 * - If energy is at or above `energyThreshold`, the caller is speaking: mark
 *   the speaking state, remember `now` as the last speech time, and return
 *   `'speaking'`.
 * - Otherwise the frame is below threshold. If we were previously speaking and
 *   a valid silence duration `now - lastSpeechAt` is at least `silenceMs`, the
 *   turn has ended: clear the speaking state and return `'turn_end'`.
 * - In every other case return `'silence'`.
 *
 * Robust and total: a non-finite or out-of-range `energyThreshold`/`silenceMs`
 * falls back to its default; a non-finite `now` cannot satisfy the silence
 * duration test, so it degrades to `'silence'` rather than emitting a spurious
 * turn end. No I/O, no shared mutable input — fully replayable given the same
 * sequence of inputs.
 */
export function createTurnDetector(opts?: {
  energyThreshold?: number;
  silenceMs?: number;
}): TurnDetector {
  const energyThreshold =
    typeof opts?.energyThreshold === 'number' && Number.isFinite(opts.energyThreshold) && opts.energyThreshold >= 0
      ? opts.energyThreshold
      : DEFAULT_ENERGY_THRESHOLD;
  const silenceMs =
    typeof opts?.silenceMs === 'number' && Number.isFinite(opts.silenceMs) && opts.silenceMs >= 0
      ? opts.silenceMs
      : DEFAULT_SILENCE_MS;

  let speaking = false;
  let lastSpeechAt: number | null = null;

  return {
    push(frame: AudioChunk, now: number): 'speaking' | 'turn_end' | 'silence' {
      const energy = frameRmsEnergy(frame);
      if (energy >= energyThreshold) {
        speaking = true;
        if (Number.isFinite(now)) {
          lastSpeechAt = now;
        }
        return 'speaking';
      }
      if (
        speaking &&
        lastSpeechAt !== null &&
        Number.isFinite(now) &&
        now - lastSpeechAt >= silenceMs
      ) {
        speaking = false;
        lastSpeechAt = null;
        return 'turn_end';
      }
      return 'silence';
    },
    reset(): void {
      speaking = false;
      lastSpeechAt = null;
    },
  };
}

/** Total samples represented by a `pcm_s16le` chunk's byte buffer. */
function sampleCountOf(chunk: AudioChunk): number {
  return Math.floor(chunk.data.length / BYTES_PER_SAMPLE);
}

/**
 * Build a canonical 44-byte WAV (RIFF) header for a mono `pcm_s16le` stream and
 * prepend it to `chunk.data`, producing a self-describing WAV file the
 * whisper.cpp binary can read with `-f`. Pure and total.
 */
function pcmToWav(chunk: AudioChunk): Buffer {
  const { sampleRate, channels } = chunk.format;
  const pcm = Buffer.from(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
  const byteRate = sampleRate * channels * BYTES_PER_SAMPLE;
  const blockAlign = channels * BYTES_PER_SAMPLE;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Create the real whisper.cpp-backed {@link SttEngine}.
 *
 * `transcribe` writes the accumulated turn audio to a temporary WAV file and
 * spawns the bundled whisper.cpp binary (default `WHISPER_BIN` or
 * `/opt/whisper/main`) with `-m <modelDir>/<model>.bin` and no-timestamp flags
 * so the transcript is emitted as plain text on stdout. The call is bounded by
 * `opts.timeoutMs`; it rejects on timeout, a non-zero exit, or a spawn error.
 * The trimmed transcript is returned verbatim and treated as untrusted
 * (Req 11.1).
 *
 * `spawn` is injectable so tests use a mock and no real whisper.cpp process
 * runs in CI (Req 14.5). Transcript content is never logged; credentials are
 * never handled here.
 */
export function createWhisperSttEngine(deps?: {
  binPath?: string;
  modelDir?: string;
  spawn?: typeof import('node:child_process').spawn;
  logger?: Logger;
}): SttEngine {
  const spawn = deps?.spawn ?? defaultSpawn;
  const logger = deps?.logger;
  const binPath = deps?.binPath ?? process.env.WHISPER_BIN ?? '/opt/whisper/main';
  const modelDir = deps?.modelDir ?? process.env.WHISPER_MODEL_DIR ?? '/opt/whisper/models';
  const descriptorModel = process.env.STT_MODEL ?? process.env.WHISPER_MODEL ?? 'ggml-base';

  async function transcribe(audio: AudioChunk, opts: { model: string; timeoutMs: number }): Promise<string> {
    if (sampleCountOf(audio) <= 0) {
      // Nothing was captured for this turn; an empty transcript is the honest
      // result and avoids spawning the binary on no audio.
      return '';
    }

    const modelPath = join(modelDir, `${opts.model}.bin`);
    const dir = await mkdtemp(join(tmpdir(), 'roza-stt-'));
    const wavPath = join(dir, 'turn.wav');

    try {
      await writeFile(wavPath, pcmToWav(audio));
      return await runWhisper({ spawn, binPath, modelPath, wavPath, timeoutMs: opts.timeoutMs, logger });
    } finally {
      // Best-effort cleanup of the temp dir; never let cleanup failure mask the
      // transcription outcome.
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    transcribe,
    descriptor: { name: 'whisper.cpp', license: 'MIT', model: descriptorModel },
  };
}

/**
 * Spawn the whisper.cpp binary against a prepared WAV file and resolve with its
 * trimmed plain-text transcript. Bounded by `timeoutMs`; rejects on timeout,
 * spawn error, or non-zero exit. Never logs the transcript content.
 */
function runWhisper(args: {
  spawn: typeof import('node:child_process').spawn;
  binPath: string;
  modelPath: string;
  wavPath: string;
  timeoutMs: number;
  logger: Logger | undefined;
}): Promise<string> {
  const { spawn, binPath, modelPath, wavPath, timeoutMs, logger } = args;
  return new Promise<string>((resolve, reject) => {
    // `-nt` suppresses timestamps so stdout is plain transcript text; `-f`
    // feeds the WAV file produced from the accumulated turn audio.
    const child = spawn(binPath, ['-m', modelPath, '-f', wavPath, '-nt'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      try {
        child.kill('SIGKILL');
      } catch {
        // Process may already have exited; nothing more to do.
      }
      logger?.error('stt.whisper transcription failed', { reason: error.message });
      reject(error);
    };

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        fail(new Error(`whisper.cpp transcription timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // Do not keep the event loop alive solely for this timer.
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    }

    child.stdout?.on('data', (buf: Buffer) => {
      stdout += buf.toString('utf8');
    });
    child.stderr?.on('data', (buf: Buffer) => {
      stderr += buf.toString('utf8');
    });

    child.on('error', (err: Error) => {
      fail(err);
    });

    child.on('close', (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      const detail = stderr.trim();
      logger?.error('stt.whisper exited non-zero', { code: code ?? -1 });
      reject(new Error(`whisper.cpp exited with code ${code ?? -1}${detail ? `: ${detail}` : ''}`));
    });
  });
}
