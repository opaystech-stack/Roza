/**
 * Language module (Component 7) — Req 7.1, 7.2, 7.3, 7.4, 7.6.
 *
 * Pure, side-effect-free helpers for Roza's bilingual (FR/EN) behavior and her
 * Swahili/Lingala learning hooks:
 *
 *  - `detectLanguage`        — heuristic FR/EN classification with a confidence
 *                              score, returning a `null` language when the text
 *                              is too short or ambiguous to classify (Req 7.1).
 *  - `resolveResponseLanguage` — picks exactly one target language: a confident
 *                              detection, else the last detected language, else
 *                              French (Req 7.1, 7.2).
 *  - `parseTeachInstruction` — extracts a taught term + meaning from a natural
 *                              "teach me X means Y" instruction (Req 7.3).
 *  - `appendTaughtTerm` / `extractTaughtTerms` — serialize and read taught terms
 *                              stored inside the `personality_notes` JSON blob,
 *                              capping at the most-recent `max` (50) entries and
 *                              treating malformed JSON defensively (Req 7.4, 7.6).
 *
 * The module performs no I/O and never throws on malformed stored data.
 */

/** A language Roza natively responds in (Req 5.5, 7.1). */
export type Lang = 'fr' | 'en';

/** A Swahili or Lingala term Roza has been taught (Req 7.3). */
export interface TaughtTerm {
  term: string;
  meaning: string;
  lang: 'sw' | 'ln';
}

/**
 * Minimum confidence for a fresh detection to override the conversation's
 * remembered language. Below this, resolution falls back to the last detected
 * language (Req 7.2).
 */
export const CONFIDENCE_THRESHOLD = 0.6;

/** Maximum taught terms injected into / extracted from `personality_notes` (Req 7.6). */
export const MAX_TAUGHT_TERMS = 50;

/** Shape of the JSON stored in `human_relationships.personality_notes`. */
interface PersonalityNotes {
  notes: string;
  taughtTerms: TaughtTerm[];
}

/**
 * Distinctive French markers. Diacritic-bearing words and FR-only function
 * words are deliberately preferred over tokens that overlap with English.
 */
const FR_STOPWORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'est', 'suis',
  'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles', 'que', 'qui',
  'quoi', 'pas', 'ne', 'ce', 'cette', 'ces', 'mon', 'ma', 'mes', 'ton',
  'avec', 'pour', 'dans', 'sur', 'mais', 'comment', 'pourquoi', 'bonjour',
  'merci', 'oui', 'non', 'salut', 'voudrais', 'peux', 'fait', 'faire',
  'aussi', 'très', 'alors', 'donc', 'parce', 'sont', 'être', 'avoir',
]);

/** Distinctive English markers, chosen to avoid overlap with the FR set. */
const EN_STOPWORDS = new Set([
  'the', 'and', 'is', 'are', 'was', 'were', 'you', 'your', 'he', 'she',
  'they', 'them', 'this', 'that', 'these', 'those', 'which', 'what', 'who',
  'not', 'with', 'for', 'from', 'but', 'how', 'why', 'hello', 'thanks',
  'thank', 'yes', 'please', 'would', 'like', 'could', 'should', 'have',
  'has', 'will', 'about', 'because', 'really', 'very', 'also', 'doing',
  'i', 'we', 'me', 'my',
]);

/** Characters that signal French text (accented Latin letters). */
const FR_DIACRITICS = /[àâäçéèêëîïôöùûüÿœæ]/i;

/** Split text into lowercase alphabetic tokens (diacritics preserved). */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-zàâäçéèêëîïôöùûüÿœæ']+/i)
    .filter((token) => token.length > 0);
}

/**
 * Heuristic FR/EN detection (Req 7.1). Scores stopword hits per language and
 * gives French a boost for each diacritic-bearing token. Returns `{ lang: null,
 * confidence }` with low confidence when there is no signal or the scores tie,
 * so callers can fall back to remembered state (Req 7.2).
 */
export function detectLanguage(text: string): { lang: Lang | null; confidence: number } {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { lang: null, confidence: 0 };
  }

  const tokens = tokenize(text);
  if (tokens.length === 0) {
    return { lang: null, confidence: 0 };
  }

  let frScore = 0;
  let enScore = 0;
  for (const token of tokens) {
    if (FR_STOPWORDS.has(token)) {
      frScore += 1;
    }
    if (EN_STOPWORDS.has(token)) {
      enScore += 1;
    }
    if (FR_DIACRITICS.test(token)) {
      frScore += 1;
    }
  }

  const total = frScore + enScore;
  if (total === 0 || frScore === enScore) {
    return { lang: null, confidence: 0 };
  }

  const lang: Lang = frScore > enScore ? 'fr' : 'en';
  const confidence = Math.max(frScore, enScore) / total;
  return { lang, confidence };
}

/**
 * Resolve the single target response language for a message (Req 7.1, 7.2, 7.5):
 * use a confident fresh detection, else the user's last detected language, else
 * default to French.
 */
export function resolveResponseLanguage(
  detected: { lang: Lang | null; confidence: number },
  lastDetected: Lang | null,
): Lang {
  if (detected.lang !== null && detected.confidence >= CONFIDENCE_THRESHOLD) {
    return detected.lang;
  }
  return lastDetected ?? 'fr';
}

/** Strip wrapping quotes and surrounding punctuation/whitespace from a fragment. */
function cleanFragment(raw: string): string {
  return raw
    .trim()
    .replace(/^["'«»“”‘’]+/, '')
    .replace(/["'«»“”‘’]+$/, '')
    .replace(/[.!?,;:]+$/, '')
    .trim();
}

/** Teach-instruction patterns: capture group 1 = term, group 2 = meaning. */
const TEACH_PATTERNS: RegExp[] = [
  // "teach me X means Y" / "the word X means Y" / "learn that X means Y"
  /(?:teach me|learn(?: that)?|the word|the term)\s+(.+?)\s+means\s+(.+)$/i,
  // bare "X means Y"
  /^(.+?)\s+means\s+(.+)$/i,
  // French: "apprends que X signifie Y" / "X veut dire Y" / "X signifie Y"
  /(?:apprends(?: que)?|le mot|le terme)\s+(.+?)\s+(?:signifie|veut dire)\s+(.+)$/i,
  /^(.+?)\s+(?:signifie|veut dire)\s+(.+)$/i,
];

/**
 * Parse a natural "teach me X means Y" instruction into a {@link TaughtTerm}
 * (Req 7.3). The target language (`sw`/`ln`) is inferred from an explicit
 * Swahili/Lingala mention, defaulting to Swahili. Returns `null` when no teach
 * pattern matches or the extracted term/meaning is empty.
 */
export function parseTeachInstruction(text: string): TaughtTerm | null {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return null;
  }

  const lang: 'sw' | 'ln' = /lingala/i.test(text) ? 'ln' : 'sw';

  // Drop a trailing "in/en Swahili|Lingala" clause so it never bleeds into the
  // captured meaning.
  const stripped = text
    .replace(/\s+(?:in|en)\s+(?:swahili|kiswahili|lingala)\b.*$/i, '')
    .trim();

  for (const pattern of TEACH_PATTERNS) {
    const match = pattern.exec(stripped);
    if (match && match[1] !== undefined && match[2] !== undefined) {
      const term = cleanFragment(match[1]);
      const meaning = cleanFragment(match[2]);
      if (term.length > 0 && meaning.length > 0) {
        return { term, meaning, lang };
      }
    }
  }

  return null;
}

/** Type guard for a stored taught-term record. */
function isTaughtTerm(value: unknown): value is TaughtTerm {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.term === 'string' &&
    typeof candidate.meaning === 'string' &&
    (candidate.lang === 'sw' || candidate.lang === 'ln')
  );
}

/**
 * Defensively parse a `personality_notes` blob into structured form. Malformed
 * or non-object JSON is treated as empty rather than throwing (Req 7.4).
 */
function parseNotes(notes: string): PersonalityNotes {
  const empty: PersonalityNotes = { notes: '', taughtTerms: [] };
  if (typeof notes !== 'string' || notes.trim().length === 0) {
    return empty;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(notes);
  } catch {
    return empty;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return empty;
  }

  const record = parsed as Record<string, unknown>;
  const text = typeof record.notes === 'string' ? record.notes : '';
  const terms = Array.isArray(record.taughtTerms)
    ? record.taughtTerms.filter(isTaughtTerm)
    : [];

  return { notes: text, taughtTerms: terms };
}

/**
 * Append a taught term to the `personality_notes` JSON and return the updated
 * serialized blob (Req 7.3, 7.6). Prior free-form notes are preserved and the
 * input is parsed defensively, so malformed stored JSON never throws.
 */
export function appendTaughtTerm(notes: string, term: TaughtTerm): string {
  const parsed = parseNotes(notes);
  parsed.taughtTerms.push({ term: term.term, meaning: term.meaning, lang: term.lang });
  return JSON.stringify(parsed);
}

/**
 * Extract up to `max` most-recently taught terms from a `personality_notes`
 * blob (Req 7.6). Returns an empty array for malformed JSON or non-positive
 * `max`, and never throws (Req 7.4).
 */
export function extractTaughtTerms(notes: string, max: number): TaughtTerm[] {
  if (!Number.isFinite(max) || max <= 0) {
    return [];
  }

  const { taughtTerms } = parseNotes(notes);
  const cap = Math.floor(max);
  // Most-recent entries live at the end of the array; keep the trailing `cap`.
  return taughtTerms.slice(Math.max(0, taughtTerms.length - cap));
}
