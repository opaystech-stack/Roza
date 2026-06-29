// Feature: roza-step3-voice-telephony, Property 11: Audio-format contract integrity
//
// Validates: Requirements 2.4
//
// Property 11 asserts the audio-format contract is internally consistent so TTS
// output is directly playable by the telephony gateway without an undocumented
// conversion. Concretely:
//   1. `frameBytes(fmt, ms)` is exactly `floor(sampleRate * ms / 1000) * 2 * channels`
//      for any supported `AudioFormat` and any non-negative finite `ms`; `ms === 0`
//      yields `0`; and a negative or non-finite `ms` is clamped to `0` (never
//      negative, never NaN).
//   2. The format the TTS adapter contract emits (`TELEPHONY_PCM_8K`) is
//      `isCompatible` with itself — i.e. directly playable as the telephony
//      playback format.
//   3. `isCompatible` is an equivalence-style relation over formats: reflexive,
//      symmetric, and false whenever the sample rate differs.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  frameBytes,
  isCompatible,
  TELEPHONY_PCM_8K,
  TELEPHONY_PCM_16K,
  type AudioFormat,
} from './audio.js';

/** Bytes per PCM sample for `pcm_s16le` (16 bits = 2 bytes). Mirrors audio.ts. */
const BYTES_PER_SAMPLE = 2;

/**
 * Generator for any valid `AudioFormat`: the only shapes the telephony stack
 * uses — signed 16-bit little-endian, mono, at one of the two supported rates.
 */
const audioFormatArb: fc.Arbitrary<AudioFormat> = fc.record({
  encoding: fc.constant('pcm_s16le' as const),
  sampleRate: fc.constantFrom(8000 as const, 16000 as const),
  channels: fc.constant(1 as const),
});

/** Non-negative finite millisecond durations, including 0 and fractional values. */
const nonNegativeMsArb: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),
  fc.double({ min: 0, max: 600_000, noNaN: true, noDefaultInfinity: true }),
  // Whole-millisecond integers, common in real framing (10/20/30 ms frames).
  fc.integer({ min: 0, max: 600_000 }),
);

/** Values of `ms` that must clamp to 0: negatives and non-finite numbers. */
const invalidMsArb: fc.Arbitrary<number> = fc.oneof(
  fc.double({ min: -600_000, max: -1e-9, noNaN: true, noDefaultInfinity: true }),
  fc.integer({ min: -600_000, max: -1 }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
);

describe('frameBytes contract (Property 11)', () => {
  it('equals floor(sampleRate * ms / 1000) * 2 * channels for any non-negative finite ms', () => {
    fc.assert(
      fc.property(audioFormatArb, nonNegativeMsArb, (fmt, ms) => {
        const expected =
          Math.floor((fmt.sampleRate * ms) / 1000) *
          BYTES_PER_SAMPLE *
          fmt.channels;
        expect(frameBytes(fmt, ms)).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });

  it('always returns a non-negative whole number of complete samples', () => {
    fc.assert(
      fc.property(audioFormatArb, nonNegativeMsArb, (fmt, ms) => {
        const bytes = frameBytes(fmt, ms);
        expect(Number.isInteger(bytes)).toBe(true);
        expect(bytes).toBeGreaterThanOrEqual(0);
        // Sample-aligned: a whole number of 2-byte mono samples.
        expect(bytes % (BYTES_PER_SAMPLE * fmt.channels)).toBe(0);
      }),
      { numRuns: 300 },
    );
  });

  it('yields 0 for ms === 0', () => {
    fc.assert(
      fc.property(audioFormatArb, (fmt) => {
        expect(frameBytes(fmt, 0)).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('clamps negative or non-finite ms to 0 (never negative, never NaN)', () => {
    fc.assert(
      fc.property(audioFormatArb, invalidMsArb, (fmt, ms) => {
        expect(frameBytes(fmt, ms)).toBe(0);
      }),
      { numRuns: 200 },
    );
  });
});

describe('isCompatible relation (Property 11)', () => {
  it('reports the TTS adapter contract format (TELEPHONY_PCM_8K) compatible with itself', () => {
    // The TTS adapter emits TELEPHONY_PCM_8K, which must be directly playable as
    // the telephony playback format — no undocumented conversion (Req 2.4).
    expect(isCompatible(TELEPHONY_PCM_8K, TELEPHONY_PCM_8K)).toBe(true);
  });

  it('is reflexive: every format is compatible with itself', () => {
    fc.assert(
      fc.property(audioFormatArb, (fmt) => {
        expect(isCompatible(fmt, fmt)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('is symmetric: isCompatible(a, b) === isCompatible(b, a)', () => {
    fc.assert(
      fc.property(audioFormatArb, audioFormatArb, (a, b) => {
        expect(isCompatible(a, b)).toBe(isCompatible(b, a));
      }),
      { numRuns: 200 },
    );
  });

  it('is false whenever the sample rate differs', () => {
    fc.assert(
      fc.property(audioFormatArb, audioFormatArb, (a, b) => {
        if (a.sampleRate !== b.sampleRate) {
          expect(isCompatible(a, b)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('distinguishes the narrowband and wideband telephony formats', () => {
    expect(isCompatible(TELEPHONY_PCM_8K, TELEPHONY_PCM_16K)).toBe(false);
    expect(isCompatible(TELEPHONY_PCM_16K, TELEPHONY_PCM_8K)).toBe(false);
  });
});
