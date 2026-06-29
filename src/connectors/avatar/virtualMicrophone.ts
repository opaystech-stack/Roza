/**
 * VirtualMicrophone interface + PipeWire null-sink adapter (Component A6) —
 * Req 5.2, 5.4, 5.5, 9.1.
 *
 * Defines the injectable {@link VirtualMicrophone} boundary the Avatar_Connector
 * uses to present Roza's reply speech audio as microphone input any WebRTC
 * client (a browser, a Google Meet tab, an RTMP encoder) can consume, plus the
 * default {@link createPipeWireVirtualMicrophone} adapter over a self-hosted
 * **PipeWire** (or PulseAudio) null sink.
 *
 * The adapter spawns a long-lived playback process (`pw-cat --playback`, or the
 * PulseAudio `pacat` equivalent) targeting the configured null-sink device
 * (`cfg.avatar.devices.microphone`), then streams the reply PCM to that
 * process's stdin one {@link AudioChunk} at a time. The concrete media backend
 * stays confined to this file: swapping PipeWire for PulseAudio (or any other
 * sink) re-implements only this adapter behind the unchanged interface (Req
 * 5.4).
 *
 * Lifecycle: {@link VirtualMicrophone.open} provisions the sink process and
 * **rejects — naming the device — if it cannot be initialized** (binary missing,
 * sink absent, immediate non-zero exit), so the Avatar_Connector applies its Req
 * 9 audio-only fallback rather than crashing (Req 5.5). {@link
 * VirtualMicrophone.write} forwards a chunk's PCM bytes to the sink; {@link
 * VirtualMicrophone.close} ends stdin and reaps the child.
 *
 * Testability: `spawn` and the device name are injectable, so tests drive the
 * adapter against a mocked child process — **no real PipeWire null sink runs in
 * CI** (Req 12.5).
 *
 * Secret/PII discipline: this module NEVER logs the reply audio bytes nor any
 * credential. Only non-sensitive identifiers (device name, backend, byte
 * counts) appear in logs.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { Logger } from '../../types.js';
import type { AudioChunk, AudioFormat } from '../voice/audio.js';

/** Injectable `spawn`, structurally compatible with `node:child_process` spawn. */
export type SpawnFn = typeof nodeSpawn;

/**
 * The self-hosted Virtual_Microphone surface the Avatar_Connector presents the
 * reply speech audio on. The concrete sink technology (PipeWire/PulseAudio null
 * sink) is hidden behind this interface so it stays swappable (Req 5.4).
 */
export interface VirtualMicrophone {
  /** Open the virtual audio device (PipeWire null sink) for writing (Req 5.2). */
  open(format: AudioFormat): Promise<void>;
  /** Present speech audio so a WebRTC client consumes it as microphone input. */
  write(chunk: AudioChunk): Promise<void>;
  /** Release the device. */
  close(): Promise<void>;
  /** Static descriptor for the license manifest + logs (carries no secrets). */
  readonly descriptor: { device: string; backend: string; license: string };
}

/** Dependencies for {@link createPipeWireVirtualMicrophone}; every external edge is injectable. */
export interface PipeWireVirtualMicrophoneDeps {
  /**
   * Name of the PipeWire/PulseAudio null sink to feed. Defaults to
   * `AVATAR_MIC_DEVICE` or `roza_virtmic`. Wire `cfg.avatar.devices.microphone`
   * here.
   */
  device?: string;
  /** Path to the playback binary. Defaults to `PIPEWIRE_PLAYBACK_BIN` or `pw-cat`. */
  binPath?: string;
  /** Injectable process spawner; defaults to `node:child_process` `spawn`. */
  spawn?: SpawnFn;
  /** Optional structured logger; never receives audio bytes or secrets. */
  logger?: Logger;
}

/** A child process resembling what `node:child_process` `spawn` returns. */
type SpawnedChild = ReturnType<typeof nodeSpawn>;

/** Default null-sink device name when none is configured via deps or env. */
const DEFAULT_MIC_DEVICE = 'roza_virtmic';
/** Default PipeWire playback binary when none is configured. */
const DEFAULT_PLAYBACK_BIN = 'pw-cat';
/** Human-readable backend name recorded in the descriptor and logs. */
const BACKEND = 'pipewire';
/** SPDX license of the selected Virtual_Microphone backend (PipeWire). */
const BACKEND_LICENSE = 'MIT';

/** No-op logger so the adapter works without an injected logger. */
const NO_OP_LOGGER: Logger = {
  info: () => undefined,
  error: () => undefined,
};

/** Extract a safe, credential-free message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Map a PCM {@link AudioFormat} to the `pw-cat` rate/channel arguments. The
 * encoding is always signed 16-bit little-endian (`s16`), matching the
 * `pcm_s16le` contract every voice boundary agrees on.
 */
function playbackArgs(device: string, format: AudioFormat): string[] {
  return [
    '--playback',
    '--target',
    device,
    '--rate',
    String(format.sampleRate),
    '--channels',
    String(format.channels),
    '--format',
    's16',
    '-',
  ];
}

/**
 * Create a PipeWire-backed {@link VirtualMicrophone}.
 *
 * The returned device's `open` spawns the playback binary feeding the configured
 * null sink and resolves once the child has spawned successfully; it rejects —
 * naming the device — on a spawn error or an immediate non-zero exit so the
 * Avatar_Connector can apply its Req 9 audio-only fallback (Req 5.5). `write`
 * forwards the chunk's PCM bytes to the sink's stdin; `close` ends stdin and
 * reaps the child.
 */
export function createPipeWireVirtualMicrophone(
  deps: PipeWireVirtualMicrophoneDeps = {},
): VirtualMicrophone {
  const spawnFn: SpawnFn = deps.spawn ?? nodeSpawn;
  const device = deps.device ?? process.env.AVATAR_MIC_DEVICE ?? DEFAULT_MIC_DEVICE;
  const binPath = deps.binPath ?? process.env.PIPEWIRE_PLAYBACK_BIN ?? DEFAULT_PLAYBACK_BIN;
  const logger = deps.logger ?? NO_OP_LOGGER;

  let child: SpawnedChild | null = null;

  return {
    descriptor: { device, backend: BACKEND, license: BACKEND_LICENSE },

    open(format: AudioFormat): Promise<void> {
      if (child) {
        // Idempotent open: the sink is already provisioned.
        return Promise.resolve();
      }

      return new Promise<void>((resolve, reject) => {
        let settled = false;

        const proc = spawnFn(binPath, playbackArgs(device, format), {
          stdio: ['pipe', 'ignore', 'pipe'],
        });

        const settle = (fn: () => void): void => {
          if (settled) {
            return;
          }
          settled = true;
          fn();
        };

        // A spawn error (binary missing / not executable / sink unavailable)
        // means the device could not be initialized — reject naming it (Req 5.5).
        proc.on('error', (err: Error) => {
          settle(() => {
            child = null;
            logger.error('avatar.virtmic.open_failed', {
              device,
              backend: BACKEND,
              error: err.message,
            });
            reject(new Error(`VirtualMicrophone failed to initialize device "${device}": ${err.message}`));
          });
        });

        // An immediate exit before the device is considered open is also an
        // initialization failure (e.g. the named sink does not exist).
        proc.on('close', (code: number | null) => {
          settle(() => {
            child = null;
            logger.error('avatar.virtmic.open_failed', { device, backend: BACKEND, code });
            reject(
              new Error(
                `VirtualMicrophone failed to initialize device "${device}": exited with code ${code ?? 'null'}`,
              ),
            );
          });
        });

        // Node emits `spawn` once the child has been successfully spawned; that
        // is the clean signal the sink process is up and ready for PCM.
        proc.on('spawn', () => {
          settle(() => {
            child = proc;
            logger.info('avatar.virtmic.opened', {
              device,
              backend: BACKEND,
              sampleRate: format.sampleRate,
              channels: format.channels,
            });
            resolve();
          });
        });
      });
    },

    write(chunk: AudioChunk): Promise<void> {
      const proc = child;
      if (!proc) {
        return Promise.reject(
          new Error(`VirtualMicrophone device "${device}" is not open`),
        );
      }
      const stdin = proc.stdin;
      if (!stdin) {
        return Promise.reject(
          new Error(`VirtualMicrophone device "${device}" stdin is unavailable`),
        );
      }

      return new Promise<void>((resolve, reject) => {
        // Never log the audio bytes themselves — only the byte count.
        stdin.write(chunk.data, (err) => {
          if (err) {
            logger.error('avatar.virtmic.write_failed', {
              device,
              backend: BACKEND,
              error: err.message,
            });
            reject(err);
            return;
          }
          resolve();
        });
      });
    },

    close(): Promise<void> {
      const proc = child;
      if (!proc) {
        return Promise.resolve();
      }
      child = null;

      return new Promise<void>((resolve) => {
        const done = (): void => {
          logger.info('avatar.virtmic.closed', { device, backend: BACKEND });
          resolve();
        };

        proc.once('close', done);
        try {
          proc.stdin?.end();
        } catch (err: unknown) {
          // Closing stdin can throw if the pipe is already broken; reap anyway.
          logger.error('avatar.virtmic.close_error', {
            device,
            backend: BACKEND,
            error: errorMessage(err),
          });
        }
        // Ensure the child is reaped even if it ignores stdin EOF.
        proc.kill('SIGTERM');
      });
    },
  };
}
