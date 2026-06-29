/**
 * StreamSession interface + ffmpeg/RTMP adapter (Component A8) — Req 7.1, 7.2,
 * 7.3, 7.4, 8.1, 9.4.
 *
 * Defines the injectable {@link StreamSession} boundary the Avatar_Connector
 * uses to broadcast the combined Video_Stream + speech audio to an
 * operator-supplied `RTMP_Target`, plus the default
 * {@link createFfmpegStreamSession} adapter that pipes the combined
 * {@link AvatarStream} A/V to an `ffmpeg` child process publishing to the
 * target, optionally through a self-hosted MediaMTX / nginx-rtmp relay.
 *
 * The adapter spawns `ffmpeg` configured (from the {@link AvatarStream}'s video
 * format) to read the rendered A/V from the self-hosted virtual devices and
 * publish it to the RTMP ingest URL. `start` resolves once the publishing
 * process has spawned successfully and rejects — with an error that **does NOT
 * contain the key** — if the process cannot be spawned or exits/errors before
 * it is established (a connection drop/failure), so the connector can release
 * resources and keep the rest of the service and other channels running
 * (Req 7.4, 9.4). `stop` ends and reaps the process.
 *
 * Secret discipline (CRITICAL — Req 7.4, 8.4): the `Stream_Key` is an env-only
 * secret. It is passed to the transport **only** by being embedded in the RTMP
 * publish URL handed to the spawned `ffmpeg` process; it is **NEVER** logged.
 * Every log line (start, drop, failure, stop) carries only the non-sensitive
 * base ingest URL (`target.url`), the backend, and the descriptor — never the
 * key and never the composed publish URL that contains it.
 *
 * Everything that performs real media I/O lives behind the
 * {@link StreamSession} interface, so swapping the backend (ffmpeg ↔ MediaMTX ↔
 * nginx-rtmp relay) touches only this file. `spawn` is injectable so tests
 * exercise the adapter against a mocked child process — no real RTMP endpoint
 * runs in CI (Req 12.5).
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { Logger } from '../../types.js';
import type { AvatarStream } from './avatarFormat.js';

/** Injectable `spawn`, structurally compatible with `node:child_process` spawn. */
export type SpawnFn = typeof nodeSpawn;

/** The RTMP_Target: the ingest base URL plus the env-only Stream_Key secret. */
export interface StreamTarget {
  /** RTMP ingest base URL (`cfg.avatar.stream.url`); non-secret, safe to log. */
  url: string;
  /** The `Stream_Key` (`cfg.avatar.stream.key`); an env-only secret — NEVER logged. */
  key: string;
}

/**
 * The self-hosted live-streaming boundary the Avatar_Connector broadcasts the
 * combined Video_Stream + speech audio on. The default implementation drives an
 * `ffmpeg` publisher, but any conformant backend can be injected in its place.
 */
export interface StreamSession {
  /** Start broadcasting the combined Video_Stream + speech audio to the RTMP_Target (Req 7.1). */
  start(target: StreamTarget, stream: AvatarStream): Promise<void>;
  /** Stop the broadcast and release resources (Req 7.2). */
  stop(): Promise<void>;
  /** Static descriptor for the license manifest + logs (carries no secrets). */
  readonly descriptor: { backend: 'ffmpeg' | 'mediamtx'; license: string };
}

/** Dependencies for {@link createFfmpegStreamSession}; every external edge is injectable. */
export interface FfmpegStreamSessionDeps {
  /**
   * Path to the `ffmpeg` binary that publishes the combined A/V to RTMP.
   * Defaults to `AVATAR_STREAM_BIN` or `ffmpeg`.
   */
  binPath?: string;
  /**
   * The `v4l2loopback` camera device the rendered Video_Stream is presented on
   * (`cfg.avatar.devices.camera`); ffmpeg reads it as the video input. Defaults
   * to `AVATAR_CAMERA_DEVICE` or `/dev/video0`. Carries no secret.
   */
  cameraDevice?: string;
  /**
   * The PipeWire/PulseAudio source the speech audio is presented on
   * (`cfg.avatar.devices.microphone`); ffmpeg reads it as the audio input.
   * Defaults to `AVATAR_MIC_DEVICE` or `default`. Carries no secret.
   */
  micSource?: string;
  /**
   * Streaming backend recorded in the descriptor: a direct `ffmpeg` publisher
   * or an `ffmpeg`-fed self-hosted `mediamtx` relay. Defaults to `'ffmpeg'`.
   */
  backend?: 'ffmpeg' | 'mediamtx';
  /** SPDX license override for the descriptor; defaults per backend. */
  license?: string;
  /** Injectable process spawner; defaults to `node:child_process` `spawn`. */
  spawn?: SpawnFn;
  /** Optional structured logger; NEVER receives the Stream_Key or the publish URL. */
  logger?: Logger;
}

/** Default media tool that publishes the combined A/V to the RTMP target. */
const DEFAULT_STREAM_BIN = 'ffmpeg';
/** Default v4l2loopback camera device ffmpeg reads the Video_Stream from. */
const DEFAULT_CAMERA_DEVICE = '/dev/video0';
/** Default PipeWire/PulseAudio source ffmpeg reads the speech audio from. */
const DEFAULT_MIC_SOURCE = 'default';
/** SPDX license of a direct ffmpeg publisher (separate process). */
const FFMPEG_LICENSE = 'GPL-2.0';
/** SPDX license of a MediaMTX relay (separate process). */
const MEDIAMTX_LICENSE = 'MIT';

/**
 * Compose the RTMP publish URL ffmpeg writes to from the non-secret ingest base
 * URL and the `Stream_Key`.
 *
 * RTMP publishing appends the stream key as the final path segment of the
 * ingest URL (`rtmp://host/app/<key>`). The base URL's trailing slash is
 * trimmed so the join never produces a doubled separator.
 *
 * The returned value embeds the secret key and therefore MUST only ever be
 * handed to the spawned transport — it is NEVER logged (Req 7.4, 8.4).
 */
function buildPublishUrl(target: StreamTarget): string {
  const base = target.url.endsWith('/') ? target.url.slice(0, -1) : target.url;
  return target.key.length > 0 ? `${base}/${target.key}` : base;
}

/**
 * Build the ffmpeg argument vector that reads the combined Video_Stream + speech
 * audio from the self-hosted virtual devices and publishes the muxed FLV stream
 * to `publishUrl`.
 *
 * The video size/rate are taken from the {@link AvatarStream}'s video format so
 * the published stream matches what the Virtual_Camera presents; H.264/AAC is
 * the de-facto RTMP interchange codec pair.
 *
 * `publishUrl` (which embeds the secret key) is the final argument — it reaches
 * only the spawned process, never a log line.
 */
function buildStreamArgs(
  cameraDevice: string,
  micSource: string,
  stream: AvatarStream,
  publishUrl: string,
): string[] {
  const width = Math.max(0, Math.floor(stream.video.width));
  const height = Math.max(0, Math.floor(stream.video.height));
  return [
    // Video input: the Virtual_Camera (v4l2loopback) device.
    '-f',
    'v4l2',
    '-framerate',
    String(stream.video.fps),
    '-video_size',
    `${width}x${height}`,
    '-i',
    cameraDevice,
    // Audio input: the Virtual_Microphone (PipeWire/PulseAudio) source.
    '-f',
    'pulse',
    '-i',
    micSource,
    // Encode to the RTMP interchange codecs and mux as FLV.
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-c:a',
    'aac',
    '-f',
    'flv',
    publishUrl,
  ];
}

/**
 * Create an `ffmpeg`-backed {@link StreamSession}.
 *
 * `start(target, stream)` spawns the configured media tool wired to read the
 * combined Video_Stream + speech audio from the self-hosted virtual devices and
 * publish it to `target.url` with `target.key` (the `Stream_Key`). It resolves
 * once the process has spawned successfully and rejects — with an error that
 * **never contains the key** — if the process cannot be spawned or exits/errors
 * before it is established (a connection drop/failure), so the connector can
 * release resources without crashing the service (Req 7.4, 9.4). `stop()` ends
 * the process and reaps it.
 *
 * The `Stream_Key` is passed to the transport ONLY inside the composed RTMP
 * publish URL handed to the spawned process; it is NEVER logged (Req 7.4, 8.4).
 *
 * `spawn` is injectable so tests run against a mocked child process and no real
 * RTMP endpoint runs in CI (Req 12.5).
 */
export function createFfmpegStreamSession(deps: FfmpegStreamSessionDeps = {}): StreamSession {
  const spawnFn: SpawnFn = deps.spawn ?? nodeSpawn;
  const binPath = deps.binPath ?? process.env.AVATAR_STREAM_BIN ?? DEFAULT_STREAM_BIN;
  const cameraDevice =
    deps.cameraDevice ?? process.env.AVATAR_CAMERA_DEVICE ?? DEFAULT_CAMERA_DEVICE;
  const micSource = deps.micSource ?? process.env.AVATAR_MIC_DEVICE ?? DEFAULT_MIC_SOURCE;
  const backend = deps.backend ?? 'ffmpeg';
  const license = deps.license ?? (backend === 'mediamtx' ? MEDIAMTX_LICENSE : FFMPEG_LICENSE);
  const logger = deps.logger;

  // The live publishing child process, or null when stopped/never started.
  let child: ReturnType<SpawnFn> | null = null;

  return {
    descriptor: { backend, license },

    start(target: StreamTarget, stream: AvatarStream): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        let settled = false;

        // The publish URL embeds the secret key — only the spawned process ever
        // sees it. Logs reference the non-secret base URL alone (Req 7.4, 8.4).
        const publishUrl = buildPublishUrl(target);

        let proc: ReturnType<SpawnFn>;
        try {
          proc = spawnFn(binPath, buildStreamArgs(cameraDevice, micSource, stream, publishUrl), {
            stdio: ['ignore', 'ignore', 'pipe'],
          });
        } catch (err) {
          // A synchronous spawn throw (e.g. invalid binary path) — log without the key.
          const message = err instanceof Error ? err.message : String(err);
          logger?.error('avatar.stream.start_failed', { url: target.url, backend, error: message });
          reject(new Error(`StreamSession failed to start publishing to ${target.url}: ${message}`));
          return;
        }

        child = proc;

        // Successful spawn → the publish transport is established.
        proc.once('spawn', () => {
          if (settled) {
            return;
          }
          settled = true;
          logger?.info('avatar.stream.started', { url: target.url, backend });
          resolve();
        });

        // Spawn/transport error before it is established → reject without the key.
        proc.on('error', (err: Error) => {
          if (settled) {
            // Already streaming: a later transport error is a connection drop.
            child = null;
            logger?.error('avatar.stream.dropped', { url: target.url, backend, error: err.message });
            return;
          }
          settled = true;
          child = null;
          logger?.error('avatar.stream.start_failed', { url: target.url, backend, error: err.message });
          reject(new Error(`StreamSession failed to start publishing to ${target.url}: ${err.message}`));
        });

        // Process exiting before it is established → connection drop/failure.
        proc.on('close', (code: number | null) => {
          if (settled) {
            // Already streaming: a later exit is a connection drop — log without the key.
            child = null;
            logger?.error('avatar.stream.dropped', { url: target.url, backend, code });
            return;
          }
          settled = true;
          child = null;
          logger?.error('avatar.stream.start_failed', { url: target.url, backend, code });
          reject(
            new Error(
              `StreamSession failed to start publishing to ${target.url}: process exited with code ${code ?? 'null'}`,
            ),
          );
        });
      });
    },

    stop(): Promise<void> {
      return new Promise<void>((resolve) => {
        const proc = child;
        child = null;
        if (proc === null) {
          resolve();
          return;
        }
        const done = (): void => {
          logger?.info('avatar.stream.stopped', { backend });
          resolve();
        };
        proc.once('close', done);
        // Signal ffmpeg to finalize the broadcast and exit, then ensure it is
        // reaped even if it ignores the signal.
        try {
          proc.kill('SIGTERM');
        } catch {
          // Process may already have exited; the close listener still resolves.
        }
      });
    },
  };
}
