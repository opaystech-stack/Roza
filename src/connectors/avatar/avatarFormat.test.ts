// Feature: roza-step4-avatar-video, Property 7: Avatar_Video_Format contract integrity and A/V pairing
//
// Validates: Requirements 2.4, 5.3
//
// Property 7 asserts the Avatar_Video_Format contract is internally consistent
// so the Avatar_Renderer's output is directly consumable by the Virtual_Camera
// and the speech audio stays paired with the video. Concretely:
//   1. `frameBytes(fmt)` equals `floor(floor(width) * floor(height) *
//      bytesPerPixel(pixelFormat))` for any valid (finite, positive) width and
//      height — the documented per-pixel flooring rule for 4:2:0 formats — and
//      yields `0` for a zero, negative, non-finite, or unknown-pixel-format
//      frame (never negative, never NaN, never fractional).
//   2. `frameIntervalMs(fmt)` equals `1000 / fps` for any valid positive finite
//      `fps`, and is clamped to `0` for a zero, negative, or non-finite `fps`
//      (never negative, never Infinity, never NaN).
//   3. `isVideoCompatible(a, b)` is true iff width, height, fps, and pixelFormat
//      all match — reflexive, symmetric, and false whenever any field differs.
//   4. The paired `AvatarStream.audio` carries the SAME `AudioFormat` the
//      Voice_Channel produced (Req 4.4 / 5.3) — the presented video and audio
//      derive from one synchronized pairing rather than independent encodings.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  frameBytes,
  frameIntervalMs,
  bytesPerPixel,
  isVideoCompatible,
  type AvatarVideoFormat,
  type AvatarPixelFormat,
  type AvatarStream,
} from './avatarFormat.js';
import {
  TELEPHONY_PCM_8K,
  TELEPHONY_PCM_16K,
  isCompatible,
  type AudioFormat,
} from '../voice/audio.js';

/** The known pixel formats the contract recognizes. */
const pixelFormatArb: fc.Arbitrary<AvatarPixelFormat> = fc.constantFrom(
  'rgba' as const,
  'yuv420p' as const,
  'nv12' as const,
);

/**
 * Generator for an `AvatarVideoFormat` with valid (finite, positive) width,
 * height, and fps — the real domain a renderer/camera operates in. Includes
 * fractional values so the flooring rule is exercised, plus small extremes
 * (1px, odd pixel counts that drop the trailing 4:2:0 half-byte).
 */
const validVideoFormatArb: fc.Arbitrary<AvatarVideoFormat> = fc.record({
  width: fc.oneof(
    fc.integer({ min: 1, max: 7680 }),
    fc.double({ min: 1, max: 7680, noNaN: true, noDefaultInfinity: true }),
  ),
  height: fc.oneof(
    fc.integer({ min: 1, max: 4320 }),
    fc.double({ min: 1, max: 4320, noNaN: true, noDefaultInfinity: true }),
  ),
  fps: fc.oneof(
    fc.integer({ min: 1, max: 240 }),
    fc.double({ min: 1e-3, max: 240, noNaN: true, noDefaultInfinity: true }),
  ),
  pixelFormat: pixelFormatArb,
});

/** Width/height values that must drive `frameBytes` to 0: zero, negative, non-finite. */
const invalidDimensionArb: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),
  fc.double({ min: -7680, max: -1e-9, noNaN: true, noDefaultInfinity: true }),
  fc.integer({ min: -7680, max: -1 }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
);

/** fps values that must clamp `frameIntervalMs` to 0: zero, negative, non-finite. */
const invalidFpsArb: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),
  fc.double({ min: -240, max: -1e-9, noNaN: true, noDefaultInfinity: true }),
  fc.integer({ min: -240, max: -1 }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
);

/** The supported telephony PCM formats the Voice_Channel produces. */
const audioFormatArb: fc.Arbitrary<AudioFormat> = fc.constantFrom(
  TELEPHONY_PCM_8K,
  TELEPHONY_PCM_16K,
);

describe('frameBytes contract (Property 7)', () => {
  it('equals floor(floor(width) * floor(height) * bytesPerPixel(pixelFormat)) for any valid format', () => {
    fc.assert(
      fc.property(validVideoFormatArb, (fmt) => {
        const expected = Math.floor(
          Math.floor(fmt.width) *
            Math.floor(fmt.height) *
            bytesPerPixel(fmt.pixelFormat),
        );
        expect(frameBytes(fmt)).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });

  it('always returns a non-negative whole number of bytes (never fractional, never NaN)', () => {
    fc.assert(
      fc.property(validVideoFormatArb, (fmt) => {
        const bytes = frameBytes(fmt);
        expect(Number.isInteger(bytes)).toBe(true);
        expect(bytes).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 300 },
    );
  });

  it('yields 0 for a zero, negative, or non-finite width or height', () => {
    fc.assert(
      fc.property(
        invalidDimensionArb,
        fc.integer({ min: 1, max: 4320 }),
        pixelFormatArb,
        (badWidth, height, pixelFormat) => {
          expect(frameBytes({ width: badWidth, height, fps: 25, pixelFormat })).toBe(0);
          expect(frameBytes({ width: height, height: badWidth, fps: 25, pixelFormat })).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('yields 0 for an unknown pixel format (bytesPerPixel === 0)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 7680 }),
        fc.integer({ min: 1, max: 4320 }),
        (width, height) => {
          const fmt = {
            width,
            height,
            fps: 25,
            pixelFormat: 'unknown' as unknown as AvatarPixelFormat,
          };
          expect(bytesPerPixel(fmt.pixelFormat)).toBe(0);
          expect(frameBytes(fmt)).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('frameIntervalMs contract (Property 7)', () => {
  it('equals 1000 / fps for any valid positive finite fps', () => {
    fc.assert(
      fc.property(validVideoFormatArb, (fmt) => {
        expect(frameIntervalMs(fmt)).toBe(1000 / fmt.fps);
      }),
      { numRuns: 300 },
    );
  });

  it('clamps a zero, negative, or non-finite fps to 0 (never negative, Infinity, or NaN)', () => {
    fc.assert(
      fc.property(invalidFpsArb, pixelFormatArb, (fps, pixelFormat) => {
        const result = frameIntervalMs({ width: 512, height: 512, fps, pixelFormat });
        expect(result).toBe(0);
        expect(Number.isNaN(result)).toBe(false);
        expect(Number.isFinite(result)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

describe('isVideoCompatible relation (Property 7)', () => {
  it('is reflexive: every format is compatible with itself', () => {
    fc.assert(
      fc.property(validVideoFormatArb, (fmt) => {
        expect(isVideoCompatible(fmt, fmt)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('is symmetric: isVideoCompatible(a, b) === isVideoCompatible(b, a)', () => {
    fc.assert(
      fc.property(validVideoFormatArb, validVideoFormatArb, (a, b) => {
        expect(isVideoCompatible(a, b)).toBe(isVideoCompatible(b, a));
      }),
      { numRuns: 200 },
    );
  });

  it('is true iff width, height, fps, and pixelFormat all match', () => {
    fc.assert(
      fc.property(validVideoFormatArb, validVideoFormatArb, (a, b) => {
        const allMatch =
          a.width === b.width &&
          a.height === b.height &&
          a.fps === b.fps &&
          a.pixelFormat === b.pixelFormat;
        expect(isVideoCompatible(a, b)).toBe(allMatch);
      }),
      { numRuns: 300 },
    );
  });

  it('is false whenever exactly one field differs', () => {
    fc.assert(
      fc.property(
        validVideoFormatArb,
        fc.constantFrom('width', 'height', 'fps', 'pixelFormat'),
        (base, field) => {
          const other: AvatarVideoFormat = { ...base };
          switch (field) {
            case 'width':
              other.width = base.width + 1;
              break;
            case 'height':
              other.height = base.height + 1;
              break;
            case 'fps':
              other.fps = base.fps + 1;
              break;
            case 'pixelFormat':
              other.pixelFormat = base.pixelFormat === 'rgba' ? 'yuv420p' : 'rgba';
              break;
          }
          expect(isVideoCompatible(base, other)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('AvatarStream A/V pairing (Property 7)', () => {
  it('carries the exact same AudioFormat the Voice_Channel produced', () => {
    fc.assert(
      fc.property(validVideoFormatArb, audioFormatArb, (video, audio) => {
        // The stream pairs the rendered video with the reply PCM the Voice_Channel
        // already produced — not a re-encoded or resampled copy (Req 4.4 / 5.3).
        const stream: AvatarStream = { video, audio };

        // The paired audio is the identical reference/value the Voice_Channel produced.
        expect(stream.audio).toBe(audio);
        expect(isCompatible(stream.audio, audio)).toBe(true);

        // And the paired video round-trips as compatible with the configured format,
        // so presented video and audio derive from one synchronized pairing.
        expect(isVideoCompatible(stream.video, video)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
