/**
 * Phase 4 scope-boundary, dependency, and licensing smoke tests (task 14.2) —
 * Req 2.5, 3.1, 3.2, 4.1, 4.2, 4.3, 5.4, 11.1, 11.2, 11.3, 12.5.
 *
 * These are static, file-system-only checks (no Docker, no GPU, no browser, no
 * RTMP, no v4l2/PipeWire) that guard the Phase 4 scope boundary, the
 * open-source-first dependency rule, and the commercial-use licensing
 * constraint now that the Avatar_Channel is a configuration-gated presence
 * capability:
 *
 *   - Open-source dependency (Req 2.5, 4.1, 4.2, 4.3): the Phase 4 runtime
 *     addition is the open-source `playwright` (Apache-2.0, for the Meet
 *     adapter), and NO paid avatar/streaming media SaaS SDK
 *     (HeyGen/Tavus/D-ID/Synthesia/Colossyan…) is declared in `package.json`.
 *   - Commercial-safe licensing (Req 3.1, 3.2): every role in
 *     `AVATAR_COMPONENT_LICENSES` carries a commercial-use-permissive license
 *     (per `isCommercialUseLicense`) with `commercialUse: true`, the manifest
 *     covers every required role (renderer / face_analysis / weights /
 *     virtual_camera / virtual_microphone / meet / stream), and NO
 *     non-commercial weights (no Wav2Lip checkpoint, no InsightFace stock
 *     model) appear with `commercialUse: true`.
 *   - Channel boundary (Req 11.1): the avatar adds NO member to the `Channel`
 *     union — the operative set stays exactly `internal`/`telegram`/`email`/
 *     `voice`, and the avatar is modeled as a presence capability via
 *     `decideAvatar`, not a `Channel`.
 *   - X capability scope (Req 11.1, and Phase 5 Req 1.5, 2.1, 2.2, 12.1, 12.2):
 *     no paid X/Twitter API SDK (twitter/twitter-api-v2/twit/node-twitter) is
 *     declared or imported. X via browser automation (Playwright) is a
 *     legitimate capability — delivered in Phase 5 under the open-source-first
 *     rule — so this suite NO LONGER asserts the X capability or Playwright is
 *     absent; it only forbids the genuinely-excluded paid X/Twitter API SDKs.
 *
 * The import scan inspects *import specifiers* (not raw text), reusing the
 * approach from `isolation.smoke.test.ts` / `phase3-scope.smoke.test.ts`, so a
 * literal channel string in prose is not mistaken for a real coupling. Paths
 * are resolved from `import.meta.url` (NodeNext ESM) via `fileURLToPath`.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decideAvatar } from './connectors/avatar/avatarConnector.js';
import {
  AVATAR_COMPONENT_LICENSES,
  isCommercialUseLicense,
  type AvatarComponentRole,
} from './connectors/avatar/licenses.js';
import { operativeChannels } from './engine.js';
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

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(): PackageJson {
  const pkgPath = path.join(SERVICE_ROOT, 'package.json');
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PackageJson;
}

/**
 * Paid avatar / streaming media SaaS SDKs the open-source-first rule excludes
 * (Req 4.1, 4.2, 4.3). Matched against dependency names and external import
 * specifiers; each pattern is anchored to a package-name segment so it cannot
 * false-positive on an unrelated substring.
 */
const PAID_AVATAR_STREAM_SDKS: { label: string; pattern: RegExp }[] = [
  { label: 'HeyGen (paid avatar SaaS)', pattern: /(^|[/@])heygen/i },
  { label: 'Tavus (paid avatar SaaS)', pattern: /(^|[/@])tavus/i },
  { label: 'D-ID (paid avatar SaaS)', pattern: /(^|[/@])d-?id($|[-/])/i },
  { label: 'Synthesia (paid avatar SaaS)', pattern: /(^|[/@])synthesia/i },
  { label: 'Colossyan (paid avatar SaaS)', pattern: /(^|[/@])colossyan/i },
  { label: 'ElevenLabs (paid voice SaaS)', pattern: /(^|[/@])elevenlabs/i },
];

describe('Phase 4 scope — open-source avatar/stream dependencies (Req 2.5, 4.1, 4.2, 4.3)', () => {
  const pkg = readPackageJson();
  const deps = pkg.dependencies ?? {};
  const allDepNames = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];

  it("declares the open-source 'playwright' dependency for the Meet adapter", () => {
    expect(
      deps['playwright'],
      "expected open-source runtime dependency 'playwright' in package.json",
    ).toBeTruthy();
  });

  it('declares no paid avatar/streaming media SaaS SDK (no HeyGen/Tavus/D-ID/…)', () => {
    const violations: string[] = [];
    for (const name of allDepNames) {
      for (const { label, pattern } of PAID_AVATAR_STREAM_SDKS) {
        if (pattern.test(name)) {
          violations.push(`'${name}' matches excluded ${label}`);
        }
      }
    }

    expect(
      violations,
      `Phase 4 scope breach — paid avatar/streaming SaaS SDK declared in package.json:\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});

describe('Phase 4 licensing — avatar/device/Meet/stream components are commercial-use-safe (Req 3.1, 3.2)', () => {
  /** The roles the manifest must cover for a complete, auditable Phase 4 stack. */
  const REQUIRED_ROLES: readonly AvatarComponentRole[] = [
    'renderer',
    'face_analysis',
    'weights',
    'virtual_camera',
    'virtual_microphone',
    'meet',
    'stream',
  ];

  it('covers every required role exactly (renderer/face_analysis/weights/virtual_camera/virtual_microphone/meet/stream)', () => {
    const present = new Set(AVATAR_COMPONENT_LICENSES.map((e) => e.role));
    const missing = REQUIRED_ROLES.filter((role) => !present.has(role));

    expect(
      missing,
      `Phase 4 license manifest is missing required role(s): ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every role license is commercial-use-permissive and flagged commercialUse', () => {
    const violations: string[] = [];
    for (const entry of AVATAR_COMPONENT_LICENSES) {
      if (!isCommercialUseLicense(entry.license)) {
        violations.push(`role '${entry.role}' (${entry.component}) license '${entry.license}' is not commercial-use-permissive`);
      }
      if (entry.commercialUse !== true) {
        violations.push(`role '${entry.role}' (${entry.component}) has commercialUse=${entry.commercialUse}`);
      }
    }

    expect(
      violations,
      `non-commercial license in the avatar component manifest:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('contains no non-commercial weights (no Wav2Lip checkpoint, no InsightFace stock model) flagged commercial', () => {
    // Wav2Lip pretrained checkpoints are distributed non-commercial and the
    // InsightFace stock models carry a non-commercial research license. Neither
    // may appear in the production manifest with commercialUse: true.
    const nonCommercialWeights = /wav2lip|insightface/i;
    const violations = AVATAR_COMPONENT_LICENSES.filter(
      (e) => e.commercialUse && (nonCommercialWeights.test(e.component) || nonCommercialWeights.test(e.license)),
    ).map((e) => `role '${e.role}': component '${e.component}', license '${e.license}'`);

    expect(
      violations,
      `non-commercial Wav2Lip/InsightFace weights found flagged commercial in manifest:\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});

describe('Phase 4 scope — the avatar adds no member to the Channel union (Req 11.1)', () => {
  /** A base config; only the avatar/channel enable flags are overridden. */
  function makeConfig(overrides: {
    telegram: boolean;
    mail: boolean;
    voice: boolean;
    avatar: boolean;
    meet: boolean;
    stream: boolean;
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
        enabled: overrides.avatar,
        video: { width: 512, height: 512, fps: 25, pixelFormat: 'yuv420p' },
        latency: { renderMs: 4000 },
        renderer: { endpoint: '', engine: '' },
        devices: { camera: '', microphone: '' },
        meet: { enabled: overrides.meet, consent: false, account: '', password: '' },
        stream: { enabled: overrides.stream, url: '', key: '' },
      },
      x: {
        enabled: false,
        credentials: { username: '', password: '' },
        storageStatePath: '',
        autonomyIntervalMinutes: 60,
        rateLimit: { dailyPostLimit: 10, actionSpacingMs: 600000 },
        maxTopics: 3,
        maxPostChars: 280,
        dryRun: false,
      },
    };
  }

  it('the operative channel set stays a subset of internal/telegram/email/voice for every config', () => {
    const allowed = new Set<Channel>(['internal', 'telegram', 'email', 'voice']);

    for (const telegram of [false, true]) {
      for (const mail of [false, true]) {
        for (const voice of [false, true]) {
          for (const avatar of [false, true]) {
            const cfg = makeConfig({ telegram, mail, voice, avatar, meet: avatar, stream: avatar });
            const channels = operativeChannels(cfg);

            for (const channel of channels) {
              expect(
                allowed.has(channel),
                `unexpected operative channel '${channel}' — avatar must not introduce a Channel`,
              ).toBe(true);
            }
            // The avatar literal must never appear as a conversation channel.
            expect(channels.has('avatar' as Channel)).toBe(false);
          }
        }
      }
    }
  });

  it('operativeChannels is identical for two configs differing only in avatar.* — avatar is not a Channel', () => {
    const base = makeConfig({ telegram: true, mail: true, voice: true, avatar: false, meet: false, stream: false });
    const withAvatar = makeConfig({ telegram: true, mail: true, voice: true, avatar: true, meet: true, stream: true });

    const baseSet = [...operativeChannels(base)].sort();
    const avatarSet = [...operativeChannels(withAvatar)].sort();

    expect(avatarSet).toEqual(baseSet);
  });

  it('the avatar is modeled as a presence capability via decideAvatar, not a Channel', () => {
    const enabled = makeConfig({ telegram: false, mail: false, voice: true, avatar: true, meet: true, stream: true });
    const disabled = makeConfig({ telegram: false, mail: false, voice: true, avatar: false, meet: false, stream: false });

    // The capability gate — not a Channel decision — governs the avatar.
    expect(decideAvatar('avatar', enabled).ok).toBe(true);
    expect(decideAvatar('meet', enabled).ok).toBe(true);
    expect(decideAvatar('stream', enabled).ok).toBe(true);

    const disabledDecision = decideAvatar('avatar', disabled);
    expect(disabledDecision.ok).toBe(false);
    if (!disabledDecision.ok) {
      expect(disabledDecision.reason).toBe('avatar_not_enabled');
    }
  });
});

describe('Phase 4 scope — paid X/Twitter API SDK absent; X via browser automation now legitimately implemented in Phase 5 (Req 11.1; Phase 5 Req 1.5, 2.1, 2.2, 12.1, 12.2)', () => {
  const pkg = readPackageJson();
  const allDepNames = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];

  /**
   * The genuinely-excluded PAID X/Twitter API client SDKs. Browser automation
   * (Playwright/Puppeteer) is NOT excluded — it is the approved open-source
   * approach, and Phase 5 legitimately ships X autonomy via browser automation
   * (`src/connectors/x/`). Only the paid X/Twitter API SDKs remain forbidden.
   */
  const PAID_TWITTER_SDKS = /(^|[/@])(twitter|twitter-api-v2|twit($|[-/])|node-twitter)/i;

  it('declares no paid X/Twitter API SDK dependency — X uses browser automation, not a paid API', () => {
    const violations = allDepNames.filter((name) => PAID_TWITTER_SDKS.test(name));
    expect(
      violations,
      `paid X/Twitter API SDK must not be a dependency (X uses browser automation): ${violations.join(', ')}`,
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

  it('records the X-via-browser-automation direction in the committed spec docs', () => {
    // The direction lives in the SIBLING spec repo's design.md; fall back to the
    // requirements.md and any service-local docs. It passes as long as the
    // direction is recorded in at least one reachable committed document.
    const parent = path.dirname(SERVICE_ROOT);
    const specDir = path.join(parent, 'Opays-HQ', '.kiro', 'specs', 'roza-step4-avatar-video');
    const candidates = [
      path.join(specDir, 'design.md'),
      path.join(specDir, 'requirements.md'),
      path.join(SERVICE_ROOT, 'README.md'),
      path.join(SERVICE_ROOT, 'NOTES.md'),
    ];

    const sources: string[] = [];
    let text = '';
    for (const file of candidates) {
      if (fs.existsSync(file)) {
        sources.push(path.relative(parent, file));
        text += '\n' + fs.readFileSync(file, 'utf8');
      }
    }

    expect(sources.length, 'no committed spec/service documentation found to scan').toBeGreaterThan(0);
    expect(
      /(twitter|\bx\b)/i.test(text) && /browser automation/i.test(text),
      `expected an X-via-browser-automation direction recorded in: ${sources.join(', ')}`,
    ).toBe(true);
  });
});
