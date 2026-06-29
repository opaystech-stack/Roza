/**
 * Operator profile-edit entrypoint (Component A, editing mechanism) — Req 2.1, 2.2, 2.3, 2.4.
 *
 * A guarded, operator-facing CLI that edits the single Roza_Profile. It is the
 * concrete realization of the design's "operator-facing CLI subcommand / guarded
 * internal function invoked from an admin entrypoint" — it opens NO socket and
 * exposes NO public network surface, consistent with the isolated, no-inbound-HTTP
 * posture inherited from Phase 1.
 *
 * Flow (mirrors `editProfile`): open config → database → repository (the same
 * fail-fast collaborators bootstrap uses), load the current profile via
 * `loadProfileOrDefault`, parse the CLI flags into a `Partial<RozaProfile>` patch,
 * then call `editProfile`. On success it prints the updated profile and exits 0;
 * on a validation failure it prints every invalid field by name and exits non-zero,
 * leaving the stored profile byte-for-byte unchanged (Req 2.3).
 *
 * Security note (Req 2.5): the {@link RozaProfile} shape carries NO credential of
 * any kind, so printing the updated profile here can never leak a secret.
 *
 * Every collaborator is injectable so the parser and the success/failure paths can
 * be unit-tested without opening a real database or calling the real `process.exit`.
 * Execution is guarded by an {@link isDirectRun} check so importing this module
 * (e.g. from a test) never triggers a real run.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigOrExit } from './config.js';
import { initDatabaseOrExit } from './db.js';
import { createRepository } from './repository.js';
import { editProfile, loadProfileOrDefault } from './profile.js';
import type { ProfileLang, RozaProfile } from './profile.js';
import type { Logger } from './types.js';

/** Structured overrides parsed from the CLI flags (each present only if supplied). */
interface ParsedArgs {
  displayName?: string;
  roleTitles?: string[];
  nativeLanguages?: string[];
  learnableLanguages?: string[];
  telegramIdentity?: string;
  emailIdentity?: string;
  avatarAssetPath?: string;
  personaTone?: string;
  personaHumor?: string;
  personaFormality?: string;
  timezoneRef?: string;
}

/** Outcome of {@link parseProfileArgs}: the parsed overrides plus any usage errors. */
export interface ParseResult {
  /** Parsed overrides; only the fields actually supplied on the command line are set. */
  parsed: ParsedArgs;
  /** Usage errors (unknown flag, missing value). Non-empty means the CLI must abort with a usage error. */
  errors: string[];
  /** True when at least one recognized profile flag was supplied. */
  recognizedAny: boolean;
}

/** The recognized flags and the {@link ParsedArgs} key each maps to. */
const SCALAR_FLAGS: Record<string, keyof ParsedArgs> = {
  '--display-name': 'displayName',
  '--telegram-identity': 'telegramIdentity',
  '--email-identity': 'emailIdentity',
  '--avatar-path': 'avatarAssetPath',
  '--persona-tone': 'personaTone',
  '--persona-humor': 'personaHumor',
  '--persona-formality': 'personaFormality',
  '--timezone-ref': 'timezoneRef',
};

/** The recognized comma-separated list flags and their {@link ParsedArgs} key. */
const LIST_FLAGS: Record<string, keyof ParsedArgs> = {
  '--role-titles': 'roleTitles',
  '--native-languages': 'nativeLanguages',
  '--learnable-languages': 'learnableLanguages',
};

/** Split a comma-separated value: trim each entry and drop empties (order preserved). */
function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Pure parse of the operator CLI flags into structured overrides (Req 2.1).
 *
 * Supports both `--flag value` and `--flag=value` spellings. Recognized scalar
 * flags map to single strings; list flags (`--role-titles`, `--native-languages`,
 * `--learnable-languages`) are comma-separated. Unknown flags and flags missing a
 * value are reported as usage errors rather than silently ignored. Total: never
 * throws.
 */
export function parseProfileArgs(argv: readonly string[]): ParseResult {
  const parsed: ParsedArgs = {};
  const errors: string[] = [];
  let recognizedAny = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) {
      continue;
    }
    if (!token.startsWith('--')) {
      errors.push(`unexpected argument "${token}" (expected a --flag)`);
      continue;
    }

    // Support both "--flag=value" and "--flag value".
    const eq = token.indexOf('=');
    let flag: string;
    let inlineValue: string | undefined;
    if (eq !== -1) {
      flag = token.slice(0, eq);
      inlineValue = token.slice(eq + 1);
    } else {
      flag = token;
      inlineValue = undefined;
    }

    const scalarKey = SCALAR_FLAGS[flag];
    const listKey = LIST_FLAGS[flag];
    if (scalarKey === undefined && listKey === undefined) {
      errors.push(`unknown flag "${flag}"`);
      continue;
    }

    // Resolve the value: inline (--flag=value) or the next token (--flag value).
    let value: string | undefined = inlineValue;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        errors.push(`flag "${flag}" requires a value`);
        continue;
      }
      value = next;
      i++; // consume the value token
    }

    recognizedAny = true;
    // Write through a widened view so the union-keyed assignment type-checks; the
    // SCALAR_FLAGS/LIST_FLAGS maps guarantee scalar vs list targets line up.
    const sink: Partial<Record<keyof ParsedArgs, string | string[]>> = parsed;
    if (scalarKey !== undefined) {
      sink[scalarKey] = value;
    } else if (listKey !== undefined) {
      // validateProfile (inside editProfile) is the single source of truth for
      // which list entries are valid and reports bad ones by name.
      sink[listKey] = splitList(value);
    }
  }

  return { parsed, errors, recognizedAny };
}

/**
 * Assemble a validated-by-`editProfile` patch from the parsed overrides and the
 * current profile. Nested `persona` / `workingHours` are rebuilt from the current
 * values so a single sub-field can change without resupplying the others, while
 * keeping the patch a fully-typed {@link RozaProfile} fragment.
 */
export function buildPatch(current: RozaProfile, parsed: ParsedArgs): Partial<RozaProfile> {
  const patch: Partial<RozaProfile> = {};

  if (parsed.displayName !== undefined) patch.displayName = parsed.displayName;
  if (parsed.roleTitles !== undefined) patch.roleTitles = parsed.roleTitles;
  if (parsed.nativeLanguages !== undefined) {
    patch.nativeLanguages = parsed.nativeLanguages as ProfileLang[];
  }
  if (parsed.learnableLanguages !== undefined) {
    patch.learnableLanguages = parsed.learnableLanguages as ProfileLang[];
  }
  if (parsed.telegramIdentity !== undefined) patch.telegramIdentity = parsed.telegramIdentity;
  if (parsed.emailIdentity !== undefined) patch.emailIdentity = parsed.emailIdentity;
  if (parsed.avatarAssetPath !== undefined) patch.avatarAssetPath = parsed.avatarAssetPath;

  if (
    parsed.personaTone !== undefined ||
    parsed.personaHumor !== undefined ||
    parsed.personaFormality !== undefined
  ) {
    patch.persona = {
      tone: parsed.personaTone ?? current.persona.tone,
      humor: parsed.personaHumor ?? current.persona.humor,
      formality: parsed.personaFormality ?? current.persona.formality,
    };
  }

  if (parsed.timezoneRef !== undefined) {
    patch.workingHours = { timezoneRef: parsed.timezoneRef };
  }

  return patch;
}

/** Human-readable usage banner printed on a usage error or an empty invocation. */
const USAGE = [
  'Usage: node dist/admin.js [flags]',
  '',
  'Edit the Roza_Profile (operator-only; no network surface).',
  '',
  'Flags:',
  '  --display-name <name>',
  '  --role-titles <a,b,c>',
  '  --native-languages <fr,en,sw,ln>',
  '  --learnable-languages <fr,en,sw,ln>',
  '  --telegram-identity <@handle>',
  '  --email-identity <addr@domain.tld>',
  '  --avatar-path <assets/roza-avatar.png>',
  '  --persona-tone <text>',
  '  --persona-humor <text>',
  '  --persona-formality <text>',
  '  --timezone-ref <config:timezone>',
].join('\n');

/** Injectable collaborators for {@link runAdmin}; each defaults to the real implementation. */
export interface AdminDeps {
  loadConfig?: typeof loadConfigOrExit;
  initDatabase?: typeof initDatabaseOrExit;
  createRepo?: typeof createRepository;
  loadProfile?: typeof loadProfileOrDefault;
  edit?: typeof editProfile;
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
  exit?: (code: number) => never;
}

/** A minimal console-backed {@link Logger}. The profile contains no secrets, so nothing confidential is logged. */
const defaultLogger: Logger = {
  info(message: string, meta?: Record<string, unknown>): void {
    if (meta === undefined) console.log(message);
    else console.log(message, meta);
  },
  error(message: string, meta?: Record<string, unknown>): void {
    if (meta === undefined) console.error(message);
    else console.error(message, meta);
  },
};

/**
 * Run the operator profile edit (Req 2.1–2.4).
 *
 * Exit codes: `0` on a successful edit; `2` on a usage error (unknown/badly formed
 * flags, or no flags supplied); `1` on a validation failure (every offending field
 * is printed by name and the stored profile is left untouched — Req 2.3).
 */
export function runAdmin(argv: readonly string[], deps: AdminDeps = {}): void {
  const loadConfig = deps.loadConfig ?? loadConfigOrExit;
  const initDatabase = deps.initDatabase ?? initDatabaseOrExit;
  const createRepo = deps.createRepo ?? createRepository;
  const loadProfile = deps.loadProfile ?? loadProfileOrDefault;
  const edit = deps.edit ?? editProfile;
  const logger = deps.logger ?? defaultLogger;
  const env = deps.env ?? process.env;
  const exit = deps.exit ?? (process.exit as (code: number) => never);

  const { parsed, errors, recognizedAny } = parseProfileArgs(argv);

  if (errors.length > 0) {
    for (const message of errors) {
      logger.error(`[admin] ${message}`);
    }
    logger.info(USAGE);
    return exit(2);
  }

  if (!recognizedAny) {
    logger.error('[admin] no profile fields supplied; nothing to edit.');
    logger.info(USAGE);
    return exit(2);
  }

  // Open the same fail-fast collaborators bootstrap uses (config → DB → repo).
  const cfg = loadConfig(env);
  const db = initDatabase(cfg.dataDir, cfg.keyVersion);
  const repo = createRepo(db, { secret: cfg.rozaPrivateKey, keyVersion: cfg.keyVersion });

  try {
    const current = loadProfile(repo, logger);
    const patch = buildPatch(current, parsed);
    const result = edit(repo, current, patch);

    if (!result.ok) {
      logger.error('[admin] Profile edit rejected; stored profile unchanged.');
      for (const fieldError of result.errors) {
        logger.error(`[admin]   ${fieldError.field}: ${fieldError.reason}`);
      }
      return exit(1);
    }

    // The profile carries no credential field, so this dump can leak no secret (Req 2.5).
    logger.info('[admin] Profile updated successfully.', { profile: result.value });
    return exit(0);
  } finally {
    closeQuietly(db);
  }
}

/** Close the database handle best-effort; a failed close must not mask the exit path. */
function closeQuietly(db: { close?: () => void }): void {
  try {
    db.close?.();
  } catch {
    // Best-effort: ignore close failures during teardown.
  }
}

/** True when this module is the file Node was invoked with directly. */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  // argv[0]=node, argv[1]=script; operator flags start at index 2.
  runAdmin(process.argv.slice(2));
}
