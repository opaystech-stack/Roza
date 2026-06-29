/**
 * Phase 3 scope-boundary, dependency, and licensing smoke tests (task 15.2) —
 * Req 3.1, 3.2, 3.5, 6.1, 6.3, 12.3, 13.1, 13.2, 13.3, 13.4.
 *
 * These are static, file-system-only checks (no Docker, no SIP, no network)
 * that guard the Phase 3 scope boundary, the open-source-first dependency rule,
 * and the commercial-use licensing constraint now that `voice` is operative:
 *
 *   - Open-source dependency (Req 6.1, 6.3, 12.3, 3.5): the Phase 3 telephony
 *     dependency is the open-source `ari-client`, and NO paid cloud
 *     telephony/voice SaaS SDK (Twilio/Vonage/Plivo/ElevenLabs/HeyGen/Tavus…)
 *     is declared in `package.json`.
 *   - Commercial-safe licensing (Req 3.1, 3.2): every role in
 *     `VOICE_COMPONENT_LICENSES` carries a commercial-use-permissive license
 *     (per `isCommercialUseLicense`) with no non-commercial entry, the chosen
 *     TTS/STT are the commercial-safe engines (Piper / whisper.cpp), and no
 *     manifest component or license is the non-commercial XTTS-v2 / Coqui
 *     Public Model License.
 *   - Scope boundary (Req 13.1, 13.2): no source module imports an excluded
 *     integration — no video/avatar (Wav2Lip/SadTalker/HeyGen/Tavus) and no
 *     paid X/Twitter API client SDK. `voice` IS now operative; video/avatar is
 *     NOT. X via browser automation (Playwright) is legitimately implemented in
 *     Phase 5 and is NOT excluded — only paid X/Twitter API SDKs are.
 *   - Operative channels (Req 13.1): `engine.ts` makes `voice` operative
 *     (`channels.add('voice')`), and the only channels ever added to the
 *     operative set are `internal`/`telegram`/`email`/`voice`.
 *   - Forward-looking directions (Req 13.3, 13.4): video/avatar (Wav2Lip/
 *     SadTalker) is FUTURE — recorded in the spec docs, not implemented. X via
 *     browser automation has since been delivered in Phase 5; this test still
 *     confirms no paid X/Twitter API SDK dependency exists in `package.json`.
 *
 * The import scan inspects *import specifiers* (not raw text), reusing the
 * approach from `isolation.smoke.test.ts`/`phase2-scope.smoke.test.ts`, so a
 * literal channel string in prose is not mistaken for a real coupling. Paths
 * are resolved from `import.meta.url` (NodeNext ESM) via `fileURLToPath`.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VOICE_COMPONENT_LICENSES,
  isCommercialUseLicense,
  type VoiceComponentRole,
} from './connectors/voice/licenses.js';

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
 * Paid cloud telephony / voice SaaS SDKs that the open-source-first rule
 * excludes (Req 6.1, 6.3, 12.3). Matched against dependency names and external
 * import specifiers; each pattern is anchored to a package-name segment so it
 * cannot false-positive on an unrelated substring.
 */
const PAID_VOICE_TELEPHONY_SDKS: { label: string; pattern: RegExp }[] = [
  { label: 'Twilio (paid telephony)', pattern: /(^|[/@])twilio/i },
  { label: 'Vonage / Nexmo (paid telephony)', pattern: /(^|[/@])(vonage|nexmo)/i },
  { label: 'Plivo (paid telephony)', pattern: /(^|[/@])plivo/i },
  { label: 'ElevenLabs (paid voice)', pattern: /(^|[/@])elevenlabs/i },
  { label: 'Vapi (paid voice/telephony)', pattern: /(^|[/@])vapi/i },
];

/**
 * Excluded video/avatar + paid X/Twitter API integrations (Req 13.1, 13.2,
 * 13.3, 13.4). Matched against dependency names and external import specifiers.
 *
 * NOTE: X via browser automation (Playwright) is NOT excluded — Phase 5
 * legitimately implements X autonomy via browser automation under the
 * open-source-first rule. Only the paid X/Twitter API client SDKs (twitter,
 * twitter-api-v2, twit, node-twitter) remain forbidden.
 */
const EXCLUDED_INTEGRATIONS: { label: string; pattern: RegExp }[] = [
  { label: 'Wav2Lip (video/avatar)', pattern: /(^|[/@])wav2lip/i },
  { label: 'SadTalker (video/avatar)', pattern: /(^|[/@])sadtalker/i },
  { label: 'HeyGen (avatar/video)', pattern: /(^|[/@])heygen/i },
  { label: 'Tavus (avatar/video)', pattern: /(^|[/@])tavus/i },
  {
    label: 'paid X/Twitter API SDK',
    pattern: /(^|[/@])(twitter|twitter-api-v2|twit($|[-/])|node-twitter)/i,
  },
];

describe('Phase 3 scope — open-source telephony dependency (Req 6.1, 6.3, 12.3, 3.5)', () => {
  const pkg = readPackageJson();
  const deps = pkg.dependencies ?? {};
  const allDepNames = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];

  it("declares the open-source 'ari-client' telephony dependency", () => {
    expect(
      deps['ari-client'],
      "expected open-source runtime dependency 'ari-client' in package.json",
    ).toBeTruthy();
  });

  it('declares no paid cloud telephony or voice SaaS SDK', () => {
    const violations: string[] = [];
    for (const name of allDepNames) {
      for (const { label, pattern } of PAID_VOICE_TELEPHONY_SDKS) {
        if (pattern.test(name)) {
          violations.push(`'${name}' matches excluded ${label}`);
        }
      }
    }

    expect(
      violations,
      `Phase 3 scope breach — paid telephony/voice SDK declared in package.json:\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});

describe('Phase 3 licensing — selected components are commercial-use-safe (Req 3.1, 3.2)', () => {
  it('every role license is commercial-use-permissive and flagged commercialUse', () => {
    const violations: string[] = [];
    for (const entry of VOICE_COMPONENT_LICENSES) {
      if (!isCommercialUseLicense(entry.license)) {
        violations.push(`role '${entry.role}' (${entry.component}) license '${entry.license}' is not commercial-use-permissive`);
      }
      if (entry.commercialUse !== true) {
        violations.push(`role '${entry.role}' (${entry.component}) has commercialUse=${entry.commercialUse}`);
      }
    }

    expect(
      violations,
      `non-commercial license in the voice component manifest:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('contains no non-commercial license entry (NC / Coqui Public Model License / XTTS)', () => {
    // CC-BY-NC, the Coqui Public Model License, and XTTS-v2 weights are all
    // non-commercial and must never appear in the production manifest.
    const nonCommercial = /(\bNC\b|non[-\s]?commercial|coqui|xtts)/i;
    const violations = VOICE_COMPONENT_LICENSES.filter(
      (e) => nonCommercial.test(e.license) || nonCommercial.test(e.component),
    ).map((e) => `role '${e.role}': component '${e.component}', license '${e.license}'`);

    expect(
      violations,
      `non-commercial XTTS-v2/Coqui (or other NC) entry found in manifest:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('selects the commercial-safe engines: Piper (TTS) and whisper.cpp (STT), not XTTS-v2/Coqui', () => {
    const byRole = (role: VoiceComponentRole) =>
      VOICE_COMPONENT_LICENSES.find((e) => e.role === role);

    const tts = byRole('tts');
    const stt = byRole('stt');

    expect(tts, 'expected a TTS entry in the manifest').toBeTruthy();
    expect(stt, 'expected an STT entry in the manifest').toBeTruthy();

    expect(tts?.component).toBe('Piper');
    expect(stt?.component).toBe('whisper.cpp');

    // Defensive: the chosen TTS engine is not the non-commercial Coqui/XTTS-v2.
    expect(/xtts|coqui/i.test(tts?.component ?? '')).toBe(false);
    expect(/xtts|coqui/i.test(tts?.license ?? '')).toBe(false);
  });
});

describe('Phase 3 scope — no excluded video/avatar or X import (Req 13.1, 13.2)', () => {
  const sourceFiles = collectSourceFiles(SRC_DIR);

  it('discovers source files to scan', () => {
    expect(sourceFiles.length, `no .ts source files found under ${SRC_DIR}`).toBeGreaterThan(0);
  });

  it('no source module imports a video/avatar or X/Twitter integration', () => {
    const violations: string[] = [];

    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, 'utf8');
      const rel = path.relative(SERVICE_ROOT, file);
      for (const spec of importSpecifiers(content)) {
        if (!isExternalPackage(spec)) continue;
        for (const { label, pattern } of [...EXCLUDED_INTEGRATIONS, ...PAID_VOICE_TELEPHONY_SDKS]) {
          if (pattern.test(spec)) {
            violations.push(`${rel}: imports excluded ${label} integration via '${spec}'`);
          }
        }
      }
    }

    expect(
      violations,
      `Phase 3 scope breach — excluded integration import found:\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});

describe('Phase 3 scope — operative channels are exactly internal/telegram/email/voice (Req 13.1)', () => {
  const engineSource = fs.readFileSync(path.join(SRC_DIR, 'engine.ts'), 'utf8');

  it('makes the voice channel operative', () => {
    expect(
      /channels\.add\(\s*['"]voice['"]\s*\)/.test(engineSource),
      "expected engine.ts to add the 'voice' channel (channels.add('voice'))",
    ).toBe(true);
  });

  it('adds no operative channel outside the allowed set', () => {
    const allowed = new Set(['internal', 'telegram', 'email', 'voice']);

    // The base operative set is seeded with `new Set<Channel>(['internal'])`
    // and then conditionally extended via `channels.add('<name>')`. Collect
    // every channel literal that can enter the operative set.
    const seen = new Set<string>();
    for (const m of engineSource.matchAll(/channels\.add\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (m[1]) seen.add(m[1]);
    }
    for (const m of engineSource.matchAll(/new Set<Channel>\(\s*\[([^\]]*)\]/g)) {
      for (const lit of (m[1] ?? '').matchAll(/['"]([^'"]+)['"]/g)) {
        if (lit[1]) seen.add(lit[1]);
      }
    }

    expect(seen.size, 'expected to discover at least the seeded operative channel(s)').toBeGreaterThan(0);

    const violations = [...seen].filter((c) => !allowed.has(c));
    expect(
      violations,
      `Phase 3 scope breach — engine makes a non-allowed channel operative: ${violations.join(', ')}`,
    ).toEqual([]);

    // Voice must be among the operative channels (it is now operative).
    expect(seen.has('voice')).toBe(true);
  });
});

describe('Phase 3 scope — forward-looking video/X directions are FUTURE, not implemented (Req 13.3, 13.4)', () => {
  const pkg = readPackageJson();
  const allDepNames = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];

  it('declares no video/avatar (Wav2Lip/SadTalker/HeyGen/Tavus) dependency', () => {
    const videoAvatar = /(^|[/@])(wav2lip|sadtalker|heygen|tavus)/i;
    const violations = allDepNames.filter((name) => videoAvatar.test(name));
    expect(
      violations,
      `video/avatar is a FUTURE direction and must not be implemented as a dependency: ${violations.join(', ')}`,
    ).toEqual([]);
  });

  it('declares no X/Twitter client SDK dependency', () => {
    // X/Twitter posting is a FUTURE direction. Only X/Twitter CLIENT SDKs are
    // forbidden here. Browser automation (Playwright/Puppeteer) is NOT forbidden:
    // per the golden rule it is the approved open-source approach, and Phase 4
    // legitimately ships it for Google Meet avatar sessions.
    const xTwitter = /(^|[/@])(twitter|twitter-api-v2|twit($|[-/])|node-twitter)/i;
    const violations = allDepNames.filter((name) => xTwitter.test(name));
    expect(
      violations,
      `X/Twitter client SDK is a FUTURE direction and must not be implemented as a dependency: ${violations.join(', ')}`,
    ).toEqual([]);
  });
});
