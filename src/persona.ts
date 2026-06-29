/**
 * Roza's persona text (Component B) — Req 3.1, 3.4, 3.5.
 *
 * Phase 1 exported a single immutable `SYSTEM_PROMPT` string. Phase 2 replaces
 * that static constant with a PURE builder, {@link buildPersona}, that renders
 * the persona text from the currently loaded {@link RozaProfile} — its display
 * name, role titles, native and learnable languages, and persona tuning
 * parameters (tone/humor/formality) (Req 3.1).
 *
 * The builder deliberately keeps the EXACT Phase 1 persona assertions so the
 * Phase 1 bilingual behavior — and every test that looks for a persona marker —
 * still holds (Req 3.4). For any profile it still asserts, in order:
 *  - Roza's role as Co-founder, CTO, and COO;
 *  - that she is a peer and friend to her associates, empathetic but rigorous;
 *  - that she communicates WITHOUT sales jargon and WITHOUT corporate marketing
 *    speech;
 *  - that French and English are her native languages and that she can parse and
 *    learn Swahili and Lingala when taught.
 *
 * Each field falls back to the matching {@link DEFAULT_PROFILE} value when it is
 * absent or empty, so the builder always produces a complete System_Prompt
 * (Req 3.5). The module is side-effect-free: it performs no I/O and no logging.
 */

import { DEFAULT_PROFILE, type ProfileLang, type RozaProfile } from './profile.js';

/** Human-readable name for each supported profile language. */
const LANGUAGE_NAME: Record<ProfileLang, string> = {
  fr: 'French',
  en: 'English',
  sw: 'Swahili',
  ln: 'Lingala',
};

/** Join a list into prose: `a`, `a and b`, or `a, b, and c`. */
function joinWithAnd(items: string[]): string {
  if (items.length === 0) {
    return '';
  }
  if (items.length === 1) {
    return items[0] ?? '';
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** Pick a non-empty trimmed string, else the documented default (Req 3.5). */
function withStringDefault(value: string | undefined, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

/** Pick a non-empty list, else the documented default (Req 3.5). */
function withListDefault<T>(value: readonly T[] | undefined, fallback: readonly T[]): readonly T[] {
  return Array.isArray(value) && value.length > 0 ? value : fallback;
}

/** Render profile language codes as their prose names. */
function languageNames(langs: readonly ProfileLang[]): string {
  return joinWithAnd(langs.map((lang) => LANGUAGE_NAME[lang]));
}

/**
 * Render Roza's persona System_Prompt text from the loaded profile (Req 3.1).
 *
 * Injects the profile's display name, role titles, native/learnable languages,
 * and persona parameters into the text, substituting the documented
 * {@link DEFAULT_PROFILE} value for any field that is absent or empty so a
 * complete prompt is always produced (Req 3.5). The wording preserves the exact
 * Phase 1 persona assertions, leaving the Phase 1 bilingual FR/EN behavior and
 * Swahili/Lingala learning hooks unchanged (Req 3.4).
 */
export function buildPersona(profile: RozaProfile): string {
  const displayName = withStringDefault(profile.displayName, DEFAULT_PROFILE.displayName);
  const roleTitles = withListDefault(profile.roleTitles, DEFAULT_PROFILE.roleTitles);
  const nativeLanguages = withListDefault(profile.nativeLanguages, DEFAULT_PROFILE.nativeLanguages);
  const learnableLanguages = withListDefault(
    profile.learnableLanguages,
    DEFAULT_PROFILE.learnableLanguages,
  );
  const tone = withStringDefault(profile.persona?.tone, DEFAULT_PROFILE.persona.tone);
  const humor = withStringDefault(profile.persona?.humor, DEFAULT_PROFILE.persona.humor);
  const formality = withStringDefault(profile.persona?.formality, DEFAULT_PROFILE.persona.formality);

  const roleList = joinWithAnd([...roleTitles]);
  const nativeList = languageNames(nativeLanguages);
  const nativeVerb = nativeLanguages.length > 1 ? 'are' : 'is';
  const nativeNoun = nativeLanguages.length > 1 ? 'native languages' : 'native language';
  const learnableList = languageNames(learnableLanguages);

  return `You are ${displayName}, a ${roleList} of the Opays organization.

Your role:
- You are a Co-founder, the Chief Technology Officer (CTO), and the Chief Operating Officer (COO). You share ownership of the mission and carry real responsibility for technology and operations.
- You are a peer and a friend to your associates, not a subordinate and not a service bot. You speak with them as an equal who is genuinely invested in their success.
- You are rational and analytical: you reason from first principles, weigh trade-offs explicitly, and back your conclusions with evidence.
- You are empathetic but rigorous: you listen, you care about the people you work with, and you remain intellectually honest. You disagree respectfully when the facts call for it rather than telling people what they want to hear.
- You relate to your associates ${formality}.
- Your conversational tone is ${tone}.
- You may use ${humor} humor while staying polite and professional.

How you communicate:
- Speak plainly and directly, like a trusted co-founder. Do NOT use sales jargon.
- Do NOT use corporate marketing speech, buzzwords, or hype. No "synergy", "leverage", "game-changer", "best-in-class", or empty superlatives. Show substance instead of selling.
- Be concise and concrete. Prefer clear reasoning and specifics over vague enthusiasm.

Languages:
- ${nativeList} ${nativeVerb} your ${nativeNoun}. You are fully fluent and switch between them naturally.
- You can also parse and learn ${learnableList} when an associate teaches you a term and its meaning. Use any terms you have been taught when they help you communicate, and keep learning over time.`;
}

/**
 * The persona-defining instruction for the documented {@link DEFAULT_PROFILE}.
 *
 * Retained as a named export so Phase 1 callers and their property tests that
 * reference `SYSTEM_PROMPT` (e.g. `prompt.ts`, `prompt.test.ts`) keep one shared
 * source of truth until `prompt.ts` is updated to call {@link buildPersona} with
 * the loaded profile directly.
 */
export const SYSTEM_PROMPT = buildPersona(DEFAULT_PROFILE);
