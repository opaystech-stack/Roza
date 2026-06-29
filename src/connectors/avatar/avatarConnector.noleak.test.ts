// Feature: roza-step4-avatar-video, Property 4: Secrets and private state never leak through the avatar pipeline
//
// Validates: Requirements 8.4, 8.5, 8.6, 7.4
//
// Property 4 drives `createAvatarConnector` (the I/O shell) with in-memory
// FAKES for every injected interface (renderer / camera / microphone / meet /
// stream / audit repo) plus a SPY logger, and asserts that a set of distinctive
// sentinel secrets — the `Meet_Credentials` (account/password), the
// `Stream_Key`, and a simulated private-journal value carried in the
// Avatar_Image — NEVER leak through any observable surface:
//
//   - NO log line (every spy-logger info + error call, message + meta
//     serialized) contains a secret (Req 8.4).
//   - NO surfaced error / returned `reason` contains a secret (Req 8.4).
//   - NO persisted `avatar_sessions` audit row's `target` is ever a credential:
//     it is only ever `null` (a bare render) or a meet/RTMP URL (Req 8.5, 7.4).
//   - NO value handed to the fake Virtual_Camera (frames), Virtual_Microphone
//     (audio), the audio-only fallback delivery, the `meetUrl` navigation
//     target, or the RTMP base URL contains a secret (Req 8.6).
//
// The ONLY two places a secret may legitimately appear are the dedicated secret
// parameters of their adapter — `MeetSession.join(meetUrl, creds)`'s `creds`
// and `StreamSession.start({ url, key }, …)`'s `key` — and the test proves the
// secrets travel ONLY there (the credentials/key are passed through verbatim to
// their adapter and appear in no other sink). The renderer legitimately
// receives the Avatar_Image + reply audio and is therefore not a leak surface.
//
// Both the success and the failure paths are exercised (fake adapters that
// throw on render / device-write / Meet-join / stream-start) so the
// degradation/error logging paths are scanned too. No real GPU, browser, RTMP
// endpoint, or v4l2/PipeWire device runs — every edge is an in-memory fake.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { createAvatarConnector } from './avatarConnector.js';
import type { RozaConfig, AvatarChannelConfig, AvatarPixelFormat } from '../../config.js';
import { type AudioChunk, TELEPHONY_PCM_16K } from '../voice/audio.js';
import type { AvatarRenderer, RenderRequest, RenderResult } from './renderer.js';
import type { VirtualCamera } from './virtualCamera.js';
import type { VirtualMicrophone } from './virtualMicrophone.js';
import type { MeetSession, MeetCredentials } from './meetSession.js';
import type { StreamSession, StreamTarget } from './streamSession.js';
import type { AvatarStream, AvatarVideoFormat } from './avatarFormat.js';
import type {
  Repository,
  AvatarSession,
  AvatarSessionKind,
  AvatarOutcome,
} from '../../repository.js';
import type { Logger } from '../../types.js';

/** Minimum fast-check iterations mandated by the design for every property. */
const NUM_RUNS = 100;

/** A logged call captured by the spy logger. */
interface LogCall {
  level: 'info' | 'error';
  message: string;
  meta: Record<string, unknown> | undefined;
}

/** Decode arbitrary bytes losslessly so an ASCII sentinel is found if present. */
function bytesToString(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

/** Serialize a log call (message + meta) into a single scannable string. */
function serializeLog(call: LogCall): string {
  let metaStr: string;
  try {
    metaStr = JSON.stringify(call.meta ?? {}, (_k, v) =>
      v instanceof Error ? `${v.name}: ${v.message}` : (v as unknown),
    );
  } catch {
    metaStr = String(call.meta);
  }
  return `${call.level} ${call.message} ${metaStr}`;
}

/** Assert that none of the forbidden sentinels appear in `haystack`. */
function assertNoSecret(haystack: string, forbidden: string[], where: string): void {
  for (const secret of forbidden) {
    expect(
      haystack.includes(secret),
      `${where} leaked a secret value (substring match)`,
    ).toBe(false);
  }
}

const pixelFormatArb: fc.Arbitrary<AvatarPixelFormat> = fc.constantFrom(
  'rgba' as const,
  'yuv420p' as const,
  'nv12' as const,
);

/** A distinctive, collision-free random token for building sentinel secrets. */
const tokenArb = fc.hexaString({ minLength: 8, maxLength: 16 });

/**
 * Build a fully-resolved `RozaConfig` with the avatar capability + both Meet and
 * stream sub-capabilities ENABLED (so the gates pass and the secrets actually
 * flow), seeding the secret-bearing fields with the supplied sentinels and a
 * non-secret RTMP base URL.
 */
function makeConfig(opts: {
  account: string;
  password: string;
  streamKey: string;
  rtmpUrl: string;
  pixelFormat: AvatarPixelFormat;
}): RozaConfig {
  const avatar: AvatarChannelConfig = {
    enabled: true,
    video: { width: 320, height: 240, fps: 25, pixelFormat: opts.pixelFormat },
    latency: { renderMs: 4000 },
    renderer: { endpoint: 'http://renderer.local/render', engine: 'liveportrait' },
    devices: { camera: 'roza_cam', microphone: 'roza_mic' },
    meet: { enabled: true, consent: true, account: opts.account, password: opts.password },
    stream: { enabled: true, url: opts.rtmpUrl, key: opts.streamKey },
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
  };
}

describe('Secrets and private state never leak through the avatar pipeline (Property 4)', () => {
  // Feature: roza-step4-avatar-video, Property 4: Secrets and private state never leak through the avatar pipeline
  // Validates: Requirements 8.4, 8.5, 8.6, 7.4
  it('never surfaces credentials/keys/journal values in logs, errors, audit rows, or device/session sinks', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          tokens: fc.tuple(tokenArb, tokenArb, tokenArb, tokenArb),
          meetToken: tokenArb,
          rtmpToken: tokenArb,
          pixelFormat: pixelFormatArb,
          startCameraFails: fc.boolean(),
          renderFails: fc.boolean(),
          presentWriteFails: fc.boolean(),
          meetFails: fc.boolean(),
          streamFails: fc.boolean(),
        }),
        async (scenario) => {
          const [tA, tP, tK, tJ] = scenario.tokens;

          // Distinctive sentinel secrets so substring scans are meaningful.
          const accountSecret = `SECRET-ACCOUNT-${tA}`;
          const passwordSecret = `SECRET-PASSWORD-${tP}`;
          const streamKeySecret = `SECRET-KEY-${tK}`;
          // A simulated private-journal value carried as private state in the
          // Avatar_Image bytes — it must never escape the renderer boundary.
          const journalSecret = `SECRET-JOURNAL-${tJ}`;

          const forbidden = [accountSecret, passwordSecret, streamKeySecret, journalSecret];

          // Non-secret targets: a parseable meet URL and an RTMP ingest base URL.
          const meetUrl = `https://meet.google.com/${scenario.meetToken}`;
          const rtmpUrl = `rtmp://live.example.com/app/${scenario.rtmpToken}`;

          const cfg = makeConfig({
            account: accountSecret,
            password: passwordSecret,
            streamKey: streamKeySecret,
            rtmpUrl,
            pixelFormat: scenario.pixelFormat,
          });
          const videoFormat = cfg.avatar.video as AvatarVideoFormat;

          // --- Captured sinks --------------------------------------------------
          const logCalls: LogCall[] = [];
          const cameraFrames: Uint8Array[] = [];
          const micChunks: Uint8Array[] = [];
          const deliverChunks: Uint8Array[] = [];
          const auditTargets: (string | null)[] = [];
          const meetJoins: { meetUrl: string; creds: MeetCredentials }[] = [];
          const streamStarts: { target: StreamTarget; stream: AvatarStream }[] = [];

          // --- Spy logger ------------------------------------------------------
          const logger: Logger = {
            info: (message, meta) => logCalls.push({ level: 'info', message, meta }),
            error: (message, meta) => logCalls.push({ level: 'error', message, meta }),
          };

          // --- Fakes -----------------------------------------------------------
          const renderer: AvatarRenderer = {
            descriptor: { engine: 'liveportrait', license: 'MIT' },
            render(_req: RenderRequest): Promise<RenderResult> {
              if (scenario.renderFails) {
                // Failure carries NO secret (a well-behaved adapter never leaks).
                return Promise.reject(new Error('renderer sidecar exited non-zero (status 1)'));
              }
              async function* frames(): AsyncGenerator<Uint8Array> {
                yield Buffer.from('clean-video-frame-bytes-0');
                yield Buffer.from('clean-video-frame-bytes-1');
              }
              const stream: AvatarStream = { video: videoFormat, audio: TELEPHONY_PCM_16K };
              return Promise.resolve({ stream, frames: frames() });
            },
          };

          const camera: VirtualCamera = {
            descriptor: { device: 'roza_cam', backend: 'fake', license: 'MIT' },
            open: (_fmt) =>
              scenario.startCameraFails
                ? Promise.reject(new Error('VirtualCamera failed to initialize device roza_cam'))
                : Promise.resolve(),
            write: (frame) => {
              cameraFrames.push(frame);
              return scenario.presentWriteFails
                ? Promise.reject(new Error('VirtualCamera write failed: broken pipe'))
                : Promise.resolve();
            },
            close: () => Promise.resolve(),
          };

          const microphone: VirtualMicrophone = {
            descriptor: { device: 'roza_mic', backend: 'fake', license: 'MIT' },
            open: (_fmt) => Promise.resolve(),
            write: (chunk) => {
              micChunks.push(chunk.data);
              return Promise.resolve();
            },
            close: () => Promise.resolve(),
          };

          const meet: MeetSession = {
            descriptor: { backend: 'playwright', license: 'Apache-2.0' },
            join: (url, creds) => {
              meetJoins.push({ meetUrl: url, creds });
              return scenario.meetFails
                ? Promise.reject(new Error('MeetSession failed to join meeting: browser disconnected'))
                : Promise.resolve();
            },
            mute: () => Promise.resolve(),
            leave: () => Promise.resolve(),
          };

          const stream: StreamSession = {
            descriptor: { backend: 'ffmpeg', license: 'GPL-2.0' },
            start: (target, st) => {
              streamStarts.push({ target, stream: st });
              return scenario.streamFails
                ? Promise.reject(new Error('StreamSession failed to start: rtmp connection dropped'))
                : Promise.resolve();
            },
            stop: () => Promise.resolve(),
          };

          // Fake audit repo: only startAvatarSession/endAvatarSession are used.
          let auditSeq = 0;
          const repo = {
            startAvatarSession(kind: AvatarSessionKind, target?: string | null): AvatarSession {
              auditTargets.push(target ?? null);
              auditSeq += 1;
              return {
                id: `audit-${auditSeq}`,
                kind,
                target: target ?? null,
                outcome: 'in_progress' as AvatarOutcome,
                started_at: '2024-01-01T00:00:00.000Z',
                ended_at: null,
              };
            },
            endAvatarSession(_id: string, _outcome: AvatarOutcome, _at: string): void {
              // no-op audit close
            },
          } as unknown as Repository;

          // The Avatar_Image carries a private-journal sentinel as private state.
          const avatarImage = (): Uint8Array => Buffer.from(`roza-portrait::${journalSecret}`);
          // The reply audio is non-secret content delivered to the WebRTC sinks.
          const replyAudio: AudioChunk = {
            format: TELEPHONY_PCM_16K,
            data: Buffer.from('clean-reply-audio-pcm'),
          };

          const deliverAudios = (audio: AudioChunk): Promise<void> => {
            deliverChunks.push(audio.data);
            return Promise.resolve();
          };

          const connector = createAvatarConnector({
            renderer,
            camera,
            microphone,
            meet,
            stream,
            cfg,
            avatarImage,
            now: () => new Date('2024-01-01T00:00:00.000Z'),
            logger,
            audioOnlyDeliver: deliverAudios,
            repo,
          });

          // --- Drive the full surface across success AND failure paths ---------
          const reasons: (string | undefined)[] = [];

          await connector.start();

          const presentResult = await connector.present(replyAudio);
          reasons.push(presentResult.reason);

          const joinResult = await connector.joinMeet(meetUrl);
          reasons.push(joinResult.reason);
          await connector.muteMeet();
          await connector.leaveMeet();

          const streamResult = await connector.startStream();
          reasons.push(streamResult.reason);
          await connector.stopStream();

          // --- Assertions: no secret in any leak surface -----------------------

          // 1. Logs (Req 8.4): every spy-logger info + error call, serialized.
          for (const call of logCalls) {
            assertNoSecret(serializeLog(call), forbidden, `log '${call.message}'`);
          }

          // 2. Surfaced reasons (Req 8.4): no returned reason carries a secret.
          for (const reason of reasons) {
            if (reason !== undefined) {
              assertNoSecret(reason, forbidden, 'returned reason');
            }
          }

          // 3. Audit rows (Req 8.5, 7.4): every `target` is null or a
          //    meet/RTMP URL — never a credential or the Stream_Key.
          for (const target of auditTargets) {
            if (target !== null) {
              assertNoSecret(target, forbidden, 'avatar_sessions target');
              expect(
                target === meetUrl || target === rtmpUrl,
                'audit target must be only a meet URL / RTMP ingest URL',
              ).toBe(true);
            }
          }

          // 4. Virtual_Camera frames (Req 8.6): never any secret/journal value.
          for (const frame of cameraFrames) {
            assertNoSecret(bytesToString(frame), forbidden, 'camera frame');
          }

          // 5. Virtual_Microphone audio + audio-only fallback delivery (Req 8.6).
          for (const chunk of micChunks) {
            assertNoSecret(bytesToString(chunk), forbidden, 'microphone chunk');
          }
          for (const chunk of deliverChunks) {
            assertNoSecret(bytesToString(chunk), forbidden, 'audio-only delivery chunk');
          }

          // 6. MeetSession (Req 8.6): the `meetUrl` navigation target carries no
          //    secret; the credentials travel ONLY in the dedicated `creds`
          //    parameter and are passed through verbatim — nowhere else.
          for (const join of meetJoins) {
            assertNoSecret(join.meetUrl, forbidden, 'meet.join meetUrl');
            expect(join.creds.account).toBe(accountSecret);
            expect(join.creds.password).toBe(passwordSecret);
            // The creds param must not smuggle the Stream_Key or journal value.
            assertNoSecret(join.creds.account, [streamKeySecret, journalSecret], 'meet creds.account');
            assertNoSecret(join.creds.password, [streamKeySecret, journalSecret], 'meet creds.password');
          }

          // 7. StreamSession (Req 7.4, 8.6): the RTMP base `url` and the paired
          //    AvatarStream carry no secret; the `Stream_Key` travels ONLY in
          //    the dedicated `key` parameter and is passed through verbatim.
          for (const start of streamStarts) {
            assertNoSecret(start.target.url, forbidden, 'stream target.url');
            assertNoSecret(
              JSON.stringify(start.stream),
              forbidden,
              'stream AvatarStream',
            );
            expect(start.target.key).toBe(streamKeySecret);
            assertNoSecret(
              start.target.url,
              [streamKeySecret, accountSecret, passwordSecret, journalSecret],
              'stream target.url (no smuggled secret)',
            );
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
