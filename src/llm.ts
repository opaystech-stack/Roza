/**
 * OpenRouter LLM client (Component 6) — Req 5.1, 5.6, 5.7.
 *
 * Minimal client for the OpenAI-compatible OpenRouter Chat Completions
 * endpoint, mirroring the proven Opays HQ `server/llm.ts` pattern. Roza adds a
 * 30-second request timeout via `AbortSignal.timeout` (Req 5.6) and returns a
 * discriminated `LlmResult` instead of throwing, so the Cognitive Engine can
 * map failures to a no-mutation error path (Req 5.7).
 *
 * The API key is sent only in the `Authorization` header and is NEVER logged,
 * returned, or otherwise exposed.
 */

/** A single chat message in the OpenAI-compatible format. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Result of a chat completion call. Success carries the assistant text;
 * failure carries a human-readable reason (HTTP status, network error, empty
 * response, or timeout) suitable for an error log — never the API key.
 */
export type LlmResult =
  | { ok: true; content: string }
  | { ok: false; reason: string };

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** Default request timeout in milliseconds (Req 5.6). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Shape of the relevant fields in an OpenRouter chat completion response. */
interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

/**
 * Call the OpenRouter chat completions endpoint and return the assistant text.
 *
 * Returns `{ ok: false, reason }` on a non-2xx HTTP status, a network error, an
 * empty response body, or a timeout (Req 5.7). Returns `{ ok: true, content }`
 * with the trimmed assistant message on success. Applies a default 30-second
 * timeout (Req 5.6) that callers may override via `opts.timeoutMs`.
 */
export async function chatCompletion(
  cfg: { apiKey: string; model: string },
  messages: ChatMessage[],
  opts?: { temperature?: number; timeoutMs?: number },
): Promise<LlmResult> {
  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        // Attribution headers recommended by OpenRouter.
        'HTTP-Referer': 'https://hq.opays.io',
        'X-Title': 'Roza Agent',
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: opts?.temperature ?? 0.7,
      }),
      // AbortSignal fires after the timeout, surfacing as a rejected fetch.
      signal: AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    // Covers both network failures and the timeout abort. Never logs the key.
    const reason =
      err instanceof Error && err.name === 'TimeoutError'
        ? `OpenRouter request timed out after ${opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
        : `OpenRouter request failed: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, reason };
  }

  if (!res.ok) {
    // Report only the status and any error message; never the API key.
    let detail = '';
    try {
      const body = (await res.json()) as ChatCompletionResponse;
      detail = body?.error?.message ?? '';
    } catch {
      /* response body was not JSON; status alone is enough */
    }
    return {
      ok: false,
      reason: `OpenRouter responded ${res.status}${detail ? `: ${detail}` : ''}`,
    };
  }

  let data: ChatCompletionResponse;
  try {
    data = (await res.json()) as ChatCompletionResponse;
  } catch (err) {
    return {
      ok: false,
      reason: `OpenRouter returned an unparseable response: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    return { ok: false, reason: 'OpenRouter returned an empty response' };
  }

  return { ok: true, content };
}
