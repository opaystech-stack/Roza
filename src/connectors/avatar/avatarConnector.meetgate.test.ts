// Feature: roza-step4-avatar-video, Property 9: Meet join requires enablement, recorded consent, and credentials
//
// Validates: Requirements 6.2, 6.4
//
// Property 9 pins down the Meet-join gate of the Avatar_Connector I/O shell
// (`createAvatarConnector(...).joinMeet(meetUrl)`). Joining a Google Meet is a
// privileged, ToS-fragile, credential-bearing action, so it is allowed to reach
// the swappable `MeetSession.join` adapter EXACTLY when the full conjunction of
// gates holds:
//
//   avatar.enabled                         (base capability — Req 1.4)
//   AND avatar.meet.enabled                (Meet sub-capability — Req 6.2)
//   AND avatar.meet.consent === true       (recorded operator consent — Req 6.4)
//   AND Meet_Credentials both non-blank    (account AND password — Req 6.2)
//
// In EVERY other combination of those gating inputs, `joinMeet` must return an
// `{ ok: false }` verdict and must NEVER invoke `meet.join` — no browser is
// driven, no credentials are handed out, no appearance is made. This test drives
// the real connector against an in-memory fake `MeetSession` (spying on
// join/mute/leave) and generates the four gating booleans plus blank/present
// credential values independently, asserting the join spy's call count equals
// the conjunction exactly. No real browser, GPU, or network runs.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { createAvatarConnector, type AvatarConnectorDeps } from './avatarConnector.js';
import type { MeetSession, MeetCredentials } from './meetSession.js';
import type { AvatarRenderer, RenderResult } from './renderer.js';
import type { VirtualCamera } from './virtualCamera.js';
import type { VirtualMicrophone } from './virtualMicrophone.js';
import type { AudioChunk } from '../voice/audio.js';
import type {
  RozaConfig,
  AvatarChannelConfig,
  AvatarPixelFormat,
} from '../../config.js';
import type { Logger } from '../../types.js';

/** Minimum fast-check iterations mandated by the design for every property. */
const NUM_RUNS = 100;

// ───────────────────────────────────────────────────────────────────────────
// In-memory fakes — no real browser, GPU, device, or network (Req 12.5).
// ───────────────────────────────────────────────────────────────────────────

/**
 * A fake {@link MeetSession} that records every `join`/`mute`/`leave` call so the
 * test can assert whether — and with what arguments — the Meet adapter was ever
 * reached. `join` resolves successfully (the gate, not the adapter, is under
 * test); the captured credentials let us confirm the connector forwards the
 * configured `Meet_Credentials` only when every gate passes.
 */
interface FakeMeetSession extends MeetSession {
  joinCalls: { meetUrl: string; creds: MeetCredentials }[];
  muteCalls: number;
  leaveCalls: number;
}

function makeFakeMeetSession(): FakeMeetSession {
  const session: FakeMeetSession = {
    descriptor: { backend: 'playwright', license: 'Apache-2.0' },
    joinCalls: [],
    muteCalls: 0,
    leaveCalls: 0,
    async join(meetUrl: string, creds: MeetCredentials): Promise<void> {
      session.joinCalls.push({ meetUrl, creds });
    },
    async mute(): Promise<void> {
      session.muteCalls += 1;
    },
    async leave(): Promise<void> {
      session.leaveCalls += 1;
    },
  };
  return session;
}

/** A minimal renderer fake; never exercised by the Meet-join gate. */
const fakeRenderer: AvatarRenderer = {
  descriptor: { engine: 'fake', license: 'MIT' },
  render(): Promise<RenderResult> {
    return Promise.reject(new Error('renderer must not be called by joinMeet'));
  },
};

/** A minimal camera fake; never exercised by the Meet-join gate. */
const fakeCamera: VirtualCamera = {
  descriptor: { device: 'fake-cam', backend: 'fake', license: 'MIT' },
  open: () => Promise.resolve(),
  write: () => Promise.resolve(),
  close: () => Promise.resolve(),
};

/** A minimal microphone fake; never exercised by the Meet-join gate. */
const fakeMicrophone: VirtualMicrophone = {
  descriptor: { device: 'fake-mic', backend: 'fake', license: 'MIT' },
  open: () => Promise.resolve(),
  write: () => Promise.resolve(),
  close: () => Promise.resolve(),
};

/** A silent logger so the property run produces no console noise. */
const silentLogger: Logger = {
  info: () => undefined,
  error: () => undefined,
};

// ───────────────────────────────────────────────────────────────────────────
// Generators — the four gating booleans + blank/present credentials, varied
// independently so every combination of the gate inputs is explored.
// ───────────────────────────────────────────────────────────────────────────

const pixelFormatArb: fc.Arbitrary<AvatarPixelFormat> = fc.constantFrom(
  'rgba' as const,
  'yuv420p' as const,
  'nv12' as const,
);

/**
 * Blank-or-present credential string. Blank values (undefined, empty,
 * whitespace-only) must be treated as missing by the gate; present values are
 * non-blank text. Generated independently for the account and the password.
 */
const credentialArb: fc.Arbitrary<string> = fc.oneof(
  // Blank variants — must count as missing.
  fc.constantFrom('', ' ', '   ', '\t', '\n', ' \t '),
  // Present variants — non-blank, must count as present.
  fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
);

/** A meeting URL the operator might pass in (untrusted data — never executed). */
const meetUrlArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    'https://meet.google.com/abc-defg-hij',
    'https://meet.google.com/xyz-1234-567',
    'not-a-url',
    '',
  ),
  fc.webUrl(),
);

/**
 * Build a fully-resolved `RozaConfig` whose only varied fields are the four Meet
 * gating inputs (avatar.enabled, meet.enabled, meet.consent) plus the
 * account/password credentials. Every other field is well-formed and fixed so
 * the gate depends solely on the inputs under test.
 */
function makeConfig(opts: {
  avatarEnabled: boolean;
  meetEnabled: boolean;
  consent: boolean;
  account: string;
  password: string;
  pixelFormat: AvatarPixelFormat;
}): RozaConfig {
  const avatar: AvatarChannelConfig = {
    enabled: opts.avatarEnabled,
    video: { width: 512, height: 512, fps: 25, pixelFormat: opts.pixelFormat },
    latency: { renderMs: 4000 },
    renderer: { endpoint: 'http://localhost:9000', engine: 'fake' },
    devices: { camera: 'roza_virtcam', microphone: 'roza_virtmic' },
    meet: {
      enabled: opts.meetEnabled,
      consent: opts.consent,
      account: opts.account,
      password: opts.password,
    },
    stream: { enabled: false, url: '', key: '' },
  };

  return {
    rozaPrivateKey: 'test-private-key',
    openRouterApiKey: 'test-api-key',
    openRouterModel: 'openai/gpt-4o-mini',
    dataDir: '/tmp/roza-test',
    timezone: 'Africa/Kinshasa',
    activeWindow: { startMinutes: 420, endMinutes: 1320 },
    keyVersion: 'v1',
    telegram: { enabled: false, botToken: '', allowlist: [] },
    mail: {
      enabled: false,
      imap: { host: '', port: 0, user: '', password: '' },
      smtp: { host: '', port: 0, user: '', password: '' },
      allowlist: [],
    },
    voice: {
      enabled: false,
      sip: { host: '', port: 0, user: '', password: '', realm: '' },
      allowlist: [],
      defaultAccess: 'reject',
      quietHoursInbound: 'take_message',
      tts: { engine: 'piper', voice: 'en_US-amy-medium', model: 'en_US-amy-medium' },
      stt: { engine: 'whisper.cpp', model: 'ggml-base.en' },
      maxReplyChars: 1000,
      latency: { ttsMs: 5000, sttMs: 5000, endToEndMs: 8000, ringTimeoutMs: 30000 },
    },
    avatar,
    x: {
      enabled: false,
      credentials: { username: '', password: '' },
      storageStatePath: '',
      autonomyIntervalMinutes: 60,
      rateLimit: { dailyPostLimit: 10, actionSpacingMs: 600000 },
      maxTopics: 3,
      maxPostChars: 280,
      dryRun: false,
    },
  };
}

/** Build the connector deps over the fakes for a given config + Meet session. */
function makeDeps(cfg: RozaConfig, meet: MeetSession): AvatarConnectorDeps {
  return {
    renderer: fakeRenderer,
    camera: fakeCamera,
    microphone: fakeMicrophone,
    meet,
    cfg,
    avatarImage: () => new Uint8Array(0),
    now: () => new Date('2025-01-01T00:00:00.000Z'),
    logger: silentLogger,
    audioOnlyDeliver: (_audio: AudioChunk) => Promise.resolve(),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Property 9.
// ───────────────────────────────────────────────────────────────────────────

describe('Meet join requires enablement, recorded consent, and credentials (Property 9)', () => {
  // Feature: roza-step4-avatar-video, Property 9: Meet join requires enablement, recorded consent, and credentials
  // Validates: Requirements 6.2, 6.4
  it('invokes meet.join IFF (avatar enabled AND meet enabled AND consent===true AND both credentials non-blank), else returns { ok:false } and never calls meet.join', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(), // avatar.enabled
        fc.boolean(), // meet.enabled
        fc.boolean(), // meet.consent
        credentialArb, // account (blank or present)
        credentialArb, // password (blank or present)
        pixelFormatArb,
        meetUrlArb,
        async (avatarEnabled, meetEnabled, consent, account, password, pixelFormat, meetUrl) => {
          const cfg = makeConfig({
            avatarEnabled,
            meetEnabled,
            consent,
            account,
            password,
            pixelFormat,
          });
          const meet = makeFakeMeetSession();
          const connector = createAvatarConnector(makeDeps(cfg, meet));

          const result = await connector.joinMeet(meetUrl);

          // The exact conjunction the gate must enforce (Req 6.2, 6.4). A blank
          // credential is undefined/empty/whitespace-only.
          const accountPresent = account.trim().length > 0;
          const passwordPresent = password.trim().length > 0;
          const shouldJoin =
            avatarEnabled && meetEnabled && consent === true && accountPresent && passwordPresent;

          // The join spy is reached EXACTLY when the full conjunction holds.
          expect(meet.joinCalls.length).toBe(shouldJoin ? 1 : 0);

          if (shouldJoin) {
            // Success path: ok verdict and the configured (non-blank)
            // Meet_Credentials forwarded verbatim to the adapter, with the
            // untrusted meetUrl passed only as the navigation argument.
            expect(result.ok).toBe(true);
            const call = meet.joinCalls[0];
            expect(call).toBeDefined();
            expect(call?.meetUrl).toBe(meetUrl);
            expect(call?.creds).toEqual({ account, password });
          } else {
            // Every rejecting combination: ok:false and the adapter untouched.
            expect(result.ok).toBe(false);
            expect(meet.joinCalls.length).toBe(0);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
