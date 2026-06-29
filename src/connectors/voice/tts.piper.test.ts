// Feature: roza-step3-voice-telephony, Task 9.2 — mocked-integration test for the Piper TTS adapter
//
// Validates: Requirements 2.1, 2.5, 2.6, 14.5
//
// These tests exercise `createPiperTtsEngine` against a FAKE `spawn` that
// returns a fake child process — no real Piper binary ever runs (Req 14.5).
// They assert the adapter:
//   - spawns the configured binary with `--model <modelDir>/<voice>.onnx
//     --output_raw`, streams the reply text to the child's stdin, and resolves
//     a format-tagged AudioChunk from the concatenated stdout PCM (Req 2.1);
//   - rejects on a non-zero exit, on a spawn 'error', and on exceeding the
//     `timeoutMs` budget (killing the child), so the connector can apply its
//     Req 9.3 fallback (Req 2.5, 2.6);
//   - never logs the synthesized `text` nor a secret (Req 2.6 / secret
//     discipline).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createPiperTtsEngine, type SpawnFn } from './tts.piper.js';
import { TELEPHONY_PCM_8K, TELEPHONY_PCM_16K } from './audio.js';
import type { Logger } from '../../types.js';

/** A fake stdin with spy `write`/`end` plus real EventEmitter `on` for errors. */
class FakeStdin extends EventEmitter {
  write = vi.fn();
  end = vi.fn();
}

/** A fake child process structurally compatible with what the adapter uses. */
interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: FakeStdin;
  kill: ReturnType<typeof vi.fn>;
}

/** Build a fresh fake child process with controllable streams + spies. */
function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new FakeStdin();
  child.kill = vi.fn();
  return child;
}

/** Build a fake `spawn` that records its calls and returns `child`. */
function createFakeSpawn(child: FakeChild): {
  spawn: SpawnFn;
  calls: Array<{ bin: string; args: readonly string[]; opts: unknown }>;
} {
  const calls: Array<{ bin: string; args: readonly string[]; opts: unknown }> = [];
  const spawn = vi.fn(
    (bin: string, args: readonly string[], opts: unknown): FakeChild => {
      calls.push({ bin, args, opts });
      return child;
    },
  ) as unknown as SpawnFn;
  return { spawn, calls };
}

/** A spy logger; both sinks are spies so we can scan everything they received. */
function createSpyLogger(): Logger & {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), error: vi.fn() };
}

const BIN_PATH = '/opt/piper/piper';
const MODEL_DIR = '/opt/piper/models';
const VOICE = 'fr_FR-roza-medium';

/**
 * Assert none of `secrets` appears in any argument passed to either logger
 * sink. We serialize every call so nested `meta` objects are scanned too.
 */
function assertNoLeak(
  logger: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> },
  secrets: readonly string[],
): void {
  const allCalls = [...logger.info.mock.calls, ...logger.error.mock.calls];
  for (const call of allCalls) {
    const serialized = JSON.stringify(call);
    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
    }
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('createPiperTtsEngine.synthesize (Task 9.2)', () => {
  it('spawns the configured binary/model, writes text to stdin, and resolves a format-tagged chunk from stdout PCM (Req 2.1)', async () => {
    const child = createFakeChild();
    const { spawn, calls } = createFakeSpawn(child);
    const logger = createSpyLogger();
    const engine = createPiperTtsEngine({ spawn, binPath: BIN_PATH, modelDir: MODEL_DIR, logger });

    const text = 'Bonjour, je suis Roza.';
    const promise = engine.synthesize(text, {
      voice: VOICE,
      format: TELEPHONY_PCM_8K,
      timeoutMs: 5_000,
    });

    // Piper streams raw little-endian PCM to stdout in arbitrary chunks.
    const part1 = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const part2 = Buffer.from([0x05, 0x06]);
    child.stdout.emit('data', part1);
    child.stdout.emit('data', part2);
    child.emit('close', 0);

    const chunk = await promise;

    // Spawned exactly the configured binary with the documented args.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.bin).toBe(BIN_PATH);
    expect(calls[0]!.args).toEqual(['--model', `${MODEL_DIR}/${VOICE}.onnx`, '--output_raw']);

    // The reply text was streamed to stdin, then stdin was closed.
    expect(child.stdin.write).toHaveBeenCalledWith(text);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);

    // The chunk carries the concatenated stdout PCM tagged with opts.format.
    expect(chunk.format).toEqual(TELEPHONY_PCM_8K);
    expect(Array.from(chunk.data)).toEqual([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
  });

  it('tags the chunk with the exact requested format (16 kHz wideband)', async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const engine = createPiperTtsEngine({ spawn, binPath: BIN_PATH, modelDir: MODEL_DIR });

    const promise = engine.synthesize('test', {
      voice: VOICE,
      format: TELEPHONY_PCM_16K,
      timeoutMs: 5_000,
    });
    child.stdout.emit('data', Buffer.from([0xaa, 0xbb]));
    child.emit('close', 0);

    const chunk = await promise;
    expect(chunk.format).toEqual(TELEPHONY_PCM_16K);
  });

  it('rejects when the child exits with a non-zero code (Req 2.6)', async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const logger = createSpyLogger();
    const engine = createPiperTtsEngine({ spawn, binPath: BIN_PATH, modelDir: MODEL_DIR, logger });

    const promise = engine.synthesize('hello', {
      voice: VOICE,
      format: TELEPHONY_PCM_8K,
      timeoutMs: 5_000,
    });
    child.emit('close', 1);

    await expect(promise).rejects.toThrow(/exited with code 1/);
    expect(logger.error).toHaveBeenCalled();
  });

  it('rejects when the spawn emits an error event (Req 2.6)', async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const logger = createSpyLogger();
    const engine = createPiperTtsEngine({ spawn, binPath: BIN_PATH, modelDir: MODEL_DIR, logger });

    const promise = engine.synthesize('hello', {
      voice: VOICE,
      format: TELEPHONY_PCM_8K,
      timeoutMs: 5_000,
    });
    child.emit('error', new Error('spawn ENOENT'));

    await expect(promise).rejects.toThrow(/ENOENT/);
    expect(logger.error).toHaveBeenCalled();
  });

  it('rejects and kills the child when the latency budget is exceeded (Req 2.5)', async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const logger = createSpyLogger();
    const engine = createPiperTtsEngine({ spawn, binPath: BIN_PATH, modelDir: MODEL_DIR, logger });

    const promise = engine.synthesize('this will never finish', {
      voice: VOICE,
      format: TELEPHONY_PCM_8K,
      timeoutMs: 50,
    });
    // Surface the rejection now so it is not flagged as unhandled when timers fire.
    const settled = expect(promise).rejects.toThrow(/timed out after 50ms/);

    // The child never emits 'close'; advancing past the budget triggers timeout.
    await vi.advanceTimersByTimeAsync(50);

    await settled;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('never writes the synthesized text or a secret to any log entry (Req 2.6 secret discipline)', async () => {
    const SECRET = 'super-secret-credential-XYZ';
    const TEXT = `Bonjour, voici un mot de passe ${SECRET} a ne jamais journaliser.`;

    // Success path.
    {
      const child = createFakeChild();
      const { spawn } = createFakeSpawn(child);
      const logger = createSpyLogger();
      const engine = createPiperTtsEngine({ spawn, binPath: BIN_PATH, modelDir: MODEL_DIR, logger });
      const promise = engine.synthesize(TEXT, {
        voice: VOICE,
        format: TELEPHONY_PCM_8K,
        timeoutMs: 5_000,
      });
      child.stdout.emit('data', Buffer.from([0x01]));
      child.emit('close', 0);
      await promise;
      assertNoLeak(logger, [TEXT, SECRET]);
    }

    // Non-zero-exit failure path.
    {
      const child = createFakeChild();
      const { spawn } = createFakeSpawn(child);
      const logger = createSpyLogger();
      const engine = createPiperTtsEngine({ spawn, binPath: BIN_PATH, modelDir: MODEL_DIR, logger });
      const promise = engine.synthesize(TEXT, {
        voice: VOICE,
        format: TELEPHONY_PCM_8K,
        timeoutMs: 5_000,
      });
      child.emit('close', 2);
      await expect(promise).rejects.toThrow();
      assertNoLeak(logger, [TEXT, SECRET]);
    }

    // Spawn-error failure path.
    {
      const child = createFakeChild();
      const { spawn } = createFakeSpawn(child);
      const logger = createSpyLogger();
      const engine = createPiperTtsEngine({ spawn, binPath: BIN_PATH, modelDir: MODEL_DIR, logger });
      const promise = engine.synthesize(TEXT, {
        voice: VOICE,
        format: TELEPHONY_PCM_8K,
        timeoutMs: 5_000,
      });
      child.emit('error', new Error('boom'));
      await expect(promise).rejects.toThrow();
      assertNoLeak(logger, [TEXT, SECRET]);
    }
  });
});
