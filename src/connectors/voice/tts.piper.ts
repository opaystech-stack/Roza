/**
 * TtsEngine interface + Piper adapter (Component V5) — Req 2.1–2.6, 3.1, 12.1.
 *
 * Defines the injectable {@link TtsEngine} boundary the Voice_Connector uses to
 * turn an engine reply (plain text) into a playable {@link AudioChunk}, plus the
 * default {@link createPiperTtsEngine} adapter over the bundled, MIT-licensed
 * `piper` native binary.
 *
 * The adapter spawns `piper --model <model> --output_raw`, writes the reply
 * text to stdin, and collects the raw little-endian PCM the binary streams to
 * stdout into a single {@link AudioChunk} tagged with the requested
 * {@link AudioFormat}. A `timeoutMs` budget bounds time-to-first-audio (Req
 * 2.5); on timeout, a non-zero exit, or a spawn error the returned promise
 * rejects so the Voice_Connector can apply its Req 9.3 fallback (Req 2.6). The
 * killed child is reaped on timeout.
 *
 * `spawn` is injectable (defaulting to `node:child_process` `spawn`) and the
 * binary/model paths are configurable, so tests exercise the adapter against a
 * mocked child process — no real Piper ever runs in CI (Req 14.5).
 *
 * Secret/PII discipline: this module NEVER logs the synthesized `text` nor any
 * credential. Only non-sensitive identifiers (voice name, byte counts, the
 * descriptor) appear in logs.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { Logger } from '../../types.js';
import type { AudioChunk, AudioFormat } from './audio.js';

/** Injectable `spawn`, structurally compatible with `node:child_process` spawn. */
export type SpawnFn = typeof nodeSpawn;

/**
 * Synthesizes plain text into playable telephony PCM.
 *
 * The single boundary the Voice_Connector depends on for text-to-speech; the
 * default implementation wraps Piper, but any conformant engine (e.g. Kokoro)
 * can be injected in its place.
 */
export interface TtsEngine {
  /**
   * Synthesize `text` into a playable {@link AudioChunk} in the requested
   * format. Rejects on failure or when it cannot begin producing audio within
   * `opts.timeoutMs`.
   */
  synthesize(
    text: string,
    opts: { voice: string; format: AudioFormat; timeoutMs: number },
  ): Promise<AudioChunk>;
  /** Static descriptor for the license manifest + logs (carries no secrets). */
  readonly descriptor: { name: 'piper' | 'kokoro'; license: string; voice: string };
}

/** Dependencies for {@link createPiperTtsEngine}; every external edge is injectable. */
export interface PiperTtsEngineDeps {
  /**
   * Path to the bundled `piper` binary. Defaults to `PIPER_BIN` or
   * `/opt/piper/piper`.
   */
  binPath?: string;
  /**
   * Directory holding the `<voice>.onnx` voice models. Defaults to
   * `PIPER_MODEL_DIR` or `/opt/piper/models`.
   */
  modelDir?: string;
  /** Injectable process spawner; defaults to `node:child_process` `spawn`. */
  spawn?: SpawnFn;
  /** Optional structured logger; never receives `text` or secrets. */
  logger?: Logger;
}

/** Default Piper binary path when none is configured via deps or env. */
const DEFAULT_PIPER_BIN = '/opt/piper/piper';
/** Default directory holding `<voice>.onnx` models when none is configured. */
const DEFAULT_PIPER_MODEL_DIR = '/opt/piper/models';

/**
 * Build the absolute model path for `voice` under `modelDir`.
 *
 * Piper loads an ONNX voice model named `<voice>.onnx`; the path is joined with
 * a forward slash, which Piper accepts on every supported platform.
 */
function modelPathFor(modelDir: string, voice: string): string {
  const dir = modelDir.endsWith('/') ? modelDir.slice(0, -1) : modelDir;
  return `${dir}/${voice}.onnx`;
}

/**
 * Create a Piper-backed {@link TtsEngine}.
 *
 * The returned engine's `synthesize` spawns the bundled `piper` binary with
 * `--model <model> --output_raw`, writes `text` to stdin, and accumulates the
 * raw PCM streamed to stdout. The chunk is tagged with `opts.format`; Piper's
 * native model rate may differ from the requested telephony rate, so resampling
 * is a documented follow-up — the chunk is tagged with the requested format
 * here to keep the boundary contract simple and correct for the common case
 * where the model already emits the requested rate.
 *
 * Rejects (so the connector applies the Req 9.3 fallback) on:
 * - a spawn error (binary missing / not executable),
 * - a non-zero exit, or
 * - exceeding `opts.timeoutMs` before completion (the child is killed).
 */
export function createPiperTtsEngine(deps: PiperTtsEngineDeps = {}): TtsEngine {
  const spawnFn: SpawnFn = deps.spawn ?? nodeSpawn;
  const binPath = deps.binPath ?? process.env.PIPER_BIN ?? DEFAULT_PIPER_BIN;
  const modelDir = deps.modelDir ?? process.env.PIPER_MODEL_DIR ?? DEFAULT_PIPER_MODEL_DIR;
  const logger = deps.logger;

  return {
    descriptor: { name: 'piper', license: 'MIT', voice: '' },

    synthesize(
      text: string,
      opts: { voice: string; format: AudioFormat; timeoutMs: number },
    ): Promise<AudioChunk> {
      const model = modelPathFor(modelDir, opts.voice);

      return new Promise<AudioChunk>((resolve, reject) => {
        let settled = false;
        const chunks: Buffer[] = [];

        const child = spawnFn(binPath, ['--model', model, '--output_raw'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const timer = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          // Reap the child so no orphaned Piper process is left running.
          child.kill('SIGKILL');
          // Never log `text`; only the non-sensitive voice + budget.
          logger?.error('tts.piper.timeout', { voice: opts.voice, timeoutMs: opts.timeoutMs });
          reject(new Error(`Piper TTS timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);

        const finish = (fn: () => void): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          fn();
        };

        child.stdout?.on('data', (data: Buffer) => {
          chunks.push(data);
        });

        child.on('error', (err: Error) => {
          finish(() => {
            logger?.error('tts.piper.spawn_error', { voice: opts.voice, error: err.message });
            reject(err);
          });
        });

        child.on('close', (code: number | null) => {
          finish(() => {
            if (code !== 0) {
              logger?.error('tts.piper.nonzero_exit', { voice: opts.voice, code });
              reject(new Error(`Piper TTS exited with code ${code ?? 'null'}`));
              return;
            }
            const pcm = Buffer.concat(chunks);
            logger?.info('tts.piper.synthesized', { voice: opts.voice, bytes: pcm.byteLength });
            resolve({
              format: opts.format,
              data: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
            });
          });
        });

        // Stream the reply text to Piper, then close stdin so it begins
        // synthesis. Errors on stdin (e.g. EPIPE after a killed child) reject.
        const stdin = child.stdin;
        if (!stdin) {
          finish(() => reject(new Error('Piper TTS stdin is unavailable')));
          return;
        }
        stdin.on('error', (err: Error) => {
          finish(() => {
            logger?.error('tts.piper.stdin_error', { voice: opts.voice, error: err.message });
            reject(err);
          });
        });
        stdin.write(text);
        stdin.end();
      });
    },
  };
}
