/**
 * Avatar_Video_Format contract (Component A4) — Req 2.3, 2.4, 5.3.
 *
 * A single documented contract that every avatar render/present interface
 * boundary agrees on, so the Avatar_Renderer's output is directly consumable by
 * the Virtual_Camera and the speech audio stays paired and synchronized with
 * the video. It mirrors the Phase 3 `audio.ts` PCM contract: pure data plus
 * pure helpers, with no I/O, no side effects, and no imports beyond the local
 * types and the Phase 3 `AudioFormat`.
 *
 * This module is the primary property-based-testing target for the video
 * contract and is the pure-logic foundation the render/present pipeline builds
 * on. Every helper is total — it never throws for any input.
 */

import type { AudioFormat } from '../voice/audio.js'; // Phase 3 PCM contract (paired audio)

/**
 * Pixel/encoding format of a rendered Video_Frame.
 *
 * - `rgba`    — 32-bit packed RGBA, 4 bytes per pixel (uncompressed, no
 *   chroma subsampling).
 * - `yuv420p` — planar YUV with 4:2:0 chroma subsampling; the de-facto
 *   interchange format for v4l2loopback / GStreamer, ~1.5 bytes per pixel.
 * - `nv12`    — semi-planar YUV with 4:2:0 chroma subsampling (interleaved
 *   UV plane); also ~1.5 bytes per pixel.
 */
export type AvatarPixelFormat = 'rgba' | 'yuv420p' | 'nv12';

/**
 * The video format the Avatar_Renderer must emit and the Virtual_Camera
 * consumes — the Avatar_Video_Format contract (Req 2.3).
 */
export interface AvatarVideoFormat {
  /** Frame width in pixels. */
  width: number;
  /** Frame height in pixels. */
  height: number;
  /** Nominal frames per second. */
  fps: number;
  /** Pixel/encoding format of each Video_Frame. */
  pixelFormat: AvatarPixelFormat;
}

/**
 * The unit exchanged across the render/present interfaces: a paired
 * Video_Stream format and the speech audio it is synchronized with.
 *
 * The `audio` is the SAME signed 16-bit little-endian Piper PCM the
 * Voice_Channel already produced (Req 4.4), so the presented video and audio
 * always derive from one synthesized turn rather than being re-encoded or
 * resampled independently.
 */
export interface AvatarStream {
  /** Video format of the rendered frames. */
  video: AvatarVideoFormat;
  /** The same Piper PCM the Voice_Channel produced for this reply (Req 4.4). */
  audio: AudioFormat;
}

/**
 * Bytes per pixel for an `AvatarPixelFormat` (pure, total).
 *
 * - `rgba`    → `4` (one byte each for R, G, B, A).
 * - `yuv420p` / `nv12` → `1.5`, the standard 4:2:0 average: a full-resolution
 *   luma (Y) plane at 1 byte/pixel plus two chroma planes subsampled by 2 in
 *   each dimension, i.e. `1 + 2 * (1/4) = 1.5` bytes/pixel.
 *
 * Returns `0` for any value outside the known union so the helper is total and
 * never throws.
 */
export function bytesPerPixel(pixelFormat: AvatarPixelFormat): number {
  switch (pixelFormat) {
    case 'rgba':
      return 4;
    case 'yuv420p':
    case 'nv12':
      return 1.5;
    default:
      return 0;
  }
}

/**
 * Total number of bytes in a single Video_Frame at `fmt`.
 *
 * Computed with the standard formula `width * height * bytesPerPixel(pixelFormat)`.
 *
 * Pure and total — never throws. Flooring rule (consistent for all inputs):
 * the pixel count is taken from the floored width and height, then multiplied
 * by the (possibly fractional, for 4:2:0) bytes-per-pixel and the whole result
 * is floored, so a `yuv420p`/`nv12` frame whose pixel count is odd drops the
 * trailing half-byte rather than rounding up and the result is always a whole
 * number of bytes.
 *
 * Edge cases:
 * - A zero, negative, or non-finite `width` or `height` yields `0`.
 * - An unknown `pixelFormat` yields `0` via `bytesPerPixel`.
 */
export function frameBytes(fmt: AvatarVideoFormat): number {
  if (
    !Number.isFinite(fmt.width) ||
    !Number.isFinite(fmt.height) ||
    fmt.width <= 0 ||
    fmt.height <= 0
  ) {
    return 0;
  }
  const pixels = Math.floor(fmt.width) * Math.floor(fmt.height);
  return Math.floor(pixels * bytesPerPixel(fmt.pixelFormat));
}

/**
 * Nominal interval between frames, in milliseconds, at `fmt`.
 *
 * Computed as `1000 / fps`.
 *
 * Pure and total — never throws. A zero, negative, or non-finite `fps` is
 * clamped to `0` so the result is never negative, `Infinity`, or `NaN`.
 */
export function frameIntervalMs(fmt: AvatarVideoFormat): number {
  if (!Number.isFinite(fmt.fps) || fmt.fps <= 0) {
    return 0;
  }
  return 1000 / fmt.fps;
}

/**
 * True iff two video formats are byte-compatible for direct presentation
 * without rescaling, re-timing, or re-encoding — i.e. identical width, height,
 * fps, and pixel format. Pure and total.
 *
 * Used to assert that the format the Avatar_Renderer produced matches the
 * configured/consumed Avatar_Video_Format the Virtual_Camera expects (Req 2.4,
 * 5.3).
 */
export function isVideoCompatible(
  a: AvatarVideoFormat,
  b: AvatarVideoFormat
): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.fps === b.fps &&
    a.pixelFormat === b.pixelFormat
  );
}
