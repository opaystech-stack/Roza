/**
 * Property-based tests for the Phase 3 voice channel configuration resolver in
 * `config.ts` (Correctness Properties 2 and 3 of the roza-step3-voice-telephony
 * design).
 *
 * These exercise ONLY the side-effect-free resolver `resolveVoiceConfig`. The
 * imperative `loadConfigOrExit` wrapper is intentionally NOT called here because
 * it performs logging and `process.exit`. Each property runs a minimum of 100
 * fast-check iterations.
 *
 * This file is intentionally separate from the Phase 1 `config.test.ts` and the
 * Phase 2 `config.channels.test.ts` so the prior property suites stay untouched.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  type MissingVoiceVar,
  type QuietHoursInboundPolicy,
  type VoiceDefaultAccess,
  resolveVoiceConfig,
} from './config.js';

const NUM_RUNS = 200;

// Documented defaults applied when the corresponding optional settings are
// absent (mirrors the DEFAULT_* constants in config.ts).
const DEFAULTS = {
  ttsEngine: 'piper',
  ttsVoice: 'en_US-amy-medium',
  ttsModel: 'en_US-amy-medium',
  sttEngine: 'whisper.cpp',
  sttModel: 'ggml-base.en',
  maxReplyChars: 1000,
  ttsMs: 5000,
  sttMs: 5000,
  endToEndMs: 8000,
  ringTimeoutMs: 30000,
  defaultAccess: 'reject' as VoiceDefaultAccess,
  quietHoursInbound: 'take_message' as QuietHoursInboundPolicy,
} as const;

/** Build a typed env object from a plain record (values may be undefined). */
function makeEnv(record: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return record as NodeJS.ProcessEnv;
}

/** Every SIP credential variable name that may legitimately appear in `missing`. */
const VALID_VOICE_VARS: ReadonlySet<MissingVoiceVar> = new Set<MissingVoiceVar>([
  'SIP_HOST',
  'SIP_PORT',
  'SIP_USER',
  'SIP_PASSWORD',
  'SIP_REALM',
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

// A `VOICE_ENABLED` flag value that is NOT the literal (case-insensitive,
// trimmed) "true" — i.e. the disabled-channel case.
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

describe('voice config resolution — Property 2', () => {
  // Feature: roza-step3-voice-telephony, Property 2: Voice configuration resolution from environment and defaults
  // Validates: Requirements 2.3, 7.1, 7.3, 10.4, 12.2

  it('Property 2: disabled channel resolves ok with enabled:false regardless of SIP presence (inert)', () => {
    fc.assert(
      fc.property(
        notTrueFlag,
        // All five SIP variables free to be present or blank — none of it matters.
        fc.tuple(blankOrPresent, fc.oneof(blankValue, validPort), blankOrPresent, blankOrPresent, blankOrPresent),
        (flag, [host, port, user, password, realm]) => {
          const env = makeEnv({
            VOICE_ENABLED: flag,
            SIP_HOST: host,
            SIP_PORT: port,
            SIP_USER: user,
            SIP_PASSWORD: password,
            SIP_REALM: realm,
          });

          const result = resolveVoiceConfig(env);

          // A disabled channel is always ok and never aborts (Req 7.1, 7.3).
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

  it('Property 2: disabled channel applies documented defaults for all optional settings', () => {
    fc.assert(
      fc.property(notTrueFlag, (flag) => {
        // No optional settings supplied → every documented default applies.
        const env = makeEnv({ VOICE_ENABLED: flag });

        const result = resolveVoiceConfig(env);

        expect(result.ok).toBe(true);
        if (!result.ok) {
          return;
        }
        const { cfg } = result;
        expect(cfg.enabled).toBe(false);
        expect(cfg.tts).toEqual({
          engine: DEFAULTS.ttsEngine,
          voice: DEFAULTS.ttsVoice,
          model: DEFAULTS.ttsModel,
        });
        expect(cfg.stt).toEqual({ engine: DEFAULTS.sttEngine, model: DEFAULTS.sttModel });
        expect(cfg.maxReplyChars).toBe(DEFAULTS.maxReplyChars);
        expect(cfg.latency).toEqual({
          ttsMs: DEFAULTS.ttsMs,
          sttMs: DEFAULTS.sttMs,
          endToEndMs: DEFAULTS.endToEndMs,
          ringTimeoutMs: DEFAULTS.ringTimeoutMs,
        });
        expect(cfg.defaultAccess).toBe(DEFAULTS.defaultAccess);
        expect(cfg.quietHoursInbound).toBe(DEFAULTS.quietHoursInbound);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 2: enabled with all SIP vars present draws every field from the env vars', () => {
    const accessGen = fc.constantFrom<VoiceDefaultAccess>('reject', 'allow');
    const quietGen = fc.constantFrom<QuietHoursInboundPolicy>('reject', 'answer_busy', 'take_message');

    fc.assert(
      fc.property(
        fc.record({
          host: presentSecret,
          port: fc.integer({ min: 1, max: 65535 }),
          user: presentSecret,
          password: presentSecret,
          realm: presentSecret,
          // Comma-free, already-trimmed entries so VOICE_ALLOWLIST round-trips
          // through parseAllowlist (split-on-comma + trim) verbatim.
          allowlistEntries: fc.array(
            fc
              .string({ minLength: 1 })
              .map((s) => `id-${s}`)
              .map((s) => s.replace(/[,\s]/g, '_')),
            { minLength: 0, maxLength: 5 }
          ),
          access: accessGen,
          quiet: quietGen,
          ttsEngine: presentSecret,
          ttsVoice: presentSecret,
          ttsModel: presentSecret,
          sttEngine: presentSecret,
          sttModel: presentSecret,
          maxReplyChars: fc.integer({ min: 1, max: 100000 }),
          ttsMs: fc.integer({ min: 1, max: 100000 }),
          sttMs: fc.integer({ min: 1, max: 100000 }),
          endToEndMs: fc.integer({ min: 1, max: 100000 }),
          ringTimeoutMs: fc.integer({ min: 1, max: 100000 }),
        }),
        (r) => {
          const env = makeEnv({
            VOICE_ENABLED: 'true',
            SIP_HOST: r.host,
            SIP_PORT: String(r.port),
            SIP_USER: r.user,
            SIP_PASSWORD: r.password,
            SIP_REALM: r.realm,
            VOICE_ALLOWLIST: r.allowlistEntries.join(','),
            VOICE_DEFAULT_ACCESS: r.access,
            VOICE_QUIET_HOURS_INBOUND: r.quiet,
            TTS_ENGINE: r.ttsEngine,
            TTS_VOICE: r.ttsVoice,
            TTS_MODEL: r.ttsModel,
            STT_ENGINE: r.sttEngine,
            STT_MODEL: r.sttModel,
            TTS_MAX_REPLY_CHARS: String(r.maxReplyChars),
            TTS_LATENCY_MS: String(r.ttsMs),
            STT_LATENCY_MS: String(r.sttMs),
            VOICE_RESPONSE_LATENCY_MS: String(r.endToEndMs),
            VOICE_RING_TIMEOUT_MS: String(r.ringTimeoutMs),
          });

          const result = resolveVoiceConfig(env);

          expect(result.ok).toBe(true);
          if (!result.ok) {
            return;
          }
          const { cfg } = result;
          expect(cfg.enabled).toBe(true);
          // Every SIP field drawn from its env var. host/user/realm are trimmed
          // by the resolver; password is stored verbatim.
          expect(cfg.sip.host).toBe(r.host.trim());
          expect(cfg.sip.port).toBe(r.port);
          expect(cfg.sip.user).toBe(r.user.trim());
          expect(cfg.sip.password).toBe(r.password);
          expect(cfg.sip.realm).toBe(r.realm.trim());
          // Allowlist parsed from VOICE_ALLOWLIST (Req 10.4).
          expect(cfg.allowlist).toEqual(r.allowlistEntries);
          expect(cfg.defaultAccess).toBe(r.access);
          expect(cfg.quietHoursInbound).toBe(r.quiet);
          // Engine/voice/model fields drawn from their env vars (trimmed).
          expect(cfg.tts).toEqual({
            engine: r.ttsEngine.trim(),
            voice: r.ttsVoice.trim(),
            model: r.ttsModel.trim(),
          });
          expect(cfg.stt).toEqual({ engine: r.sttEngine.trim(), model: r.sttModel.trim() });
          // Numeric settings drawn from their env vars.
          expect(cfg.maxReplyChars).toBe(r.maxReplyChars);
          expect(cfg.latency).toEqual({
            ttsMs: r.ttsMs,
            sttMs: r.sttMs,
            endToEndMs: r.endToEndMs,
            ringTimeoutMs: r.ringTimeoutMs,
          });
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 2: enabled with all SIP vars present but optional settings absent applies defaults', () => {
    fc.assert(
      fc.property(
        fc.record({
          host: presentSecret,
          port: validPort,
          user: presentSecret,
          password: presentSecret,
          realm: presentSecret,
        }),
        (sip) => {
          const env = makeEnv({
            VOICE_ENABLED: 'true',
            SIP_HOST: sip.host,
            SIP_PORT: sip.port,
            SIP_USER: sip.user,
            SIP_PASSWORD: sip.password,
            SIP_REALM: sip.realm,
          });

          const result = resolveVoiceConfig(env);

          expect(result.ok).toBe(true);
          if (!result.ok) {
            return;
          }
          const { cfg } = result;
          expect(cfg.enabled).toBe(true);
          expect(cfg.allowlist).toEqual([]);
          expect(cfg.tts).toEqual({
            engine: DEFAULTS.ttsEngine,
            voice: DEFAULTS.ttsVoice,
            model: DEFAULTS.ttsModel,
          });
          expect(cfg.stt).toEqual({ engine: DEFAULTS.sttEngine, model: DEFAULTS.sttModel });
          expect(cfg.maxReplyChars).toBe(DEFAULTS.maxReplyChars);
          expect(cfg.latency).toEqual({
            ttsMs: DEFAULTS.ttsMs,
            sttMs: DEFAULTS.sttMs,
            endToEndMs: DEFAULTS.endToEndMs,
            ringTimeoutMs: DEFAULTS.ringTimeoutMs,
          });
          expect(cfg.defaultAccess).toBe(DEFAULTS.defaultAccess);
          expect(cfg.quietHoursInbound).toBe(DEFAULTS.quietHoursInbound);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});

describe('voice config fail-fast — Property 3', () => {
  // Feature: roza-step3-voice-telephony, Property 3: Enabled-voice credential fail-fast names every missing variable
  // Validates: Requirements 7.2, 14.4

  // The five SIP credential variables, in resolver order, tagged for ports.
  const SIP_VARS: ReadonlyArray<{ name: MissingVoiceVar; port: boolean }> = [
    { name: 'SIP_HOST', port: false },
    { name: 'SIP_PORT', port: true },
    { name: 'SIP_USER', port: false },
    { name: 'SIP_PASSWORD', port: false },
    { name: 'SIP_REALM', port: false },
  ];

  /** Per-variable state: present (with a value) or missing (blank/garbage). */
  type VarState = { present: boolean; value: string | undefined };
  const varStateGen = (port: boolean): fc.Arbitrary<VarState> =>
    fc.oneof(
      (port ? validPort : presentSecret).map((value) => ({ present: true, value })),
      (port ? missingPort : blankValue).map((value) => ({ present: false, value: value ?? undefined }))
    );

  // Five independent variable states with AT LEAST ONE missing (so resolution
  // must fail), corresponding to a non-empty subset of offending variables.
  const someMissingSipStates = fc
    .tuple(varStateGen(false), varStateGen(true), varStateGen(false), varStateGen(false), varStateGen(false))
    .filter((states) => states.some((s) => !s.present));

  function buildVoiceEnv(states: readonly VarState[]): NodeJS.ProcessEnv {
    return makeEnv({
      VOICE_ENABLED: 'true',
      SIP_HOST: states[0]!.value,
      SIP_PORT: states[1]!.value,
      SIP_USER: states[2]!.value,
      SIP_PASSWORD: states[3]!.value,
      SIP_REALM: states[4]!.value,
    });
  }

  it('Property 3: enabled fails listing EXACTLY the offending variables and leaks no value', () => {
    fc.assert(
      fc.property(someMissingSipStates, (states) => {
        const env = buildVoiceEnv(states);

        const expectedMissing = SIP_VARS.filter((_, i) => !states[i]!.present).map((v) => v.name);
        const presentValues = states
          .filter((s) => s.present && s.value !== undefined)
          .map((s) => s.value as string);

        const result = resolveVoiceConfig(env);

        expect(result.ok).toBe(false);
        if (result.ok) {
          return;
        }
        // The `missing` set is EXACTLY the offending variables (order-free).
        expect(asSet(result.missing)).toEqual(asSet(expectedMissing));
        // The failure result carries ONLY {ok, missing} — no credential field.
        expect(Object.keys(result).sort()).toEqual(['missing', 'ok']);
        // Every reported name is a valid SIP variable name, never a value.
        for (const name of result.missing) {
          expect(VALID_VOICE_VARS.has(name)).toBe(true);
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

  it('Property 3: each single missing variable is named in isolation', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4 }), (missingIndex) => {
        // All present except the one at `missingIndex`.
        const env = makeEnv({
          VOICE_ENABLED: 'true',
          SIP_HOST: missingIndex === 0 ? '   ' : 'secret-host',
          SIP_PORT: missingIndex === 1 ? '0' : '5060',
          SIP_USER: missingIndex === 2 ? '' : 'secret-user',
          SIP_PASSWORD: missingIndex === 3 ? undefined : 'secret-pass',
          SIP_REALM: missingIndex === 4 ? '\t' : 'secret-realm',
        });

        const result = resolveVoiceConfig(env);

        expect(result.ok).toBe(false);
        if (result.ok) {
          return;
        }
        expect(result.missing).toEqual([SIP_VARS[missingIndex]!.name]);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 3: SIP_PORT counts as missing when not a positive integer', () => {
    fc.assert(
      fc.property(missingPort, (port) => {
        const env = makeEnv({
          VOICE_ENABLED: 'true',
          SIP_HOST: 'secret-host',
          SIP_PORT: port,
          SIP_USER: 'secret-user',
          SIP_PASSWORD: 'secret-pass',
          SIP_REALM: 'secret-realm',
        });

        const result = resolveVoiceConfig(env);

        expect(result.ok).toBe(false);
        if (result.ok) {
          return;
        }
        expect(result.missing).toEqual(['SIP_PORT']);
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
