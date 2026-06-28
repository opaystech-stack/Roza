import crypto from 'node:crypto';

/**
 * Private journal encryption (AES-256-GCM) for the Roza agent.
 *
 * Mirrors the Opays HQ `server/crypto.ts` pattern (AES-256-GCM, 12-byte IV,
 * stored auth tag, hex envelope) and extends it for Roza:
 *  - the key is *derived* from `ROZA_PRIVATE_KEY` via scrypt with a fixed app
 *    salt, so the secret need not be exactly 32 bytes;
 *  - the envelope is prefixed with the active key version so future phases can
 *    rotate keys (`keyVersion:ivHex:tagHex:cipherHex`). The prefix is tolerated
 *    but selects nothing in Phase 1 — a single derivation is used (Req 4.7).
 *
 * Confidentiality and integrity guarantees:
 *  - every entry gets a fresh random 12-byte IV (Req 4.3);
 *  - the GCM authentication tag is stored and verified on read; decryption of a
 *    tampered or wrong-key envelope throws `DecryptionError` and never returns
 *    unverified plaintext (Req 4.5);
 *  - encryption requires a non-blank secret; a blank/whitespace-only secret
 *    throws so no plaintext is ever stored (Req 4.6).
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits, recommended for GCM
const KEY_LENGTH = 32; // 256 bits
const TAG_LENGTH = 16; // 128-bit GCM authentication tag

/**
 * Fixed application salt for the scrypt key derivation. A fixed salt is
 * acceptable here because per-entry uniqueness is provided by the random IV;
 * the salt only domain-separates the derived key from other scrypt users.
 */
const APP_SALT = Buffer.from('roza-agent.private-journal.v1', 'utf8');

/** Matches a non-empty, even-length string of hexadecimal characters. */
const HEX_RE = /^(?:[0-9a-fA-F]{2})+$/;

/** Signals that a stored envelope is malformed or failed authentication. */
export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

/**
 * Derive a 32-byte AES key from `ROZA_PRIVATE_KEY` using scrypt with a fixed
 * app salt. Throws if the secret is blank or whitespace-only (Req 4.6).
 */
export function deriveKey(secret: string): Buffer {
  if (isBlank(secret)) {
    throw new Error('ROZA_PRIVATE_KEY missing: cannot derive journal encryption key.');
  }
  return crypto.scryptSync(secret, APP_SALT, KEY_LENGTH);
}

/**
 * Encrypt `plaintext` into a `keyVersion:ivHex:tagHex:cipherHex` envelope using
 * a fresh random 12-byte IV and storing the GCM auth tag (Req 4.1, 4.3, 4.7).
 * Throws if the secret is blank/whitespace-only so no plaintext is stored
 * (Req 4.6).
 */
export function encryptThought(plaintext: string, secret: string, keyVersion: string): string {
  if (isBlank(secret)) {
    throw new Error('ROZA_PRIVATE_KEY missing: refusing to encrypt journal entry.');
  }
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${keyVersion}:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Parse and decrypt a `keyVersion:ivHex:tagHex:cipherHex` envelope, verifying
 * the GCM auth tag before returning plaintext. The `keyVersion` prefix is
 * tolerated but selects nothing in Phase 1. Throws `DecryptionError` on a
 * malformed envelope or any tag mismatch, never returning unverified plaintext
 * (Req 4.5).
 */
export function decryptThought(envelope: string, secret: string): string {
  if (isBlank(secret)) {
    throw new DecryptionError('Missing decryption key.');
  }

  const parts = envelope.split(':');
  // Envelope is keyVersion:ivHex:tagHex:cipherHex. Take the last three segments
  // as iv/tag/cipher so a keyVersion containing ':' is still tolerated.
  if (parts.length < 4) {
    throw new DecryptionError('Malformed envelope: expected keyVersion:iv:tag:cipher.');
  }
  const cipherHex = parts.pop() as string;
  const tagHex = parts.pop() as string;
  const ivHex = parts.pop() as string;
  // Remaining segments form the keyVersion prefix; ignored in Phase 1.

  if (!HEX_RE.test(ivHex) || !HEX_RE.test(tagHex) || !HEX_RE.test(cipherHex)) {
    throw new DecryptionError('Malformed envelope: non-hexadecimal segment.');
  }

  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(cipherHex, 'hex');

  if (iv.length !== IV_LENGTH) {
    throw new DecryptionError('Malformed envelope: invalid initialization vector length.');
  }
  if (tag.length !== TAG_LENGTH) {
    throw new DecryptionError('Malformed envelope: invalid authentication tag length.');
  }

  try {
    const key = deriveKey(secret);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    // GCM tag mismatch (tamper or wrong key) surfaces here; never return bytes.
    throw new DecryptionError(
      `Authentication failed: ${err instanceof Error ? err.message : 'unknown error'}`
    );
  }
}
