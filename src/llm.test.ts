/**
 * Integration tests for the OpenRouter LLM client (`chatCompletion`).
 *
 * Validates: Requirements 5.1, 5.6, 5.7
 *
 * These tests stub the global `fetch` so no real network call is made. They
 * assert the API key travels only in the `Authorization` header, that it never
 * leaks into a returned reason, a thrown error, or console output, and that
 * every failure mode (non-2xx, network error, timeout, empty body) maps to a
 * `{ ok: false }` result.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatCompletion, type ChatMessage } from './llm.js';

const API_KEY = 'sk-or-secret-test-key-1234567890';
const CFG = { apiKey: API_KEY, model: 'test/model' };
const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'Hello Roza' }];

/** Build a minimal `Response`-like object for the stubbed fetch. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Captured console output across all console methods, joined per call. */
let consoleOutput: string[];

beforeEach(() => {
  consoleOutput = [];
  const capture =
    () =>
    (...args: unknown[]) => {
      consoleOutput.push(args.map((a) => String(a)).join(' '));
    };
  vi.spyOn(console, 'log').mockImplementation(capture());
  vi.spyOn(console, 'info').mockImplementation(capture());
  vi.spyOn(console, 'warn').mockImplementation(capture());
  vi.spyOn(console, 'error').mockImplementation(capture());
  vi.spyOn(console, 'debug').mockImplementation(capture());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('chatCompletion', () => {
  it('sends the API key as a Bearer Authorization header (Req 5.1)', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonResponse(200, {
          choices: [{ message: { content: 'Bonjour' } }],
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await chatCompletion(CFG, MESSAGES);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('returns { ok: true, content } on a successful 200 response (Req 5.1)', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        choices: [{ message: { content: '  trimmed answer  ' } }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await chatCompletion(CFG, MESSAGES);

    expect(result).toEqual({ ok: true, content: 'trimmed answer' });
  });

  it('returns { ok: false } with a key-free reason on a 401 response (Req 5.7, 5.8)', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(401, { error: { message: 'Unauthorized' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await chatCompletion(CFG, MESSAGES);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('401');
      expect(result.reason).not.toContain(API_KEY);
    }
  });

  it('returns { ok: false } with a key-free reason on a 500 response (Req 5.7)', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(500, { error: { message: 'Internal Server Error' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await chatCompletion(CFG, MESSAGES);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('500');
      expect(result.reason).not.toContain(API_KEY);
    }
  });

  it('returns { ok: false } when fetch rejects with a network error (Req 5.7)', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await chatCompletion(CFG, MESSAGES);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('failed');
      expect(result.reason).not.toContain(API_KEY);
    }
  });

  it('returns { ok: false } with a timeout reason when the request times out (Req 5.6)', async () => {
    // Mimic AbortSignal.timeout: fetch rejects with an Error named 'TimeoutError'.
    // A small timeoutMs keeps the test fast without waiting the 30s default.
    const fetchMock = vi.fn(async () => {
      const err = new Error('The operation timed out.');
      err.name = 'TimeoutError';
      throw err;
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await chatCompletion(CFG, MESSAGES, { timeoutMs: 5 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('timed out');
      expect(result.reason).toContain('5ms');
      expect(result.reason).not.toContain(API_KEY);
    }
  });

  it('returns { ok: false } when the response has empty content', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { choices: [{ message: { content: '   ' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await chatCompletion(CFG, MESSAGES);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('empty');
    }
  });

  it('returns { ok: false } when the response has missing choices', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    const result = await chatCompletion(CFG, MESSAGES);

    expect(result.ok).toBe(false);
  });

  it('never leaks the API key into console output across all paths (Req 5.1)', async () => {
    // Drive every branch, then assert nothing logged contained the key.
    const scenarios: Array<() => Response | never> = [
      () => jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
      () => jsonResponse(401, { error: { message: 'Unauthorized' } }),
      () => {
        throw new TypeError('Failed to fetch');
      },
      () => {
        const err = new Error('timeout');
        err.name = 'TimeoutError';
        throw err;
      },
      () => jsonResponse(200, {}),
    ];

    for (const produce of scenarios) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => produce()),
      );
      await chatCompletion(CFG, MESSAGES, { timeoutMs: 5 });
      vi.unstubAllGlobals();
    }

    for (const line of consoleOutput) {
      expect(line).not.toContain(API_KEY);
    }
  });
});
