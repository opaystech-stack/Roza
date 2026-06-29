/**
 * Property-based test for the Phase 4 avatar capability configuration resolver
 * in `config.ts` (Correctness Property 2 of the roza-step4-avatar-video
 * design).
 *
 * This exercises ONLY the side-effect-free resolver `resolveAvatarConfig`. The
 * imperative `loadConfigOrExit` wrapper is intentionally NOT called here because
 * it performs logging and `process.exit`. The property runs a minimum of 100
 * fast-check iterations.
 *
 * This file is intentionally separate from the Phase 1 `config.test.ts`, the
 * Phase 2 `config.channels.test.ts`, the Phase 3 `config.voice.test.ts`, and
 * the Phase 4 fail-fast suite so the prior property suites stay untouched.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  type AvatarPixelFormat,
  type AvatarChannelConfig,
  resolveAvatarConfig,
} from './config.js';

const NUM_RUNS = 200;

// Documented defaults applied when the corresponding optional settings are
// absent (mirrors the DEFAULT_AVATAR_* constants in config.ts).
const DEFAULTS = {
  width: 512,
  height: 512,
  fps: 25,
  pixelFormat: 'yuv420p' as AvatarPixelFormat,
  renderMs: 4000,
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

// A flag value that may or may not enable a sub-capability.
const anyFlag = fc.oneof(notTrueFlag, fc.constantFrom('true', 'TRUE', 'True', ' true '));

describe('avatar config resolution — Property 2', () => {
  // Feature: roza-step4-avatar-video, Property 2: Avatar configuration resolution from environment and defaults
  // Validates: Requirements 1.3, 2.3, 7.3, 8.1, 8.3, 10.1

  it('Property 2: disabled capability resolves ok with enabled:false REGARDLESS of any Meet/stream secret (inert)', () => {
    fc.assert(
      fc.property(
        notTrueFlag,
        // Meet/stream sub-flags and ALL their secrets free to be present or
        // blank — a disabled avatar capability must never abort.
        fc.record({
          meetEnabled: anyFlag,
          meetConsent: anyFlag,
          meetAccount: blankOrPresent,
          meetPassword: blankOrPresent,
          streamEnabled: anyFlag,
          rtmpUrl: blankOrPresent,
          streamKey: blankOrPresent,
        }),
        (flag, r) => {
          const env = makeEnv({
            AVATAR_ENABLED: flag,
            MEET_ENABLED: r.meetEnabled,
            MEET_CONSENT: r.meetConsent,
            MEET_ACCOUNT: r.meetAccount,
            MEET_PASSWORD: r.meetPassword,
            STREAM_ENABLED: r.streamEnabled,
            RTMP_URL: r.rtmpUrl,
            STREAM_KEY: r.streamKey,
          });

          const result = resolveAvatarConfig(env);

          // A disabled capability is ALWAYS ok and never aborts, even when a
          // Meet/stream secret is present or absent (Req 1.3, 8.3).
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
      fc.property(notTrueFlag, (flag) => {
        // No optional settings supplied → every documented default applies.
        const env = makeEnv({ AVATAR_ENABLED: flag });

        const result = resolveAvatarConfig(env);

        expect(result.ok).toBe(true);
        if (!result.ok) {
          return;
        }
        const { cfg } = result;
        expect(cfg.enabled).toBe(false);
        expect(cfg.video).toEqual({
          width: DEFAULTS.width,
          height: DEFAULTS.height,
          fps: DEFAULTS.fps,
          pixelFormat: DEFAULTS.pixelFormat,
        });
        expect(cfg.latency).toEqual({ renderMs: DEFAULTS.renderMs });
        expect(cfg.renderer).toEqual({ endpoint: '', engine: '' });
        expect(cfg.devices).toEqual({ camera: '', microphone: '' });
        // Sub-capabilities default disabled/inert with empty secrets.
        expect(cfg.meet).toEqual({ enabled: false, consent: false, account: '', password: '' });
        expect(cfg.stream).toEqual({ enabled: false, url: '', key: '' });
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 2: enabled with all settings present draws every field from its env var', () => {
    const pixelFormatGen = fc.constantFrom<AvatarPixelFormat>('rgba', 'yuv420p', 'nv12');

    fc.assert(
      fc.property(
        fc.record({
          width: validPositiveInt,
          height: validPositiveInt,
          fps: validPositiveInt,
          pixelFormat: pixelFormatGen,
          renderMs: validPositiveInt,
          rendererEndpoint: presentSecret,
          engine: presentSecret,
          camera: presentSecret,
          microphone: presentSecret,
          meetConsent: fc.boolean(),
          meetAccount: presentSecret,
          meetPassword: presentSecret,
          rtmpUrl: presentSecret,
          streamKey: presentSecret,
        }),
        (r) => {
          const env = makeEnv({
            AVATAR_ENABLED: 'true',
            AVATAR_WIDTH: String(r.width),
            AVATAR_HEIGHT: String(r.height),
            AVATAR_FPS: String(r.fps),
            AVATAR_PIXEL_FORMAT: r.pixelFormat,
            AVATAR_RENDER_LATENCY_MS: String(r.renderMs),
            AVATAR_RENDERER_ENDPOINT: r.rendererEndpoint,
            AVATAR_ENGINE: r.engine,
            AVATAR_CAMERA_DEVICE: r.camera,
            AVATAR_MIC_DEVICE: r.microphone,
            // Meet + stream enabled with all credentials present so the
            // capability resolves ok and every field is populated.
            MEET_ENABLED: 'true',
            MEET_CONSENT: r.meetConsent ? 'true' : 'false',
            MEET_ACCOUNT: r.meetAccount,
            MEET_PASSWORD: r.meetPassword,
            STREAM_ENABLED: 'true',
            RTMP_URL: r.rtmpUrl,
            STREAM_KEY: r.streamKey,
          });

          const result = resolveAvatarConfig(env);

          expect(result.ok).toBe(true);
          if (!result.ok) {
            return;
          }
          const { cfg } = result;
          expect(cfg.enabled).toBe(true);
          // Avatar_Video_Format fields drawn from their env vars (Req 2.3, 10.1).
          expect(cfg.video).toEqual({
            width: r.width,
            height: r.height,
            fps: r.fps,
            pixelFormat: r.pixelFormat,
          });
          // Render latency budget drawn from its env var (Req 10.1).
          expect(cfg.latency).toEqual({ renderMs: r.renderMs });
          // Renderer endpoint/engine and device names drawn from their env vars
          // (trimmed). No secret involved here.
          expect(cfg.renderer).toEqual({
            endpoint: r.rendererEndpoint.trim(),
            engine: r.engine.trim(),
          });
          expect(cfg.devices).toEqual({
            camera: r.camera.trim(),
            microphone: r.microphone.trim(),
          });
          // Meet sub-capability fields drawn from their env vars. account is
          // trimmed; password is stored verbatim (Req 8.1).
          expect(cfg.meet.enabled).toBe(true);
          expect(cfg.meet.consent).toBe(r.meetConsent);
          expect(cfg.meet.account).toBe(r.meetAccount.trim());
          expect(cfg.meet.password).toBe(r.meetPassword);
          // Stream sub-capability fields drawn from their env vars. url is
          // trimmed; key is stored verbatim (Req 7.3, 8.1).
          expect(cfg.stream.enabled).toBe(true);
          expect(cfg.stream.url).toBe(r.rtmpUrl.trim());
          expect(cfg.stream.key).toBe(r.streamKey);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 2: enabled with optional video/latency/renderer/device settings absent applies defaults', () => {
    fc.assert(
      fc.property(
        // Meet + stream both disabled so an enabled capability with no other
        // settings still resolves ok (no required secret).
        fc.record({ meetFlag: notTrueFlag, streamFlag: notTrueFlag }),
        (r) => {
          const env = makeEnv({
            AVATAR_ENABLED: 'true',
            MEET_ENABLED: r.meetFlag,
            STREAM_ENABLED: r.streamFlag,
          });

          const result = resolveAvatarConfig(env);

          expect(result.ok).toBe(true);
          if (!result.ok) {
            return;
          }
          const { cfg } = result;
          expect(cfg.enabled).toBe(true);
          // Documented defaults: 512×512, 25 fps, yuv420p, 4000 ms (Req 2.3, 10.1).
          expect(cfg.video).toEqual({
            width: DEFAULTS.width,
            height: DEFAULTS.height,
            fps: DEFAULTS.fps,
            pixelFormat: DEFAULTS.pixelFormat,
          });
          expect(cfg.latency).toEqual({ renderMs: DEFAULTS.renderMs });
          expect(cfg.renderer).toEqual({ endpoint: '', engine: '' });
          expect(cfg.devices).toEqual({ camera: '', microphone: '' });
          expect(cfg.meet.enabled).toBe(false);
          expect(cfg.stream.enabled).toBe(false);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('Property 2: each field is drawn ONLY from its corresponding env var (no cross-wiring)', () => {
    // Distinct sentinel values let us assert each config field maps to exactly
    // one env var and nothing bleeds across fields.
    const env = makeEnv({
      AVATAR_ENABLED: 'true',
      AVATAR_WIDTH: '640',
      AVATAR_HEIGHT: '480',
      AVATAR_FPS: '30',
      AVATAR_PIXEL_FORMAT: 'rgba',
      AVATAR_RENDER_LATENCY_MS: '2500',
      AVATAR_RENDERER_ENDPOINT: 'http://renderer:9000',
      AVATAR_ENGINE: 'liveportrait',
      AVATAR_CAMERA_DEVICE: '/dev/video10',
      AVATAR_MIC_DEVICE: 'roza-null-sink',
      MEET_ENABLED: 'true',
      MEET_CONSENT: 'true',
      MEET_ACCOUNT: 'secret-account',
      MEET_PASSWORD: 'secret-password',
      STREAM_ENABLED: 'true',
      RTMP_URL: 'rtmp://ingest/live',
      STREAM_KEY: 'secret-streamkey',
    });

    const result = resolveAvatarConfig(env);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const expected: AvatarChannelConfig = {
      enabled: true,
      video: { width: 640, height: 480, fps: 30, pixelFormat: 'rgba' },
      latency: { renderMs: 2500 },
      renderer: { endpoint: 'http://renderer:9000', engine: 'liveportrait' },
      devices: { camera: '/dev/video10', microphone: 'roza-null-sink' },
      meet: { enabled: true, consent: true, account: 'secret-account', password: 'secret-password' },
      stream: { enabled: true, url: 'rtmp://ingest/live', key: 'secret-streamkey' },
    };
    expect(result.cfg).toEqual(expected);
  });
});
