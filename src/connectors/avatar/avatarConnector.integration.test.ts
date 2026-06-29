// Feature: roza-step4-avatar-video — Example/integration tests for `createAvatarConnector`.
//
// Validates: Requirements 2.1, 5.1, 5.2, 5.3, 6.1, 6.3, 7.2, 9.2
//
// These are CONCRETE example/integration tests (not property tests) for the
// Avatar_Connector I/O shell (`createAvatarConnector`), driven entirely by
// in-memory FAKES for all five injectable interfaces (AvatarRenderer,
// VirtualCamera, VirtualMicrophone, MeetSession, StreamSession) plus a fake
// audit repository, a spy logger, and an ENABLED RozaConfig. No real GPU,
// renderer sidecar, kernel module, null sink, browser, or RTMP endpoint runs —
// there is NO real I/O of any kind (Req 12.5).
//
// Cases:
//   1. Render→present happy path (Req 2.1, 5.1, 5.2, 5.3).
//   2. Renderer failure → audio-only fallback (Req 2.8, 9.2).
//   3. Device-init failure at start → fallback without crash (Req 5.5, 9.2).
//   4. Meet join/mute/leave delegation + a swapped alternate MeetSession
//      proving the interface is swappable (Req 6.1, 6.3).
//   5. Stream start/stop delegation (Req 7.2).

import { describe, it, expect } from 'vitest';

import { createAvatarConnector } from './avatarConnector.js';
import type { AvatarRenderer, RenderRequest, RenderResult } from './renderer.js';
import type { VirtualCamera } from './virtualCamera.js';
import type { VirtualMicrophone } from './virtualMicrophone.js';
import type { MeetSession, MeetCredentials } from './meetSession.js';
import type { StreamSession, StreamTarget } from './streamSession.js';
import type { AvatarStream, AvatarVideoFormat } from './avatarFormat.js';
import type { AudioChunk, AudioFormat } from '../voice/audio.js';
import type { RozaConfig, AvatarChannelConfig } from '../../config.js';
import type { Logger } from '../../types.js';
import type {
  AvatarOutcome,
  AvatarSession,
  AvatarSessionKind,
  Repository,
} from '../../repository.js';

// ───────────────────────────────────────────────────────────────────────────
// Concrete fixtures (no generators — these are example tests).
// ───────────────────────────────────────────────────────────────────────────

/** The configured Avatar_Video_Format the renderer emits and the camera consumes. */
const VIDEO_FORMAT: AvatarVideoFormat = { width: 512, height: 512, fps: 25, pixelFormat: 'yuv420p' };

/** Configured render latency budget (ms). */
const RENDER_MS = 4000;

/** Signed 16-bit little-endian wideband PCM, the reply audio format. */
const AUDIO_FORMAT: AudioFormat = { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 };

/** A concrete reply audio chunk the Voice_Channel produced for a turn. */
const REPLY_AUDIO: AudioChunk = {
  format: AUDIO_FORMAT,
  data: Uint8Array.from([10, 20, 30, 40]),
};

/** The static placeholder Avatar_Image portrait bytes. */
const PORTRAIT: Uint8Array = Uint8Array.from([1, 2, 3, 4, 5]);

/** Canned Video_Stream frames the happy-path fake renderer produces. */
const CANNED_FRAMES: Uint8Array[] = [
  Uint8Array.from([1, 1]),
  Uint8Array.from([2, 2]),
  Uint8Array.from([3, 3]),
];

// ───────────────────────────────────────────────────────────────────────────
// In-memory fakes for the five injectable interfaces.
// ───────────────────────────────────────────────────────────────────────────

interface FakeRenderer extends AvatarRenderer {
  readonly requests: RenderRequest[];
}

/** A fake renderer that records each request and returns the canned frames. */
function makeFakeRenderer(cannedFrames: Uint8Array[]): FakeRenderer {
  const requests: RenderRequest[] = [];
  return {
    requests,
    descriptor: { engine: 'fake-renderer', license: 'MIT' },
    async render(req: RenderRequest): Promise<RenderResult> {
      requests.push(req);
      const stream: AvatarStream = { video: req.format, audio: req.audio.format };
      async function* frameIterator(): AsyncGenerator<Uint8Array> {
        for (const frame of cannedFrames) {
          yield frame;
        }
      }
      return { stream, frames: frameIterator() };
    },
  };
}

/** A fake renderer whose `render` always rejects (renderer timeout/failure). */
function makeFailingRenderer(): FakeRenderer {
  const requests: RenderRequest[] = [];
  return {
    requests,
    descriptor: { engine: 'fake-failing-renderer', license: 'MIT' },
    async render(req: RenderRequest): Promise<RenderResult> {
      requests.push(req);
      throw new Error('renderer timed out');
    },
  };
}

interface FakeCamera extends VirtualCamera {
  readonly opened: AvatarVideoFormat[];
  readonly frames: Uint8Array[];
  closes: number;
}

/** A fake Virtual_Camera that records opens/frames; `openRejects` simulates init failure. */
function makeFakeCamera(openRejects = false): FakeCamera {
  const opened: AvatarVideoFormat[] = [];
  const frames: Uint8Array[] = [];
  const cam: FakeCamera = {
    opened,
    frames,
    closes: 0,
    descriptor: { device: '/dev/video-fake', backend: 'fake', license: 'GPL-2.0' },
    async open(format: AvatarVideoFormat): Promise<void> {
      if (openRejects) {
        throw new Error('v4l2loopback device /dev/video-fake could not be initialized');
      }
      opened.push(format);
    },
    async write(frame: Uint8Array): Promise<void> {
      frames.push(frame);
    },
    async close(): Promise<void> {
      cam.closes += 1;
    },
  };
  return cam;
}

interface FakeMicrophone extends VirtualMicrophone {
  readonly opened: AudioFormat[];
  readonly writes: AudioChunk[];
  closes: number;
}

/** A fake Virtual_Microphone that records opens/writes. */
function makeFakeMicrophone(): FakeMicrophone {
  const opened: AudioFormat[] = [];
  const writes: AudioChunk[] = [];
  const mic: FakeMicrophone = {
    opened,
    writes,
    closes: 0,
    descriptor: { device: 'roza_virtmic_fake', backend: 'fake', license: 'MIT' },
    async open(format: AudioFormat): Promise<void> {
      opened.push(format);
    },
    async write(chunk: AudioChunk): Promise<void> {
      writes.push(chunk);
    },
    async close(): Promise<void> {
      mic.closes += 1;
    },
  };
  return mic;
}

interface FakeMeet extends MeetSession {
  readonly joins: { meetUrl: string; creds: MeetCredentials }[];
  mutes: number;
  leaves: number;
}

/** A fake MeetSession (default object-literal implementation) recording delegation. */
function makeFakeMeet(): FakeMeet {
  const joins: { meetUrl: string; creds: MeetCredentials }[] = [];
  const meet: FakeMeet = {
    joins,
    mutes: 0,
    leaves: 0,
    descriptor: { backend: 'playwright', license: 'Apache-2.0' },
    async join(meetUrl: string, creds: MeetCredentials): Promise<void> {
      joins.push({ meetUrl, creds });
    },
    async mute(): Promise<void> {
      meet.mutes += 1;
    },
    async leave(): Promise<void> {
      meet.leaves += 1;
    },
  };
  return meet;
}

/**
 * A SWAPPED alternate MeetSession — a class-based implementation with entirely
 * different internals. It conforms to the SAME `MeetSession` interface, proving
 * the connector delegates through the interface and the adapter is swappable
 * (Req 6.1), exactly like swapping Playwright for Puppeteer.
 */
class AlternateMeetSession implements MeetSession {
  public readonly events: string[] = [];
  public lastCreds: MeetCredentials | null = null;
  public readonly descriptor = { backend: 'playwright' as const, license: 'Apache-2.0' };

  async join(meetUrl: string, creds: MeetCredentials): Promise<void> {
    this.lastCreds = creds;
    this.events.push(`join:${meetUrl}`);
  }

  async mute(): Promise<void> {
    this.events.push('mute');
  }

  async leave(): Promise<void> {
    this.events.push('leave');
  }
}

interface FakeStream extends StreamSession {
  readonly starts: { target: StreamTarget; stream: AvatarStream }[];
  stops: number;
}

/** A fake StreamSession recording start/stop delegation. */
function makeFakeStream(): FakeStream {
  const starts: { target: StreamTarget; stream: AvatarStream }[] = [];
  const stream: FakeStream = {
    starts,
    stops: 0,
    descriptor: { backend: 'ffmpeg', license: 'LGPL-2.1' },
    async start(target: StreamTarget, av: AvatarStream): Promise<void> {
      starts.push({ target, stream: av });
    },
    async stop(): Promise<void> {
      stream.stops += 1;
    },
  };
  return stream;
}

interface SpyLogger extends Logger {
  readonly infos: { message: string; meta?: Record<string, unknown> }[];
  readonly errors: { message: string; meta?: Record<string, unknown> }[];
}

/** A spy logger capturing info/error calls for assertions. */
function makeSpyLogger(): SpyLogger {
  const infos: { message: string; meta?: Record<string, unknown> }[] = [];
  const errors: { message: string; meta?: Record<string, unknown> }[] = [];
  return {
    infos,
    errors,
    info(message: string, meta?: Record<string, unknown>): void {
      infos.push({ message, meta });
    },
    error(message: string, meta?: Record<string, unknown>): void {
      errors.push({ message, meta });
    },
  };
}

interface FakeRepo {
  readonly started: { kind: AvatarSessionKind; target: string | null }[];
  readonly ended: { id: string; outcome: AvatarOutcome; at: string }[];
}

/**
 * An in-memory audit repository fake implementing only the two avatar methods
 * the connector calls. Cast to `Repository` for injection — the connector never
 * touches any other method.
 */
function makeFakeRepo(): { repo: Repository; spy: FakeRepo } {
  const started: { kind: AvatarSessionKind; target: string | null }[] = [];
  const ended: { id: string; outcome: AvatarOutcome; at: string }[] = [];
  let seq = 0;
  const repo = {
    startAvatarSession(kind: AvatarSessionKind, target?: string | null): AvatarSession {
      seq += 1;
      const id = `sess-${seq}`;
      const resolvedTarget = target ?? null;
      started.push({ kind, target: resolvedTarget });
      return {
        id,
        kind,
        target: resolvedTarget,
        outcome: 'in_progress',
        started_at: '1970-01-01T00:00:00.000Z',
        ended_at: null,
      };
    },
    endAvatarSession(id: string, outcome: AvatarOutcome, at: string): void {
      ended.push({ id, outcome, at });
    },
  } as unknown as Repository;
  return { repo, spy: { started, ended } };
}

// ───────────────────────────────────────────────────────────────────────────
// Enabled RozaConfig builder (mirrors the routing test's config builder).
// ───────────────────────────────────────────────────────────────────────────

interface ConfigOptions {
  meet?: Partial<AvatarChannelConfig['meet']>;
  stream?: Partial<AvatarChannelConfig['stream']>;
}

/** Build a fully-resolved RozaConfig with the avatar capability ENABLED. */
function makeEnabledConfig(opts: ConfigOptions = {}): RozaConfig {
  const avatar: AvatarChannelConfig = {
    enabled: true,
    video: VIDEO_FORMAT,
    latency: { renderMs: RENDER_MS },
    renderer: { endpoint: 'http://renderer.local/render', engine: 'fake' },
    devices: { camera: '/dev/video-fake', microphone: 'roza_virtmic_fake' },
    meet: {
      enabled: false,
      consent: false,
      account: '',
      password: '',
      ...opts.meet,
    },
    stream: {
      enabled: false,
      url: '',
      key: '',
      ...opts.stream,
    },
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

// ───────────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────────

describe('createAvatarConnector — example/integration tests with in-memory fakes', () => {
  // ── Case 1 ────────────────────────────────────────────────────────────────
  // Render→present happy path on a fake pipeline (Req 2.1, 5.1, 5.2, 5.3).
  it('start() opens devices and present(audio) renders + presents A/V, returning { ok:true, mode:"video" }', async () => {
    const renderer = makeFakeRenderer(CANNED_FRAMES);
    const camera = makeFakeCamera();
    const microphone = makeFakeMicrophone();
    const { repo, spy: repoSpy } = makeFakeRepo();
    const logger = makeSpyLogger();
    const cfg = makeEnabledConfig();

    const delivered: AudioChunk[] = [];
    const connector = createAvatarConnector({
      renderer,
      camera,
      microphone,
      cfg,
      avatarImage: () => PORTRAIT,
      now: () => new Date(0),
      logger,
      audioOnlyDeliver: async (audio) => {
        delivered.push(audio);
      },
      repo,
    });

    await connector.start();

    // start() opens BOTH virtual devices with the configured formats (Req 5.1, 5.2).
    expect(camera.opened).toEqual([VIDEO_FORMAT]);
    expect(microphone.opened).toEqual([AUDIO_FORMAT]);

    const result = await connector.present(REPLY_AUDIO);

    // The renderer was handed the portrait + the EXACT reply audio + format (Req 2.1).
    expect(renderer.requests).toHaveLength(1);
    expect(renderer.requests[0]!.image).toBe(PORTRAIT);
    expect(renderer.requests[0]!.audio).toBe(REPLY_AUDIO);
    expect(renderer.requests[0]!.format).toEqual(VIDEO_FORMAT);
    expect(renderer.requests[0]!.timeoutMs).toBe(RENDER_MS);

    // Frames written to the camera in order; reply audio written to the mic (Req 5.1, 5.2, 5.3).
    expect(camera.frames).toEqual(CANNED_FRAMES);
    expect(microphone.writes).toEqual([REPLY_AUDIO]);

    // A successful render is a video turn; no audio-only fallback ran.
    expect(result).toEqual({ ok: true, mode: 'video' });
    expect(delivered).toHaveLength(0);

    // The audit session was opened and closed with the `presented` outcome.
    expect(repoSpy.started).toEqual([{ kind: 'render', target: null }]);
    expect(repoSpy.ended).toHaveLength(1);
    expect(repoSpy.ended[0]!.outcome).toBe('presented');
  });

  // ── Case 2 ────────────────────────────────────────────────────────────────
  // Renderer timeout/failure → audio-only fallback (Req 2.8, 9.2).
  it('present(audio) falls back to audio-only when the renderer rejects, invoking audioOnlyDeliver', async () => {
    const renderer = makeFailingRenderer();
    const camera = makeFakeCamera();
    const microphone = makeFakeMicrophone();
    const logger = makeSpyLogger();
    const cfg = makeEnabledConfig();

    const delivered: AudioChunk[] = [];
    const connector = createAvatarConnector({
      renderer,
      camera,
      microphone,
      cfg,
      avatarImage: () => PORTRAIT,
      now: () => new Date(0),
      logger,
      audioOnlyDeliver: async (audio) => {
        delivered.push(audio);
      },
    });

    await connector.start();
    const result = await connector.present(REPLY_AUDIO);

    // The renderer was attempted exactly once, then degraded.
    expect(renderer.requests).toHaveLength(1);

    // present() NEVER rejects — it resolves to an audio-only result (Req 2.8, 9.2).
    expect(result).toEqual({ ok: true, mode: 'audio_only' });

    // The reply is still delivered via the operative Voice_Channel with the
    // EXACT reply audio (Req 9.2).
    expect(delivered).toEqual([REPLY_AUDIO]);

    // No video frames were presented to the camera on the failed render.
    expect(camera.frames).toEqual([]);

    // A degradation was logged (error level), proving the failure was surfaced.
    expect(logger.errors.some((e) => e.message === 'avatar.render.failed')).toBe(true);
  });

  // ── Case 3 ────────────────────────────────────────────────────────────────
  // Device-init failure at start → fallback without crash (Req 5.5, 9.2).
  it('start() does not throw when a device fails to open, and a later present() degrades to audio_only', async () => {
    const renderer = makeFakeRenderer(CANNED_FRAMES);
    const camera = makeFakeCamera(/* openRejects */ true);
    const microphone = makeFakeMicrophone();
    const logger = makeSpyLogger();
    const cfg = makeEnabledConfig();

    const delivered: AudioChunk[] = [];
    const connector = createAvatarConnector({
      renderer,
      camera,
      microphone,
      cfg,
      avatarImage: () => PORTRAIT,
      now: () => new Date(0),
      logger,
      audioOnlyDeliver: async (audio) => {
        delivered.push(audio);
      },
    });

    // A device-init failure must NOT crash the connector (Req 5.5).
    await expect(connector.start()).resolves.toBeUndefined();

    // The camera open failure was logged naming the device (Req 5.5).
    expect(logger.errors.some((e) => e.message === 'avatar.start.camera_failed')).toBe(true);

    const result = await connector.present(REPLY_AUDIO);

    // Degraded to audio-only: no render attempted, reply delivered via fallback (Req 9.2).
    expect(result).toEqual({ ok: true, mode: 'audio_only' });
    expect(renderer.requests).toHaveLength(0);
    expect(delivered).toEqual([REPLY_AUDIO]);
    expect(camera.frames).toEqual([]);
  });

  // ── Case 4 ────────────────────────────────────────────────────────────────
  // Meet join/mute/leave delegation + a swapped alternate MeetSession (Req 6.1, 6.3).
  it('delegates joinMeet/muteMeet/leaveMeet to the wired MeetSession when enabled with consent + credentials', async () => {
    const meet = makeFakeMeet();
    const cfg = makeEnabledConfig({
      meet: { enabled: true, consent: true, account: 'roza@example.com', password: 'secret-pw' },
    });

    const connector = createAvatarConnector({
      renderer: makeFakeRenderer(CANNED_FRAMES),
      camera: makeFakeCamera(),
      microphone: makeFakeMicrophone(),
      meet,
      cfg,
      avatarImage: () => PORTRAIT,
      now: () => new Date(0),
      logger: makeSpyLogger(),
      audioOnlyDeliver: async () => undefined,
    });

    const joinResult = await connector.joinMeet('https://meet.google.com/abc-defg-hij');
    expect(joinResult).toEqual({ ok: true });

    // join delegated with the untrusted URL + the resolved Meet_Credentials (Req 6.2).
    expect(meet.joins).toEqual([
      {
        meetUrl: 'https://meet.google.com/abc-defg-hij',
        creds: { account: 'roza@example.com', password: 'secret-pw' },
      },
    ]);

    await connector.muteMeet();
    await connector.leaveMeet();
    expect(meet.mutes).toBe(1);
    expect(meet.leaves).toBe(1);
  });

  it('works with a swapped alternate MeetSession implementation, proving the interface is swappable (Req 6.1, 6.3)', async () => {
    const alternate = new AlternateMeetSession();
    const cfg = makeEnabledConfig({
      meet: { enabled: true, consent: true, account: 'alt@example.com', password: 'alt-pw' },
    });

    const connector = createAvatarConnector({
      renderer: makeFakeRenderer(CANNED_FRAMES),
      camera: makeFakeCamera(),
      microphone: makeFakeMicrophone(),
      meet: alternate,
      cfg,
      avatarImage: () => PORTRAIT,
      now: () => new Date(0),
      logger: makeSpyLogger(),
      audioOnlyDeliver: async () => undefined,
    });

    const joinResult = await connector.joinMeet('https://meet.google.com/xyz-1234-567');
    expect(joinResult).toEqual({ ok: true });

    await connector.muteMeet();
    await connector.leaveMeet();

    // The SAME connector drove the entirely different adapter through the
    // unchanged interface, in order (Req 6.1, 6.3).
    expect(alternate.events).toEqual(['join:https://meet.google.com/xyz-1234-567', 'mute', 'leave']);
    expect(alternate.lastCreds).toEqual({ account: 'alt@example.com', password: 'alt-pw' });
  });

  // ── Case 5 ────────────────────────────────────────────────────────────────
  // Stream start/stop delegation (Req 7.2).
  it('delegates startStream/stopStream to the wired StreamSession when enabled', async () => {
    const stream = makeFakeStream();
    const cfg = makeEnabledConfig({
      stream: { enabled: true, url: 'rtmp://ingest.example.com/live', key: 'stream-key-xyz' },
    });

    const connector = createAvatarConnector({
      renderer: makeFakeRenderer(CANNED_FRAMES),
      camera: makeFakeCamera(),
      microphone: makeFakeMicrophone(),
      stream,
      cfg,
      avatarImage: () => PORTRAIT,
      now: () => new Date(0),
      logger: makeSpyLogger(),
      audioOnlyDeliver: async () => undefined,
    });

    const startResult = await connector.startStream();
    expect(startResult).toEqual({ ok: true });

    // start delegated with the RTMP_Target (url + key) and the combined A/V stream (Req 7.2).
    expect(stream.starts).toHaveLength(1);
    expect(stream.starts[0]!.target).toEqual({
      url: 'rtmp://ingest.example.com/live',
      key: 'stream-key-xyz',
    });
    expect(stream.starts[0]!.stream.video).toEqual(VIDEO_FORMAT);

    await connector.stopStream();
    expect(stream.stops).toBe(1);
  });
});
