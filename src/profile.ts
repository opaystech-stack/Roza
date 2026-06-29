/**
 * Roza_Profile (Component A) — Req 1.1, 1.3, 1.6, 2.3, 2.5.
 *
 * The profile is the single source of identity truth for Roza: her display
 * name, role titles, native/learnable languages, persona tuning parameters, the
 * Telegram and email identities she presents, her committed avatar asset path,
 * and a working-hours reference that points at — but never redefines — the
 * Phase 1 timezone configuration.
 *
 * This module mirrors the Phase 1 `config.ts` idiom: every function here is
 * PURE (no I/O, no logging, no `process.exit`) so the whole profile validation
 * surface is unit- and property-testable in isolation. The side-effecting
 * `loadProfileOrDefault` / `editProfile` wrappers (which read and write the
 * single-row `roza_profile` table over the repository) are layered on top of
 * these pure primitives separately and are intentionally NOT defined here.
 *
 * Security note (Req 2.5, 4.5): the {@link RozaProfile} shape deliberately
 * contains NO Channel_Credential field — no Bot_Token, no mailbox password.
 * Credentials live only in environment variables and protocol handshakes and
 * are never modelled by, validated by, or persisted through this profile.
 */

import type { Repository } from './repository.js';
import type { Logger } from './types.js';

/** A language Roza either speaks natively or can be taught (Req 3.4). */
export type ProfileLang = 'fr' | 'en' | 'sw' | 'ln';

/** Persona tuning parameters fed verbatim into the System_Prompt (Req 3.1). */
export interface PersonaParams {
  /** Conversational tone, e.g. "warm, candid, rigorous". */
  tone: string;
  /** Humor register, e.g. "subtle, good-natured". */
  humor: string;
  /** Formality register, e.g. "peer-to-peer". */
  formality: string;
}

/**
 * Roza's configurable identity record (Req 1.1).
 *
 * Contains NO Channel_Credential value of any kind (Req 2.5): the Telegram and
 * email fields hold only the public identities Roza *presents*, never the
 * Bot_Token or Mailbox_Credentials used to authenticate.
 */
export interface RozaProfile {
  /** Display name Roza presents, e.g. "Roza". */
  displayName: string;
  /** Role titles she holds, e.g. ["Co-founder","CTO","COO"]. */
  roleTitles: string[];
  /** Native languages she speaks fluently — declares fr/en (Req 3.4). */
  nativeLanguages: ProfileLang[];
  /** Languages she can be taught — declares sw/ln (Req 3.4). */
  learnableLanguages: ProfileLang[];
  /** Persona tuning parameters injected into the System_Prompt (Req 3.1). */
  persona: PersonaParams;
  /** Public Telegram handle Roza presents, e.g. "@roza_opays" (Req 3.2). */
  telegramIdentity: string;
  /** Public email address Roza presents, "roza@opays.io" (Req 3.3). */
  emailIdentity: string;
  /** Path to the committed avatar asset, e.g. "assets/roza-avatar.png". */
  avatarAssetPath: string;
  /**
   * Working-hours reference. `timezoneRef` POINTS AT the Phase 1 timezone
   * configuration (e.g. "config:timezone") rather than redefining the
   * Active_Window/timezone behavior itself (Req 1.5, 10.5).
   */
  workingHours: { timezoneRef: string };
}

/**
 * The documented default profile (Req 1.3, 3.5). Persisted verbatim when no
 * stored profile exists, and used field-by-field by {@link applyDefaults} to
 * heal a partially-invalid stored profile.
 *
 * Defaults are deliberately consistent with the Phase 1 persona text in
 * `persona.ts`: Co-founder/CTO/COO, peer-to-peer, warm/candid/rigorous with
 * subtle good-natured humor, native FR/EN and learnable SW/LN.
 */
export const DEFAULT_PROFILE: RozaProfile = {
  displayName: 'Roza',
  roleTitles: ['Co-founder', 'CTO', 'COO'],
  nativeLanguages: ['fr', 'en'],
  learnableLanguages: ['sw', 'ln'],
  persona: {
    tone: 'warm, candid, rigorous',
    humor: 'subtle, good-natured',
    formality: 'peer-to-peer',
  },
  telegramIdentity: '@roza_opays',
  emailIdentity: 'roza@opays.io',
  avatarAssetPath: 'assets/roza-avatar.png',
  // References the Phase 1 timezone config; never redefines it (Req 1.5).
  workingHours: { timezoneRef: 'config:timezone' },
};

/** A single field's validation failure, naming the offending field (Req 2.3, 1.6). */
export interface FieldError {
  /** Dotted field path, e.g. "displayName" or "persona.tone". */
  field: string;
  /** Human-readable reason the field was rejected. */
  reason: string;
}

/** Outcome of validating a candidate profile. */
export type ValidationResult =
  | { ok: true; value: RozaProfile }
  | { ok: false; errors: FieldError[] };

/** The complete set of valid {@link ProfileLang} values. */
const PROFILE_LANGS: readonly ProfileLang[] = ['fr', 'en', 'sw', 'ln'];

/** Pragmatic single-line email shape: `local@domain.tld`. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Internal per-field check outcome. */
type Check<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Narrow an unknown to a plain (non-array) object record, else `null`. */
function asRecord(candidate: unknown): Record<string, unknown> | null {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return null;
  }
  return candidate as Record<string, unknown>;
}

/** Read a property from a possibly-null record without throwing. */
function prop(record: Record<string, unknown> | null, key: string): unknown {
  return record === null ? undefined : record[key];
}

/** A string with at least one non-whitespace character. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** A valid {@link ProfileLang} token. */
function isProfileLang(value: unknown): value is ProfileLang {
  return typeof value === 'string' && (PROFILE_LANGS as readonly string[]).includes(value);
}

/** Validate + normalize (trim) a required non-empty string field. */
function checkScalarString(value: unknown): Check<string> {
  if (value === undefined) {
    return { ok: false, reason: 'is required' };
  }
  if (!isNonEmptyString(value)) {
    return { ok: false, reason: 'must be a non-empty string' };
  }
  return { ok: true, value: value.trim() };
}

/** Validate + normalize a required, non-empty list of non-empty role titles. */
function checkRoleTitles(value: unknown): Check<string[]> {
  if (value === undefined) {
    return { ok: false, reason: 'is required' };
  }
  if (!Array.isArray(value)) {
    return { ok: false, reason: 'must be an array of non-empty strings' };
  }
  if (value.length === 0) {
    return { ok: false, reason: 'must contain at least one role title' };
  }
  if (!value.every(isNonEmptyString)) {
    return { ok: false, reason: 'each role title must be a non-empty string' };
  }
  return { ok: true, value: value.map((title) => title.trim()) };
}

/**
 * Validate a list of {@link ProfileLang} values. `nativeLanguages` requires at
 * least one entry; `learnableLanguages` may be empty (`allowEmpty`).
 */
function checkLangs(value: unknown, allowEmpty: boolean): Check<ProfileLang[]> {
  if (value === undefined) {
    return { ok: false, reason: 'is required' };
  }
  if (!Array.isArray(value)) {
    return { ok: false, reason: 'must be an array of language codes (fr, en, sw, ln)' };
  }
  if (!allowEmpty && value.length === 0) {
    return { ok: false, reason: 'must contain at least one language' };
  }
  if (!value.every(isProfileLang)) {
    return { ok: false, reason: 'each entry must be one of fr, en, sw, ln' };
  }
  return { ok: true, value: [...value] };
}

/** Validate + normalize a required, well-formed email address. */
function checkEmail(value: unknown): Check<string> {
  if (value === undefined) {
    return { ok: false, reason: 'is required' };
  }
  if (!isNonEmptyString(value)) {
    return { ok: false, reason: 'must be a non-empty string' };
  }
  const trimmed = value.trim();
  if (!EMAIL_RE.test(trimmed)) {
    return { ok: false, reason: 'must be a valid email address' };
  }
  return { ok: true, value: trimmed };
}

/**
 * Pure validation of a candidate profile (Req 2.3, 1.6). Validates every field,
 * naming each invalid or missing field (nested fields use a dotted path, e.g.
 * `persona.tone`, `workingHours.timezoneRef`). On success returns the
 * normalized (trimmed) profile; on failure returns every field error.
 */
export function validateProfile(candidate: unknown): ValidationResult {
  const record = asRecord(candidate);
  if (record === null) {
    return { ok: false, errors: [{ field: '(root)', reason: 'profile must be an object' }] };
  }

  const errors: FieldError[] = [];

  const personaRecord = asRecord(record.persona);
  const workingHoursRecord = asRecord(record.workingHours);

  const dn = checkScalarString(record.displayName);
  const rt = checkRoleTitles(record.roleTitles);
  const nl = checkLangs(record.nativeLanguages, false);
  const ll = checkLangs(record.learnableLanguages, true);
  const tone = checkScalarString(prop(personaRecord, 'tone'));
  const humor = checkScalarString(prop(personaRecord, 'humor'));
  const formality = checkScalarString(prop(personaRecord, 'formality'));
  const tg = checkScalarString(record.telegramIdentity);
  const em = checkEmail(record.emailIdentity);
  const avatar = checkScalarString(record.avatarAssetPath);
  const tz = checkScalarString(prop(workingHoursRecord, 'timezoneRef'));

  if (!dn.ok) errors.push({ field: 'displayName', reason: dn.reason });
  if (!rt.ok) errors.push({ field: 'roleTitles', reason: rt.reason });
  if (!nl.ok) errors.push({ field: 'nativeLanguages', reason: nl.reason });
  if (!ll.ok) errors.push({ field: 'learnableLanguages', reason: ll.reason });
  if (!tone.ok) errors.push({ field: 'persona.tone', reason: tone.reason });
  if (!humor.ok) errors.push({ field: 'persona.humor', reason: humor.reason });
  if (!formality.ok) errors.push({ field: 'persona.formality', reason: formality.reason });
  if (!tg.ok) errors.push({ field: 'telegramIdentity', reason: tg.reason });
  if (!em.ok) errors.push({ field: 'emailIdentity', reason: em.reason });
  if (!avatar.ok) errors.push({ field: 'avatarAssetPath', reason: avatar.reason });
  if (!tz.ok) errors.push({ field: 'workingHours.timezoneRef', reason: tz.reason });

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // All checks passed here, so every `*.ok` branch below selects the validated value.
  return {
    ok: true,
    value: {
      displayName: dn.ok ? dn.value : DEFAULT_PROFILE.displayName,
      roleTitles: rt.ok ? rt.value : [...DEFAULT_PROFILE.roleTitles],
      nativeLanguages: nl.ok ? nl.value : [...DEFAULT_PROFILE.nativeLanguages],
      learnableLanguages: ll.ok ? ll.value : [...DEFAULT_PROFILE.learnableLanguages],
      persona: {
        tone: tone.ok ? tone.value : DEFAULT_PROFILE.persona.tone,
        humor: humor.ok ? humor.value : DEFAULT_PROFILE.persona.humor,
        formality: formality.ok ? formality.value : DEFAULT_PROFILE.persona.formality,
      },
      telegramIdentity: tg.ok ? tg.value : DEFAULT_PROFILE.telegramIdentity,
      emailIdentity: em.ok ? em.value : DEFAULT_PROFILE.emailIdentity,
      avatarAssetPath: avatar.ok ? avatar.value : DEFAULT_PROFILE.avatarAssetPath,
      workingHours: { timezoneRef: tz.ok ? tz.value : DEFAULT_PROFILE.workingHours.timezoneRef },
    },
  };
}

/** Deep copy of {@link DEFAULT_PROFILE} so callers never alias its mutable parts. */
function cloneDefaultProfile(): RozaProfile {
  return {
    displayName: DEFAULT_PROFILE.displayName,
    roleTitles: [...DEFAULT_PROFILE.roleTitles],
    nativeLanguages: [...DEFAULT_PROFILE.nativeLanguages],
    learnableLanguages: [...DEFAULT_PROFILE.learnableLanguages],
    persona: { ...DEFAULT_PROFILE.persona },
    telegramIdentity: DEFAULT_PROFILE.telegramIdentity,
    emailIdentity: DEFAULT_PROFILE.emailIdentity,
    avatarAssetPath: DEFAULT_PROFILE.avatarAssetPath,
    workingHours: { ...DEFAULT_PROFILE.workingHours },
  };
}

/**
 * Pure per-field default substitution (Req 1.6, 3.5). Coerces a
 * partially-invalid candidate into a fully-valid {@link RozaProfile} by
 * replacing each missing or invalid field with its documented default, and
 * reports exactly which fields were defaulted (by name, with the reason). The
 * returned `value` always satisfies {@link validateProfile}.
 */
export function applyDefaults(candidate: unknown): { value: RozaProfile; defaulted: FieldError[] } {
  const record = asRecord(candidate);
  if (record === null) {
    return {
      value: cloneDefaultProfile(),
      defaulted: [{ field: '(root)', reason: 'profile was not an object; applied full default profile' }],
    };
  }

  const value = cloneDefaultProfile();
  const defaulted: FieldError[] = [];

  const substitute = <T>(field: string, check: Check<T>, assign: (v: T) => void): void => {
    if (check.ok) {
      assign(check.value);
    } else {
      defaulted.push({ field, reason: `${check.reason}; applied default` });
    }
  };

  const personaRecord = asRecord(record.persona);
  const workingHoursRecord = asRecord(record.workingHours);

  substitute('displayName', checkScalarString(record.displayName), (v) => {
    value.displayName = v;
  });
  substitute('roleTitles', checkRoleTitles(record.roleTitles), (v) => {
    value.roleTitles = v;
  });
  substitute('nativeLanguages', checkLangs(record.nativeLanguages, false), (v) => {
    value.nativeLanguages = v;
  });
  substitute('learnableLanguages', checkLangs(record.learnableLanguages, true), (v) => {
    value.learnableLanguages = v;
  });
  substitute('persona.tone', checkScalarString(prop(personaRecord, 'tone')), (v) => {
    value.persona.tone = v;
  });
  substitute('persona.humor', checkScalarString(prop(personaRecord, 'humor')), (v) => {
    value.persona.humor = v;
  });
  substitute('persona.formality', checkScalarString(prop(personaRecord, 'formality')), (v) => {
    value.persona.formality = v;
  });
  substitute('telegramIdentity', checkScalarString(record.telegramIdentity), (v) => {
    value.telegramIdentity = v;
  });
  substitute('emailIdentity', checkEmail(record.emailIdentity), (v) => {
    value.emailIdentity = v;
  });
  substitute('avatarAssetPath', checkScalarString(record.avatarAssetPath), (v) => {
    value.avatarAssetPath = v;
  });
  substitute('workingHours.timezoneRef', checkScalarString(prop(workingHoursRecord, 'timezoneRef')), (v) => {
    value.workingHours.timezoneRef = v;
  });

  return { value, defaulted };
}

/**
 * Pure merge of an edit patch onto a base profile, producing a candidate for
 * {@link validateProfile} (the caller validates, then persists all-or-nothing).
 *
 * Scalars and arrays in `patch` replace those in `base`; the nested `persona`
 * and `workingHours` objects are merged field-by-field so a patch may update a
 * single persona parameter without resupplying the others. The result is typed
 * `unknown` because a patch may carry invalid values that validation must
 * still catch.
 */
export function mergeProfile(base: RozaProfile, patch: Partial<RozaProfile>): unknown {
  const merged: RozaProfile = {
    ...base,
    ...patch,
    persona: { ...base.persona, ...(patch.persona ?? {}) },
    workingHours: { ...base.workingHours, ...(patch.workingHours ?? {}) },
  };
  return merged;
}

// ---------------------------------------------------------------------------
// Side-effecting wrappers (Req 1.2, 1.3, 1.6, 2.2, 2.3, 2.4)
//
// These two functions are the ONLY I/O surface in this module. They read and
// write the single-row `roza_profile` table through the Repository and log via
// the structured Logger, layering durability and self-healing on top of the
// pure primitives above. They never throw (startup must continue, Req 1.6) and
// never log a Channel_Credential — the profile shape contains none.
// ---------------------------------------------------------------------------

/**
 * Load the profile at startup (Req 1.2).
 *
 * Reads the single stored row. When absent, the documented {@link DEFAULT_PROFILE}
 * is persisted and returned (Req 1.3). When present, the JSON is parsed
 * defensively — malformed JSON is treated as an invalid candidate rather than
 * crashing — then {@link applyDefaults} heals any missing/invalid field; each
 * defaulted field is logged BY NAME (never with a secret value), and the healed
 * profile is persisted so the store self-heals. Startup always continues: this
 * function returns a fully-valid {@link RozaProfile} and never throws (Req 1.6).
 */
export function loadProfileOrDefault(repo: Repository, logger: Logger): RozaProfile {
  const stored = repo.getProfile();

  // Req 1.3: no stored profile yet — persist the documented default verbatim.
  if (stored === null) {
    repo.upsertProfile(JSON.stringify(DEFAULT_PROFILE));
    logger.info('No stored profile found; persisted documented default profile', {
      source: 'profile',
    });
    return cloneDefaultProfile();
  }

  // Defensive parse: malformed JSON is treated as absent/invalid (Req 1.6) so a
  // corrupt row heals to defaults instead of aborting startup.
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    parsed = undefined;
    logger.error('Stored profile JSON is malformed; healing with documented defaults', {
      source: 'profile',
    });
  }

  // Req 1.6, 3.5: substitute the documented default for each missing/invalid
  // field and report exactly which fields were defaulted.
  const { value, defaulted } = applyDefaults(parsed);

  if (defaulted.length > 0) {
    for (const fieldError of defaulted) {
      // Log each defaulted field BY NAME with its reason — never a value (Req 1.6).
      logger.error('Profile field invalid or missing; applied documented default', {
        source: 'profile',
        field: fieldError.field,
        reason: fieldError.reason,
      });
    }
    // Persist the healed profile so subsequent reads are already valid.
    repo.upsertProfile(JSON.stringify(value));
  }

  return value;
}

/**
 * Edit the profile (Req 2.2, 2.3, 2.4).
 *
 * Merges the patch onto the current profile, then validates the merged result.
 * On any field failure the WHOLE edit is rejected: the stored profile is left
 * byte-for-byte unchanged and every invalid field is returned by name (Req 2.3).
 * On success the validated, normalized profile is persisted atomically inside a
 * transaction and returned so the caller can swap the in-memory profile, which
 * applies the change to subsequent prompts/identities without a restart (Req 2.4).
 */
export function editProfile(
  repo: Repository,
  current: RozaProfile,
  patch: Partial<RozaProfile>
): { ok: true; value: RozaProfile } | { ok: false; errors: FieldError[] } {
  const merged = mergeProfile(current, patch);
  const result = validateProfile(merged);

  // Req 2.3: reject the entire edit on any failure, leaving the store untouched.
  if (!result.ok) {
    return { ok: false, errors: result.errors };
  }

  // Req 2.2: atomic single-row persist of the validated, normalized profile.
  repo.tx(() => {
    repo.upsertProfile(JSON.stringify(result.value));
  });

  return { ok: true, value: result.value };
}
