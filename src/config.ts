/**
 * Startup configuration (Component 1) — Req 1.7, 2.3, 2.4, 5.2.
 *
 * Mirrors the Opays HQ `server/config.ts` pattern: pure validator functions
 * (no logging, no `process.exit`) so they can be unit/property tested, plus a
 * thin imperative wrapper `loadConfigOrExit` that performs the side effects
 * (logging + exit) at startup. Secret values are never logged — only the
 * offending variable's name is ever surfaced (Req 1.7).
 */

import { type ActiveWindow, DEFAULT_WINDOW } from './window.js';

/** Default OpenRouter model when `OPENROUTER_MODEL` is not provided. */
const DEFAULT_MODEL = 'openai/gpt-4o-mini';
/** Default durable data directory (mounted volume) for the SQLite database. */
const DEFAULT_DATA_DIR = '/app/data';
/** Default IANA timezone used for Active_Window math and timestamps. */
const DEFAULT_TIMEZONE = 'Africa/Kinshasa';
/** Default encryption key identifier recorded with each journal entry. */
const DEFAULT_KEY_VERSION = 'v1';

/** Minutes in a single day; HH:MM values resolve to `[0, 1439]`. */
const MINUTES_PER_DAY = 24 * 60;

/**
 * Fully-resolved configuration consumed by the rest of the service. Required
 * secrets are guaranteed non-empty once this object exists.
 */
export interface RozaConfig {
  /** Secret backing the journal key derivation; validated non-empty (Req 1.7). */
  rozaPrivateKey: string;
  /** OpenRouter credential; validated non-empty (Req 1.7, 5.2). */
  openRouterApiKey: string;
  /** OpenRouter model id; defaults to `openai/gpt-4o-mini`. */
  openRouterModel: string;
  /** Durable data directory; defaults to `/app/data`. */
  dataDir: string;
  /** IANA timezone; defaults to `Africa/Kinshasa`. */
  timezone: string;
  /** Resolved Active_Window; defaults to 07:00–22:00 (Req 2.3, 2.4). */
  activeWindow: ActiveWindow;
  /** Encryption key identifier; defaults to `v1`. */
  keyVersion: string;
}

/** The two required environment variables (Req 1.7). */
export type MissingVar = 'ROZA_PRIVATE_KEY' | 'OPENROUTER_API_KEY';

/** Structured configuration error; carries the offending name, never a value. */
export type ConfigError = { kind: 'ENV_MISSING'; name: MissingVar };

/**
 * Pure validation of the required environment variables (Req 1.7).
 *
 * Checks `ROZA_PRIVATE_KEY` first, then `OPENROUTER_API_KEY`. A value that is
 * undefined, empty, or whitespace-only counts as missing. On failure the
 * returned error names the variable but never echoes its value.
 */
export function validateRequiredEnv(
  env: NodeJS.ProcessEnv
): { ok: true } | { ok: false; error: ConfigError } {
  const order: MissingVar[] = ['ROZA_PRIVATE_KEY', 'OPENROUTER_API_KEY'];
  for (const name of order) {
    const raw = env[name];
    if (raw === undefined || raw.trim().length === 0) {
      return { ok: false, error: { kind: 'ENV_MISSING', name } };
    }
  }
  return { ok: true };
}

/**
 * Pure parse of a 24-hour `HH:MM` value (Req 2.3).
 *
 * Returns minutes since midnight for a valid value in `00:00`–`23:59`, and
 * `null` for anything else (wrong shape, out-of-range, non-numeric, undefined).
 * The format is strict: exactly two digits for the hour and two for the minute.
 */
export function parseHHMM(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }

  const match = /^(\d{2}):(\d{2})$/.exec(raw.trim());
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  const total = hours * 60 + minutes;
  // Defensive: total is in [0, 1439] for valid HH:MM, but guard the bound.
  return total >= 0 && total < MINUTES_PER_DAY ? total : null;
}

/**
 * Pure resolution of the Active_Window from configuration (Req 2.4).
 *
 * Builds the window from `ACTIVE_WINDOW_START` / `ACTIVE_WINDOW_END`. When
 * either bound is absent or not a valid HH:MM value, falls back to
 * `DEFAULT_WINDOW` (07:00–22:00) and reports `usedDefault: true` so the caller
 * can emit the invalid-configuration log. A window whose start is not strictly
 * before its end is also treated as invalid and falls back to the default.
 */
export function resolveActiveWindow(
  env: NodeJS.ProcessEnv
): { window: ActiveWindow; usedDefault: boolean } {
  const startMinutes = parseHHMM(env.ACTIVE_WINDOW_START);
  const endMinutes = parseHHMM(env.ACTIVE_WINDOW_END);

  if (startMinutes === null || endMinutes === null || startMinutes >= endMinutes) {
    return { window: DEFAULT_WINDOW, usedDefault: true };
  }

  return { window: { startMinutes, endMinutes }, usedDefault: false };
}

/**
 * Imperative startup wrapper (Req 1.7, 2.4, 5.2).
 *
 * Validates required secrets; on failure it logs the variable NAME only (never
 * the value) and calls `process.exit(1)` so the service never reaches an
 * operational state without its prerequisites. When the Active_Window
 * configuration is invalid it emits an error log and falls back to defaults.
 */
export function loadConfigOrExit(env: NodeJS.ProcessEnv): RozaConfig {
  const required = validateRequiredEnv(env);
  if (!required.ok) {
    console.error(
      `[config] Startup aborted: required environment variable ${required.error.name} is missing or empty.`
    );
    process.exit(1);
  }

  const { window, usedDefault } = resolveActiveWindow(env);
  if (usedDefault) {
    console.error(
      '[config] Invalid or missing Active_Window configuration ' +
        '(ACTIVE_WINDOW_START / ACTIVE_WINDOW_END); falling back to defaults 07:00–22:00.'
    );
  }

  return {
    // Non-null assertions are safe: validateRequiredEnv guarantees presence.
    rozaPrivateKey: env.ROZA_PRIVATE_KEY!.trim(),
    openRouterApiKey: env.OPENROUTER_API_KEY!.trim(),
    openRouterModel: env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL,
    // Prefer the documented ROZA_-prefixed names; fall back to the unprefixed
    // legacy names for resilience (see .env.example / docker-compose.yml).
    dataDir: env.ROZA_DATA_DIR?.trim() || env.DATA_DIR?.trim() || DEFAULT_DATA_DIR,
    timezone: env.ROZA_TIMEZONE?.trim() || env.TIMEZONE?.trim() || DEFAULT_TIMEZONE,
    activeWindow: window,
    keyVersion: env.ROZA_KEY_VERSION?.trim() || env.KEY_VERSION?.trim() || DEFAULT_KEY_VERSION,
  };
}
