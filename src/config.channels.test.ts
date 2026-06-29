/**
 * Property-based tests for the Phase 2 channel configuration resolvers in
 * `config.ts` (Correctness Property 10 of the roza-step2-channels design).
 *
 * These exercise ONLY the side-effect-free resolvers — `resolveTelegramConfig`,
 * `resolveMailConfig`, `parseAllowlist`, and `parseBoolFlag`. The imperative
 * `loadConfigOrExit` wrapper is intentionally NOT called here because it
 * performs logging and `process.exit`. Each property runs a minimum of 100
 * fast-check iterations.
 *
 * This file is intentionally separate from the Phase 1 `config.test.ts` so the
 * Phase 1 property suite stays untouched.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  type MissingChannelVar,
  parseAllowlist,
  parseBoolFlag,
  resolveMailConfig,
  resolveTelegramConfig,
} from './config.js';

const NUM_RUNS = 200;

/** Build a typed env object from a plain record (values may be undefined). */
function makeEnv(record: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return record as NodeJS.ProcessEnv;
}

/** Every credential variable name that may legitimately appear in `missing`. */
const VALID_CHANNEL_VARS: ReadonlySet<MissingChannelVar> = new Set<MissingChannelVar>([
  'TELEGRAM_BOT_TOKEN',
  'MAIL_IMAP_HOST',
  'MAIL_IMAP_PORT',
  'MAIL_IMAP_USER',
  'MAIL_IMAP_PASSWORD',
  'MAIL_SMTP_HOST',
  'MAIL_SMTP_PORT',
  'MAIL_SMTP_USER',
  'MAIL_SMTP_PASSWORD',
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

// A valid positive-integer TCP port rendered as a string.
const validPort = fc.integer({ min: 1, max: 65535 }).map(String);

// A port value that resolves to "missing": blank, zero, negative, or
// non-numeric. NOTE: values like "12.5" are NOT included because
// `Number.parseInt("12.5", 10)` is 12 (a valid positive port), so the resolver
// would treat them as present.
const missingPort = fc.oneof(blankValue, fc.constantFrom('0', '-1', '-42', 'abc', '  '));

// A `*_ENABLED` flag value that is NOT the literal (case-insensitive) "true".
const notTrueFlag = fc
  .oneof(
    fc.constant(undefined),
    fc.constant(''),
    fc.constantFrom('false', 'False', 'FALSE', '0', 'no', 'yes', 'enabled', 'on'),
    fc.string()
  )
  .filter((v) => v === undefined || v.trim().toLowerCase() !== 'true');

/** Comparable sorted copy of a string list, for set equality assertions. */
function asSet(values: readonly string[]): string[] {
  return [...values].sort();
}

describe('channel config resolvers — Property 10', () => {
  // Feature: roza-step2-channels, Property 10: Channel-credential validation fails fast and names every missing variable
  // Validates: Requirements 4.2, 4.3

  it('Property 10 (Telegram): enabled + blank token fails naming TELEGRAM_BOT_TOKEN and leaks no value', () => {
    fc.assert(
      fc.property(blankValue, fc.option(fc.string(), { nil: undefined }), (token, allowlist) => {
        const env = makeEnv({
          TELEGRAM_ENABLED: 'true',
          TELEGRAM_BOT_TOKEN: token,
          TELEGRAM_ALLOWLIST: allowlist,
        });

        const result = resolveTelegramConfig(env);

        expect(result.ok).toBe(false);
        if (result.ok) {
          return;
        }
        // Names exactly the missing variable, by name only.
        expect(result.missing).toEqual(['TELEGRAM_BOT_TOKEN']);
        // The failure result carries ONLY {ok, missing} — no token value field.
        expect(Object.keys(result).sort()).toEqual(['missing', 'ok']);
        // Every reported name is a valid channel variable.
        for (const name of result.missing) {
          expect(VALID_CHANNEL_VARS.has(name)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 10 (Telegram): enabled + present token resolves ok with the trimmed token', () => {
    fc.assert(
      fc.property(presentSecret, fc.option(fc.string(), { nil: undefined }), (token, allowlist) => {
        const env = makeEnv({
          TELEGRAM_ENABLED: 'true',
          TELEGRAM_BOT_TOKEN: token,
          TELEGRAM_ALLOWLIST: allowlist,
        });

        const result = resolveTelegramConfig(env);

        expect(result.ok).toBe(true);
        if (!result.ok) {
          return;
        }
        expect(result.cfg.enabled).toBe(true);
        expect(result.cfg.botToken).toBe(token.trim());
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 10 (Telegram): disabled channel resolves ok regardless of token presence', () => {
    fc.assert(
      fc.property(notTrueFlag, blankOrPresent, (flag, token) => {
        const env = makeEnv({
          TELEGRAM_ENABLED: flag,
          TELEGRAM_BOT_TOKEN: token,
        });

        const result = resolveTelegramConfig(env);

        expect(result.ok).toBe(true);
        if (!result.ok) {
          return;
        }
        expect(result.cfg.enabled).toBe(false);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  // The eight Mail credential variables, in resolver order, tagged for ports.
  const MAIL_VARS: ReadonlyArray<{ name: MissingChannelVar; port: boolean }> = [
    { name: 'MAIL_IMAP_HOST', port: false },
    { name: 'MAIL_IMAP_PORT', port: true },
    { name: 'MAIL_IMAP_USER', port: false },
    { name: 'MAIL_IMAP_PASSWORD', port: false },
    { name: 'MAIL_SMTP_HOST', port: false },
    { name: 'MAIL_SMTP_PORT', port: true },
    { name: 'MAIL_SMTP_USER', port: false },
    { name: 'MAIL_SMTP_PASSWORD', port: false },
  ];

  /** Per-variable state: present (with a value) or missing (blank/garbage). */
  type VarState = { present: boolean; value: string | undefined };
  const varStateGen = (port: boolean): fc.Arbitrary<VarState> =>
    fc.oneof(
      (port ? validPort : presentSecret).map((value) => ({ present: true, value })),
      (port ? missingPort : blankValue).map((value) => ({ present: false, value: value ?? undefined }))
    );

  // Eight independent variable states with AT LEAST ONE missing (so the channel
  // is enabled and resolution must fail).
  const someMissingMailStates = fc
    .tuple(
      varStateGen(false),
      varStateGen(true),
      varStateGen(false),
      varStateGen(false),
      varStateGen(false),
      varStateGen(true),
      varStateGen(false),
      varStateGen(false)
    )
    .filter((states) => states.some((s) => !s.present));

  // Eight variable states that are ALL present (so resolution succeeds).
  const allPresentMailStates = fc.tuple(
    presentSecret,
    validPort,
    presentSecret,
    presentSecret,
    presentSecret,
    validPort,
    presentSecret,
    presentSecret
  );

  // `enabled` is a required parameter: relying on a default value would be
  // defeated by JS default-parameter semantics when an `undefined` flag is
  // passed (the disabled-channel case), silently re-enabling the channel.
  function buildMailEnv(states: readonly VarState[], enabled: string | undefined): NodeJS.ProcessEnv {
    return makeEnv({
      MAIL_ENABLED: enabled,
      MAIL_IMAP_HOST: states[0]!.value,
      MAIL_IMAP_PORT: states[1]!.value,
      MAIL_IMAP_USER: states[2]!.value,
      MAIL_IMAP_PASSWORD: states[3]!.value,
      MAIL_SMTP_HOST: states[4]!.value,
      MAIL_SMTP_PORT: states[5]!.value,
      MAIL_SMTP_USER: states[6]!.value,
      MAIL_SMTP_PASSWORD: states[7]!.value,
    });
  }

  it('Property 10 (Mail): enabled fails listing EXACTLY the blank variables and leaks no value', () => {
    fc.assert(
      fc.property(someMissingMailStates, (states) => {
        const env = buildMailEnv(states, 'true');

        const expectedMissing = MAIL_VARS.filter((_, i) => !states[i]!.present).map((v) => v.name);
        const presentValues = states
          .filter((s) => s.present && s.value !== undefined)
          .map((s) => s.value as string);

        const result = resolveMailConfig(env);

        expect(result.ok).toBe(false);
        if (result.ok) {
          return;
        }
        // Names EXACTLY the blank variables (compared as sets — order-free).
        expect(asSet(result.missing)).toEqual(asSet(expectedMissing));
        // The failure result carries ONLY {ok, missing}.
        expect(Object.keys(result).sort()).toEqual(['missing', 'ok']);
        // Every reported name is a valid channel variable, never a value.
        for (const name of result.missing) {
          expect(VALID_CHANNEL_VARS.has(name)).toBe(true);
        }
        // No present credential value appears anywhere in the failure result.
        const serialized = JSON.stringify(result);
        for (const value of presentValues) {
          expect(result.missing as string[]).not.toContain(value);
          expect(serialized.includes(value)).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 10 (Mail): enabled with every credential present resolves ok', () => {
    fc.assert(
      fc.property(allPresentMailStates, (values) => {
        const states: VarState[] = values.map((value) => ({ present: true, value }));
        const env = buildMailEnv(states, 'true');

        const result = resolveMailConfig(env);

        expect(result.ok).toBe(true);
        if (!result.ok) {
          return;
        }
        expect(result.cfg.enabled).toBe(true);
        expect(result.cfg.imap.port).toBeGreaterThan(0);
        expect(result.cfg.smtp.port).toBeGreaterThan(0);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 10 (Mail): disabled channel resolves ok regardless of credential presence', () => {
    fc.assert(
      fc.property(
        notTrueFlag,
        fc.tuple(
          blankOrPresent,
          fc.oneof(blankValue, validPort),
          blankOrPresent,
          blankOrPresent,
          blankOrPresent,
          fc.oneof(blankValue, validPort),
          blankOrPresent,
          blankOrPresent
        ),
        (flag, raw) => {
          const states: VarState[] = raw.map((value) => ({ present: false, value: value ?? undefined }));
          const env = buildMailEnv(states, flag);

          const result = resolveMailConfig(env);

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
});

describe('allowlist and boolean flag parsing', () => {
  it('parseAllowlist splits on commas, trims entries, and drops empties', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 6 }), { maxLength: 12 }), (parts) => {
        const raw = parts.join(',');
        const expected = raw
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);

        const result = parseAllowlist(raw);

        expect(result).toEqual(expected);
        for (const entry of result) {
          // Each surviving entry is already trimmed and non-empty.
          expect(entry).toBe(entry.trim());
          expect(entry.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('parseAllowlist returns an empty array for undefined input', () => {
    expect(parseAllowlist(undefined)).toEqual([]);
  });

  it('parseBoolFlag treats only case-insensitive trimmed "true" as true', () => {
    const flagValue = fc.oneof(
      fc.constant(undefined),
      fc.constantFrom('true', 'TRUE', 'True', 'tRuE', '  true  ', 'false', '1', 'yes', 'on', ''),
      fc.string()
    );

    fc.assert(
      fc.property(flagValue, (raw) => {
        const expected = raw !== undefined && raw.trim().toLowerCase() === 'true';
        expect(parseBoolFlag(raw)).toBe(expected);
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
