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

/** Default TTS engine (Phase 3, Req 2.3, 3.1) — Piper (MIT, commercial-safe). */
const DEFAULT_TTS_ENGINE = 'piper';
/** Default Piper voice id when `TTS_VOICE` is not provided. */
const DEFAULT_TTS_VOICE = 'en_US-amy-medium';
/** Default Piper model id when `TTS_MODEL` is not provided. */
const DEFAULT_TTS_MODEL = 'en_US-amy-medium';
/** Default STT engine (Phase 3, Req 3.1) — whisper.cpp (MIT, commercial-safe). */
const DEFAULT_STT_ENGINE = 'whisper.cpp';
/** Default whisper.cpp ggml model id when `STT_MODEL` is not provided. */
const DEFAULT_STT_MODEL = 'ggml-base.en';
/** Default maximum reply length handed to TTS (Phase 3, Req 2.5). */
const DEFAULT_MAX_REPLY_CHARS = 1000;
/** Default time-to-first-audio bound for TTS, in ms (Phase 3, Req 12.1, 12.2). */
const DEFAULT_TTS_LATENCY_MS = 5000;
/** Default transcription bound for STT, in ms (Phase 3, Req 12.1, 12.2). */
const DEFAULT_STT_LATENCY_MS = 5000;
/** Default end-to-end voice response bound, in ms (Phase 3, Req 12.1, 12.2). */
const DEFAULT_VOICE_RESPONSE_LATENCY_MS = 8000;
/** Default ring timeout for outbound origination, in ms (Phase 3, Req 5.4). */
const DEFAULT_VOICE_RING_TIMEOUT_MS = 30000;
/** Default inbound no-allowlist access policy (Phase 3, Req 10.6). */
const DEFAULT_VOICE_ACCESS: VoiceDefaultAccess = 'reject';
/** Default inbound quiet-hours policy (Phase 3, Req 8.3). */
const DEFAULT_QUIET_HOURS_INBOUND: QuietHoursInboundPolicy = 'take_message';

/** Default avatar Video_Frame width in pixels (Phase 4, Req 2.3, 10.1). */
const DEFAULT_AVATAR_WIDTH = 512;
/** Default avatar Video_Frame height in pixels (Phase 4, Req 2.3, 10.1). */
const DEFAULT_AVATAR_HEIGHT = 512;
/** Default avatar frame rate in frames per second (Phase 4, Req 2.3, 10.1). */
const DEFAULT_AVATAR_FPS = 25;
/** Default avatar pixel/encoding format when `AVATAR_PIXEL_FORMAT` is not provided. */
const DEFAULT_AVATAR_PIXEL_FORMAT: AvatarPixelFormat = 'yuv420p';
/** Default synthesis latency budget, in ms; on overrun → audio-only fallback (Phase 4, Req 2.7, 10.1, 10.3). */
const DEFAULT_AVATAR_RENDER_LATENCY_MS = 4000;

/** Minutes in a single day; HH:MM values resolve to `[0, 1439]`. */
const MINUTES_PER_DAY = 24 * 60;

/**
 * Telegram channel configuration (Phase 2, Req 4, 5, 9, 13).
 *
 * `enabled` reflects `TELEGRAM_ENABLED` (default false). `botToken` is the
 * secret `TELEGRAM_BOT_TOKEN`, validated non-blank only WHEN the channel is
 * enabled. `allowlist` is the optional comma-separated `TELEGRAM_ALLOWLIST`;
 * an enabled channel with an empty allowlist is documented allow-all.
 */
export interface TelegramChannelConfig {
  /** TELEGRAM_ENABLED (default false). */
  enabled: boolean;
  /** TELEGRAM_BOT_TOKEN; validated non-blank only when `enabled`. Never logged. */
  botToken: string;
  /**
   * TELEGRAM_ALLOWLIST: trimmed, non-empty chat/user ids. An empty array on an
   * enabled channel means allow-all (documented default — Req 9.3).
   */
  allowlist: string[];
}

/**
 * Mail channel configuration (Phase 2, Req 4, 5, 7, 9, 13).
 *
 * `enabled` reflects `MAIL_ENABLED` (default false). The IMAP (read) and SMTP
 * (send) host/port/user/password are validated non-blank only WHEN the channel
 * is enabled. `allowlist` is the optional comma-separated `MAIL_ALLOWLIST`; an
 * enabled channel with an empty allowlist is documented allow-all.
 */
export interface MailChannelConfig {
  /** MAIL_ENABLED (default false). */
  enabled: boolean;
  /** IMAP read credentials; validated non-blank only when `enabled`. Never logged. */
  imap: { host: string; port: number; user: string; password: string };
  /** SMTP send credentials; validated non-blank only when `enabled`. Never logged. */
  smtp: { host: string; port: number; user: string; password: string };
  /**
   * MAIL_ALLOWLIST: trimmed, non-empty email addresses. An empty array on an
   * enabled channel means allow-all (documented default — Req 9.3).
   */
  allowlist: string[];
}

/**
 * Inbound quiet-hours policy (Phase 3, Req 8.3). When a call arrives during
 * Quiet_Hours the connector applies exactly this policy: outright `reject`,
 * `answer_busy`, or `take_message`.
 */
export type QuietHoursInboundPolicy = 'reject' | 'answer_busy' | 'take_message';

/**
 * No-allowlist default access for the voice channel (Phase 3, Req 10.6). When
 * `VOICE_ALLOWLIST` is empty this decides whether unknown callers are rejected
 * or allowed.
 */
export type VoiceDefaultAccess = 'reject' | 'allow';

/**
 * Voice channel configuration (Phase 3, Req 1.1, 2.3, 2.5, 7, 8.3, 10, 12).
 *
 * `enabled` reflects `VOICE_ENABLED` (default false). The SIP trunk
 * host/port/user/password/realm are validated non-blank only WHEN the channel
 * is enabled and are never logged or persisted. `allowlist` is the optional
 * comma-separated `VOICE_ALLOWLIST`; an enabled channel with an empty allowlist
 * applies `defaultAccess`. Engine/voice/model and latency settings parse with
 * documented defaults so an enabled channel always has a complete, tunable
 * config.
 */
export interface VoiceChannelConfig {
  /** VOICE_ENABLED (default false) — Req 1.1. */
  enabled: boolean;
  /** SIP trunk credentials; validated non-blank only when `enabled`. Never logged/persisted (Req 7). */
  sip: { host: string; port: number; user: string; password: string; realm: string };
  /**
   * VOICE_ALLOWLIST: trimmed, non-empty caller identities. An empty array on an
   * enabled channel applies `defaultAccess` (Req 10.4, 10.6).
   */
  allowlist: string[];
  /** VOICE_DEFAULT_ACCESS for an empty allowlist (default 'reject') — Req 10.6. */
  defaultAccess: VoiceDefaultAccess;
  /** VOICE_QUIET_HOURS_INBOUND policy (default 'take_message') — Req 8.3. */
  quietHoursInbound: QuietHoursInboundPolicy;
  /** TTS_ENGINE/TTS_VOICE/TTS_MODEL with documented defaults — Req 2.3. */
  tts: { engine: string; voice: string; model: string };
  /** STT_ENGINE/STT_MODEL with documented defaults. */
  stt: { engine: string; model: string };
  /** TTS_MAX_REPLY_CHARS — synthesis latency contract bound (Req 2.5). */
  maxReplyChars: number;
  /** Tunable latency bounds in ms (Req 5.4, 12.1, 12.2). */
  latency: { ttsMs: number; sttMs: number; endToEndMs: number; ringTimeoutMs: number };
}

/**
 * Pixel/encoding format of a rendered Video_Frame (Phase 4 — Avatar_Video_Format,
 * Req 2.3). Parsed with the documented default `'yuv420p'`.
 */
export type AvatarPixelFormat = 'rgba' | 'yuv420p' | 'nv12';

/**
 * Avatar capability configuration (Phase 4, Req 1.1, 2.3, 6, 7, 8.1–8.4, 10.1).
 *
 * `enabled` reflects `AVATAR_ENABLED` (default false). The avatar is a
 * configuration-gated presence/output capability, not a conversation `Channel`.
 * The `video` Avatar_Video_Format, `latency` budget, `renderer` sidecar
 * endpoint, and virtual `devices` names parse with documented defaults so an
 * enabled capability always has a complete, tunable config. The `meet`
 * sub-capability carries the operator-provided `Meet_Credentials`
 * (account/password) validated non-blank only WHEN `meet.enabled`, plus a
 * `consent` flag that must be true before any join. The `stream` sub-capability
 * carries the optional `RTMP_Target` url and the secret `key`, validated
 * non-blank only WHEN `stream.enabled`. Credential/key VALUES are never logged
 * or surfaced — only the offending variable NAME (Req 8.4).
 */
export interface AvatarChannelConfig {
  /** AVATAR_ENABLED (default false) — Req 1.1. */
  enabled: boolean;
  /** Avatar_Video_Format the renderer must emit and the devices consume — Req 2.3, 10.1. */
  video: { width: number; height: number; fps: number; pixelFormat: AvatarPixelFormat };
  /** Synthesis latency budget; on overrun → audio-only fallback — Req 2.7, 10.1, 10.3. */
  latency: { renderMs: number };
  /** Renderer sidecar endpoint and engine id (no secret) — Req 2.5, 2.6. */
  renderer: { endpoint: string; engine: string };
  /** Virtual-device names (no secret) — Req 5.4. */
  devices: { camera: string; microphone: string };
  /** Google Meet presence sub-capability — Req 6. Credentials validated only when `enabled`. */
  meet: { enabled: boolean; consent: boolean; account: string; password: string };
  /** Optional live RTMP streaming sub-capability — Req 7. Key validated only when `enabled`. */
  stream: { enabled: boolean; url: string; key: string };
}

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
  /** Telegram channel enablement, credentials, and allowlist (Phase 2, Req 4, 5, 9). */
  telegram: TelegramChannelConfig;
  /** Mail channel enablement, credentials, and allowlist (Phase 2, Req 4, 5, 9). */
  mail: MailChannelConfig;
  /** Voice channel enablement, SIP credentials, allowlist, and engine/latency settings (Phase 3). */
  voice: VoiceChannelConfig;
  /** Avatar presence/output capability enablement, video/latency/renderer/device settings, and Meet/stream sub-capabilities (Phase 4). */
  avatar: AvatarChannelConfig;
}

/** The two required environment variables (Req 1.7). */
export type MissingVar = 'ROZA_PRIVATE_KEY' | 'OPENROUTER_API_KEY';

/**
 * Per-channel credential environment variables that are required only when
 * their owning channel is enabled (Phase 2, Req 4.2, 4.3). Reported by NAME
 * only — the value is never surfaced.
 */
export type MissingChannelVar =
  | 'TELEGRAM_BOT_TOKEN'
  | 'MAIL_IMAP_HOST'
  | 'MAIL_IMAP_PORT'
  | 'MAIL_IMAP_USER'
  | 'MAIL_IMAP_PASSWORD'
  | 'MAIL_SMTP_HOST'
  | 'MAIL_SMTP_PORT'
  | 'MAIL_SMTP_USER'
  | 'MAIL_SMTP_PASSWORD';

/**
 * SIP trunk credential environment variables that are required only when the
 * voice channel is enabled (Phase 3, Req 7.2). Reported by NAME only — the
 * value is never surfaced.
 */
export type MissingVoiceVar = 'SIP_HOST' | 'SIP_PORT' | 'SIP_USER' | 'SIP_PASSWORD' | 'SIP_REALM';

/**
 * Meet/streaming secret environment variables that are required only when their
 * owning sub-capability is enabled (Phase 4, Req 8.2). `MEET_ACCOUNT`/
 * `MEET_PASSWORD` are the `Meet_Credentials`; `STREAM_KEY` is the `Stream_Key`.
 * Reported by NAME only — the value is never surfaced (Req 8.4).
 */
export type MissingAvatarVar = 'MEET_ACCOUNT' | 'MEET_PASSWORD' | 'STREAM_KEY';

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

/** True when a raw env value is undefined, empty, or whitespace-only. */
function isBlank(raw: string | undefined): boolean {
  return raw === undefined || raw.trim().length === 0;
}

/**
 * Pure parse of a comma-separated allowlist (Phase 2, Req 9.1, 9.3).
 *
 * Splits on commas, trims each entry, and drops empty entries. An undefined or
 * blank input yields an empty array. The result preserves input order and is
 * total (never throws).
 */
export function parseAllowlist(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Pure parse of a `*_ENABLED` boolean flag (Phase 2, Req 5.1).
 *
 * Returns `true` only for the literal (case-insensitive, trimmed) value
 * `"true"`. Every other value — including `"false"`, garbage, empty, and
 * undefined — resolves to the default `false`. Total (never throws).
 */
export function parseBoolFlag(raw: string | undefined): boolean {
  return raw !== undefined && raw.trim().toLowerCase() === 'true';
}

/**
 * Pure parse of a TCP port (Phase 2, Req 4.3).
 *
 * Returns the parsed positive integer, or `0` when the value is absent or not
 * a valid positive integer. Total (never throws).
 */
function parsePort(raw: string | undefined): number {
  if (isBlank(raw)) {
    return 0;
  }
  const n = Number.parseInt((raw as string).trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** True when a port env value is missing or not a valid positive integer. */
function isPortMissing(raw: string | undefined): boolean {
  return parsePort(raw) === 0;
}

/**
 * Pure resolution of the Telegram channel configuration (Phase 2, Req 4.2, 5.1, 9).
 *
 * When `TELEGRAM_ENABLED` is true and `TELEGRAM_BOT_TOKEN` is blank/whitespace/
 * undefined, the token is reported missing by NAME. When the channel is
 * disabled, the result is always `ok` with `enabled: false` and no error even
 * if the token is absent. The bot token value is never surfaced in the error.
 */
export function resolveTelegramConfig(
  env: NodeJS.ProcessEnv
): { ok: true; cfg: TelegramChannelConfig } | { ok: false; missing: MissingChannelVar[] } {
  const enabled = parseBoolFlag(env.TELEGRAM_ENABLED);
  const allowlist = parseAllowlist(env.TELEGRAM_ALLOWLIST);

  if (enabled && isBlank(env.TELEGRAM_BOT_TOKEN)) {
    return { ok: false, missing: ['TELEGRAM_BOT_TOKEN'] };
  }

  return {
    ok: true,
    cfg: {
      enabled,
      botToken: env.TELEGRAM_BOT_TOKEN?.trim() ?? '',
      allowlist,
    },
  };
}

/**
 * Pure resolution of the Mail channel configuration (Phase 2, Req 4.3, 5.1, 9).
 *
 * When `MAIL_ENABLED` is true, each blank/missing IMAP and SMTP host/port/user/
 * password variable is reported missing by NAME (in a stable order). Ports are
 * parsed as numbers. When the channel is disabled, the result is always `ok`
 * with `enabled: false` and no error even if credentials are absent. Credential
 * values are never surfaced in the error.
 */
export function resolveMailConfig(
  env: NodeJS.ProcessEnv
): { ok: true; cfg: MailChannelConfig } | { ok: false; missing: MissingChannelVar[] } {
  const enabled = parseBoolFlag(env.MAIL_ENABLED);
  const allowlist = parseAllowlist(env.MAIL_ALLOWLIST);

  const cfg: MailChannelConfig = {
    enabled,
    imap: {
      host: env.MAIL_IMAP_HOST?.trim() ?? '',
      port: parsePort(env.MAIL_IMAP_PORT),
      user: env.MAIL_IMAP_USER?.trim() ?? '',
      password: env.MAIL_IMAP_PASSWORD ?? '',
    },
    smtp: {
      host: env.MAIL_SMTP_HOST?.trim() ?? '',
      port: parsePort(env.MAIL_SMTP_PORT),
      user: env.MAIL_SMTP_USER?.trim() ?? '',
      password: env.MAIL_SMTP_PASSWORD ?? '',
    },
    allowlist,
  };

  if (!enabled) {
    return { ok: true, cfg };
  }

  const missing: MissingChannelVar[] = [];
  if (isBlank(env.MAIL_IMAP_HOST)) missing.push('MAIL_IMAP_HOST');
  if (isPortMissing(env.MAIL_IMAP_PORT)) missing.push('MAIL_IMAP_PORT');
  if (isBlank(env.MAIL_IMAP_USER)) missing.push('MAIL_IMAP_USER');
  if (isBlank(env.MAIL_IMAP_PASSWORD)) missing.push('MAIL_IMAP_PASSWORD');
  if (isBlank(env.MAIL_SMTP_HOST)) missing.push('MAIL_SMTP_HOST');
  if (isPortMissing(env.MAIL_SMTP_PORT)) missing.push('MAIL_SMTP_PORT');
  if (isBlank(env.MAIL_SMTP_USER)) missing.push('MAIL_SMTP_USER');
  if (isBlank(env.MAIL_SMTP_PASSWORD)) missing.push('MAIL_SMTP_PASSWORD');

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return { ok: true, cfg };
}

/**
 * Pure parse of a positive-integer setting with a documented default (Phase 3).
 *
 * Returns the parsed positive integer, or `fallback` when the value is absent
 * or not a valid positive integer. Total (never throws).
 */
function parsePositiveIntOr(raw: string | undefined, fallback: number): number {
  if (isBlank(raw)) {
    return fallback;
  }
  const n = Number.parseInt((raw as string).trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Pure parse of `VOICE_DEFAULT_ACCESS` (Phase 3, Req 10.6).
 *
 * Returns `'reject'` or `'allow'` for the matching (trimmed, case-insensitive)
 * value; every other value resolves to the default `'reject'`. Total.
 */
function parseVoiceDefaultAccess(raw: string | undefined): VoiceDefaultAccess {
  const v = raw?.trim().toLowerCase();
  return v === 'allow' || v === 'reject' ? v : DEFAULT_VOICE_ACCESS;
}

/**
 * Pure parse of `VOICE_QUIET_HOURS_INBOUND` (Phase 3, Req 8.3).
 *
 * Returns one of `'reject' | 'answer_busy' | 'take_message'` for the matching
 * (trimmed, case-insensitive) value; every other value resolves to the default
 * `'take_message'`. Total.
 */
function parseQuietHoursInbound(raw: string | undefined): QuietHoursInboundPolicy {
  const v = raw?.trim().toLowerCase();
  return v === 'reject' || v === 'answer_busy' || v === 'take_message'
    ? v
    : DEFAULT_QUIET_HOURS_INBOUND;
}

/**
 * Pure resolution of the Voice channel configuration (Phase 3, Req 1.1, 2.3,
 * 2.5, 7.1–7.3, 8.3, 10.4, 10.6, 12.1, 12.2).
 *
 * When `VOICE_ENABLED` is true, each blank/missing SIP host/port/user/password/
 * realm variable is reported missing by NAME (in a stable order); `SIP_PORT`
 * counts as missing unless it parses to a positive integer. When the channel is
 * disabled, the result is always `ok` with `enabled: false` and no error even
 * if SIP credentials are absent — the channel stays inert. Engine/voice/model,
 * latency bounds, `maxReplyChars`, `defaultAccess`, and `quietHoursInbound`
 * parse with documented defaults so an enabled channel always has a complete,
 * tunable config. Credential values are never surfaced in the error.
 */
export function resolveVoiceConfig(
  env: NodeJS.ProcessEnv
): { ok: true; cfg: VoiceChannelConfig } | { ok: false; missing: MissingVoiceVar[] } {
  const enabled = parseBoolFlag(env.VOICE_ENABLED);
  const allowlist = parseAllowlist(env.VOICE_ALLOWLIST);

  const cfg: VoiceChannelConfig = {
    enabled,
    sip: {
      host: env.SIP_HOST?.trim() ?? '',
      port: parsePort(env.SIP_PORT),
      user: env.SIP_USER?.trim() ?? '',
      password: env.SIP_PASSWORD ?? '',
      realm: env.SIP_REALM?.trim() ?? '',
    },
    allowlist,
    defaultAccess: parseVoiceDefaultAccess(env.VOICE_DEFAULT_ACCESS),
    quietHoursInbound: parseQuietHoursInbound(env.VOICE_QUIET_HOURS_INBOUND),
    tts: {
      engine: env.TTS_ENGINE?.trim() || DEFAULT_TTS_ENGINE,
      voice: env.TTS_VOICE?.trim() || DEFAULT_TTS_VOICE,
      model: env.TTS_MODEL?.trim() || DEFAULT_TTS_MODEL,
    },
    stt: {
      engine: env.STT_ENGINE?.trim() || DEFAULT_STT_ENGINE,
      model: env.STT_MODEL?.trim() || DEFAULT_STT_MODEL,
    },
    maxReplyChars: parsePositiveIntOr(env.TTS_MAX_REPLY_CHARS, DEFAULT_MAX_REPLY_CHARS),
    latency: {
      ttsMs: parsePositiveIntOr(env.TTS_LATENCY_MS, DEFAULT_TTS_LATENCY_MS),
      sttMs: parsePositiveIntOr(env.STT_LATENCY_MS, DEFAULT_STT_LATENCY_MS),
      endToEndMs: parsePositiveIntOr(env.VOICE_RESPONSE_LATENCY_MS, DEFAULT_VOICE_RESPONSE_LATENCY_MS),
      ringTimeoutMs: parsePositiveIntOr(env.VOICE_RING_TIMEOUT_MS, DEFAULT_VOICE_RING_TIMEOUT_MS),
    },
  };

  if (!enabled) {
    return { ok: true, cfg };
  }

  const missing: MissingVoiceVar[] = [];
  if (isBlank(env.SIP_HOST)) missing.push('SIP_HOST');
  if (isPortMissing(env.SIP_PORT)) missing.push('SIP_PORT');
  if (isBlank(env.SIP_USER)) missing.push('SIP_USER');
  if (isBlank(env.SIP_PASSWORD)) missing.push('SIP_PASSWORD');
  if (isBlank(env.SIP_REALM)) missing.push('SIP_REALM');

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return { ok: true, cfg };
}

/**
 * Pure parse of `AVATAR_PIXEL_FORMAT` (Phase 4, Req 2.3).
 *
 * Returns one of `'rgba' | 'yuv420p' | 'nv12'` for the matching (trimmed,
 * case-insensitive) value; every other value resolves to the documented default
 * `'yuv420p'`. Total (never throws).
 */
function parseAvatarPixelFormat(raw: string | undefined): AvatarPixelFormat {
  const v = raw?.trim().toLowerCase();
  return v === 'rgba' || v === 'yuv420p' || v === 'nv12' ? v : DEFAULT_AVATAR_PIXEL_FORMAT;
}

/**
 * Pure resolution of the Avatar capability configuration (Phase 4, Req 1.1,
 * 1.3, 2.3, 6.4, 7.3, 8.1–8.4, 10.1).
 *
 * Reads `AVATAR_ENABLED`. When the capability is DISABLED, the result is always
 * `ok` with `enabled: false` and no error even if any Meet/RTMP secret is absent
 * — the capability stays inert (Req 1.3, 8.3). When ENABLED, the video
 * width/height/fps/pixel-format, the render latency budget, the renderer
 * endpoint/engine, and the device names parse with documented defaults so an
 * enabled capability always has a complete, tunable config (Req 2.3, 10.1).
 *
 * The Meet sub-capability is missing-checked ONLY when `MEET_ENABLED` is true:
 * `MEET_ACCOUNT` and `MEET_PASSWORD` (the `Meet_Credentials`) blank/whitespace/
 * undefined are collected by NAME in a stable order (Req 8.2); `MEET_CONSENT`
 * parses as a boolean (default false) and is enforced at the connector gate
 * (Req 6.4). The stream sub-capability is missing-checked ONLY when
 * `STREAM_ENABLED` is true: a blank `STREAM_KEY` is collected by NAME — its
 * VALUE is never surfaced (Req 8.4). Mirrors `resolveVoiceConfig` line-for-line.
 */
export function resolveAvatarConfig(
  env: NodeJS.ProcessEnv
): { ok: true; cfg: AvatarChannelConfig } | { ok: false; missing: MissingAvatarVar[] } {
  const enabled = parseBoolFlag(env.AVATAR_ENABLED);
  const meetEnabled = parseBoolFlag(env.MEET_ENABLED);
  const streamEnabled = parseBoolFlag(env.STREAM_ENABLED);

  const cfg: AvatarChannelConfig = {
    enabled,
    video: {
      width: parsePositiveIntOr(env.AVATAR_WIDTH, DEFAULT_AVATAR_WIDTH),
      height: parsePositiveIntOr(env.AVATAR_HEIGHT, DEFAULT_AVATAR_HEIGHT),
      fps: parsePositiveIntOr(env.AVATAR_FPS, DEFAULT_AVATAR_FPS),
      pixelFormat: parseAvatarPixelFormat(env.AVATAR_PIXEL_FORMAT),
    },
    latency: {
      renderMs: parsePositiveIntOr(env.AVATAR_RENDER_LATENCY_MS, DEFAULT_AVATAR_RENDER_LATENCY_MS),
    },
    renderer: {
      endpoint: env.AVATAR_RENDERER_ENDPOINT?.trim() ?? '',
      engine: env.AVATAR_ENGINE?.trim() ?? '',
    },
    devices: {
      camera: env.AVATAR_CAMERA_DEVICE?.trim() ?? '',
      microphone: env.AVATAR_MIC_DEVICE?.trim() ?? '',
    },
    meet: {
      enabled: meetEnabled,
      consent: parseBoolFlag(env.MEET_CONSENT),
      account: env.MEET_ACCOUNT?.trim() ?? '',
      password: env.MEET_PASSWORD ?? '',
    },
    stream: {
      enabled: streamEnabled,
      url: env.RTMP_URL?.trim() ?? '',
      key: env.STREAM_KEY ?? '',
    },
  };

  if (!enabled) {
    return { ok: true, cfg };
  }

  const missing: MissingAvatarVar[] = [];
  if (meetEnabled && isBlank(env.MEET_ACCOUNT)) missing.push('MEET_ACCOUNT');
  if (meetEnabled && isBlank(env.MEET_PASSWORD)) missing.push('MEET_PASSWORD');
  if (streamEnabled && isBlank(env.STREAM_KEY)) missing.push('STREAM_KEY');

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return { ok: true, cfg };
}

/**
 * Imperative startup wrapper (Req 1.7, 2.4, 5.2).
 *
 * Validates required secrets; on failure it logs the variable NAME only (never
 * the value) and calls `process.exit(1)` so the service never reaches an
 * operational state without its prerequisites. When the Active_Window
 * configuration is invalid it emits an error log and falls back to defaults.
 *
 * Phase 2 (Req 4.2, 4.3, 5.1): after the Phase 1 checks it resolves the
 * Telegram and Mail channels. For each ENABLED channel with one or more missing
 * credential variables, it logs each missing variable by NAME (never its value)
 * and `process.exit(1)`. A DISABLED channel with missing credentials is not an
 * error — it stays inert. An enabled channel with no configured allowlist is the
 * documented allow-all default (Req 9.3).
 *
 * Phase 3 (Req 7.2, 7.3): the voice channel follows the identical contract.
 * When `VOICE_ENABLED` is true and any SIP trunk variable is missing, each is
 * logged by NAME and `process.exit(1)`; a disabled voice channel stays inert.
 *
 * Phase 4 (Req 8.2, 8.3): the avatar capability follows the identical contract.
 * When the Meet sub-capability is enabled and `MEET_ACCOUNT`/`MEET_PASSWORD` are
 * missing, or the stream sub-capability is enabled and `STREAM_KEY` is missing,
 * each is logged by NAME (never the value) and `process.exit(1)`; a disabled
 * avatar capability stays inert.
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

  // Phase 2: resolve channel enablement + credentials. Only ENABLED channels
  // with missing credentials abort startup; disabled channels stay inert.
  // Phase 3: the voice channel follows the identical fail-fast contract.
  const telegram = resolveTelegramConfig(env);
  const mail = resolveMailConfig(env);
  const voice = resolveVoiceConfig(env);
  const avatar = resolveAvatarConfig(env);
  if (!telegram.ok || !mail.ok || !voice.ok || !avatar.ok) {
    const channelMissing: (MissingChannelVar | MissingVoiceVar | MissingAvatarVar)[] = [
      ...(telegram.ok ? [] : telegram.missing),
      ...(mail.ok ? [] : mail.missing),
      ...(voice.ok ? [] : voice.missing),
      ...(avatar.ok ? [] : avatar.missing),
    ];
    for (const name of channelMissing) {
      console.error(
        `[config] Startup aborted: required environment variable ${name} is missing or empty.`
      );
    }
    process.exit(1);
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
    // Phase 2: both resolvers are `ok` here (the guard above exits otherwise).
    telegram: telegram.cfg,
    mail: mail.cfg,
    // Phase 3: `voice` is `ok` here (the guard above exits otherwise).
    voice: voice.cfg,
    // Phase 4: `avatar` is `ok` here (the guard above exits otherwise).
    avatar: avatar.cfg,
  };
}
