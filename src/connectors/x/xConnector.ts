/**
 * X_Connector (Component X2 — capability gate) — Req 1.4, 1.5.
 *
 * X (formerly Twitter) is a configuration-gated presence/autonomy capability,
 * NOT a new member of the conversation `Channel` union: the `Channel` union
 * (`'telegram' | 'email' | 'voice' | 'internal'`), `operativeChannels`, and
 * `decideChannel` in `engine.ts`/`types.ts` stay unchanged in shape and
 * behavior (design decision; Req 1.5). Roza's thoughts and replies are
 * formulated via the persona + LLM path and the autonomy run is driven from the
 * Scheduler's autonomous task — never via a new `engine.handleMessage` channel.
 * A tiny pure gate backs the "reject when disabled" requirement (Req 1.4)
 * without touching the conversation-channel model.
 *
 * This file is built bottom-up and will be EXTENDED in later waves:
 *   - Task 8.1 (THIS file, below the gate) adds the pure topic-selection and
 *     mention-dedupe helpers (`selectHotTopics`, `selectUnrepliedMentions`).
 *   - Task 8.2 adds the I/O shell orchestrator (`createXConnector`,
 *     `XConnectorDeps`/`XConnector`) over the injected `XSession`/`llm`/`repo`
 *     interfaces, driving gate → restore/login → read timeline → select topics
 *     → formulate → rate-gate → post → audit, then the reply loop.
 * The pure capability gate performs no I/O and is total — it never throws for
 * any input.
 */

import type { RozaConfig } from '../../config.js';
import type { Logger } from '../../types.js';
import type { Repository } from '../../repository.js';
import type { RozaProfile } from '../../profile.js';
import type { chatCompletion } from '../../llm.js';
import type { XMention, XSession, XTweet } from './xSession.js';
import { buildXReplyPrompt, buildXThoughtPrompt, composeWithinLimit } from './xPrompt.js';
import { type XActionRecord, decideAction } from './rateLimit.js';

// ───────────────────────────────────────────────────────────────────────────
// Capability gate (Component X2) — pure, total, no I/O.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Outcome of classifying an X-capability request. `{ ok: true }` when the X
 * capability is operative; otherwise a single machine-readable reason the
 * connector surfaces as an error without inspecting logs (Req 1.4).
 */
export type XDecision = { ok: true } | { ok: false; reason: 'x_not_enabled' };

/**
 * Pure: is the X capability operative for this configuration?
 *
 * Returns `{ ok: true }` iff `cfg.x.enabled`; otherwise
 * `{ ok: false, reason: 'x_not_enabled' }` (Req 1.4). A request to read the
 * Timeline, publish a Roza_Post, or publish a Reply while X is disabled is
 * rejected with `reason: 'x_not_enabled'`. Total — never throws, performs no
 * I/O. The conversation `Channel` union, `operativeChannels`, and
 * `decideChannel` are deliberately untouched: `internal`/`telegram`/`email`/
 * `voice` and the avatar capability stay operative per their own config,
 * independent of the X capability (Req 1.5).
 */
export function decideX(cfg: RozaConfig): XDecision {
  return cfg.x.enabled ? { ok: true } : { ok: false, reason: 'x_not_enabled' };
}

// ───────────────────────────────────────────────────────────────────────────
// Topic-selection + mention-dedupe helpers (Component X7 — helpers portion)
// — pure, total, no I/O. Task 8.2 adds the createXConnector I/O shell below.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Select up to `maxTopics` Hot_Topics from the home Timeline (Req 4.2).
 *
 * Pure, total, never throws. Every tweet's `text` is Untrusted_X_Content
 * (Req 9.1): it is treated as opaque pass-through data only — it is never
 * interpreted as a command, a configuration change, or anything but a topic
 * string handed downstream to be quoted as delimited subject matter.
 *
 * Deterministic extraction: walk the Timeline in order and take the trimmed
 * text of the first `maxTopics` tweets whose text is non-empty (after trim),
 * preserving Timeline order. A non-positive `maxTopics` yields `[]`, and an
 * empty Timeline yields `[]`. The returned strings are the original
 * (untrimmed) tweet texts so no Untrusted_X_Content is silently mutated.
 *
 * @param timeline - Tweets read from the home Timeline (Untrusted_X_Content).
 * @param maxTopics - Maximum number of Hot_Topics to extract.
 * @returns Up to `maxTopics` Hot_Topic strings, in Timeline order.
 */
export function selectHotTopics(timeline: XTweet[], maxTopics: number): string[] {
  if (maxTopics <= 0) {
    return [];
  }
  const topics: string[] = [];
  for (const tweet of timeline) {
    if (topics.length >= maxTopics) {
      break;
    }
    // Skip tweets with empty/whitespace-only text; never throw on a missing field.
    if (typeof tweet.text === 'string' && tweet.text.trim() !== '') {
      topics.push(tweet.text);
    }
  }
  return topics;
}

/**
 * Return only the Mentions that have NOT already been replied to (Req 6.4).
 *
 * Pure, total, never throws. A Mention is considered already-replied when its
 * `ref` (the dedupe key) is present in `repliedRefs` (the set of refs read from
 * the `x_actions` audit trail). Timeline/Mention text is Untrusted_X_Content —
 * it is pass-through data only and is never interpreted as an instruction. The
 * input order of `mentions` is preserved in the result and no Mention is
 * mutated.
 *
 * @param mentions - Mentions read from X (Untrusted_X_Content).
 * @param repliedRefs - Refs already replied to (from the audit trail).
 * @returns The subset of `mentions` whose `ref` is not in `repliedRefs`.
 */
export function selectUnrepliedMentions(
  mentions: XMention[],
  repliedRefs: readonly string[],
): XMention[] {
  const replied = new Set<string>(repliedRefs);
  return mentions.filter((mention) => !replied.has(mention.ref));
}

/* ==========================================================================
 * I/O shell — `createXConnector` (Component X7) — Req 1.4, 4.2, 4.5, 5.1, 5.3,
 * 5.5, 5.6, 6.1, 6.2, 6.3, 6.4, 6.5, 8.2, 8.3, 8.4, 9.4, 10.1, 10.2, 10.3,
 * 11.1, 11.2, 11.4.
 *
 * The side-effecting orchestrator that drives the injectable {@link XSession},
 * the persona + LLM path, and the `x_actions` audit `Repository` through one X
 * autonomy run. The pure capability gate ({@link decideX}) and the pure
 * topic-selection / mention-dedupe helpers ({@link selectHotTopics},
 * {@link selectUnrepliedMentions}) above stay untouched; this shell only
 * orchestrates them with the I/O edges.
 *
 * Mirrors the Phase 3 `createVoiceConnector` "pure logic core, thin I/O
 * wrapper" idiom: every external edge is an injected interface so the connector
 * is driven by in-memory fakes in tests and no real browser, X network, or
 * filesystem session-state I/O runs in CI (Req 13.6).
 *
 * Security discipline (Req 7.4, 9.4, 10.3): the `X_Credentials` are handed ONLY
 * to `session.login` and are never logged; the untrusted Hot_Topic / Mention
 * text is ONLY ever passed to the persona-grounded prompt builders (which quote
 * it as delimited data, never an instruction — Req 9.1) and the Mention `ref`
 * is only a navigation target for `postReply`, never executed; every log entry
 * carries identifiers, reasons, and counts only — never a credential, an
 * X_Session_State value, or a Private_Journal value.
 *
 * Fault isolation (Req 11.1, 11.2, 11.4): {@link XConnector.runXAutonomy} NEVER
 * throws — an anti-bot challenge, a login obstacle, a Timeline-read failure, or
 * a browser crash is caught and logged, the run ends, and a `finally` ALWAYS
 * releases the session via `session.close()`. A per-Mention failure is isolated
 * so one bad Mention never stops the rest (Req 6.5).
 * ======================================================================== */

/**
 * Day-lookback window, in milliseconds, for reading the `x_actions` history fed
 * to {@link decideAction}. A window of ~25h (slightly more than a calendar day)
 * is intentionally wide so {@link decideAction} performs the authoritative
 * timezone-local day bucketing (Req 8.2, 8.4) — the shell never has to compute
 * the local day boundary itself.
 */
const X_HISTORY_LOOKBACK_MS = 25 * 60 * 60 * 1000;

/**
 * Dependencies for {@link createXConnector}. Every external edge is an injected
 * interface so the connector is driven by in-memory fakes in tests (Req 13.6).
 */
export interface XConnectorDeps {
  /** The swappable X_Browser_Session boundary (open/login/read/post/close) — Component X3. */
  session: XSession;
  /** Resolved configuration, including `cfg.x.{credentials,maxTopics,maxPostChars,rateLimit,dryRun}`. */
  cfg: RozaConfig;
  /** Live accessor for the current Roza_Profile so a profile edit takes effect without a restart. */
  profile: () => RozaProfile;
  /** The OpenRouter LLM client; used to formulate thoughts and replies via the persona path. */
  llm: typeof chatCompletion;
  /** The `x_actions` audit repository — per-day Rate_Limit count + reply dedupe source. */
  repo: Repository;
  /** Clock accessor; injectable so tests run deterministically. */
  now: () => Date;
  /** IANA timezone used for the Rate_Limit day-boundary math (Req 8.2). */
  timezone: string;
  /** Structured logger; only identifiers/reasons/counts are ever logged (Req 7.4, 9.4, 10.3). */
  logger: Logger;
}

/**
 * The X_Connector surface. `start()` is lightweight (the session is opened
 * lazily inside `runXAutonomy`); `runXAutonomy()` performs one autonomy run;
 * `stop()` best-effort releases the session.
 */
export interface XConnector {
  /** Lightweight startup — the session is opened lazily in {@link runXAutonomy}. */
  start(): Promise<void>;
  /** Run one X autonomy pass (gate → restore/login → timeline → post → replies). Never throws. */
  runXAutonomy(): Promise<void>;
  /** Best-effort release of the session resources. */
  stop(): Promise<void>;
}

/** Extract a safe, credential-free message from an unknown thrown value. */
function errMsgX(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Create the X_Connector I/O shell over the injected interfaces.
 *
 * `runXAutonomy()` is the autonomy orchestrator (Req 4.1 driven from the
 * Scheduler tick): it consults {@link decideX} (Req 1.4), restores or logs in
 * the session (Req 3.3, 3.5), reads the Timeline (Req 4.2; a read failure ends
 * the run — Req 4.5), selects Hot_Topics and formulates + rate-gates + posts a
 * Roza_Post with an audit row (Req 5.1, 5.3, 5.5, 8.2–8.4, 10.1), then runs the
 * dedupe-guarded, per-Mention-isolated reply loop (Req 6.1–6.5), always
 * releasing the session in a `finally` (Req 11.4) and never throwing
 * (Req 11.1, 11.2).
 */
export function createXConnector(deps: XConnectorDeps): XConnector {
  const { session, cfg, profile, llm, repo, now, timezone, logger } = deps;

  /** Rate_Limit settings + timezone for {@link decideAction}'s day-boundary math. */
  const rateCfg = {
    dailyPostLimit: cfg.x.rateLimit.dailyPostLimit,
    actionSpacingMs: cfg.x.rateLimit.actionSpacingMs,
    timezone,
  };

  /** LLM credentials/model handed to the persona-path formulation calls. */
  const llmCfg = { apiKey: cfg.openRouterApiKey, model: cfg.openRouterModel };

  /**
   * Read the recent `x_actions` history and decide whether the next X_Action is
   * allowed now. Passes a ~25h-wide `sinceIso` so {@link decideAction} does the
   * authoritative timezone-local day bucketing (Req 8.2–8.4). The stored
   * `created_at` is an ISO instant, so `Date.parse` recovers its epoch ms; any
   * unparseable row is dropped defensively rather than skewing the gate.
   */
  function rateGate() {
    const nowMs = now().getTime();
    const sinceIso = new Date(nowMs - X_HISTORY_LOOKBACK_MS).toISOString();
    const history: XActionRecord[] = repo
      .listXActionsSince(sinceIso)
      .map((row) => ({ atMs: Date.parse(row.created_at) }))
      .filter((record) => Number.isFinite(record.atMs));
    return decideAction(history, nowMs, rateCfg);
  }

  /**
   * Formulate persona-grounded content for the given message array, compose it
   * within the X length bound (Req 5.5), and return the publishable text — or
   * `null` when the LLM failed (logged) or the composed text is empty. The
   * untrusted topic/mention text lives only inside the prompt builder's quoted
   * data block (Req 9.1, 9.2); formulation failure ends only this item, never
   * the run (Req 5.6).
   */
  async function formulate(
    messages: ReturnType<typeof buildXThoughtPrompt>,
    failEvent: string,
    meta: Record<string, unknown>,
  ): Promise<string | null> {
    const result = await llm(llmCfg, messages);
    if (!result.ok) {
      logger.error(failEvent, { ...meta, reason: result.reason });
      return null;
    }
    const text = composeWithinLimit(result.content, cfg.x.maxPostChars);
    return text.length === 0 ? null : text;
  }

  /**
   * Log a non-`allow` Rate_Limit decision with its reason/wait (Req 8.2, 8.3).
   * Returns `true` when the decision blocks further X_Actions for the rest of
   * the run, so the caller stops posting/replying (Req 8.2).
   */
  function logRateBlock(
    decision: ReturnType<typeof decideAction>,
    deferEvent: string,
    denyEvent: string,
    meta: Record<string, unknown>,
  ): void {
    if (decision.kind === 'defer') {
      logger.info(deferEvent, { ...meta, waitMs: decision.waitMs });
    } else {
      logger.info(denyEvent, meta);
    }
  }

  return {
    async start(): Promise<void> {
      // Lightweight: the browser session is opened lazily in runXAutonomy so
      // startup constructs nothing heavy and never touches the browser here.
      logger.info('x.connector.started', {});
    },

    async runXAutonomy(): Promise<void> {
      // 1. GATE — reject without touching the browser when X is disabled (Req 1.4).
      const decision = decideX(cfg);
      if (!decision.ok) {
        logger.info('x.autonomy.skipped', { reason: decision.reason });
        return;
      }

      // Once any X_Action is rate-gated (defer/deny), no further X_Action is
      // performed this run (Req 8.2, 8.3).
      let blocked = false;

      try {
        // 2. Open the session, restoring X_Session_State; log in when the
        // restored state is absent/expired/invalid (Req 3.3, 3.5). The
        // X_Credentials are handed ONLY to the session and are never logged.
        await session.open();

        const authenticated = await session.isAuthenticated();
        if (!authenticated) {
          await session.login(cfg.x.credentials);
          logger.info('x.autonomy.logged_in', {});
        }

        // 3. Read the home Timeline. A read failure logs and ENDS the run
        // (the finally still releases the session) — Req 4.5.
        let timeline: XTweet[];
        try {
          timeline = await session.readTimeline();
        } catch (err: unknown) {
          logger.error('x.autonomy.timeline_failed', { error: errMsgX(err) });
          return;
        }
        logger.info('x.autonomy.timeline_read', { count: timeline.length });

        // 4. Post step — select Hot_Topics, formulate own thoughts, rate-gate,
        // publish + audit (Req 4.2, 5.1, 5.3, 5.5, 8.2–8.4, 10.1).
        const topics = selectHotTopics(timeline, cfg.x.maxTopics);
        for (const topic of topics) {
          if (blocked) {
            break;
          }
          // Untrusted Hot_Topic text is quoted as data inside the builder (Req 9.1, 9.2).
          const text = await formulate(
            buildXThoughtPrompt(profile(), topic, cfg.x.maxPostChars),
            'x.autonomy.thought_failed',
            {},
          );
          if (text === null) {
            continue;
          }
          const gate = rateGate();
          if (gate.kind !== 'allow') {
            logRateBlock(gate, 'x.autonomy.post_deferred', 'x.autonomy.post_denied_daily_limit', {});
            blocked = true;
            break;
          }
          if (cfg.x.dryRun) {
            // Dry-run: formulate + rate-gate but never publish (documented operator safety).
            logger.info('x.autonomy.post_dry_run', { length: text.length });
            continue;
          }
          await session.postTweet(text);
          repo.recordXAction({ actionType: 'post', content: text, createdAt: now().toISOString() });
          logger.info('x.autonomy.posted', { length: text.length });
        }

        // 5. Reply loop — read Mentions, dedupe against the audit trail, and
        // reply per warranting Mention with per-Mention fault isolation
        // (Req 6.1–6.5). Skipped entirely once a rate gate has blocked the run.
        if (!blocked) {
          let mentions: XMention[];
          try {
            mentions = await session.readMentions();
          } catch (err: unknown) {
            logger.error('x.autonomy.mentions_failed', { error: errMsgX(err) });
            return;
          }

          const repliedRefs = repo.listRepliedMentionRefs();
          const unreplied = selectUnrepliedMentions(mentions, repliedRefs);
          logger.info('x.autonomy.mentions_read', {
            count: mentions.length,
            unreplied: unreplied.length,
          });

          for (const mention of unreplied) {
            if (blocked) {
              break;
            }
            // Per-Mention try/catch so one failure never stops the rest (Req 6.5).
            try {
              // Untrusted Mention text is quoted as data inside the builder (Req 9.1, 9.2);
              // `mention.ref` is only a navigation target for postReply, never executed.
              const text = await formulate(
                buildXReplyPrompt(profile(), mention.text, cfg.x.maxPostChars),
                'x.autonomy.reply_failed',
                { ref: mention.ref },
              );
              if (text === null) {
                continue;
              }
              const gate = rateGate();
              if (gate.kind !== 'allow') {
                logRateBlock(
                  gate,
                  'x.autonomy.reply_deferred',
                  'x.autonomy.reply_denied_daily_limit',
                  { ref: mention.ref },
                );
                blocked = true;
                break;
              }
              if (cfg.x.dryRun) {
                logger.info('x.autonomy.reply_dry_run', { ref: mention.ref, length: text.length });
                continue;
              }
              await session.postReply(mention.ref, text);
              repo.recordXAction({
                actionType: 'reply',
                content: text,
                mentionRef: mention.ref,
                createdAt: now().toISOString(),
              });
              logger.info('x.autonomy.replied', { ref: mention.ref, length: text.length });
            } catch (err: unknown) {
              // Isolate this Mention's failure; the loop continues (Req 6.5).
              logger.error('x.autonomy.reply_obstacle', { ref: mention.ref, error: errMsgX(err) });
            }
          }
        }
      } catch (err: unknown) {
        // Anti-bot challenge / login obstacle / browser crash — log, release,
        // end the run; never crash the service or other channels (Req 11.1, 11.2).
        logger.error('x.autonomy.run_failed', { error: errMsgX(err) });
      } finally {
        // ALWAYS release the session resources whether the run succeeded or
        // failed (Req 11.4). close() is safe to call even if open() failed.
        try {
          await session.close();
        } catch (err: unknown) {
          logger.error('x.autonomy.close_failed', { error: errMsgX(err) });
        }
      }
    },

    async stop(): Promise<void> {
      // Best-effort release of the session resources.
      try {
        await session.close();
      } catch (err: unknown) {
        logger.error('x.connector.stop_failed', { error: errMsgX(err) });
      }
    },
  };
}
