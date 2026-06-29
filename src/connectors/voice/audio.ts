/**
 * Audio format contract (Component V4) — Req 2.4.
 *
 * A single documented PCM contract that every voice interface boundary agrees
 * on, so TTS output is directly playable by the telephony gateway and STT
 * receives frames in a known shape. Telephony defaults to signed 16-bit
 * little-endian PCM, mono, at 8 kHz (classic narrowband); 16 kHz is supported
 * for wideband trunks.
 *
 * This module is pure data plus pure helpers: no I/O, no side effects, and no
 * imports beyond these local types. It matches the Phase 1/2 pure-logic core
 * idiom and is the primary property-based-testing target for the audio
 * contract.
 */

/**
 * The PCM audio format exchanged across every voice interface boundary.
 *
 * Constrained to the only shapes the telephony stack uses: signed 16-bit
 * little-endian samples, single (mono) channel, at one of the two supported
 * telephony sample rates.
 */
export interface AudioFormat {
  /** Signed 16-bit little-endian PCM. */
  encoding: 'pcm_s16le';
  /** Narrowband (8 kHz) or wideband (16 kHz) telephony sample rate. */
  sampleRate: 8000 | 16000;
  /** Mono for telephony. */
  channels: 1;
}

/**
 * An audio buffer tagged with the format it was produced in — the unit
 * exchanged across the TtsEngine, SttEngine, and TelephonyGateway boundaries.
 */
export interface AudioChunk {
  format: AudioFormat;
  data: Uint8Array;
}

/** Narrowband telephony default: 8 kHz mono signed 16-bit little-endian PCM. */
export const TELEPHONY_PCM_8K: AudioFormat = {
  encoding: 'pcm_s16le',
  sampleRate: 8000,
  channels: 1,
};

/** Wideband telephony: 16 kHz mono signed 16-bit little-endian PCM. */
export const TELEPHONY_PCM_16K: AudioFormat = {
  encoding: 'pcm_s16le',
  sampleRate: 16000,
  channels: 1,
};

/** Bytes per PCM sample for the `pcm_s16le` encoding (16 bits = 2 bytes). */
const BYTES_PER_SAMPLE = 2;

/**
 * Total number of bytes needed to hold `ms` milliseconds of audio at `fmt`.
 *
 * Computed as `sampleRate * (ms / 1000) * BYTES_PER_SAMPLE * channels`.
 *
 * Pure and total — never throws. Flooring rule (consistent for all inputs):
 * the per-channel sample count is computed first and floored down to a whole
 * sample with `Math.floor`, then multiplied by the byte width and channel
 * count. A partial trailing sample is therefore dropped rather than rounded up,
 * so the result is always a whole number of complete samples.
 *
 * Edge cases:
 * - `ms === 0` yields `0`.
 * - A non-integer `ms` (e.g. `2.5` at 8 kHz → 20 samples → 40 bytes) floors the
 *   sample count, never the byte total, so the result stays sample-aligned.
 * - A negative or non-finite `ms` is clamped to `0` so the result is never
 *   negative or `NaN`.
 */
export function frameBytes(fmt: AudioFormat, ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) {
    return 0;
  }
  const samples = Math.floor((fmt.sampleRate * ms) / 1000);
  return samples * BYTES_PER_SAMPLE * fmt.channels;
}

/**
 * True iff two formats are byte-compatible for direct playback without
 * resampling or re-encoding — i.e. identical encoding, sample rate, and
 * channel count. Pure and total.
 */
export function isCompatible(a: AudioFormat, b: AudioFormat): boolean {
  return (
    a.encoding === b.encoding &&
    a.sampleRate === b.sampleRate &&
    a.channels === b.channels
  );
}
