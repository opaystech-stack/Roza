/**
 * VirtualCamera interface + v4l2loopback/GStreamer adapter (Component A6) —
 * Req 5.1, 5.4, 5.5.
 *
 * Defines the injectable {@link VirtualCamera} boundary the Avatar_Connector
 * uses to present rendered Video_Frames so any WebRTC client (or the Meet
 * adapter) consumes Roza as a camera input, plus the default
 * {@link createV4l2VirtualCamera} adapter that feeds those frames to a
 * `v4l2loopback` device via a GStreamer/ffmpeg child process.
 *
 * The adapter spawns the media tool with the target {@link AvatarVideoFormat}
 * (width/height/fps/pixel-format) configured to read raw video from stdin and
 * write it to the configured `v4l2loopback` device (`cfg.avatar.devices.camera`).
 * Rendered frames are then streamed to the process's stdin. `open` rejects with
 * an error **naming the device** when the device/process cannot be initialized
 * (spawn failure or the process exits before it is ready), so the connector can
 * apply its Req 9 audio-only fallback rather than crashing (Req 5.5).
 *
 * Everything that performs real media I/O lives behind the {@link VirtualCamera}
 * interface, so swapping the backend (GStreamer ↔ ffmpeg ↔ OBS virtual cam)
 * touches only this file (Req 5.4). `spawn` and the device name are injectable
 * so tests exercise the adapter against a mocked child process — no real
 * kernel module or media tool runs in CI (Req 12.5).
 *
 * Secret discipline: this module NEVER logs a credential or journal value. Only
 * non-sensitive identifiers (the device name, backend, byte counts, the
 * descriptor) ever appear in logs.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { Logger } from '../../types.js';
import type { AvatarPixelFormat, AvatarVideoFormat } from './avatarFormat.js';

/** Injectable `spawn`, structurally compatible with `node:child_process` spawn. */
export type SpawnFn = typeof nodeSpawn;

/**
 * The self-hosted Virtual_Camera boundary the Avatar_Connector presents
 * rendered video on. The default implementation feeds a `v4l2loopback` device,
 * but any conformant backend can be injected in its place (Req 5.4).
 */
export interface VirtualCamera {
  /** Open the virtual video device (v4l2loopback) for writing (Req 5.1). */
  open(format: AvatarVideoFormat): Promise<void>;
  /** Present one or more Video_Frames so a WebRTC client consumes them as camera input. */
  write(frame: Uint8Array): Promise<void>;
  /** Release the device. */
  close(): Promise<void>;
  /** Static descriptor for the license manifest + logs (carries no secrets). */
  readonly descriptor: { device: string; backend: string; license: string };
}

/** Dependencies for {@link createV4l2VirtualCamera}; every external edge is injectable. */
export interface V4l2VirtualCameraDeps {
  /**
   * The `v4l2loopback` device to write frames to (e.g. `/dev/video0`). Defaults
   * to `AVATAR_CAMERA_DEVICE` or `/dev/video0`. Injectable for mocked tests.
   */
  device?: string;
  /**
   * Path to the GStreamer/ffmpeg binary that bridges stdin → v4l2loopback.
   * Defaults to `AVATAR_CAMERA_BIN` or `ffmpeg`.
   */
  binPath?: string;
  /** Injectable process spawner; defaults to `node:child_process` `spawn`. */
  spawn?: SpawnFn;
  /** Optional structured logger; never receives a secret. */
  logger?: Logger;
}

/** Default `v4l2loopback` device when none is configured via deps or env. */
const DEFAULT_CAMERA_DEVICE = '/dev/video0';
/** Default media tool that bridges raw stdin video to the v4l2 device. */
const DEFAULT_CAMERA_BIN = 'ffmpeg';
/** SPDX license of the v4l2loopback/GStreamer/ffmpeg pipeline (separate process). */
const CAMERA_LICENSE = 'GPL-2.0';
/** Human-readable backend name recorded in the descriptor. */
const CAMERA_BACKEND = 'v4l2loopback/ffmpeg';

/**
 * Map an {@link AvatarPixelFormat} to the ffmpeg `rawvideo` pixel-format token.
 *
 * The union members already match ffmpeg's `-pix_fmt` names one-to-one, so the
 * mapping is the identity; an unknown value falls back to `yuv420p` (the
 * v4l2loopback interchange default) so the helper is total.
 */
function ffmpegPixelFormat(pixelFormat: AvatarPixelFormat): string {
  switch (pixelFormat) {
    case 'rgba':
      return 'rgba';
    case 'yuv420p':
      return 'yuv420p';
    case 'nv12':
      return 'nv12';
    default:
      return 'yuv420p';
  }
}

/**
 * Build the ffmpeg argument vector that reads raw `format` video from stdin and
 * publishes it to the `v4l2loopback` `device`.
 *
 * `-f rawvideo` with the frame's pixel format, size, and rate describes the
 * stdin stream; `-f v4l2 <device>` selects the loopback sink so a WebRTC client
 * sees Roza as a camera input.
 */
function buildCameraArgs(device: string, format: AvatarVideoFormat): string[] {
  return [
    '-f',
    'rawvideo',
    '-pix_fmt',
    ffmpegPixelFormat(format.pixelFormat),
    '-s',
    `${Math.max(0, Math.floor(format.width))}x${Math.max(0, Math.floor(format.height))}`,
    '-r',
    String(format.fps),
    '-i',
    'pipe:0',
    '-f',
    'v4l2',
    device,
  ];
}

/**
 * Create a `v4l2loopback`-backed {@link VirtualCamera}.
 *
 * `open(format)` spawns the configured media tool wired to read raw `format`
 * video from stdin and write it to the configured v4l2 device. It resolves once
 * the process has spawned successfully and rejects — with an error **naming the
 * device** — if the process cannot be spawned or exits before it is ready
 * (Req 5.5). `write(frame)` streams a Video_Frame to the process's stdin,
 * honoring backpressure; it rejects if the camera is not open or the process
 * has exited. `close()` ends the stream and reaps the process.
 *
 * `spawn` and the device name are injectable so tests run against a mocked
 * child process and no real kernel module or media tool runs in CI (Req 12.5).
 */
export function createV4l2VirtualCamera(deps: V4l2VirtualCameraDeps = {}): VirtualCamera {
  const spawnFn: SpawnFn = deps.spawn ?? nodeSpawn;
  const device = deps.device ?? process.env.AVATAR_CAMERA_DEVICE ?? DEFAULT_CAMERA_DEVICE;
  const binPath = deps.binPath ?? process.env.AVATAR_CAMERA_BIN ?? DEFAULT_CAMERA_BIN;
  const logger = deps.logger;

  // The live child process bridging stdin → v4l2loopback, or null when closed.
  let child: ReturnType<SpawnFn> | null = null;
  // Set once the process has exited so `write` fails fast instead of writing to
  // a dead pipe.
  let exited = false;

  return {
    descriptor: { device, backend: CAMERA_BACKEND, license: CAMERA_LICENSE },

    open(format: AvatarVideoFormat): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        exited = false;

        let proc: ReturnType<SpawnFn>;
        try {
          proc = spawnFn(binPath, buildCameraArgs(device, format), {
            stdio: ['pipe', 'ignore', 'pipe'],
          });
        } catch (err) {
          // A synchronous spawn throw (e.g. invalid binary path) — name the device.
          const message = err instanceof Error ? err.message : String(err);
          logger?.error('avatar.camera.open_failed', { device, error: message });
          reject(new Error(`VirtualCamera failed to initialize device ${device}: ${message}`));
          return;
        }

        child = proc;

        // Successful spawn → the device pipeline is initialized and ready.
        proc.once('spawn', () => {
          if (settled) {
            return;
          }
          settled = true;
          logger?.info('avatar.camera.opened', {
            device,
            backend: CAMERA_BACKEND,
            width: format.width,
            height: format.height,
            fps: format.fps,
            pixelFormat: format.pixelFormat,
          });
          resolve();
        });

        // Spawn error before/at startup → reject naming the device (Req 5.5).
        proc.on('error', (err: Error) => {
          exited = true;
          if (settled) {
            return;
          }
          settled = true;
          child = null;
          logger?.error('avatar.camera.open_failed', { device, error: err.message });
          reject(new Error(`VirtualCamera failed to initialize device ${device}: ${err.message}`));
        });

        // Process exiting before it is ready → the device could not be initialized.
        proc.on('close', (code: number | null) => {
          exited = true;
          if (settled) {
            // Already open: a later exit just invalidates the camera for writes.
            child = null;
            return;
          }
          settled = true;
          child = null;
          logger?.error('avatar.camera.open_failed', { device, code });
          reject(
            new Error(`VirtualCamera failed to initialize device ${device}: process exited with code ${code ?? 'null'}`),
          );
        });
      });
    },

    write(frame: Uint8Array): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const proc = child;
        if (proc === null || exited) {
          reject(new Error(`VirtualCamera device ${device} is not open`));
          return;
        }
        const stdin = proc.stdin;
        if (!stdin) {
          reject(new Error(`VirtualCamera device ${device} has no writable stream`));
          return;
        }
        // Stream the Video_Frame to the media tool; honor backpressure via the
        // write callback so a slow device does not unbounded-buffer frames.
        stdin.write(Buffer.from(frame), (err?: Error | null) => {
          if (err) {
            logger?.error('avatar.camera.write_failed', { device, error: err.message });
            reject(err);
            return;
          }
          resolve();
        });
      });
    },

    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        const proc = child;
        child = null;
        if (proc === null) {
          resolve();
          return;
        }
        const done = (): void => {
          exited = true;
          logger?.info('avatar.camera.closed', { device });
          resolve();
        };
        proc.once('close', done);
        // End stdin so the media tool flushes and exits cleanly, then ensure it
        // is reaped even if it ignores the closed pipe.
        try {
          proc.stdin?.end();
        } catch {
          // stdin may already be closed; fall through to the kill safety net.
        }
        try {
          proc.kill('SIGTERM');
        } catch {
          // Process may already have exited; the close listener still resolves.
        }
      });
    },
  };
}
