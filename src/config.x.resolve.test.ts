/**
 * Property-based test for the Phase 5 X (formerly Twitter) capability
 * configuration resolver in `config.ts` (Correctness Property 2 of the
 * roza-step5-x-twitter design).
 *
 * This exercises ONLY the side-effect-free resolver `resolveXConfig(env,
 * dataDir)`. The imperative `loadConfigOrExit` wrapper is intentionally NOT
 * called here because it performs logging and `process.exit`. The property runs
 * a minimum of 100 fast-check iterations.
 *
 * This file is intentionally separate from the Phase 1 `config.test.ts`, the
 * Phase 2 `config.channels.test.ts`, the Phase 3 `config.voice.test.ts`, the
 * Phase 4 avatar suites, and the Phase 5 fail-fast suite
 * (`config.x.failfast.test.ts`) so the prior property suites stay untouched.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { type XChannelConfig, resolveXConfig } from './config.js';

const NUM_RUNS = 200;

// Documented defaults applied when the corresponding optional settings are
// absent (mirrors the DEFAULT_X_* constants in config.ts).
const DEFAULTS = {
  autonomyIntervalMinutes: 60,
  dailyPostLimit: 10,
  actionSpacingMs: 600000,
  maxTopics: 3,
  maxPostChars: 280,
  dryRun: false,
  storageStateBasename: 'x_storage_state.json',
} as const;

/** Build a typed env object from a plain record (values may be undefined). */
function makeEnv(record: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return record as NodeJS.ProcessEnv;
}

// A value that should count as "blank/missing": undefined, empty, or
// whitespace-only.
const blankValue = fc.oneof(
  fc.constant(undefined),
  fc.constant(''),
  fc
    .array(fc.constantFrom(' ', '\t', '\n', '\r', '\v', '\f'), { minLength: 1, maxLength: 8 })
    .map((parts) => parts.join(''))
);

// A non-blank "secret" value, prefixed so it can never collide with a variable
// name during the no-leak assertions.
const presentSecret = fc
  .string({ minLength: 1 })
  .filter((s) => s.trim().length > 0)
  .map((s) => `secret-${s}`);

// A value that is either present or blank.
const blankOrPresent = fc.oneof(blankValue, presentSecret);

// A valid positive-integer setting rendered as a string.
const validPositiveInt = fc.integer({ min: 1, max: 100000 });

// A non-empty, non-whitespace data directory path.
const dataDirGen = fc
  .string({ minLength: 1 })
  .filter((s) => s.trim().length > 0)
  .map((s) => `/data-${s.replace(/[^a-zA-Z0-9/_-]/g, '_')}`);

// A non-blank storage-state path override.
const presentPath = fc
  .string({ minLength: 1 })
  .filter((s) => s.trim().length > 0)
  .map((s) => `/state/${s.replace(/[^a-zA-Z0-9/_.-]/g, '_')}.json`);

// A `X_ENABLED` flag value that is NOT the literal (case-insensitive, trimmed)
// "true" — i.e. the disabled case.
const notTrueFlag = fc
  .oneof(
    fc.constant(undefined),
    fc.constant(''),
    fc.constantFrom('false', 'False', 'FALSE', '0', 'no', 'yes', 'enabled', 'on'),
    fc.string()
  )
  .filter((v) => v === undefined || v.trim().toLowerCase() !== 'true');

describe('X config resolution — Property 2', () => {
  // Feature: roza-step5-x-twitter, Property 2: X configuration resolution from environment and defaults
  // Validates: Requirements 1.3, 4.4, 7.1, 7.3, 8.1

  it('Property 2: X_ENABLED ≠ "true" always resolves ok with enabled:false REGARDLESS of credential presence (inert)', () => {
    fc.assert(
      fc.property(
        notTrueFlag,
        dataDirGen,
        // Credentials and ALL optional settings free to be present or blank —
        // a disabled X capability must never abort and never report a missing
        // credential (Req 1.3, 7.3).
        fc.record({
          username: blankOrPresent,
          password: blankOrPresent,
          storageStatePath: blankOrPresent,
          autonomyIntervalMinutes: blankOrPresent,
          dailyPostLimit: blankOrPresent,
          actionSpacingMs: blankOrPresent,
          maxTopics: blankOrPresent,
          maxPostChars: blankOrPresent,
          dryRun: blankOrPresent,
        }),
        (flag, dataDir, r) => {
          const env = makeEnv({
            X_ENABLED: flag,
            X_USERNAME: r.username,
            X_PASSWORD: r.password,
            X_STORAGE_STATE_PATH: r.storageStatePath,
            X_AUTONOMY_INTERVAL_MINUTES: r.autonomyIntervalMinutes,
            X_DAILY_POST_LIMIT: r.dailyPostLimit,
            X_ACTION_SPACING_MS: r.actionSpacingMs,
            X_MAX_TOPICS: r.maxTopics,
            X_MAX_POST_CHARS: r.maxPostChars,
            X_DRY_RUN: r.dryRun,
          });

          const result = resolveXConfig(env, dataDir);

          // A disabled capability is ALWAYS ok and never aborts, even when a
          // credential is present or absent (Req 1.3, 7.3).
          expect(result.ok).toBe(true);
          if (!result.ok) {
            return;
          }
          expect(result.cfg.enabled).toBe(false);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 2: disabled capability applies documented defaults for all optional settings', () => {
    fc.assert(
      fc.property(notTrueFlag, dataDirGen, (flag, dataDir) => {
        // No optional settings supplied → every documented default applies.
        const env = makeEnv({ X_ENABLED: flag });

        const result = resolveXConfig(env, dataDir);

        expect(result.ok).toBe(true);
        if (!result.ok) {
          return;
        }
        const { cfg } = result;
        expect(cfg.enabled).toBe(false);
        // Credentials default to empty when absent (never surfaced/required
        // while disabled).
        expect(cfg.credentials).toEqual({ username: '', password: '' });
        // Storage-state path defaults under the durable data directory (Req 3.1).
        expect(cfg.storageStatePath).toBe(`${dataDir}/${DEFAULTS.storageStateBasename}`);
        // Tunable settings fall back to their documented defaults (Req 4.4, 8.1).
        expect(cfg.autonomyIntervalMinutes).toBe(DEFAULTS.autonomyIntervalMinutes);
        expect(cfg.rateLimit).toEqual({
          dailyPostLimit: DEFAULTS.dailyPostLimit,
          actionSpacingMs: DEFAULTS.actionSpacingMs,
        });
        expect(cfg.maxTopics).toBe(DEFAULTS.maxTopics);
        expect(cfg.maxPostChars).toBe(DEFAULTS.maxPostChars);
        expect(cfg.dryRun).toBe(DEFAULTS.dryRun);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 2: enabled with optional settings absent applies documented defaults', () => {
    fc.assert(
      fc.property(
        dataDirGen,
        // Credentials present so an enabled capability resolves ok; no other
        // optional setting supplied so every default applies.
        fc.record({ username: presentSecret, password: presentSecret }),
        (dataDir, r) => {
          const env = makeEnv({
            X_ENABLED: 'true',
            X_USERNAME: r.username,
            X_PASSWORD: r.password,
          });

          const result = resolveXConfig(env, dataDir);

          expect(result.ok).toBe(true);
          if (!result.ok) {
            return;
          }
          const { cfg } = result;
          expect(cfg.enabled).toBe(true);
          // Documented defaults under the durable volume (Req 3.1, 4.4, 8.1).
          expect(cfg.storageStatePath).toBe(`${dataDir}/${DEFAULTS.storageStateBasename}`);
          expect(cfg.autonomyIntervalMinutes).toBe(DEFAULTS.autonomyIntervalMinutes);
          expect(cfg.rateLimit).toEqual({
            dailyPostLimit: DEFAULTS.dailyPostLimit,
            actionSpacingMs: DEFAULTS.actionSpacingMs,
          });
          expect(cfg.maxTopics).toBe(DEFAULTS.maxTopics);
          expect(cfg.maxPostChars).toBe(DEFAULTS.maxPostChars);
          expect(cfg.dryRun).toBe(DEFAULTS.dryRun);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 2: enabled with all settings present draws every field from its env var', () => {
    fc.assert(
      fc.property(
        dataDirGen,
        fc.record({
          username: presentSecret,
          password: presentSecret,
          storageStatePath: presentPath,
          autonomyIntervalMinutes: validPositiveInt,
          dailyPostLimit: validPositiveInt,
          actionSpacingMs: validPositiveInt,
          maxTopics: validPositiveInt,
          maxPostChars: validPositiveInt,
          dryRun: fc.boolean(),
        }),
        (dataDir, r) => {
          const env = makeEnv({
            X_ENABLED: 'true',
            X_USERNAME: r.username,
            X_PASSWORD: r.password,
            X_STORAGE_STATE_PATH: r.storageStatePath,
            X_AUTONOMY_INTERVAL_MINUTES: String(r.autonomyIntervalMinutes),
            X_DAILY_POST_LIMIT: String(r.dailyPostLimit),
            X_ACTION_SPACING_MS: String(r.actionSpacingMs),
            X_MAX_TOPICS: String(r.maxTopics),
            X_MAX_POST_CHARS: String(r.maxPostChars),
            X_DRY_RUN: r.dryRun ? 'true' : 'false',
          });

          const result = resolveXConfig(env, dataDir);

          expect(result.ok).toBe(true);
          if (!result.ok) {
            return;
          }
          const { cfg } = result;
          expect(cfg.enabled).toBe(true);
          // Credentials drawn from their env vars: username is trimmed, password
          // is stored verbatim (Req 7.1).
          expect(cfg.credentials.username).toBe(r.username.trim());
          expect(cfg.credentials.password).toBe(r.password);
          // A supplied storage-state path overrides the default (trimmed).
          expect(cfg.storageStatePath).toBe(r.storageStatePath.trim());
          // Tunable settings drawn from their env vars (Req 4.4, 8.1).
          expect(cfg.autonomyIntervalMinutes).toBe(r.autonomyIntervalMinutes);
          expect(cfg.rateLimit).toEqual({
            dailyPostLimit: r.dailyPostLimit,
            actionSpacingMs: r.actionSpacingMs,
          });
          expect(cfg.maxTopics).toBe(r.maxTopics);
          expect(cfg.maxPostChars).toBe(r.maxPostChars);
          expect(cfg.dryRun).toBe(r.dryRun);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 2: each field is drawn ONLY from its corresponding env var (no cross-wiring)', () => {
    // Distinct sentinel values let us assert each config field maps to exactly
    // one env var and nothing bleeds across fields.
    const dataDir = '/app/data';
    const env = makeEnv({
      X_ENABLED: 'true',
      X_USERNAME: 'roza_thinker',
      X_PASSWORD: 'secret-password',
      X_STORAGE_STATE_PATH: '/state/x_state.json',
      X_AUTONOMY_INTERVAL_MINUTES: '45',
      X_DAILY_POST_LIMIT: '7',
      X_ACTION_SPACING_MS: '900000',
      X_MAX_TOPICS: '5',
      X_MAX_POST_CHARS: '500',
      X_DRY_RUN: 'true',
    });

    const result = resolveXConfig(env, dataDir);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const expected: XChannelConfig = {
      enabled: true,
      credentials: { username: 'roza_thinker', password: 'secret-password' },
      storageStatePath: '/state/x_state.json',
      autonomyIntervalMinutes: 45,
      rateLimit: { dailyPostLimit: 7, actionSpacingMs: 900000 },
      maxTopics: 5,
      maxPostChars: 500,
      dryRun: true,
    };
    expect(result.cfg).toEqual(expected);
  });

  it('Property 2: an invalid (non-positive-integer) optional setting falls back to its documented default', () => {
    // Values that `parsePositiveIntOr` (Number.parseInt-based) cannot read as a
    // positive integer, so each must fall back to its documented default. Note
    // a leading-digit value like "1.5" parses to 1 and is NOT garbage here.
    const garbage = fc.oneof(
      fc.constant('0'),
      fc.constant('-1'),
      fc.constant('abc'),
      fc.constant('  '),
      fc.constant('NaN')
    );

    fc.assert(
      fc.property(
        dataDirGen,
        fc.record({
          username: presentSecret,
          password: presentSecret,
          autonomyIntervalMinutes: garbage,
          dailyPostLimit: garbage,
          actionSpacingMs: garbage,
          maxTopics: garbage,
          maxPostChars: garbage,
        }),
        (dataDir, r) => {
          const env = makeEnv({
            X_ENABLED: 'true',
            X_USERNAME: r.username,
            X_PASSWORD: r.password,
            X_AUTONOMY_INTERVAL_MINUTES: r.autonomyIntervalMinutes,
            X_DAILY_POST_LIMIT: r.dailyPostLimit,
            X_ACTION_SPACING_MS: r.actionSpacingMs,
            X_MAX_TOPICS: r.maxTopics,
            X_MAX_POST_CHARS: r.maxPostChars,
          });

          const result = resolveXConfig(env, dataDir);

          expect(result.ok).toBe(true);
          if (!result.ok) {
            return;
          }
          const { cfg } = result;
          // Invalid integers fall back to documented defaults (Req 8.1).
          expect(cfg.autonomyIntervalMinutes).toBe(DEFAULTS.autonomyIntervalMinutes);
          expect(cfg.rateLimit.dailyPostLimit).toBe(DEFAULTS.dailyPostLimit);
          expect(cfg.rateLimit.actionSpacingMs).toBe(DEFAULTS.actionSpacingMs);
          expect(cfg.maxTopics).toBe(DEFAULTS.maxTopics);
          expect(cfg.maxPostChars).toBe(DEFAULTS.maxPostChars);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});
