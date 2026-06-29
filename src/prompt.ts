/**
 * System_Prompt builder (Component 8) — Req 6.3, 7.5, 7.6.
 *
 * Pure, side-effect-free assembly of the OpenRouter message array. It composes
 * Roza's static persona ({@link SYSTEM_PROMPT}) with the per-request relational
 * and conversational memory, then appends the user's turn:
 *
 *  - the relationship profile and the recent conversation history are injected
 *    into the System_Prompt context (Req 6.3);
 *  - up to the 50 most recently taught Swahili/Lingala terms are injected
 *    (Req 7.6);
 *  - exactly one target response language directive (French or English) is
 *    included for the current message (Req 7.5).
 *
 * The module performs no I/O; callers (the Cognitive Engine) supply already
 * retrieved, ordered, and capped memory via {@link PromptContext}.
 */

import type { HumanRelationship, Message } from './types.js';
import type { Lang, TaughtTerm } from './language.js';
import type { ChatMessage } from './llm.js';
import type { RozaProfile } from './profile.js';
import { buildPersona } from './persona.js';

/** Maximum recent messages injected into the prompt context (Req 6.2, 6.3). */
export const MAX_PROMPT_MESSAGES = 20;

/** Maximum taught terms injected into the prompt context (Req 7.6). */
export const MAX_PROMPT_TAUGHT_TERMS = 50;

/** Human-readable label for each supported response language (Req 7.5). */
const LANGUAGE_LABEL: Record<Lang, string> = {
  fr: 'French',
  en: 'English',
};

/**
 * Everything the prompt builder needs to assemble one request. All fields are
 * pre-retrieved by the engine: `recentMessages` is chronological (oldest first)
 * and `taughtTerms` is already the most-recent slice; both are defensively
 * re-capped here.
 */
export interface PromptContext {
  /** The loaded Roza profile rendered into the persona System_Prompt (Req 3.1, 3.4, 3.5). */
  profile: RozaProfile;
  /** The user's relational memory profile (Req 6.1, 6.3). */
  relationship: HumanRelationship;
  /** Recent conversation history, chronological (oldest first), up to 20 (Req 6.2, 6.3). */
  recentMessages: Message[];
  /** Previously taught Swahili/Lingala terms, up to 50 (Req 7.6). */
  taughtTerms: TaughtTerm[];
  /** The single target response language for this message (Req 7.5). */
  targetLanguage: Lang;
}

/** Render the relationship profile block injected into the system context (Req 6.3). */
function formatRelationship(rel: HumanRelationship): string {
  const name = rel.full_name?.trim() ? rel.full_name.trim() : 'Unknown';
  const role = rel.role?.trim() ? rel.role.trim() : 'Unknown';
  const lastInteraction = rel.last_interaction ?? 'never';
  return [
    'Relationship profile (your memory of this associate):',
    `- Name: ${name}`,
    `- Role: ${role}`,
    `- Affinity score (0.0-1.0): ${rel.affinity_score}`,
    `- Last interaction: ${lastInteraction}`,
  ].join('\n');
}

/** Render the taught-term block, capped at the 50 most recent (Req 7.6). */
function formatTaughtTerms(terms: TaughtTerm[]): string {
  const capped = terms.slice(Math.max(0, terms.length - MAX_PROMPT_TAUGHT_TERMS));
  if (capped.length === 0) {
    return 'Taught Swahili/Lingala terms: none yet.';
  }
  const lines = capped.map((t) => {
    const language = t.lang === 'sw' ? 'Swahili' : 'Lingala';
    return `- "${t.term}" (${language}) means "${t.meaning}"`;
  });
  return ['Taught Swahili/Lingala terms (use these when relevant):', ...lines].join('\n');
}

/** Render the recent conversation history block, chronological, capped at 20 (Req 6.3). */
function formatHistory(messages: Message[]): string {
  const capped = messages.slice(Math.max(0, messages.length - MAX_PROMPT_MESSAGES));
  if (capped.length === 0) {
    return 'Recent conversation history: none yet.';
  }
  const lines = capped.map((m) => {
    const speaker = m.sender_type === 'roza' ? 'Roza' : 'Associate';
    return `${speaker}: ${m.content}`;
  });
  return ['Recent conversation history (oldest first):', ...lines].join('\n');
}

/**
 * Build the single language directive naming exactly one target response
 * language (Req 7.5). The directive is the sole instruction in the prompt that
 * commands an output language, so it names French or English but never both.
 */
function formatLanguageDirective(lang: Lang): string {
  return `LANGUAGE DIRECTIVE: Respond to this message in ${LANGUAGE_LABEL[lang]} only.`;
}

/**
 * Build the full OpenRouter message array for one request (Req 6.3, 7.5, 7.6).
 *
 * Returns a leading `system` message carrying the persona plus the injected
 * relationship profile, taught terms, recent conversation history, and exactly
 * one language directive, followed by the user's turn as a `user` message.
 */
export function buildMessages(ctx: PromptContext, userMessage: string): ChatMessage[] {
  const systemContent = [
    buildPersona(ctx.profile),
    formatRelationship(ctx.relationship),
    formatTaughtTerms(ctx.taughtTerms),
    formatHistory(ctx.recentMessages),
    formatLanguageDirective(ctx.targetLanguage),
  ].join('\n\n');

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userMessage },
  ];
}
