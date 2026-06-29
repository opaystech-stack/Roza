// Feature: roza-step4-avatar-video, Property 5: Render/present routing uses the Avatar_Image and the reply audio
//
// Validates: Requirements 2.1, 4.4, 5.1, 5.2
//
// Property 5 asserts the render/present routing contract of the Avatar_Connector
// I/O shell (`createAvatarConnector`) when the avatar capability is OPERATIVE
// (enabled). It is driven entirely by in-memory FAKES — no real GPU, renderer
// sidecar, kernel module, or null sink runs (Req 12.5):
//
//   1. RENDER ROUTING (Req 2.1, 4.4) — for any reply `AudioChunk`, `present(audio)`
//      invokes the fake `renderer.render` EXACTLY ONCE, and the `RenderRequest`
//      it receives carries:
//        - the current `avatarImage()` portrait (the Avatar_Image, Req 2.1),
//        - that EXACT reply `audio` the Voice_Channel produced (Req 4.4),
//        - the configured Avatar_Video_Format `cfg.avatar.video` (Req 2.1),
//        - the configured render latency budget `cfg.avatar.latency.renderMs`.
//
//   2. PRESENT ROUTING (Req 5.1, 5.2) — on a SUCCESSFUL render the connector
//      writes the produced Video_Stream frames to the fake Virtual_Camera, in
//      order, and writes the reply audio to the fake Virtual_Microphone; the
//      turn resolves `{ ok: true, mode: 'video' }`. No paid dependency is
//      introduced — every collaborator is an in-memory fake.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { createAvatarConnector } from './avatarConnector.js';
import type { AvatarRenderer, RenderRequest, RenderResult } from './renderer.js';
import type { VirtualCamera } from './virtualCamera.js';
import type { VirtualMicrophone } from './virtualMicrophone.js';
import type { AvatarStream, AvatarVideoFormat } from './avatarFormat.js';
import type { AudioChunk, AudioFormat } from '../voice/audio.js';
import type { RozaConfig, AvatarChannelConfig, AvatarPixelFormat } from '../../config.js';
import type { Logger } from '../../types.js';

/** Minimum fast-check iterations mandated by the design for every property. */
const NUM_RUNS = 100;

// ───────────────────────────────────────────────────────────────────────────
// Generators
// ───────────────────────────────────────────────────────────────────────────

const pixelFormatArb: fc.Arbitrary<AvatarPixelFormat> = fc.constantFrom(
  'rgba' as const,
  'yuv420p' as const,
  'nv12' as const,
);

const videoFormatArb: fc.Arbitrary<AvatarVideoFormat> = fc.record({
  width: fc.integer({ min: 1, max: 1920 }),
  height: fc.integer({ min: 1, max: 1080 }),
  fps: fc.integer({ min: 1, max: 60 }),
  pixelFormat: pixelFormatArb,
});

const audioFormatArb: fc.Arbitrary<AudioFormat> = fc.record({
  encoding: fc.constant('pcm_s16le' as const),
  sampleRate: fc.constantFrom(8000 as const, 16000 as const),
  channels: fc.constant(1 as const),
});

/** The reply speech audio the Voice_Channel produced for this turn (Req 4.4). */
const audioArb: fc.Arbitrary<AudioChunk> = fc.record({
  format: audioFormatArb,
  data: fc.uint8Array({ minLength: 0, maxLength: 256 }),
});

/** The static portrait (Avatar_Image) bytes the renderer must animate (Req 2.1). */
const imageArb: fc.Arbitrary<Uint8Array> = fc.uint8Array({ minLength: 1, maxLength: 128 });

/** The canned Video_Stream frames the fake renderer produces for the turn. */
const framesArb: fc.Arbitrary<Uint8Array[]> = fc.array(
  fc.uint8Array({ minLength: 1, maxLength: 64 }),
  { minLength: 1, maxLength: 6 },
);

const latencyArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 60000 });

// ───────────────────────────────────────────────────────────────────────────
// In-memory fakes — no real GPU, kernel module, browser, or RTMP endpoint.
// ───────────────────────────────────────────────────────────────────────────

interface FakeRenderer extends AvatarRenderer {
  /** Every RenderRequest the connector handed to `render`, in call order. */
  readonly requests: RenderRequest[];
}

/**
 * Build a fake {@link AvatarRenderer} that records each {@link RenderRequest}
 * and returns the `cannedFrames` as an async-iterable paired with the
 * `AvatarStream` derived from the request's video format + audio format.
 */
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

interface FakeCamera extends VirtualCamera {
  /** Formats `open` was called with, in order. */
  readonly opened: AvatarVideoFormat[];
  /** Every frame written to the camera, in order. */
  readonly frames: Uint8Array[];
  /** Number of times `close` was called. */
  closes: number;
}

function makeFakeCamera(): FakeCamera {
  const opened: AvatarVideoFormat[] = [];
  const frames: Uint8Array[] = [];
  const cam: FakeCamera = {
    opened,
    frames,
    closes: 0,
    descriptor: { device: '/dev/video-fake', backend: 'fake', license: 'GPL-2.0' },
    async open(format: AvatarVideoFormat): Promise<void> {
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
  /** Formats `open` was called with, in order. */
  readonly opened: AudioFormat[];
  /** Every reply audio chunk written to the microphone, in order. */
  readonly writes: AudioChunk[];
  /** Number of times `close` was called. */
  closes: number;
}

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

/** A no-op logger; the routing property does not assert on log content. */
const noopLogger: Logger = {
  info: () => undefined,
  error: () => undefined,
};

/**
 * Build a fully-resolved `RozaConfig` with the avatar capability ENABLED and
 * the Meet/stream sub-capabilities disabled, mirroring the disabled-avatar
 * fixture shape used across the suite. `video` and `latency.renderMs` are
 * supplied by the caller so the test asserts the connector routes EXACTLY
 * those configured values into the RenderRequest.
 */
function makeEnabledConfig(video: AvatarVideoFormat, renderMs: number): RozaConfig {
  const avatar: AvatarChannelConfig = {
    enabled: true,
    video,
    latency: { renderMs },
    renderer: { endpoint: 'http://renderer.local/render', engine: 'fake' },
    devices: { camera: '/dev/video-fake', microphone: 'roza_virtmic_fake' },
    meet: { enabled: false, consent: false, account: '', password: '' },
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

// ───────────────────────────────────────────────────────────────────────────
// Property 5
// ───────────────────────────────────────────────────────────────────────────

describe('Render/present routing uses the Avatar_Image and the reply audio (Property 5)', () => {
  // Feature: roza-step4-avatar-video, Property 5: Render/present routing uses the Avatar_Image and the reply audio
  // Validates: Requirements 2.1, 4.4, 5.1, 5.2
  it('present(audio) renders the portrait + reply audio in the configured format exactly once and presents the result', async () => {
    await fc.assert(
      fc.asyncProperty(
        imageArb,
        audioArb,
        framesArb,
        videoFormatArb,
        latencyArb,
        async (portrait, audio, cannedFrames, video, renderMs) => {
          const renderer = makeFakeRenderer(cannedFrames);
          const camera = makeFakeCamera();
          const microphone = makeFakeMicrophone();
          const cfg = makeEnabledConfig(video, renderMs);

          let audioOnlyCalls = 0;
          const connector = createAvatarConnector({
            renderer,
            camera,
            microphone,
            cfg,
            avatarImage: () => portrait,
            now: () => new Date(0),
            logger: noopLogger,
            audioOnlyDeliver: async () => {
              audioOnlyCalls += 1;
            },
          });

          await connector.start();
          const result = await connector.present(audio);

          // RENDER ROUTING (Req 2.1, 4.4): render invoked EXACTLY once with the
          // current portrait, that EXACT reply audio, the configured video
          // format, and the configured latency budget.
          expect(renderer.requests).toHaveLength(1);
          const req = renderer.requests[0]!;
          expect(req.image).toBe(portrait); // the Avatar_Image portrait (Req 2.1)
          expect(req.audio).toBe(audio); // the EXACT reply audio (Req 4.4)
          expect(req.format).toBe(cfg.avatar.video); // the configured Avatar_Video_Format (Req 2.1)
          expect(req.format).toEqual(video);
          expect(req.timeoutMs).toBe(renderMs);

          // PRESENT ROUTING (Req 5.1): the produced Video_Stream frames are
          // written to the Virtual_Camera, in order, exactly as produced.
          expect(camera.opened).toEqual([video]);
          expect(camera.frames).toEqual(cannedFrames);

          // PRESENT ROUTING (Req 5.2): the reply audio is written to the
          // Virtual_Microphone exactly once.
          expect(microphone.writes).toEqual([audio]);

          // A successful render is a video turn — no audio-only fallback ran.
          expect(result).toEqual({ ok: true, mode: 'video' });
          expect(audioOnlyCalls).toBe(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
