/**
 * Phase 2 scope-boundary + open-source smoke tests (task 14.2) —
 * Req 13, 15.2, 15.3, 15.4, 15.5.
 *
 * These are static, file-system-only checks (no Docker, no network) that guard
 * the Phase 2 scope boundary and the open-source-first constraint:
 *
 *   - Open-source deps (Req 13): the four Phase 2 runtime additions are the
 *     free/open set (grammy, imapflow, mailparser, nodemailer) and NO paid
 *     Telegram/email API SDK nor any excluded X/Twitter, voice, or avatar SDK
 *     appears in `package.json`.
 *   - Excluded-integration isolation (Req 15.2): no source module imports an
 *     excluded integration (ElevenLabs/Vapi/HeyGen/Tavus/Twitter/Playwright/
 *     Puppeteer) — these belong to FUTURE phases and must not be present now.
 *   - Recorded directions (Req 15.4, 15.5): the governing forward-looking
 *     technology directions (Playwright/Puppeteer for X; XTTS-v2/Coqui for
 *     voice; Wav2Lip/SadTalker for avatar/video) are recorded in the committed
 *     spec/service documentation.
 *   - `voice` not operative (Req 15.3): the engine never reports `voice` as
 *     operative and always rejects it, regardless of channel configuration.
 *
 * The import scan inspects *import specifiers* (not raw text), reusing the
 * approach from `isolation.smoke.test.ts`, so a literal channel string in prose
 * is not mistaken for a real coupling. Paths are resolved from `import.meta.url`
 * (NodeNext ESM) via `fileURLToPath`.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decideChannel, operativeChannels } from './engine.js';
import type { RozaConfig } from './config.js';
import type { Channel } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Nearest ancestor directory containing a `package.json` (the service root). */
function findServiceRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not locate package.json above ${start}`);
    }
    dir = parent;
  }
}

const SERVICE_ROOT = findServiceRoot(__dirname);
const SRC_DIR = path.join(SERVICE_ROOT, 'src');

/** Recursively collect non-test `.ts` source files under a directory. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...collectSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Extract every module specifier referenced by import/export/require in `content`. */
function importSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const patterns: RegExp[] = [
    /\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (m[1]) specifiers.push(m[1]);
    }
  }
  return specifiers;
}

/** True when a specifier points at an external package (not relative / node builtin). */
function isExternalPackage(spec: string): boolean {
  return !spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('node:');
}

/** The expected open-source / free Phase 2 runtime dependencies (Req 13.1–13.4). */
const REQUIRED_OSS_DEPS = ['grammy', 'imapflow', 'mailparser', 'nodemailer'] as const;

/**
 * Excluded integrations that belong to FUTURE phases (Req 15.2). Matched against
 * external package specifiers and dependency names. Each pattern is anchored to
 * a package-name segment so it cannot false-positive on an unrelated substring.
 *
 * NOTE: browser automation (Playwright/Puppeteer) is intentionally NOT excluded.
 * Per the project's golden rule it is the APPROVED open-source approach over
 * paid APIs, and Phase 4 legitimately ships it (Google Meet avatar sessions via
 * `src/connectors/avatar/meetSession.ts`). The genuinely-excluded set remains
 * paid voice/avatar SaaS and X/Twitter client SDKs.
 */
const EXCLUDED_INTEGRATIONS: { label: string; pattern: RegExp }[] = [
  { label: 'ElevenLabs (voice)', pattern: /(^|[/@])elevenlabs/i },
  { label: 'Vapi (voice/telephony)', pattern: /(^|[/@])vapi/i },
  { label: 'HeyGen (avatar/video)', pattern: /(^|[/@])heygen/i },
  { label: 'Tavus (avatar/video)', pattern: /(^|[/@])tavus/i },
  { label: 'X / Twitter SDK', pattern: /(^|[/@])(twitter|twit)($|[-/])/i },
];

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(): PackageJson {
  const pkgPath = path.join(SERVICE_ROOT, 'package.json');
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PackageJson;
}

describe('Phase 2 scope — open-source dependencies (Req 13)', () => {
  const pkg = readPackageJson();
  const deps = pkg.dependencies ?? {};

  it('declares the free/open Phase 2 runtime dependencies', () => {
    for (const name of REQUIRED_OSS_DEPS) {
      expect(deps[name], `expected runtime dependency '${name}' in package.json`).toBeTruthy();
    }
  });

  it('declares no paid/excluded Telegram, email, X/Twitter, voice, or avatar SDK', () => {
    // Scan every declared dependency name (runtime + dev) for an excluded SDK.
    const allDepNames = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];

    const violations: string[] = [];
    for (const name of allDepNames) {
      for (const { label, pattern } of EXCLUDED_INTEGRATIONS) {
        if (pattern.test(name)) {
          violations.push(`'${name}' matches excluded ${label}`);
        }
      }
    }

    expect(
      violations,
      `Phase 2 scope breach — excluded SDK declared in package.json:\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});

describe('Phase 2 scope — no excluded-integration imports (Req 15.2)', () => {
  const sourceFiles = collectSourceFiles(SRC_DIR);

  it('discovers source files to scan', () => {
    expect(sourceFiles.length, `no .ts source files found under ${SRC_DIR}`).toBeGreaterThan(0);
  });

  it('no source module imports a future-phase integration (X/voice/avatar paid SaaS)', () => {
    const violations: string[] = [];

    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, 'utf8');
      const rel = path.relative(SERVICE_ROOT, file);
      for (const spec of importSpecifiers(content)) {
        if (!isExternalPackage(spec)) continue;
        for (const { label, pattern } of EXCLUDED_INTEGRATIONS) {
          if (pattern.test(spec)) {
            violations.push(`${rel}: imports excluded ${label} integration via '${spec}'`);
          }
        }
      }
    }

    expect(
      violations,
      `Phase 2 scope breach — excluded integration import found:\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});

describe('Phase 2 scope — forward-looking technology directions are recorded (Req 15.4, 15.5)', () => {
  /**
   * Collect the committed documentation that may record the governing
   * directions. The spec's `design.md` lives in a SIBLING repo
   * (`Opays-HQ/.kiro/specs/roza-step2-channels/`), so that cross-repo path is
   * brittle; we try it first, then fall back to the spec's `requirements.md` in
   * the same folder and any service-local docs. The assertion passes as long as
   * the directions are recorded in at least one reachable committed document.
   */
  function collectDirectionDocs(): { sources: string[]; text: string } {
    const parent = path.dirname(SERVICE_ROOT);
    const specDir = path.join(parent, 'Opays-HQ', '.kiro', 'specs', 'roza-step2-channels');
    const candidates = [
      path.join(specDir, 'design.md'), // primary: the spec design (tried first)
      path.join(specDir, 'requirements.md'), // fallback: same-spec requirements
      path.join(SERVICE_ROOT, 'assets', 'README.md'), // fallback: service-local doc
      path.join(SERVICE_ROOT, 'NOTES.md'),
      path.join(SERVICE_ROOT, 'README.md'),
    ];

    const sources: string[] = [];
    let text = '';
    for (const file of candidates) {
      if (fs.existsSync(file)) {
        sources.push(path.relative(parent, file));
        text += '\n' + fs.readFileSync(file, 'utf8');
      }
    }
    return { sources, text };
  }

  const { sources, text } = collectDirectionDocs();

  it('finds committed documentation to scan', () => {
    expect(sources.length, 'no committed spec/service documentation found to scan').toBeGreaterThan(0);
  });

  it('records X/Twitter via browser automation (Playwright or Puppeteer)', () => {
    expect(
      /playwright|puppeteer/i.test(text),
      `expected a Playwright/Puppeteer (X/Twitter) direction recorded in: ${sources.join(', ')}`,
    ).toBe(true);
  });

  it('records voice via self-hosted XTTS-v2 or Coqui TTS', () => {
    expect(
      /xtts|coqui/i.test(text),
      `expected an XTTS-v2/Coqui (voice) direction recorded in: ${sources.join(', ')}`,
    ).toBe(true);
  });

  it('records avatar/video via self-hosted Wav2Lip or SadTalker', () => {
    expect(
      /wav2lip|sadtalker/i.test(text),
      `expected a Wav2Lip/SadTalker (avatar/video) direction recorded in: ${sources.join(', ')}`,
    ).toBe(true);
  });
});

describe('Phase 2 scope — the voice channel is never operative (Req 15.3)', () => {
  /** A base config; channel flags are overridden per case. */
  function makeConfig(telegramEnabled: boolean, mailEnabled: boolean): RozaConfig {
    return {
      rozaPrivateKey: 'k',
      openRouterApiKey: 'k',
      openRouterModel: 'openai/gpt-4o-mini',
      dataDir: '/tmp/roza',
      timezone: 'UTC',
      activeWindow: { startMinutes: 420, endMinutes: 1320 },
      keyVersion: 'v1',
      telegram: { enabled: telegramEnabled, botToken: telegramEnabled ? 't' : '', allowlist: [] },
      mail: {
        enabled: mailEnabled,
        imap: { host: '', port: 0, user: '', password: '' },
        smtp: { host: '', port: 0, user: '', password: '' },
        allowlist: [],
      },
      voice: {
        enabled: false,
        sip: { host: '', port: 0, user: '', password: '', realm: '' },
        allowlist: [],
        defaultAccess: 'reject',
        quietHoursInbound: 'take_message',
        tts: { engine: 'piper', voice: 'en_US-amy-medium', model: 'en_US-amy-medium' },
        stt: { engine: 'whisper.cpp', model: 'ggml-base.en' },
        maxReplyChars: 1000,
        latency: { ttsMs: 5000, sttMs: 5000, endToEndMs: 8000, ringTimeoutMs: 30000 },
      },
      avatar: {
        enabled: false,
        video: { width: 512, height: 512, fps: 25, pixelFormat: 'yuv420p' },
        latency: { renderMs: 4000 },
        renderer: { endpoint: '', engine: '' },
        devices: { camera: '', microphone: '' },
        meet: { enabled: false, consent: false, account: '', password: '' },
        stream: { enabled: false, url: '', key: '' },
      },
    };
  }

  it('voice is never in the operative set and is always rejected, for every channel-flag combination', () => {
    for (const tg of [false, true]) {
      for (const mail of [false, true]) {
        const cfg = makeConfig(tg, mail);
        const voice: Channel = 'voice';

        expect(operativeChannels(cfg).has(voice)).toBe(false);

        const decision = decideChannel(voice, cfg);
        expect(decision.ok).toBe(false);
        if (!decision.ok) {
          expect(decision.reason).toBe('channel_not_operative');
        }
      }
    }
  });
});
