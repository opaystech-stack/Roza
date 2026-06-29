/**
 * Phase 5 scope-boundary, dependency, and recorded-direction smoke tests
 * (task 12.2) — Req 1.5, 2.1, 2.2, 2.4, 2.5, 12.1, 12.3.
 *
 * These are static, file-system-only checks (NO browser, NO X network, NO real
 * Playwright launch) that guard the Phase 5 scope boundary now that the
 * X_Capability is a configuration-gated presence/autonomy capability delivered
 * via BROWSER AUTOMATION rather than a paid social API:
 *
 *   - No paid X/Twitter API SDK (Req 2.1, 2.2): no paid X/Twitter API client
 *     SDK or paid social SaaS (`twitter` / `twitter-api-v2` / `twit` /
 *     `node-twitter`) is declared in `package.json` or imported by any source
 *     module. Browser automation is the ONLY sanctioned X-interaction path.
 *   - Browser automation only (Req 2.1, 2.4): the sole X-interaction technology
 *     is browser automation — `playwright` (Apache-2.0, open-source) is present
 *     in the package.json dependencies and IS the approved approach.
 *   - Channel boundary (Req 1.5, 12.1): the X capability adds NO member to the
 *     closed `Channel` union (`internal | telegram | email | voice`). It is
 *     gated by the pure `decideX` capability gate, and `operativeChannels` is
 *     byte-for-byte identical for two configs differing ONLY in `cfg.x.*`.
 *   - Recorded direction (Req 2.5, 12.3): the fragility / Terms-of-Service /
 *     anti-bot honesty notes AND the "Phase 5 completes Roza's social
 *     architecture via browser automation under the open-source-first rule"
 *     note are recorded in the committed operator/spec docs (`.env.example`
 *     and/or the spec docs).
 *
 * The import scan inspects *import specifiers* (not raw text), reusing the
 * approach from `phase4-scope.smoke.test.ts`, so a literal package name in
 * prose is not mistaken for a real coupling. Paths are resolved from
 * `import.meta.url` (NodeNext ESM) via `fileURLToPath`.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decideX } from './connectors/x/xConnector.js';
import { operativeChannels } from './engine.js';
import type { RozaConfig, XChannelConfig } from './config.js';
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

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(): PackageJson {
  const pkgPath = path.join(SERVICE_ROOT, 'package.json');
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PackageJson;
}

/**
 * The genuinely-excluded PAID X/Twitter API client SDKs and paid social SaaS
 * (Req 2.1, 2.2). Browser automation (Playwright/Puppeteer) is NOT excluded —
 * it is the approved open-source approach. Each pattern is anchored to a
 * package-name segment so it cannot false-positive on an unrelated substring.
 */
const PAID_TWITTER_SDKS = /(^|[/@])(twitter|twitter-api-v2|twit($|[-/])|node-twitter)/i;

describe('Phase 5 scope — X uses browser automation, not a paid X/Twitter API (Req 2.1, 2.2, 2.4)', () => {
  const pkg = readPackageJson();
  const deps = pkg.dependencies ?? {};
  const allDepNames = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];

  it('declares no paid X/Twitter API SDK or paid social SaaS dependency', () => {
    const violations = allDepNames.filter((name) => PAID_TWITTER_SDKS.test(name));
    expect(
      violations,
      `Phase 5 scope breach — paid X/Twitter API SDK declared in package.json (X must use browser automation): ${violations.join(', ')}`,
    ).toEqual([]);
  });

  it('no source module imports a paid X/Twitter API SDK', () => {
    const sourceFiles = collectSourceFiles(SRC_DIR);
    expect(sourceFiles.length, `no .ts source files found under ${SRC_DIR}`).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, 'utf8');
      const rel = path.relative(SERVICE_ROOT, file);
      for (const spec of importSpecifiers(content)) {
        if (!isExternalPackage(spec)) continue;
        if (PAID_TWITTER_SDKS.test(spec)) {
          violations.push(`${rel}: imports excluded paid X/Twitter API SDK via '${spec}'`);
        }
      }
    }

    expect(
      violations,
      `scope breach — paid X/Twitter API SDK import found:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it("the only X-interaction technology is browser automation — open-source 'playwright' is present", () => {
    expect(
      deps['playwright'],
      "expected open-source browser-automation dependency 'playwright' in package.json (the sole X-interaction path)",
    ).toBeTruthy();
  });
});

describe('Phase 5 scope — the X capability adds no member to the Channel union (Req 1.5, 12.1)', () => {
  /** An arbitrary-but-structured X subtree; only `cfg.x.*` differs between cases. */
  function makeXConfig(overrides: Partial<XChannelConfig>): XChannelConfig {
    return {
      enabled: false,
      credentials: { username: '', password: '' },
      storageStatePath: '',
      autonomyIntervalMinutes: 60,
      rateLimit: { dailyPostLimit: 10, actionSpacingMs: 600000 },
      maxTopics: 3,
      maxPostChars: 280,
      dryRun: false,
      ...overrides,
    };
  }

  /** A base config; only the conversation-channel flags and the X subtree vary. */
  function makeConfig(overrides: {
    telegram: boolean;
    mail: boolean;
    voice: boolean;
    x: XChannelConfig;
  }): RozaConfig {
    return {
      rozaPrivateKey: 'k',
      openRouterApiKey: 'k',
      openRouterModel: 'openai/gpt-4o-mini',
      dataDir: '/tmp/roza',
      timezone: 'UTC',
      activeWindow: { startMinutes: 420, endMinutes: 1320 },
      keyVersion: 'v1',
      telegram: { enabled: overrides.telegram, botToken: overrides.telegram ? 't' : '', allowlist: [] },
      mail: {
        enabled: overrides.mail,
        imap: { host: '', port: 0, user: '', password: '' },
        smtp: { host: '', port: 0, user: '', password: '' },
        allowlist: [],
      },
      voice: {
        enabled: overrides.voice,
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
      x: overrides.x,
    };
  }

  it('the X capability is gated by decideX — ok iff cfg.x.enabled, else x_not_enabled', () => {
    const enabled = makeConfig({ telegram: false, mail: false, voice: false, x: makeXConfig({ enabled: true }) });
    const disabled = makeConfig({ telegram: false, mail: false, voice: false, x: makeXConfig({ enabled: false }) });

    expect(decideX(enabled)).toEqual({ ok: true });

    const decision = decideX(disabled);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe('x_not_enabled');
    }
  });

  it('the operative channel set stays a subset of internal/telegram/email/voice for every config', () => {
    const allowed = new Set<Channel>(['internal', 'telegram', 'email', 'voice']);

    for (const telegram of [false, true]) {
      for (const mail of [false, true]) {
        for (const voice of [false, true]) {
          for (const x of [false, true]) {
            const cfg = makeConfig({ telegram, mail, voice, x: makeXConfig({ enabled: x }) });
            const channels = operativeChannels(cfg);

            for (const channel of channels) {
              expect(
                allowed.has(channel),
                `unexpected operative channel '${channel}' — X must not introduce a Channel`,
              ).toBe(true);
            }
            // The X literal must never appear as a conversation channel.
            expect(channels.has('x' as Channel)).toBe(false);
          }
        }
      }
    }
  });

  it('operativeChannels is identical for two configs differing only in cfg.x.* — X is not a Channel', () => {
    // Two configs identical in every conversation-channel field, differing ONLY
    // in their entire `x.*` subtree (including the `enabled` flag and tunables).
    const baseConfig = makeConfig({
      telegram: true,
      mail: true,
      voice: true,
      x: makeXConfig({ enabled: false }),
    });
    const withX = makeConfig({
      telegram: true,
      mail: true,
      voice: true,
      x: makeXConfig({
        enabled: true,
        credentials: { username: 'roza', password: 'secret' },
        storageStatePath: '/tmp/roza/x_storage_state.json',
        autonomyIntervalMinutes: 30,
        rateLimit: { dailyPostLimit: 99, actionSpacingMs: 1000 },
        maxTopics: 9,
        maxPostChars: 4000,
        dryRun: true,
      }),
    });

    const baseSet = [...operativeChannels(baseConfig)].sort();
    const withXSet = [...operativeChannels(withX)].sort();

    expect(withXSet).toEqual(baseSet);
    expect((withXSet as string[]).includes('x')).toBe(false);
  });
});

describe('Phase 5 scope — fragility/ToS/anti-bot and open-source-first direction recorded in committed docs (Req 2.5, 12.3)', () => {
  // The direction lives in the committed operator doc (`.env.example`) and may
  // also be recorded in the sibling spec repo's design.md / requirements.md.
  // It passes as long as the notes are recorded in at least one reachable
  // committed document.
  const parent = path.dirname(SERVICE_ROOT);
  const specDir = path.join(parent, 'Opays-HQ', '.kiro', 'specs', 'roza-step5-x-twitter');
  const candidates = [
    path.join(SERVICE_ROOT, '.env.example'),
    path.join(specDir, 'design.md'),
    path.join(specDir, 'requirements.md'),
    path.join(SERVICE_ROOT, 'README.md'),
  ];

  function gatherDocs(): { sources: string[]; text: string } {
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

  it('records the fragility / Terms-of-Service / anti-bot honesty notes', () => {
    const { sources, text } = gatherDocs();
    expect(sources.length, 'no committed operator/spec documentation found to scan').toBeGreaterThan(0);

    expect(
      /fragile/i.test(text),
      `expected a browser-automation fragility note recorded in: ${sources.join(', ')}`,
    ).toBe(true);
    expect(
      /terms of service/i.test(text),
      `expected a Terms-of-Service risk note recorded in: ${sources.join(', ')}`,
    ).toBe(true);
    expect(
      /anti-?bot/i.test(text),
      `expected an anti-bot defenses note recorded in: ${sources.join(', ')}`,
    ).toBe(true);
  });

  it('records the "Phase 5 completes the social architecture via browser automation under the open-source-first rule" note', () => {
    const { sources, text } = gatherDocs();
    expect(sources.length, 'no committed operator/spec documentation found to scan').toBeGreaterThan(0);

    expect(
      /phase 5 completes[\s\S]*?social architecture[\s\S]*?browser automation[\s\S]*?open-source-first/i.test(text),
      `expected the Phase 5 open-source-first browser-automation direction recorded in: ${sources.join(', ')}`,
    ).toBe(true);
  });
});
