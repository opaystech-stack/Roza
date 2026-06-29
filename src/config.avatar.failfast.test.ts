/**
 * Property-based test for the Phase 4 avatar Meet/stream credential fail-fast in
 * `config.ts` (Correctness Property 3 of the roza-step4-avatar-video design).
 *
 * This exercises ONLY the side-effect-free resolver `resolveAvatarConfig`. The
 * imperative `loadConfigOrExit` wrapper is intentionally NOT called here because
 * it performs logging and `process.exit`. The property runs a minimum of 100
 * fast-check iterations.
 *
 * This file is intentionally separate from the Phase 1 `config.test.ts`, the
 * Phase 2 `config.channels.test.ts`, the Phase 3 `config.voice.test.ts`, and
 * the Phase 4 resolution suite `config.avatar.resolve.test.ts` so the prior
 * property suites stay untouched.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { type MissingAvatarVar, resolveAvatarConfig } from './config.js';

const NUM_RUNS = 200;

/** Build a typed env object from a plain record (values may be undefined). */
function makeEnv(record: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return record as NodeJS.ProcessEnv;
}

/** Every avatar secret variable name that may legitimately appear in `missing`. */
const VALID_AVATAR_VARS: ReadonlySet<MissingAvatarVar> = new Set<MissingAvatarVar>([
  'MEET_ACCOUNT',
  'MEET_PASSWORD',
  'STREAM_KEY',
]);

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

// A `*_ENABLED` flag value that is NOT the literal (case-insensitive, trimmed)
// "true" — i.e. the disabled case.
const notTrueFlag = fc
  .oneof(
    fc.constant(undefined),
    fc.constant(''),
    fc.constantFrom('false', 'False', 'FALSE', '0', 'no', 'yes', 'enabled', 'on'),
    fc.string()
  )
  .filter((v) => v === undefined || v.trim().toLowerCase() !== 'true');

// A flag value that enables a sub-capability (the literal "true", trimmed,
// case-insensitive — including surrounding whitespace).
const trueFlag = fc.constantFrom('true', 'TRUE', 'True', ' true ', '\ttrue\n');

describe('avatar config fail-fast — Property 3', () => {
  // Feature: roza-step4-avatar-video, Property 3: Enabled Meet/stream credential fail-fast names every missing variable
  // Validates: Requirements 8.2, 8.3, 12.2

  // The three avatar secret variables, in the stable order the resolver emits
  // them: MEET_ACCOUNT, MEET_PASSWORD (both Meet-gated), then STREAM_KEY
  // (stream-gated).
  const AVATAR_VARS: ReadonlyArray<{ name: MissingAvatarVar; gate: 'meet' | 'stream' }> = [
    { name: 'MEET_ACCOUNT', gate: 'meet' },
    { name: 'MEET_PASSWORD', gate: 'meet' },
    { name: 'STREAM_KEY', gate: 'stream' },
  ];

  /** Per-variable state: present (with a value) or blank (undefined/empty/ws). */
  type VarState = { present: boolean; value: string | undefined };
  const varStateGen: fc.Arbitrary<VarState> = fc.oneof(
    presentSecret.map((value) => ({ present: true, value })),
    blankValue.map((value) => ({ present: false, value: value ?? undefined }))
  );

  function buildEnv(opts: {
    meetEnabled: boolean;
    streamEnabled: boolean;
    account: VarState;
    password: VarState;
    streamKey: VarState;
  }): NodeJS.ProcessEnv {
    return makeEnv({
      AVATAR_ENABLED: 'true',
      MEET_ENABLED: opts.meetEnabled ? 'true' : 'false',
      STREAM_ENABLED: opts.streamEnabled ? 'true' : 'false',
      MEET_ACCOUNT: opts.account.value,
      MEET_PASSWORD: opts.password.value,
      STREAM_KEY: opts.streamKey.value,
    });
  }

  /**
   * The exact list of offending variables in the resolver's stable order, given
   * which sub-capabilities are enabled and which secrets are blank.
   */
  function expectedMissing(opts: {
    meetEnabled: boolean;
    streamEnabled: boolean;
    account: VarState;
    password: VarState;
    streamKey: VarState;
  }): MissingAvatarVar[] {
    const present: Record<MissingAvatarVar, boolean> = {
      MEET_ACCOUNT: opts.account.present,
      MEET_PASSWORD: opts.password.present,
      STREAM_KEY: opts.streamKey.present,
    };
    const enabled: Record<'meet' | 'stream', boolean> = {
      meet: opts.meetEnabled,
      stream: opts.streamEnabled,
    };
    return AVATAR_VARS.filter((v) => enabled[v.gate] && !present[v.name]).map((v) => v.name);
  }

  it('Property 3: enabled sub-capability with ≥1 blank secret fails naming EXACTLY the offending vars in stable order', () => {
    fc.assert(
      fc.property(
        fc.record({
          meetEnabled: fc.boolean(),
          streamEnabled: fc.boolean(),
          account: varStateGen,
          password: varStateGen,
          streamKey: varStateGen,
        }),
        (opts) => {
          const expected = expectedMissing(opts);
          // Pre-condition for THIS property: at least one offending variable, so
          // resolution must fail. Skip cases where nothing is missing (covered
          // by the "never reported when disabled / present" properties below).
          fc.pre(expected.length > 0);

          const result = resolveAvatarConfig(buildEnv(opts));

          expect(result.ok).toBe(false);
          if (result.ok) {
            return;
          }
          // EXACTLY the offending variables, in the resolver's stable order
          // (MEET_ACCOUNT, MEET_PASSWORD, STREAM_KEY).
          expect(result.missing).toEqual(expected);
          // The failure result carries ONLY {ok, missing} — no secret field.
          expect(Object.keys(result).sort()).toEqual(['missing', 'ok']);
          // Every reported entry is a valid variable NAME, never a value.
          for (const name of result.missing) {
            expect(VALID_AVATAR_VARS.has(name)).toBe(true);
          }
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 3: present secret VALUES never appear in the missing list nor anywhere in the failure result', () => {
    fc.assert(
      fc.property(
        fc.record({
          meetEnabled: fc.boolean(),
          streamEnabled: fc.boolean(),
          account: varStateGen,
          password: varStateGen,
          streamKey: varStateGen,
        }),
        (opts) => {
          const expected = expectedMissing(opts);
          fc.pre(expected.length > 0);

          const result = resolveAvatarConfig(buildEnv(opts));

          expect(result.ok).toBe(false);
          if (result.ok) {
            return;
          }
          // Collect every present secret value supplied to the resolver.
          const presentValues = [opts.account, opts.password, opts.streamKey]
            .filter((s) => s.present && s.value !== undefined)
            .map((s) => s.value as string);

          // The missing list contains ONLY variable names — never a secret value.
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

  it('Property 3: a disabled sub-capability NEVER reports its absent secret (capability inert)', () => {
    fc.assert(
      fc.property(
        fc.record({
          // Meet/stream both disabled; all three secrets free to be blank.
          account: blankOrPresent,
          password: blankOrPresent,
          streamKey: blankOrPresent,
          meetFlag: notTrueFlag,
          streamFlag: notTrueFlag,
        }),
        (r) => {
          const env = makeEnv({
            AVATAR_ENABLED: 'true',
            MEET_ENABLED: r.meetFlag,
            STREAM_ENABLED: r.streamFlag,
            MEET_ACCOUNT: r.account,
            MEET_PASSWORD: r.password,
            STREAM_KEY: r.streamKey,
          });

          const result = resolveAvatarConfig(env);

          // With both sub-capabilities disabled, no absent secret is an error:
          // the avatar capability resolves ok and stays inert (Req 8.3).
          expect(result.ok).toBe(true);
          if (!result.ok) {
            return;
          }
          expect(result.cfg.enabled).toBe(true);
          expect(result.cfg.meet.enabled).toBe(false);
          expect(result.cfg.stream.enabled).toBe(false);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 3: only the ENABLED sub-capability contributes its missing vars', () => {
    fc.assert(
      fc.property(
        fc.record({
          meetEnabled: fc.boolean(),
          streamEnabled: fc.boolean(),
        }),
        ({ meetEnabled, streamEnabled }) => {
          // All three secrets blank; only the enabled gates produce misses.
          const env = makeEnv({
            AVATAR_ENABLED: 'true',
            MEET_ENABLED: meetEnabled ? 'true' : 'false',
            STREAM_ENABLED: streamEnabled ? 'true' : 'false',
            MEET_ACCOUNT: '   ',
            MEET_PASSWORD: undefined,
            STREAM_KEY: '',
          });

          const result = resolveAvatarConfig(env);

          const expected: MissingAvatarVar[] = [
            ...(meetEnabled ? (['MEET_ACCOUNT', 'MEET_PASSWORD'] as MissingAvatarVar[]) : []),
            ...(streamEnabled ? (['STREAM_KEY'] as MissingAvatarVar[]) : []),
          ];

          if (expected.length === 0) {
            // Neither enabled → ok and inert despite every secret being blank.
            expect(result.ok).toBe(true);
            return;
          }
          expect(result.ok).toBe(false);
          if (result.ok) {
            return;
          }
          expect(result.missing).toEqual(expected);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 3: STREAM_KEY whitespace-only counts as missing when streaming is enabled', () => {
    fc.assert(
      fc.property(
        // A whitespace-only / empty / undefined STREAM_KEY with stream enabled
        // and Meet fully satisfied → only STREAM_KEY is reported.
        fc.oneof(blankValue, trueFlag.map(() => undefined)).filter((v) => v === undefined || v.trim().length === 0),
        (blankKey) => {
          const env = makeEnv({
            AVATAR_ENABLED: 'true',
            MEET_ENABLED: 'false',
            STREAM_ENABLED: 'true',
            STREAM_KEY: blankKey,
          });

          const result = resolveAvatarConfig(env);

          expect(result.ok).toBe(false);
          if (result.ok) {
            return;
          }
          expect(result.missing).toEqual(['STREAM_KEY']);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});
