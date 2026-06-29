// Feature: roza-step4-avatar-video, Task 8.5 — mocked-integration test for the
// virtual-device adapters (Virtual_Camera + Virtual_Microphone, Component A6)
//
// Validates: Requirements 5.1, 5.2, 5.5, 12.5
//
// These tests exercise `createV4l2VirtualCamera` and
// `createPipeWireVirtualMicrophone` against a FAKE `spawn` that returns a fake
// child process — NO real v4l2loopback kernel module, GStreamer/ffmpeg pipeline,
// or PipeWire null sink ever runs (Req 12.5). Mirroring the Phase 3 mocked
// subprocess-adapter style (`tts.piper.test.ts` / `stt.whisper.test.ts`) they
// assert:
//   - the camera adapter, after `open(format)`, writes Video_Frames to the
//     configured v4l2 device via the child's stdin (Req 5.1);
//   - the microphone adapter, after `open(format)`, writes the reply PCM
//     (`chunk.data`) to the configured PipeWire null sink via the child's stdin
//     (Req 5.2);
//   - EACH adapter rejects at `open` — with a message NAMING the device — when
//     the device cannot be initialized, whether the child emits an `error`
//     event or an immediate non-zero `close` at open time (Req 5.5).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  createV4l2VirtualCamera,
  type SpawnFn as CameraSpawnFn,
} from './virtualCamera.js';
import {
  createPipeWireVirtualMicrophone,
  type SpawnFn as MicSpawnFn,
} from './virtualMicrophone.js';
import type { AvatarVideoFormat } from './avatarFormat.js';
import { TELEPHONY_PCM_8K, type AudioChunk } from '../voice/audio.js';
import type { Logger } from '../../types.js';

/**
 * A fake stdin: spy `write`/`end` plus a real EventEmitter. `write` invokes its
 * optional completion callback so the adapters' backpressure-honoring
 * `stdin.write(buf, cb)` resolves exactly as it would against a real pipe.
 */
class FakeStdin extends EventEmitter {
  write = vi.fn((_data: unknown, cb?: (err?: Error | null) => void): boolean => {
    if (typeof cb === 'function') {
      cb();
    }
    return true;
  });

  end = vi.fn();
}

/** A fake child process structurally compatible with what the adapters use. */
interface FakeChild extends EventEmitter {
  stdin: FakeStdin;
  kill: ReturnType<typeof vi.fn>;
}

/** Build a fresh fake child process with a controllable stdin + spies. */
function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new FakeStdin();
  child.kill = vi.fn();
  return child;
}

/** Build a fake `spawn` that records its calls and returns `child`. */
function createFakeSpawn(child: FakeChild): {
  spawn: CameraSpawnFn & MicSpawnFn;
  calls: Array<{ bin: string; args: readonly string[]; opts: unknown }>;
} {
  const calls: Array<{ bin: string; args: readonly string[]; opts: unknown }> = [];
  const spawn = vi.fn(
    (bin: string, args: readonly string[], opts: unknown): FakeChild => {
      calls.push({ bin, args, opts });
      return child;
    },
  ) as unknown as CameraSpawnFn & MicSpawnFn;
  return { spawn, calls };
}

/** A spy logger; both sinks are spies. */
function createSpyLogger(): Logger & {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), error: vi.fn() };
}

const CAMERA_DEVICE = '/dev/video9';
const CAMERA_BIN = '/usr/bin/ffmpeg';
const MIC_DEVICE = 'roza_test_sink';
const MIC_BIN = '/usr/bin/pw-cat';

const VIDEO_FORMAT: AvatarVideoFormat = {
  width: 512,
  height: 512,
  fps: 25,
  pixelFormat: 'yuv420p',
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('createV4l2VirtualCamera (Task 8.5)', () => {
  it('after open(format), spawns the configured device and writes frames to its stdin (Req 5.1)', async () => {
    const child = createFakeChild();
    const { spawn, calls } = createFakeSpawn(child);
    const logger = createSpyLogger();
    const camera = createV4l2VirtualCamera({
      spawn,
      device: CAMERA_DEVICE,
      binPath: CAMERA_BIN,
      logger,
    });

    const opened = camera.open(VIDEO_FORMAT);
    // Node emits 'spawn' once the child process is up; that is the open signal.
    child.emit('spawn');
    await opened;

    // Spawned exactly the configured binary, and the configured v4l2 device is
    // present as the sink argument.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.bin).toBe(CAMERA_BIN);
    expect(calls[0]!.args).toContain(CAMERA_DEVICE);
    expect(calls[0]!.args).toContain('v4l2');

    // Writing a Video_Frame forwards the bytes to the device via stdin.
    const frame = new Uint8Array([0x10, 0x20, 0x30, 0x40]);
    await camera.write(frame);

    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    const written = child.stdin.write.mock.calls[0]![0] as Buffer;
    expect(Buffer.isBuffer(written)).toBe(true);
    expect(Array.from(written)).toEqual([0x10, 0x20, 0x30, 0x40]);
  });

  it('rejects at open — naming the device — when the child emits an error event (Req 5.5)', async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const logger = createSpyLogger();
    const camera = createV4l2VirtualCamera({
      spawn,
      device: CAMERA_DEVICE,
      binPath: CAMERA_BIN,
      logger,
    });

    const opened = camera.open(VIDEO_FORMAT);
    child.emit('error', new Error('spawn ENOENT'));

    await expect(opened).rejects.toThrow(CAMERA_DEVICE);
    await expect(opened).rejects.toThrow(/ENOENT/);
    expect(logger.error).toHaveBeenCalled();
  });

  it('rejects at open — naming the device — on an immediate non-zero close (Req 5.5)', async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const logger = createSpyLogger();
    const camera = createV4l2VirtualCamera({
      spawn,
      device: CAMERA_DEVICE,
      binPath: CAMERA_BIN,
      logger,
    });

    const opened = camera.open(VIDEO_FORMAT);
    child.emit('close', 1);

    await expect(opened).rejects.toThrow(CAMERA_DEVICE);
    await expect(opened).rejects.toThrow(/code 1/);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('createPipeWireVirtualMicrophone (Task 8.5)', () => {
  it('after open(format), spawns the configured null sink and writes PCM to its stdin (Req 5.2)', async () => {
    const child = createFakeChild();
    const { spawn, calls } = createFakeSpawn(child);
    const logger = createSpyLogger();
    const mic = createPipeWireVirtualMicrophone({
      spawn,
      device: MIC_DEVICE,
      binPath: MIC_BIN,
      logger,
    });

    const opened = mic.open(TELEPHONY_PCM_8K);
    // Node emits 'spawn' once the playback child is up; that is the open signal.
    child.emit('spawn');
    await opened;

    // Spawned exactly the configured binary targeting the configured null sink.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.bin).toBe(MIC_BIN);
    expect(calls[0]!.args).toContain(MIC_DEVICE);

    // Writing a chunk forwards its raw PCM bytes (chunk.data) to the sink stdin.
    const data = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const chunk: AudioChunk = { format: TELEPHONY_PCM_8K, data };
    await mic.write(chunk);

    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    expect(child.stdin.write.mock.calls[0]![0]).toBe(data);
  });

  it('rejects at open — naming the device — when the child emits an error event (Req 5.5)', async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const logger = createSpyLogger();
    const mic = createPipeWireVirtualMicrophone({
      spawn,
      device: MIC_DEVICE,
      binPath: MIC_BIN,
      logger,
    });

    const opened = mic.open(TELEPHONY_PCM_8K);
    child.emit('error', new Error('spawn ENOENT'));

    await expect(opened).rejects.toThrow(MIC_DEVICE);
    await expect(opened).rejects.toThrow(/ENOENT/);
    expect(logger.error).toHaveBeenCalled();
  });

  it('rejects at open — naming the device — on an immediate non-zero close (Req 5.5)', async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const logger = createSpyLogger();
    const mic = createPipeWireVirtualMicrophone({
      spawn,
      device: MIC_DEVICE,
      binPath: MIC_BIN,
      logger,
    });

    const opened = mic.open(TELEPHONY_PCM_8K);
    child.emit('close', 1);

    await expect(opened).rejects.toThrow(MIC_DEVICE);
    await expect(opened).rejects.toThrow(/code 1/);
    expect(logger.error).toHaveBeenCalled();
  });
});
