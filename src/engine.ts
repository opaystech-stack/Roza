/**
 * Cognitive Engine (Component 9) — the Memory Loop — Req 5, 6, 7, 9.
 *
 * The orchestrator that turns an incoming message into a persona-consistent
 * reply while maintaining Roza's relational and conversational memory. It wires
 * together the pure-logic modules (`language`, `prompt`) and the I/O modules
 * (`repository`, `llm`) behind a single `handleMessage` entrypoint that
 * implements the design's Memory Loop:
 *
 *   retrieve relational + conversational memory
 *     → resolve language → build the System_Prompt with injected memory
 *     → generate via OpenRouter → persist updated memory atomically.
 *
 * Crash/failure safety is structural: retrieval happens before generation, and
 * every memory mutation happens only after a successful generation, inside a
 * single `repo.tx` transaction. An LLM failure therefore mutates no memory
 * (Req 5.7, 6.10), and a taught-term write failure preserves prior notes while
 * still replying (Req 7.4).
 *
 * Phase 1 actively processes only the `internal` channel; requests on any other
 * channel are rejected without mutation (Req 9.3).
 */

import type { Channel, HumanRelationship, Logger } from './types.js';
import type { Repository } from './repository.js';
import type { RozaConfig } from './config.js';
import type { chatCompletion } from './llm.js';
import type { RozaProfile } from './profile.js';
import {
  appendTaughtTerm,
  detectLanguage,
  extractTaughtTerms,
  resolveResponseLanguage,
  parseTeachInstruction,
  type Lang,
} from './language.js';
import { buildMessages, MAX_PROMPT_MESSAGES, MAX_PROMPT_TAUGHT_TERMS } from './prompt.js';

/** Input to {@link CognitiveEngine.handleMessage} (design Component 9). */
export interface HandleMessageInput {
  /** Opaque Opays HQ user identifier the relationship is keyed on (Req 6.1). */
  userId: string;
  /** Conversation channel; only `internal` is operative in Phase 1 (Req 9.3). */
  channel: Channel;
  /** The raw user message text. */
  text: string;
}

/**
 * Result of {@link CognitiveEngine.handleMessage}. Success carries the reply and
 * the conversation it was stored against; failure carries a machine-readable
 * reason the caller can branch on without inspecting logs.
 */
export type HandleMessageResult =
  | { ok: true; reply: string; conversationId: string }
  | { ok: false; reason: 'channel_not_operative' | 'llm_failed' | 'config_missing' };

/** Constructor dependencies for the {@link CognitiveEngine}. */
export interface CognitiveEngineDeps {
  repo: Repository;
  llm: typeof chatCompletion;
  cfg: RozaConfig;
  now: () => Date;
  logger: Logger;
  /**
   * Live Roza_Profile accessor (Phase 2, Req 3.1, 2.4). The engine calls this
   * on every message so a profile edit applied to the holder takes effect on
   * subsequent prompts without a restart.
   */
  profile: () => RozaProfile;
}

/**
 * Pure: the set of operative channels given the configuration (Req 5.1, 5.5, 15.1).
 *
 * `internal` is always operative; `telegram` is operative iff the Telegram
 * channel is enabled; `email` is operative iff the Mail channel is enabled;
 * `voice` is now operative iff `cfg.voice.enabled` (Phase 3, Req 1.4). A
 * disabled voice channel — and any other non-operative channel — is still
 * rejected.
 */
export function operativeChannels(cfg: RozaConfig): Set<Channel> {
  const channels = new Set<Channel>(['internal']);
  if (cfg.telegram.enabled) {
    channels.add('telegram');
  }
  if (cfg.mail.enabled) {
    channels.add('email');
  }
  if (cfg.voice.enabled) {
    channels.add('voice');
  }
  return channels;
}

/** Outcome of classifying a channel request (Req 5.2, 5.3, 15.3). */
export type ChannelDecision = { ok: true } | { ok: false; reason: 'channel_not_operative' };

/**
 * Pure: classify a channel request against the operative set (Req 5.2, 5.3, 15.3).
 *
 * Returns `{ ok: true }` for an operative channel, and
 * `{ ok: false, reason: 'channel_not_operative' }` for a disabled `telegram`/
 * `email` channel or the always-rejected `voice` channel.
 */
export function decideChannel(channel: Channel, cfg: RozaConfig): ChannelDecision {
  if (operativeChannels(cfg).has(channel)) {
    return { ok: true };
  }
  return { ok: false, reason: 'channel_not_operative' };
}

/** Smallest affinity nudge applied per interaction (ambiguous message). */
const AFFINITY_STEP_BASE = 0.01;
/** Slightly larger nudge when the message language was confidently classified. */
const AFFINITY_STEP_CLASSIFIED = 0.02;

/** Clamp a value into the inclusive `[0.0, 1.0]` range, defaulting non-finite input. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * Compute the next `affinity_score` for a relationship (Req 6.6).
 *
 * Each interaction nudges affinity gently upward — a touch more when the
 * message language was classified — and the result is always clamped to the
 * inclusive `[0.0, 1.0]` range so the column's CHECK constraint can never be
 * violated regardless of the prior (possibly out-of-range) stored value.
 */
export function nextAffinity(
  rel: HumanRelationship,
  det: { lang: Lang | null; confidence: number },
): number {
  const base = Number.isFinite(rel.affinity_score) ? rel.affinity_score : 0.5;
  const step = det.lang !== null ? AFFINITY_STEP_CLASSIFIED : AFFINITY_STEP_BASE;
  return clamp01(base + step);
}

/**
 * The Cognitive Engine. Construct it once with its dependencies and call
 * {@link CognitiveEngine.handleMessage} per incoming message, or
 * {@link CognitiveEngine.runAutonomousTask} from the scheduler tick.
 */
export class CognitiveEngine {
  private readonly repo: Repository;
  private readonly llm: typeof chatCompletion;
  private readonly cfg: RozaConfig;
  private readonly now: () => Date;
  private readonly logger: Logger;
  private readonly profile: () => RozaProfile;

  constructor(deps: CognitiveEngineDeps) {
    this.repo = deps.repo;
    this.llm = deps.llm;
    this.cfg = deps.cfg;
    this.now = deps.now;
    this.logger = deps.logger;
    this.profile = deps.profile;
  }

  /**
   * Run one turn of the Memory Loop (Req 5, 6, 7, 9).
   *
   * Rejects non-`internal` channels and a missing API key before touching
   * memory, retrieves relational + conversational context, resolves the target
   * language, builds the prompt, generates a reply, and — only on success —
   * persists both messages and the relationship update atomically. Any LLM
   * failure returns an error result and mutates nothing.
   */
  async handleMessage(input: HandleMessageInput): Promise<HandleMessageResult> {
    const { userId, channel, text } = input;

    // Operative-channel gate (Phase 2, Req 5.2, 5.3, 15.3): `internal` is
    // always operative, `telegram`/`email` iff enabled, `voice` never. A
    // non-operative channel is rejected and causes no mutation.
    const decision = decideChannel(channel, this.cfg);
    if (!decision.ok) {
      this.logger.error('Rejected message on non-operative channel', { channel });
      return { ok: false, reason: 'channel_not_operative' };
    }

    // Fail fast (and mutate nothing) when the OpenRouter credential is blank, so
    // we never reach the API or the Messages history (Req 5.2).
    if (this.cfg.openRouterApiKey.trim().length === 0) {
      this.logger.error('Cannot generate response: OPENROUTER_API_KEY is missing or empty.');
      return { ok: false, reason: 'config_missing' };
    }

    // 1. RETRIEVE relational memory, creating the profile on first contact
    //    (Req 6.1, 6.8).
    const rel =
      this.repo.getRelationshipByUserId(userId) ??
      this.repo.createRelationship({ userId });

    // 2. RESOLVE the conversation on the originating channel, creating it if
    //    needed (Req 6.9, 6.4, 7.4, 8.6).
    const conv =
      this.repo.getOpenConversation(userId, channel) ??
      this.repo.createConversation(userId, channel);

    // 3. RETRIEVE the 20 most recent messages, newest-first (Req 6.2).
    const recent = this.repo.getRecentMessages(conv.id, MAX_PROMPT_MESSAGES);

    // 4. LANGUAGE: detect this message, then resolve the single target language
    //    using the remembered last language as a fallback (Req 7.1, 7.2).
    const det = detectLanguage(text);
    const lang = resolveResponseLanguage(det, rel.last_language);

    // 4b. LEARNING HOOK: parse any teach instruction now; it is persisted only
    //     on the success path (Req 7.3, 7.4).
    const taught = parseTeachInstruction(text);

    // 5. INJECT memory into the System_Prompt context. `recent` is newest-first
    //    from the repository, so reverse it to chronological order for the
    //    prompt (Req 6.3, 7.6).
    const terms = extractTaughtTerms(rel.personality_notes, MAX_PROMPT_TAUGHT_TERMS);
    const messages = buildMessages(
      {
        profile: this.profile(),
        relationship: rel,
        recentMessages: [...recent].reverse(),
        taughtTerms: terms,
        targetLanguage: lang,
      },
      text,
    );

    // 6. GENERATE with a 30-second timeout (Req 5.1, 5.6). On any failure log the
    //    cause and return without mutating memory (Req 5.7, 6.10).
    const res = await this.llm(
      { apiKey: this.cfg.openRouterApiKey, model: this.cfg.openRouterModel },
      messages,
      { timeoutMs: 30_000 },
    );
    if (!res.ok) {
      this.logger.error('LLM generation failed; no memory mutated', { reason: res.reason });
      return { ok: false, reason: 'llm_failed' };
    }

    const reply = res.content;
    const ts = this.now().toISOString();

    // Resolve the next personality_notes, tolerating a taught-term serialization
    // failure by preserving the prior notes so the reply still succeeds (Req 7.4).
    const nextNotes = this.resolveNextNotes(rel.personality_notes, taught);

    // 7. UPDATE memory atomically — all-or-nothing (Req 6.4–6.7). A thrown write
    //    rolls back every mutation, preserving prior state (Req 6.10).
    this.repo.tx(() => {
      this.repo.addMessage({ conversationId: conv.id, senderType: 'user', content: text, createdAt: ts });
      this.repo.addMessage({ conversationId: conv.id, senderType: 'roza', content: reply, createdAt: ts });
      this.repo.touchConversation(conv.id, ts);
      this.repo.updateRelationship(rel.id, {
        last_interaction: ts,
        last_language: lang,
        affinity_score: nextAffinity(rel, det),
        personality_notes: nextNotes,
      });
    });

    return { ok: true, reply, conversationId: conv.id };
  }

  /**
   * Internal reflection entrypoint invoked by the scheduler (Req 2.5).
   *
   * Records the task invocation and writes a private encrypted journal entry.
   * Kept deliberately simple and robust: any failure is logged and swallowed so
   * a single bad tick never crashes the scheduler loop (Req 2.6); the caller's
   * own try/catch is the outer safety net.
   */
  async runAutonomousTask(): Promise<void> {
    const ts = this.now().toISOString();
    try {
      this.repo.recordTaskInvocation(ts);
      this.repo.writeJournal({
        thought: `Autonomous reflection at ${ts}: reviewed state, no external action taken.`,
        mood: 'neutral',
        createdAt: ts,
      });
    } catch (err) {
      this.logger.error('Autonomous task failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return Promise.resolve();
  }

  /**
   * Compute the relationship's next `personality_notes`. When a taught term was
   * parsed, append it defensively; if serialization throws for any reason, keep
   * the prior notes unchanged so the reply is never blocked (Req 7.4).
   */
  private resolveNextNotes(
    priorNotes: string,
    taught: ReturnType<typeof parseTeachInstruction>,
  ): string {
    if (taught === null) {
      return priorNotes;
    }
    try {
      return appendTaughtTerm(priorNotes, taught);
    } catch (err) {
      this.logger.error('Failed to record taught term; preserving prior notes', {
        message: err instanceof Error ? err.message : String(err),
      });
      return priorNotes;
    }
  }
}
