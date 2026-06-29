// Feature: roza-step3-voice-telephony — mocked-integration test for the
// whisper.cpp SttEngine adapter + the pure TurnDetector endpointing.
//
// Validates: Requirements 4.2, 9.2, 14.5
//
// This suite exercises `createWhisperSttEngine` against a FAKE `spawn` that
// returns a fake child process (stdout/stderr EventEmitters, 'error'/'close'
// events, a `.kill` spy). No real whisper.cpp binary, audio, or native I/O ever
// runs (Req 14.5). The pure `createTurnDetector` is driven over canned frames
// (plus a small fast-check property) to validate energy/silence endpointing.

import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { createWhisperSttEngine, createTurnDetector } from './stt.whisper.js';
import {
  TELEPHONY_PCM_8K,
  type AudioChunk,
  type AudioFormat,
} from './audio.js';
import type { Logger } from '../../types.js';

const BYTES_PER_SAMPLE = 2;

/** Build a `pcm_s16le` {@link AudioChunk} from an array of signed-16 samples. */
function chunkFromSamples(samples: number[], format: AudioFormat = TELEPHONY_PCM_8K): AudioChunk {
  const data = new Uint8Array(samples.length * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i]! | 0;
    data[i * BYTES_PER_SAMPLE] = v & 0xff; // little-endian low byte
    data[i * BYTES_PER_SAMPLE + 1] = (v >> 8) & 0xff; // high byte
  }
  return { format, data };
}

/** A loud frame whose normalised RMS energy is well above the default threshold. */
function loudFrame(sampleCount = 16): AudioChunk {
  return chunkFromSamples(new Array(sampleCount).fill(28000));
}

/** A silent frame (all zero samples) whose energy is 0. */
function silentFrame(sampleCount = 16): AudioChunk {
  return chunkFromSamples(new Array(sampleCount).fill(0));
}

/** A fake child process: stdout/stderr emitters, 'error'/'close', a kill spy. */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn();
}

interface FakeSpawnBehavior {
  /** Text emitted on stdout before close. */
  stdout?: string;
  /** Text emitted on stderr before close. */
  stderr?: string;
  /** Exit code passed to the 'close' event (default 0). */
  closeCode?: number | null;
  /** When set, emit this on the 'error' event instead of closing. */
  emitError?: Error;
  /** When true the child never closes (drives the timeout path). */
  silent?: boolean;
}

/**
 * Build a fake `spawn` compatible with `node:child_process` spawn that records
 * every invocation and drives the returned child according to `behavior`.
 */
function makeFakeSpawn(behavior: FakeSpawnBehavior): {
  spawn: typeof import('node:child_process').spawn;
  calls: Array<{ command: string; args: string[]; child: FakeChild }>;
} {
  const calls: Array<{ command: string; args: string[]; child: FakeChild }> = [];

  const spawn = (command: string, args: string[]): FakeChild => {
    const child = new FakeChild();
    calls.push({ command, args, child });

    if (!behavior.silent) {
      // Emit asynchronously so the adapter has attached its listeners first.
      setImmediate(() => {
        if (behavior.emitError) {
          child.emit('error', behavior.emitError);
          return;
        }
        if (behavior.stdout !== undefined) {
          child.stdout.emit('data', Buffer.from(behavior.stdout, 'utf8'));
        }
        if (behavior.stderr !== undefined) {
          child.stderr.emit('data', Buffer.from(behavior.stderr, 'utf8'));
        }
        child.emit('close', behavior.closeCode ?? 0);
      });
    }

    return child;
  };

  return {
    spawn: spawn as unknown as typeof import('node:child_process').spawn,
    calls,
  };
}

/** A logger whose calls are spied so we can assert nothing sensitive is logged. */
function makeSpyLogger(): Logger & {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return {
    info: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger & {
    info: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

/** Flatten every argument of every spy call into a single searchable string. */
function allLoggedText(logger: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }): string {
  const parts: string[] = [];
  for (const call of [...logger.info.mock.calls, ...logger.error.mock.calls]) {
    for (const arg of call) {
      parts.push(typeof arg === 'string' ? arg : JSON.stringify(arg));
    }
  }
  return parts.join('\n');
}

const MODEL_DIR = '/opt/whisper/models';
const BIN_PATH = '/opt/whisper/whisper-cli';

describe('createWhisperSttEngine (mocked spawn) — Req 4.2, 9.2, 14.5', () => {
  it('spawns the binary with -m <modelDir>/<model>.bin -f <wav> and a no-timestamp flag, resolving the trimmed transcript', async () => {
    const transcript = 'bonjour roza';
    const { spawn, calls } = makeFakeSpawn({ stdout: `  ${transcript}\n`, closeCode: 0 });
    const engine = createWhisperSttEngine({ binPath: BIN_PATH, modelDir: MODEL_DIR, spawn });

    const text = await engine.transcribe(loudFrame(), { model: 'ggml-base', timeoutMs: 1000 });

    // Resolves the trimmed transcript from stdout.
    expect(text).toBe(transcript);

    // Spawned exactly once with the expected binary and arguments.
    expect(calls).toHaveLength(1);
    const { command, args } = calls[0]!;
    expect(command).toBe(BIN_PATH);

    // -m <modelDir>/<model>.bin
    const mIndex = args.indexOf('-m');
    expect(mIndex).toBeGreaterThanOrEqual(0);
    expect(args[mIndex + 1]).toBe(join(MODEL_DIR, 'ggml-base.bin'));

    // -f <wav> pointing at the written WAV turn file.
    const fIndex = args.indexOf('-f');
    expect(fIndex).toBeGreaterThanOrEqual(0);
    expect(args[fIndex + 1]).toMatch(/turn\.wav$/);

    // A no-timestamp flag is present so stdout is plain text.
    expect(args).toContain('-nt');
  });

  it('rejects when the binary exits non-zero', async () => {
    const { spawn, calls } = makeFakeSpawn({ stderr: 'model load failed', closeCode: 2 });
    const engine = createWhisperSttEngine({ binPath: BIN_PATH, modelDir: MODEL_DIR, spawn });

    await expect(
      engine.transcribe(loudFrame(), { model: 'ggml-base', timeoutMs: 1000 }),
    ).rejects.toThrow(/code 2/);
    expect(calls).toHaveLength(1);
  });

  it('rejects when spawn emits an error event', async () => {
    const { spawn } = makeFakeSpawn({ emitError: new Error('ENOENT: binary missing') });
    const engine = createWhisperSttEngine({ binPath: BIN_PATH, modelDir: MODEL_DIR, spawn });

    await expect(
      engine.transcribe(loudFrame(), { model: 'ggml-base', timeoutMs: 1000 }),
    ).rejects.toThrow(/ENOENT/);
  });

  it('rejects and kills the child when the transcription times out', async () => {
    const { spawn, calls } = makeFakeSpawn({ silent: true });
    const engine = createWhisperSttEngine({ binPath: BIN_PATH, modelDir: MODEL_DIR, spawn });

    await expect(
      engine.transcribe(loudFrame(), { model: 'ggml-base', timeoutMs: 10 }),
    ).rejects.toThrow(/timed out/);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.child.kill).toHaveBeenCalled();
  });

  it('short-circuits empty audio (zero samples) to "" without spawning', async () => {
    const { spawn, calls } = makeFakeSpawn({ stdout: 'should not be used', closeCode: 0 });
    const engine = createWhisperSttEngine({ binPath: BIN_PATH, modelDir: MODEL_DIR, spawn });

    const text = await engine.transcribe(chunkFromSamples([]), { model: 'ggml-base', timeoutMs: 1000 });

    expect(text).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('never logs the transcript content', async () => {
    const transcript = 'extremely-sensitive-transcript-payload';
    const logger = makeSpyLogger();
    const { spawn } = makeFakeSpawn({ stdout: transcript, closeCode: 0 });
    const engine = createWhisperSttEngine({ binPath: BIN_PATH, modelDir: MODEL_DIR, spawn, logger });

    const text = await engine.transcribe(loudFrame(), { model: 'ggml-base', timeoutMs: 1000 });

    expect(text).toBe(transcript);
    expect(allLoggedText(logger)).not.toContain(transcript);
  });

  it('exposes an MIT whisper.cpp descriptor', () => {
    const engine = createWhisperSttEngine({ binPath: BIN_PATH, modelDir: MODEL_DIR });
    expect(engine.descriptor.name).toBe('whisper.cpp');
    expect(engine.descriptor.license).toBe('MIT');
  });
});

describe('createTurnDetector endpointing — Req 9.2', () => {
  it('returns "speaking" for a high-energy frame', () => {
    const detector = createTurnDetector({ energyThreshold: 0.02, silenceMs: 700 });
    expect(detector.push(loudFrame(), 0)).toBe('speaking');
  });

  it('returns "turn_end" once trailing silence reaches silenceMs after speech', () => {
    const detector = createTurnDetector({ energyThreshold: 0.02, silenceMs: 700 });
    expect(detector.push(loudFrame(), 0)).toBe('speaking');
    // Below silenceMs of silence is not yet a turn end.
    expect(detector.push(silentFrame(), 300)).toBe('silence');
    // Reaching silenceMs of trailing silence closes the turn.
    expect(detector.push(silentFrame(), 700)).toBe('turn_end');
  });

  it('returns "silence" for a low-energy frame with no prior speech', () => {
    const detector = createTurnDetector({ energyThreshold: 0.02, silenceMs: 700 });
    expect(detector.push(silentFrame(), 0)).toBe('silence');
    expect(detector.push(silentFrame(), 5000)).toBe('silence');
  });

  it('reset() clears speaking state so no turn end is emitted afterwards', () => {
    const detector = createTurnDetector({ energyThreshold: 0.02, silenceMs: 700 });
    expect(detector.push(loudFrame(), 0)).toBe('speaking');
    detector.reset();
    // After reset there is no prior speech, so a long silence stays 'silence'.
    expect(detector.push(silentFrame(), 10000)).toBe('silence');
  });

  it('never emits a turn end without prior speech (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 50 }),
        (times) => {
          const detector = createTurnDetector({ energyThreshold: 0.02, silenceMs: 700 });
          // Only ever feed silent frames: without any speech the detector must
          // always report 'silence' regardless of the time sequence.
          for (const t of times) {
            expect(detector.push(silentFrame(), t)).toBe('silence');
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
