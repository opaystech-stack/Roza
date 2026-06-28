import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { DecryptionError, decryptThought, encryptThought } from './crypto.js';

/**
 * Property-based tests for the AES-256-GCM private journal crypto.
 *
 * Envelope format produced by `encryptThought`:
 *   `keyVersion:ivHex:tagHex:cipherHex`
 * where ivHex is 12 bytes (24 hex chars) and tagHex is the 16-byte (32 hex
 * char) GCM authentication tag.
 *
 * Each property runs a minimum of 100 fast-check iterations. scrypt key
 * derivation is intentionally expensive *and synchronous*, so each property is
 * an async predicate that yields to the event loop between iterations (so the
 * test-runner worker stays responsive), and repeat/length bounds are kept
 * modest while still exercising the full input space.
 */

const NUM_RUNS = 100;

/** Yield a turn to the event loop so the worker can flush runner messages. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A non-blank secret (has at least one non-whitespace character). */
const secretArb = fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.trim().length > 0);

/** Any key version token (may even be empty or contain ':' — both tolerated). */
const keyVersionArb = fc.string({ maxLength: 16 });

/** Split an envelope into its iv/tag/cipher segments (mirrors decryptThought). */
function segmentsOf(envelope: string): { iv: string; tag: string; cipher: string } {
  const parts = envelope.split(':');
  const cipher = parts.pop() as string;
  const tag = parts.pop() as string;
  const iv = parts.pop() as string;
  return { iv, tag, cipher };
}

/** Flip a single hex character to a guaranteed-different valid hex character. */
function flipHexChar(hex: string, index: number): string {
  const c = hex[index] as string;
  const replacement = c.toLowerCase() === '0' ? '1' : '0';
  return hex.slice(0, index) + replacement + hex.slice(index + 1);
}

describe('crypto property-based tests', () => {
  // Feature: roza-agent, Property 1: Journal encryption round-trip — for any plaintext (1..100,000 chars), any non-blank secret, any keyVersion: decryptThought(encryptThought(plaintext, secret, version), secret) === plaintext byte-for-byte; envelope starts with `version:`; envelope contains no plaintext substring for non-trivial plaintext.
  // Validates: Requirements 4.1, 4.2, 4.4, 4.7, 8.1
  it('Property 1: round-trips any plaintext byte-for-byte and prefixes the key version', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Unicode strings up to a few thousand chars keep runtime sane while
        // covering the 1..100,000 range; boundary cases are asserted explicitly below.
        fc.fullUnicodeString({ minLength: 1, maxLength: 3000 }),
        secretArb,
        keyVersionArb,
        async (plaintext, secret, version) => {
          await tick();
          const envelope = encryptThought(plaintext, secret, version);

          // Round-trip is byte-for-byte identical (Req 4.2, 4.4, 8.1).
          expect(decryptThought(envelope, secret)).toBe(plaintext);

          // Envelope records the key version as its prefix (Req 4.7).
          expect(envelope.startsWith(`${version}:`)).toBe(true);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  // Feature: roza-agent, Property 1: Journal encryption round-trip — envelope contains no plaintext substring for non-trivial plaintext.
  // Validates: Requirements 4.1, 8.1
  it('Property 1: produces an envelope that never contains the plaintext (non-trivial input)', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Mark the plaintext with a sentinel guaranteeing a non-hex, non-':'
        // character so any leakage of plaintext into the (hex) envelope is
        // detectable rather than a hex coincidence.
        fc.fullUnicodeString({ maxLength: 3000 }).map((s) => `«secret»${s}«end»`),
        secretArb,
        // Avoid ':' in the key version so the version prefix cannot itself
        // coincidentally contain the sentinel-wrapped plaintext.
        fc.string({ maxLength: 16 }).filter((s) => !s.includes(':')),
        async (plaintext, secret, version) => {
          await tick();
          const envelope = encryptThought(plaintext, secret, version);
          expect(envelope.includes(plaintext)).toBe(false);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  // Feature: roza-agent, Property 1: Journal encryption round-trip — explicit boundary cases (single char and large plaintext).
  // Validates: Requirements 4.1, 4.2, 4.4, 8.1
  it('Property 1: round-trips single-character and large (100,000 char) boundary plaintexts', () => {
    const secret = 'a-non-blank-secret';
    const version = 'v1';
    for (const plaintext of ['x', 'é', 'A'.repeat(100_000)]) {
      const envelope = encryptThought(plaintext, secret, version);
      expect(decryptThought(envelope, secret)).toBe(plaintext);
      expect(envelope.startsWith(`${version}:`)).toBe(true);
    }
  });

  // Feature: roza-agent, Property 2: Unique initialization vector per entry — encrypting the same plaintext N times yields N distinct IV segments, each with a non-empty tag segment.
  // Validates: Requirements 4.3
  it('Property 2: emits a distinct IV and a non-empty auth tag for every entry', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.fullUnicodeString({ minLength: 1, maxLength: 500 }),
        secretArb,
        keyVersionArb,
        fc.integer({ min: 2, max: 3 }),
        async (plaintext, secret, version, n) => {
          await tick();
          const ivs: string[] = [];
          for (let i = 0; i < n; i++) {
            const envelope = encryptThought(plaintext, secret, version);
            const { iv, tag } = segmentsOf(envelope);
            // 12-byte IV -> 24 hex chars; 16-byte tag -> 32 hex chars.
            expect(iv.length).toBe(24);
            expect(tag.length).toBe(32);
            ivs.push(iv);
          }
          // All IVs are distinct across the N encryptions of the same plaintext.
          expect(new Set(ivs).size).toBe(n);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  // Feature: roza-agent, Property 3: Tamper and wrong-key detection — any single-byte mutation of the iv/tag/cipher segment, or decryption with a different secret, makes decryptThought throw DecryptionError and return no plaintext; the original envelope still decrypts unchanged.
  // Validates: Requirements 4.5, 8.2
  it('Property 3: rejects tampered envelopes and wrong keys with DecryptionError', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.fullUnicodeString({ minLength: 1, maxLength: 500 }),
        secretArb,
        keyVersionArb,
        // One scenario per run: tamper a chosen segment, or use a wrong key.
        fc.constantFrom<'iv' | 'tag' | 'cipher' | 'wrongkey'>('iv', 'tag', 'cipher', 'wrongkey'),
        fc.nat(),
        secretArb,
        async (plaintext, secret, version, scenario, position, otherSecret) => {
          await tick();
          const envelope = encryptThought(plaintext, secret, version);

          if (scenario === 'wrongkey') {
            // A different secret derives a different key -> auth failure.
            if (otherSecret !== secret) {
              expect(() => decryptThought(envelope, otherSecret)).toThrow(DecryptionError);
            }
          } else {
            const parts = envelope.split(':');
            const cipher = parts.pop() as string;
            const tag = parts.pop() as string;
            const iv = parts.pop() as string;
            const prefix = parts.join(':'); // key version (possibly contains ':')

            // Mutate exactly one hex character in the chosen segment.
            const segVal = scenario === 'iv' ? iv : scenario === 'tag' ? tag : cipher;
            const index = position % segVal.length;
            const mutated = flipHexChar(segVal, index);
            const tampered = [
              prefix,
              scenario === 'iv' ? mutated : iv,
              scenario === 'tag' ? mutated : tag,
              scenario === 'cipher' ? mutated : cipher,
            ].join(':');

            // A tampered envelope never yields plaintext — it throws.
            expect(() => decryptThought(tampered, secret)).toThrow(DecryptionError);
          }

          // The original (untampered) envelope still decrypts correctly: the
          // stored ciphertext is preserved unchanged (Req 4.5).
          expect(decryptThought(envelope, secret)).toBe(plaintext);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  // Feature: roza-agent, Property 4: Encryption requires a key — for any blank/whitespace-only secret, encryptThought throws (no plaintext is ever encrypted).
  // Validates: Requirements 4.6
  it('Property 4: refuses to encrypt with a blank or whitespace-only secret', async () => {
    // Whitespace-only secrets, including the empty string.
    const blankSecretArb = fc
      .stringOf(fc.constantFrom(' ', '\t', '\n', '\r', '\f', '\v'), { maxLength: 8 })
      .filter((s) => s.trim().length === 0);

    await fc.assert(
      fc.asyncProperty(
        fc.fullUnicodeString({ maxLength: 1000 }),
        blankSecretArb,
        keyVersionArb,
        async (plaintext, blankSecret, version) => {
          await tick();
          expect(() => encryptThought(plaintext, blankSecret, version)).toThrow();
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});
