/**
 * AvatarRenderer interface + sidecar adapter (Component A5) — Req 2.1, 2.2,
 * 2.4–2.6, 2.7, 3.1, 9.1.
 *
 * Defines the injectable {@link AvatarRenderer} boundary the Avatar_Connector
 * uses to turn the static portrait (Avatar_Image) plus the reply speech audio
 * the Phase 3 TTS_Engine produced into a synchronized, lip-synced
 * Video_Stream, plus the default {@link createSidecarAvatarRenderer} adapter
 * that orchestrates an **external renderer sidecar** over its IPC/HTTP
 * endpoint.
 *
 * The adapter POSTs the portrait + reply PCM + target {@link AvatarVideoFormat}
 * to `cfg.avatar.renderer.endpoint` using Node's built-in `fetch`, then streams
 * the rendered Video_Stream frames back from the response body. A configurable
 * `req.timeoutMs` (sourced from `cfg.avatar.latency.renderMs`) bounds
 * time-to-first-frame via an {@link AbortController}; on timeout, a non-zero
 * HTTP status, or a connection error the returned promise rejects so the
 * Avatar_Connector can apply its Req 9.2 audio-only fallback (Req 2.8).
 *
 * **No machine-learning inference runs in the Node process** (Req 2.6): all ML
 * lives in the external sidecar. The renderer endpoint, engine name, and the
 * `fetch` implementation are all injectable, so tests exercise the adapter
 * against a mocked `fetch` returning canned frames (plus failing/slow variants)
 * — **no real GPU or sidecar ever runs in CI** (Req 12.5).
 *
 * Secret/PII discipline: this module NEVER logs the portrait bytes, the reply
 * audio, or any credential. Only non-sensitive identifiers (engine name, byte
 * counts, HTTP status, the descriptor) appear in logs.
 */

import type { Logger } from '../../types.js';
import type { AudioChunk } from '../voice/audio.js';
import { frameBytes, type AvatarStream, type AvatarVideoFormat } from './avatarFormat.js';

/**
 * A single avatar render request: the portrait to animate, the reply speech
 * audio to lip-sync to, the target Avatar_Video_Format, and the
 * time-to-first-frame budget.
 */
export interface RenderRequest {
  /** The static portrait (placeholder roza-avatar.png until the Operator replaces it). */
  image: Uint8Array;
  /** The reply speech audio the Phase 3 TTS_Engine produced (Piper PCM). */
  audio: AudioChunk;
  /** The Avatar_Video_Format to emit (from cfg.avatar.video). */
  format: AvatarVideoFormat;
  /** Time-to-first-frame budget; reject/timeout → audio-only fallback (Req 2.7, 9.1). */
  timeoutMs: number;
}

/** A produced, lip-synced clip: ordered frames paired with the speech audio (Req 2.4). */
export interface RenderResult {
  stream: AvatarStream;
  frames: AsyncIterable<Uint8Array>; // Video_Stream frames in `format`
}

export interface AvatarRenderer {
  /** Produce a synchronized lip-synced Video_Stream for `req`. Rejects on failure
   *  or when it cannot begin producing frames within `req.timeoutMs` (Req 2.1, 2.7). */
  render(req: RenderRequest): Promise<RenderResult>;
  /** Static descriptor for the license manifest + logs (no secrets). */
  readonly descriptor: { engine: string; license: string };
}

/** Injectable `fetch`, structurally compatible with the global `fetch`. */
export type FetchFn = typeof fetch;

/** Dependencies for {@link createSidecarAvatarRenderer}; every external edge is injectable. */
export interface SidecarAvatarRendererDeps {
  /** Renderer sidecar IPC/HTTP endpoint (`cfg.avatar.renderer.endpoint`); carries no secret. */
  endpoint: string;
  /** Engine name for the descriptor + logs (`cfg.avatar.renderer.engine`). */
  engine: string;
  /** SPDX license of the engine code for the descriptor. Defaults to `'MIT'` (LivePortrait code). */
  license?: string;
  /** Injectable `fetch`; defaults to the Node built-in global `fetch`. */
  fetch?: FetchFn;
  /** Optional structured logger; never receives portrait/audio bytes or secrets. */
  logger?: Logger;
}

/** Default engine-code license (LivePortrait code is MIT). */
const DEFAULT_ENGINE_LICENSE = 'MIT';

/** Concatenate two byte arrays into a fresh `Uint8Array` (owns its own ArrayBuffer). */
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/**
 * Create a sidecar-backed {@link AvatarRenderer}.
 *
 * The returned renderer's `render` POSTs a multipart request carrying the
 * portrait, the reply PCM, and the target {@link AvatarVideoFormat} to the
 * configured sidecar endpoint via the injected `fetch`, then exposes the
 * streamed Video_Stream frames as an {@link AsyncIterable}. The body is read
 * until the first whole frame (sized by {@link frameBytes}) is available so the
 * `req.timeoutMs` budget genuinely bounds time-to-first-frame; once the first
 * frame arrives the timeout is cleared and the remaining frames stream lazily.
 *
 * Rejects (so the connector applies the Req 9.2 audio-only fallback) on:
 * - exceeding `req.timeoutMs` before the first frame (the request is aborted),
 * - a non-zero / non-OK HTTP status, or
 * - a connection error (or a missing response body).
 *
 * Performs NO in-process ML — all inference happens in the external sidecar
 * (Req 2.6).
 */
export function createSidecarAvatarRenderer(deps: SidecarAvatarRendererDeps): AvatarRenderer {
  const fetchFn: FetchFn = deps.fetch ?? fetch;
  const endpoint = deps.endpoint;
  const engine = deps.engine;
  const license = deps.license ?? DEFAULT_ENGINE_LICENSE;
  const logger = deps.logger;

  return {
    descriptor: { engine, license },

    async render(req: RenderRequest): Promise<RenderResult> {
      // Describe the target render to the sidecar without ever inlining the
      // raw portrait/audio bytes into a log line.
      const form = new FormData();
      form.append('engine', engine);
      form.append('format', JSON.stringify(req.format));
      form.append('audioFormat', JSON.stringify(req.audio.format));
      // Copy into fresh ArrayBuffers so the Blob owns an exact, isolated view.
      form.append('image', new Blob([req.image.slice()]), 'portrait');
      form.append('audio', new Blob([req.audio.data.slice()]), 'reply-pcm');

      // Bound time-to-first-frame with an AbortController/timeout (Req 2.7, 9.1).
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, req.timeoutMs);

      let response: Response;
      try {
        response = await fetchFn(endpoint, {
          method: 'POST',
          body: form,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (timedOut) {
          logger?.error('avatar.renderer.timeout', { engine, timeoutMs: req.timeoutMs });
          throw new Error(`Avatar renderer timed out after ${req.timeoutMs}ms`);
        }
        const message = err instanceof Error ? err.message : String(err);
        logger?.error('avatar.renderer.connection_error', { engine, error: message });
        throw err instanceof Error ? err : new Error(message);
      }

      if (!response.ok) {
        clearTimeout(timer);
        logger?.error('avatar.renderer.nonzero_status', { engine, status: response.status });
        throw new Error(`Avatar renderer returned HTTP ${response.status}`);
      }

      if (!response.body) {
        clearTimeout(timer);
        logger?.error('avatar.renderer.no_body', { engine, status: response.status });
        throw new Error('Avatar renderer returned no response body');
      }

      const reader = response.body.getReader();
      const frameSize = frameBytes(req.format);

      // Accumulate from the body until the first whole frame is available
      // (or the stream ends), so the timeout above bounds time-to-first-frame.
      let buffer = new Uint8Array(0);
      let streamDone = false;
      try {
        if (frameSize > 0) {
          while (buffer.byteLength < frameSize && !streamDone) {
            const { value, done } = await reader.read();
            if (done) {
              streamDone = true;
              break;
            }
            if (value) {
              buffer = concatBytes(buffer, value);
            }
          }
        } else {
          // Unknown/degenerate frame size: treat the first body chunk as the
          // first frame so a fault is still surfaced inside the timeout window.
          const { value, done } = await reader.read();
          if (done) {
            streamDone = true;
          } else if (value) {
            buffer = concatBytes(buffer, value);
          }
        }
      } catch (err) {
        clearTimeout(timer);
        reader.cancel().catch(() => undefined);
        if (timedOut) {
          logger?.error('avatar.renderer.timeout', { engine, timeoutMs: req.timeoutMs });
          throw new Error(`Avatar renderer timed out after ${req.timeoutMs}ms`);
        }
        const message = err instanceof Error ? err.message : String(err);
        logger?.error('avatar.renderer.stream_error', { engine, error: message });
        throw err instanceof Error ? err : new Error(message);
      }

      // First frame (or end-of-stream) reached within budget: stop the clock.
      clearTimeout(timer);
      logger?.info('avatar.renderer.streaming', {
        engine,
        width: req.format.width,
        height: req.format.height,
        fps: req.format.fps,
        pixelFormat: req.format.pixelFormat,
      });

      const stream: AvatarStream = { video: req.format, audio: req.audio.format };

      async function* frameIterator(): AsyncGenerator<Uint8Array> {
        if (frameSize > 0) {
          // Emit whole, format-sized frames; read more from the body as needed.
          // A trailing partial frame (< frameSize) is dropped as incomplete.
          for (;;) {
            while (buffer.byteLength >= frameSize) {
              yield buffer.slice(0, frameSize);
              buffer = buffer.slice(frameSize);
            }
            if (streamDone) {
              break;
            }
            const { value, done } = await reader.read();
            if (done) {
              streamDone = true;
              continue;
            }
            if (value) {
              buffer = concatBytes(buffer, value);
            }
          }
        } else {
          if (buffer.byteLength > 0) {
            yield buffer;
          }
          while (!streamDone) {
            const { value, done } = await reader.read();
            if (done) {
              streamDone = true;
              break;
            }
            if (value) {
              yield value;
            }
          }
        }
      }

      return { stream, frames: frameIterator() };
    },
  };
}
