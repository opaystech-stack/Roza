// Feature: roza-step4-avatar-video, Task 8.9 — mocked-integration test for the ffmpeg/RTMP stream adapter
//
// Validates: Requirements 7.1, 7.2, 7.4, 12.5
//
// These tests exercise `createFfmpegStreamSession` against a FAKE
// `child_process.spawn` injected via `deps.spawn` — no real RTMP endpoint and
// no real ffmpeg process ever runs (Req 12.5). The fake child is an
// `EventEmitter` with `stdin`/`kill` spies so the start/stop lifecycle and the
// `spawn`/`error`/`close` transitions can be driven deterministically.
//
// They assert the adapter:
//   - publishes to the configured `RTMP_URL`: the non-secret base `target.url`
//     appears in the spawned ffmpeg arg vector, and the composed publish URL
//     (which embeds the key) is the final argument handed only to the process
//     (Req 7.1);
//   - NEVER logs the `STREAM_KEY` value — on a successful start, on a
//     post-established drop, and on a pre-established failure — even though the
//     key legitimately appears in the spawned process ARGS (Req 7.4, CRITICAL);
//   - surfaces a connection drop/failure (the fake child emits `error` or a
//     non-zero `close`) by logging WITHOUT the key and either rejecting `start`
//     (pre-established) or releasing the child (post-established) so the
//     connector can release resources (Req 7.4);
//   - releases resources on `stop()` by sending `SIGTERM` and reaping the child
//     on `close` (Req 7.2).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  createFfmpegStreamSession,
  type SpawnFn,
  type StreamTarget,
} from './streamSession.js';
import { TELEPHONY_PCM_8K } from '../voice/audio.js';
import type { AvatarStream } from './avatarFormat.js';
import type { Logger } from '../../types.js';

/** The env-only Stream_Key secret. It may appear in ARGS but NEVER in logs. */
const STREAM_KEY = 'sk_live_SUPERSECRET_RTMP_KEY_98765';
/** The non-secret RTMP ingest base URL (safe to log). */
const RTMP_URL = 'rtmp://relay.internal/live';

const TARGET: StreamTarget = { url: RTMP_URL, key: STREAM_KEY };

/** A realistic combined Video_Stream + paired speech-audio value (Req 4.4). */
const STREAM: AvatarStream = {
  video: { width: 512, height: 512, fps: 25, pixelFormat: 'yuv420p' },
  audio: TELEPHONY_PCM_8K,
};

/**
 * A fake `ffmpeg` child process: an `EventEmitter` with `stdin`/`kill` spies,
 * structurally compatible with the bits of `ChildProcess` the adapter touches.
 */
class FakeChild extends EventEmitter {
  readonly stdin = { write: vi.fn(), end: vi.fn() };
  readonly kill = vi.fn((_signal?: NodeJS.Signals | number): boolean => true);
}

/** A spy logger; both sinks are spies so every log call can be scanned. */
function createSpyLogger(): Logger & {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), error: vi.fn() };
}

/** A fake `spawn` recording every call and exposing the children it created. */
function createFakeSpawn(): {
  spawn: SpawnFn;
  calls: Array<{ bin: string; args: string[] }>;
  children: FakeChild[];
} {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const children: FakeChild[] = [];
  const spawn = vi.fn((bin: string, args: string[]) => {
    calls.push({ bin, args });
    const child = new FakeChild();
    children.push(child);
    return child;
  }) as unknown as SpawnFn;
  return { spawn, calls, children };
}

/** Serialize every message + meta the logger received into one scannable blob. */
function allLogText(logger: ReturnType<typeof createSpyLogger>): string {
  const calls = [...logger.info.mock.calls, ...logger.error.mock.calls];
  return calls.map((args) => JSON.stringify(args)).join('\n');
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('createFfmpegStreamSession.start (Task 8.9)', () => {
  it('publishes to the configured RTMP_URL: the base target.url is in the ffmpeg args (Req 7.1)', async () => {
    const { spawn, calls, children } = createFakeSpawn();
    const session = createFfmpegStreamSession({ spawn });

    const promise = session.start(TARGET, STREAM);
    // The executor has already attached the `spawn`/`error`/`close` listeners
    // synchronously, so emitting `spawn` now resolves the start.
    children[0]!.emit('spawn');
    await expect(promise).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    const { args } = calls[0]!;
    // The non-secret base ingest URL is present in the spawned argument vector.
    expect(args.some((a) => a.includes(RTMP_URL))).toBe(true);
    // The composed publish URL (base + key) is the FINAL argument and reaches
    // only the spawned process — the key legitimately appears here.
    expect(args[args.length - 1]).toBe(`${RTMP_URL}/${STREAM_KEY}`);
  });

  it('NEVER logs the STREAM_KEY value on a successful start, though it is in the args (Req 7.4)', async () => {
    const { spawn, calls, children } = createFakeSpawn();
    const logger = createSpyLogger();
    const session = createFfmpegStreamSession({ spawn, logger });

    const promise = session.start(TARGET, STREAM);
    children[0]!.emit('spawn');
    await promise;

    // The key IS in the spawned args (handed only to the process)...
    expect(calls[0]!.args.join(' ')).toContain(STREAM_KEY);
    // ...but it must NEVER appear in any emitted log line.
    expect(allLogText(logger)).not.toContain(STREAM_KEY);
    // The start is logged against the non-secret base URL alone.
    expect(logger.info).toHaveBeenCalledWith('avatar.stream.started', {
      url: RTMP_URL,
      backend: 'ffmpeg',
    });
  });

  it('rejects WITHOUT the key when the process exits non-zero before it is established (Req 7.4)', async () => {
    const { spawn, children } = createFakeSpawn();
    const logger = createSpyLogger();
    const session = createFfmpegStreamSession({ spawn, logger });

    const promise = session.start(TARGET, STREAM);
    // A non-zero exit before `spawn` → a connection failure → start rejects.
    children[0]!.emit('close', 1);

    await expect(promise).rejects.toThrow(/failed to start publishing/);
    // The rejection message references the base URL, never the key.
    await expect(promise).rejects.not.toThrow(new RegExp(STREAM_KEY));
    expect(logger.error).toHaveBeenCalledWith('avatar.stream.start_failed', {
      url: RTMP_URL,
      backend: 'ffmpeg',
      code: 1,
    });
    expect(allLogText(logger)).not.toContain(STREAM_KEY);
  });

  it('rejects WITHOUT the key when the process errors before it is established (Req 7.4)', async () => {
    const { spawn, children } = createFakeSpawn();
    const logger = createSpyLogger();
    const session = createFfmpegStreamSession({ spawn, logger });

    const promise = session.start(TARGET, STREAM);
    children[0]!.emit('error', new Error('spawn ffmpeg ENOENT'));

    await expect(promise).rejects.toThrow(/failed to start publishing/);
    expect(allLogText(logger)).not.toContain(STREAM_KEY);
  });

  it('rejects WITHOUT the key when spawn throws synchronously (Req 7.4)', async () => {
    const throwingSpawn = vi.fn(() => {
      throw new Error('EACCES: /usr/bin/ffmpeg');
    }) as unknown as SpawnFn;
    const logger = createSpyLogger();
    const session = createFfmpegStreamSession({ spawn: throwingSpawn, logger });

    await expect(session.start(TARGET, STREAM)).rejects.toThrow(/failed to start publishing/);
    expect(logger.error).toHaveBeenCalledWith('avatar.stream.start_failed', {
      url: RTMP_URL,
      backend: 'ffmpeg',
      error: 'EACCES: /usr/bin/ffmpeg',
    });
    expect(allLogText(logger)).not.toContain(STREAM_KEY);
  });

  it('surfaces a post-established drop WITHOUT the key and releases the child (Req 7.4)', async () => {
    const { spawn, children } = createFakeSpawn();
    const logger = createSpyLogger();
    const session = createFfmpegStreamSession({ spawn, logger });

    const promise = session.start(TARGET, STREAM);
    children[0]!.emit('spawn');
    await promise;

    // A later transport error while streaming is a connection drop.
    children[0]!.emit('error', new Error('Connection reset by peer'));

    expect(logger.error).toHaveBeenCalledWith('avatar.stream.dropped', {
      url: RTMP_URL,
      backend: 'ffmpeg',
      error: 'Connection reset by peer',
    });
    expect(allLogText(logger)).not.toContain(STREAM_KEY);

    // The child was released, so stop() is a no-op that resolves without
    // signalling a (now-dead) process.
    await expect(session.stop()).resolves.toBeUndefined();
    expect(children[0]!.kill).not.toHaveBeenCalled();
  });

  it('surfaces a post-established close-drop WITHOUT the key (Req 7.4)', async () => {
    const { spawn, children } = createFakeSpawn();
    const logger = createSpyLogger();
    const session = createFfmpegStreamSession({ spawn, logger });

    const promise = session.start(TARGET, STREAM);
    children[0]!.emit('spawn');
    await promise;

    children[0]!.emit('close', 255);

    expect(logger.error).toHaveBeenCalledWith('avatar.stream.dropped', {
      url: RTMP_URL,
      backend: 'ffmpeg',
      code: 255,
    });
    expect(allLogText(logger)).not.toContain(STREAM_KEY);
  });
});

describe('createFfmpegStreamSession.stop (Task 8.9)', () => {
  it('releases resources by sending SIGTERM and reaping the child on close (Req 7.2)', async () => {
    const { spawn, children } = createFakeSpawn();
    const logger = createSpyLogger();
    const session = createFfmpegStreamSession({ spawn, logger });

    const startPromise = session.start(TARGET, STREAM);
    const child = children[0]!;
    child.emit('spawn');
    await startPromise;

    const stopPromise = session.stop();
    // stop() signals ffmpeg to finalize and exit...
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    // ...then resolves once the process is reaped (its `close` fires).
    child.emit('close', 0);
    await expect(stopPromise).resolves.toBeUndefined();

    expect(logger.info).toHaveBeenCalledWith('avatar.stream.stopped', { backend: 'ffmpeg' });
    expect(allLogText(logger)).not.toContain(STREAM_KEY);
  });

  it('is a no-op that resolves when nothing was ever started (Req 7.2)', async () => {
    const { spawn } = createFakeSpawn();
    const session = createFfmpegStreamSession({ spawn });
    await expect(session.stop()).resolves.toBeUndefined();
  });
});
