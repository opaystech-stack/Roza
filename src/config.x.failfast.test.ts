/**
 * Property-based test for the Phase 5 X (formerly Twitter) credential fail-fast
 * in `config.ts` (Correctness Property 3 of the roza-step5-x-twitter design).
 *
 * This exercises ONLY the side-effect-free resolver `resolveXConfig`. The
 * imperative `loadConfigOrExit` wrapper is intentionally NOT called here because
 * it performs logging and `process.exit`. The property runs a minimum of 100
 * fast-check iterations.
 *
 * This file is intentionally separate from the Phase 5 resolution suite
 * `config.x.resolve.test.ts` (Property 2) so the two property suites stay
 * independent and never collide.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { type MissingXVar, resolveXConfig } from './config.js';

const NUM_RUNS = 200;

/** Build a typed env object from a plain record (values may be undefined). */
function makeEnv(record: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return record as NodeJS.ProcessEnv;
}

/** Every X secret variable name that may legitimately appear in `missing`. */
const VALID_X_VARS: ReadonlySet<MissingXVar> = new Set<MissingXVar>(['X_USERNAME', 'X_PASSWORD']);

/** Arbitrary durable data directory passed to the resolver (non-secret). */
const dataDirGen = fc.constantFrom('/app/data', '/var/roza', '/data', './data', '/srv/roza/state');

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

// An `X_ENABLED` flag value that is NOT the literal (case-insensitive, trimmed)
// "true" — i.e. the disabled case.
const notTrueFlag = fc
  .oneof(
    fc.constant(undefined),
    fc.constant(''),
    fc.constantFrom('false', 'False', 'FALSE', '0', 'no', 'yes', 'enabled', 'on'),
    fc.string()
  )
  .filter((v) => v === undefined || v.trim().toLowerCase() !== 'true');

// A flag value that enables the X capability (the literal "true", trimmed,
// case-insensitive — including surrounding whitespace).
const trueFlag = fc.constantFrom('true', 'TRUE', 'True', ' true ', '\ttrue\n');

describe('X config fail-fast — Property 3', () => {
  // Feature: roza-step5-x-twitter, Property 3: Enabled-X credential fail-fast names every missing variable
  // Validates: Requirements 7.2, 13.2

  // The two X secret variables, in the stable order the resolver emits them:
  // X_USERNAME, then X_PASSWORD.
  const X_VARS: ReadonlyArray<MissingXVar> = ['X_USERNAME', 'X_PASSWORD'];

  /** Per-variable state: present (with a value) or blank (undefined/empty/ws). */
  type VarState = { present: boolean; value: string | undefined };
  const varStateGen: fc.Arbitrary<VarState> = fc.oneof(
    presentSecret.map((value) => ({ present: true, value })),
    blankValue.map((value) => ({ present: false, value: value ?? undefined }))
  );

  function buildEnv(opts: {
    enabledFlag: string;
    username: VarState;
    password: VarState;
  }): NodeJS.ProcessEnv {
    return makeEnv({
      X_ENABLED: opts.enabledFlag,
      X_USERNAME: opts.username.value,
      X_PASSWORD: opts.password.value,
    });
  }

  /**
   * The exact list of offending variables in the resolver's stable order, given
   * which credentials are blank (only meaningful when X is enabled).
   */
  function expectedMissing(opts: { username: VarState; password: VarState }): MissingXVar[] {
    const present: Record<MissingXVar, boolean> = {
      X_USERNAME: opts.username.present,
      X_PASSWORD: opts.password.present,
    };
    return X_VARS.filter((name) => !present[name]);
  }

  it('Property 3: enabled X with ≥1 blank credential fails naming EXACTLY the offending vars in stable order', () => {
    fc.assert(
      fc.property(
        fc.record({
          enabledFlag: trueFlag,
          username: varStateGen,
          password: varStateGen,
          dataDir: dataDirGen,
        }),
        (opts) => {
          const expected = expectedMissing(opts);
          // Pre-condition for THIS property: at least one offending variable, so
          // resolution must fail. Cases where nothing is missing are covered by
          // the "never reported when disabled / present" properties below.
          fc.pre(expected.length > 0);

          const result = resolveXConfig(buildEnv(opts), opts.dataDir);

          expect(result.ok).toBe(false);
          if (result.ok) {
            return;
          }
          // EXACTLY the offending variables, in the resolver's stable order
          // (X_USERNAME, X_PASSWORD).
          expect(result.missing).toEqual(expected);
          // The failure result carries ONLY {ok, missing} — no secret field.
          expect(Object.keys(result).sort()).toEqual(['missing', 'ok']);
          // Every reported entry is a valid variable NAME, never a value.
          for (const name of result.missing) {
            expect(VALID_X_VARS.has(name)).toBe(true);
          }
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 3: present credential VALUES never appear in the missing list nor anywhere in the failure result', () => {
    fc.assert(
      fc.property(
        fc.record({
          enabledFlag: trueFlag,
          username: varStateGen,
          password: varStateGen,
          dataDir: dataDirGen,
        }),
        (opts) => {
          const expected = expectedMissing(opts);
          fc.pre(expected.length > 0);

          const result = resolveXConfig(buildEnv(opts), opts.dataDir);

          expect(result.ok).toBe(false);
          if (result.ok) {
            return;
          }
          // Collect every present credential value supplied to the resolver.
          const presentValues = [opts.username, opts.password]
            .filter((s) => s.present && s.value !== undefined)
            .map((s) => s.value as string);

          // The missing list contains ONLY variable names — never a credential
          // value — and no present secret appears anywhere in the serialized
          // failure result.
          const serialized = JSON.stringify(result);
          for (const value of presentValues) {
            expect(result.missing as string[]).not.toContain(value);
            expect(serialized.includes(value)).toBe(false);
          }
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 3: a disabled X capability NEVER reports an absent credential (capability inert)', () => {
    fc.assert(
      fc.property(
        fc.record({
          enabledFlag: notTrueFlag,
          username: blankOrPresent,
          password: blankOrPresent,
          dataDir: dataDirGen,
        }),
        (r) => {
          const env = makeEnv({
            X_ENABLED: r.enabledFlag,
            X_USERNAME: r.username,
            X_PASSWORD: r.password,
          });

          const result = resolveXConfig(env, r.dataDir);

          // With X disabled, no absent credential is an error: the capability
          // resolves ok and stays inert (Req 7.3).
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

  it('Property 3: enabled X with BOTH credentials blank reports both names in stable order', () => {
    fc.assert(
      fc.property(
        fc.record({
          enabledFlag: trueFlag,
          username: blankValue,
          password: blankValue,
          dataDir: dataDirGen,
        }),
        (opts) => {
          const env = makeEnv({
            X_ENABLED: opts.enabledFlag,
            X_USERNAME: opts.username,
            X_PASSWORD: opts.password,
          });

          const result = resolveXConfig(env, opts.dataDir);

          expect(result.ok).toBe(false);
          if (result.ok) {
            return;
          }
          expect(result.missing).toEqual(['X_USERNAME', 'X_PASSWORD']);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});
