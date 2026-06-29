// Feature: roza-step4-avatar-video, Task 8.2 — mocked-integration test for the renderer sidecar adapter
//
// Validates: Requirements 2.1, 2.7, 9.1, 12.5
//
// These tests exercise `createSidecarAvatarRenderer` against a FAKE `fetch`
// injected via `deps.fetch` — no real GPU or renderer sidecar ever runs
// (Req 12.5). They assert the adapter:
//   - POSTs to the configured endpoint and sends the portrait/audio/format
//     (inspected on the FormData the fake fetch receives) (Req 2.1);
//   - returns a format-tagged `RenderResult` whose `stream.video` matches the
//     requested format and whose `frames` async-iterable yields the streamed
//     frames reassembled from the mocked response body, each sized to
//     `frameBytes(format)` (Req 2.1, 9.1);
//   - rejects on a time-to-first-frame timeout, a non-OK HTTP status (500),
//     and a connection error so the connector can apply its Req 9.2 audio-only
//     fallback (Req 2.7, 9.1).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSidecarAvatarRenderer, type FetchFn, type RenderRequest } from './renderer.js';
import { frameBytes, type AvatarVideoFormat } from './avatarFormat.js';
import { TELEPHONY_PCM_8K, type AudioChunk } from '../voice/audio.js';
import type { Logger } from '../../types.js';

const ENDPOINT = 'http://avatar-renderer:9009/render';
const ENGINE = 'liveportrait';

/** A small, exactly-divisible Avatar_Video_Format: 2x2 RGBA → 16 bytes/frame. */
const FORMAT: AvatarVideoFormat = { width: 2, height: 2, fps: 25, pixelFormat: 'rgba' };

/** A fake reply-audio chunk (the Piper PCM the Voice_Channel produced). */
function makeAudio(): AudioChunk {
  return { format: TELEPHONY_PCM_8K, data: new Uint8Array([0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6]) };
}

/** A fake portrait (placeholder Avatar_Image bytes). */
function makeImage(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
}

function makeRequest(overrides: Partial<RenderRequest> = {}): RenderRequest {
  return { image: makeImage(), audio: makeAudio(), format: FORMAT, timeoutMs: 5_000, ...overrides };
}

/** A spy logger; both sinks are spies so we can scan everything they received. */
function createSpyLogger(): Logger & {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), error: vi.fn() };
}

/** A Response-like object structurally compatible with what the adapter uses. */
interface FakeResponse {
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | null;
}

/** Build a ReadableStream that emits `bytes` split into `chunkSize` pieces, then closes. */
function streamFromBytes(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      for (let i = 0; i < bytes.byteLength; i += chunkSize) {
        controller.enqueue(bytes.slice(i, Math.min(i + chunkSize, bytes.byteLength)));
      }
      controller.close();
    },
  });
}

/** A 200 OK response whose body streams `bytes` (in `chunkSize` chunks). */
function okResponse(bytes: Uint8Array, chunkSize: number): FakeResponse {
  return { ok: true, status: 200, body: streamFromBytes(bytes, chunkSize) };
}

/**
 * Build a fake `fetch` from a handler, recording every call (url + options).
 * The handler receives the abort signal so timeout scenarios can react to it.
 */
function createFakeFetch(
  handler: (url: string, signal: AbortSignal) => FakeResponse | Promise<FakeResponse>,
): {
  fetch: FetchFn;
  calls: Array<{ url: string; method: string; body: FormData }>;
} {
  const calls: Array<{ url: string; method: string; body: FormData }> = [];
  const fetch = vi.fn(async (url: string, options: RequestInit): Promise<FakeResponse> => {
    calls.push({
      url,
      method: String(options.method),
      body: options.body as FormData,
    });
    return handler(url, options.signal as AbortSignal);
  }) as unknown as FetchFn;
  return { fetch, calls };
}

/** Drain an async-iterable of frames into an array. */
async function collectFrames(frames: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const frame of frames) {
    out.push(frame);
  }
  return out;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('createSidecarAvatarRenderer.render (Task 8.2)', () => {
  it('POSTs to the configured endpoint and sends the portrait, audio, and format (Req 2.1)', async () => {
    const frameSize = frameBytes(FORMAT); // 16
    const { fetch, calls } = createFakeFetch(() =>
      okResponse(new Uint8Array(frameSize).fill(7), frameSize),
    );
    const renderer = createSidecarAvatarRenderer({ endpoint: ENDPOINT, engine: ENGINE, fetch });

    const req = makeRequest();
    const result = await renderer.render(req);
    // Drain so the body is fully consumed.
    await collectFrames(result.frames);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ENDPOINT);
    expect(calls[0]!.method).toBe('POST');

    const form = calls[0]!.body;
    expect(form).toBeInstanceOf(FormData);
    // The target engine + Avatar_Video_Format + paired audio format are sent.
    expect(form.get('engine')).toBe(ENGINE);
    expect(JSON.parse(String(form.get('format')))).toEqual(FORMAT);
    expect(JSON.parse(String(form.get('audioFormat')))).toEqual(req.audio.format);

    // The portrait and reply PCM are sent as blobs sized to their byte length.
    const imageBlob = form.get('image') as Blob;
    const audioBlob = form.get('audio') as Blob;
    expect(imageBlob).toBeInstanceOf(Blob);
    expect(audioBlob).toBeInstanceOf(Blob);
    expect(imageBlob.size).toBe(req.image.byteLength);
    expect(audioBlob.size).toBe(req.audio.data.byteLength);
    expect(new Uint8Array(await imageBlob.arrayBuffer())).toEqual(req.image);
    expect(new Uint8Array(await audioBlob.arrayBuffer())).toEqual(req.audio.data);
  });

  it('returns a format-tagged RenderResult whose frames reassemble the streamed body (Req 2.1, 9.1)', async () => {
    const frameSize = frameBytes(FORMAT); // 16
    // Three distinct frames concatenated into one body.
    const frame0 = new Uint8Array(frameSize).fill(0x10);
    const frame1 = new Uint8Array(frameSize).fill(0x20);
    const frame2 = new Uint8Array(frameSize).fill(0x30);
    const allBytes = new Uint8Array(frameSize * 3);
    allBytes.set(frame0, 0);
    allBytes.set(frame1, frameSize);
    allBytes.set(frame2, frameSize * 2);

    // Stream in 7-byte chunks (misaligned to the 16-byte frame boundary) to
    // prove the adapter reassembles whole frames across chunk boundaries.
    const { fetch } = createFakeFetch(() => okResponse(allBytes, 7));
    const renderer = createSidecarAvatarRenderer({ endpoint: ENDPOINT, engine: ENGINE, fetch });

    const req = makeRequest();
    const result = await renderer.render(req);

    // The result is tagged with the requested video format + paired audio.
    expect(result.stream.video).toEqual(FORMAT);
    expect(result.stream.audio).toEqual(req.audio.format);

    const frames = await collectFrames(result.frames);
    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      expect(frame.byteLength).toBe(frameSize);
    }
    expect(Array.from(frames[0]!)).toEqual(Array.from(frame0));
    expect(Array.from(frames[1]!)).toEqual(Array.from(frame1));
    expect(Array.from(frames[2]!)).toEqual(Array.from(frame2));
  });

  it('rejects when the first frame does not arrive within timeoutMs (Req 2.7, 9.1)', async () => {
    // The body resolves but never enqueues a frame; it errors only when the
    // adapter aborts the request after the time-to-first-frame budget.
    const { fetch } = createFakeFetch((_url, signal) => ({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller): void {
          signal.addEventListener('abort', () => {
            controller.error(new Error('aborted by client'));
          });
        },
      }),
    }));
    const logger = createSpyLogger();
    const renderer = createSidecarAvatarRenderer({
      endpoint: ENDPOINT,
      engine: ENGINE,
      fetch,
      logger,
    });

    const promise = renderer.render(makeRequest({ timeoutMs: 50 }));
    await expect(promise).rejects.toThrow(/timed out after 50ms/);
    expect(logger.error).toHaveBeenCalled();
  });

  it('rejects on a non-OK HTTP status (500) (Req 2.7, 9.1)', async () => {
    const { fetch } = createFakeFetch(() => ({ ok: false, status: 500, body: null }));
    const logger = createSpyLogger();
    const renderer = createSidecarAvatarRenderer({
      endpoint: ENDPOINT,
      engine: ENGINE,
      fetch,
      logger,
    });

    await expect(renderer.render(makeRequest())).rejects.toThrow(/HTTP 500/);
    expect(logger.error).toHaveBeenCalled();
  });

  it('rejects on a connection error (fetch rejects) (Req 2.7, 9.1)', async () => {
    const { fetch } = createFakeFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const logger = createSpyLogger();
    const renderer = createSidecarAvatarRenderer({
      endpoint: ENDPOINT,
      engine: ENGINE,
      fetch,
      logger,
    });

    await expect(renderer.render(makeRequest())).rejects.toThrow(/ECONNREFUSED/);
    expect(logger.error).toHaveBeenCalled();
  });
});
