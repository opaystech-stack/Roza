/**
 * Smoke tests for placement, base image, and isolation (Task 16.2).
 *
 * These are static, file-system-only checks (no Docker, no network) that guard
 * the structural invariants of the Roza agent service:
 *
 *   - Directory placement (Req 1.1): `roza-agent/` is a sibling of `Opays-HQ/`.
 *   - Node 20+ base image (Req 1.2): the Dockerfile builds on a Node >= 20 base
 *     and `package.json` declares an `engines.node` of `>= 20`.
 *   - Isolation (Req 3.4, 4.8, 9.4): no source module imports Opays HQ tooling or
 *     any of the Phase-1-excluded voice/avatar/Telegram/Gmail/X integrations.
 *
 * The isolation scan inspects *import specifiers* (the module strings of
 * `import`/`export … from`, side-effect `import '…'`, and dynamic
 * `import()`/`require()`), never raw file text. This is deliberate: the literal
 * `'telegram'` is a valid forward-compatible channel value (Req 9.2) and the
 * phrase "Opays HQ" appears in comments — neither is a real coupling, and a
 * naive substring scan would produce false positives.
 *
 * Paths are resolved from `import.meta.url` (NodeNext ESM) via `fileURLToPath`.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve the service root as the nearest ancestor directory that contains a
 * `package.json`. Robust to where the test file physically lives.
 */
function findServiceRoot(start: string): string {
  let dir = start;
  // Walk up until we find package.json or hit the filesystem root.
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
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Extract every module specifier referenced by import/export/require in `content`. */
function importSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const patterns: RegExp[] = [
    // `import … from '…'` / `export … from '…'` (binding part has no quotes,
    // so [^'"] safely spans multi-line import clauses).
    /\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    // Side-effect import: `import '…'`.
    /\bimport\s*['"]([^'"]+)['"]/g,
    // Dynamic import / CommonJS require: `import('…')` / `require('…')`.
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

/**
 * Phase-1-excluded integrations (Req 9.4). Matched against external package
 * specifiers only. Patterns cover the common SDK package names for each
 * excluded capability.
 */
const FORBIDDEN_INTEGRATIONS: { label: string; pattern: RegExp }[] = [
  { label: 'ElevenLabs (voice)', pattern: /(^|[/@])elevenlabs/i },
  { label: 'Vapi (telephony)', pattern: /(^|[/@])vapi/i },
  { label: 'HeyGen (avatar)', pattern: /(^|[/@])heygen/i },
  { label: 'Tavus (avatar)', pattern: /(^|[/@])tavus/i },
  { label: 'Telegram client', pattern: /telegram|telegraf|mtproto|gramjs/i },
  { label: 'Gmail / Google APIs', pattern: /(^|[/@])(gmail|googleapis|google-auth-library)/i },
  { label: 'X / Twitter SDK', pattern: /twitter|(^|[/@])twit($|[-/])/i },
];

describe('Roza agent — placement smoke test (Req 1.1)', () => {
  it('lives in a roza-agent/ directory that is a sibling of Opays-HQ/', () => {
    // The service root directory itself must be named `roza-agent`.
    expect(path.basename(SERVICE_ROOT)).toBe('roza-agent');

    const parentDir = path.dirname(SERVICE_ROOT);
    const siblings = fs
      .readdirSync(parentDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    // Clear, descriptive failure if the expected layout is not present.
    expect(
      siblings,
      `expected parent directory ${parentDir} to contain a 'roza-agent' folder; found: ${siblings.join(', ')}`,
    ).toContain('roza-agent');

    expect(
      siblings,
      `expected parent directory ${parentDir} to contain a sibling 'Opays-HQ' folder; found: ${siblings.join(', ')}`,
    ).toContain('Opays-HQ');
  });
});

describe('Roza agent — Node 20+ base image smoke test (Req 1.2)', () => {
  it('the Dockerfile builds on a Node >= 20 base image', () => {
    const dockerfilePath = path.join(SERVICE_ROOT, 'Dockerfile');
    expect(fs.existsSync(dockerfilePath), `missing Dockerfile at ${dockerfilePath}`).toBe(true);

    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');

    // Every `FROM node:<major>…` must reference major version 20 or later.
    const fromMatches = [...dockerfile.matchAll(/^\s*FROM\s+node:(\d+)/gim)];
    expect(fromMatches.length, 'expected at least one `FROM node:<version>` line').toBeGreaterThan(0);

    for (const match of fromMatches) {
      const major = Number(match[1]);
      expect(major, `Dockerfile base image node:${match[1]} must be Node 20 or later`).toBeGreaterThanOrEqual(20);
    }

    // Defensive: a direct regex check that a Node 20+ tag is present.
    expect(/node:(2[0-9]|[3-9][0-9])(\b|[.-])/.test(dockerfile)).toBe(true);
  });

  it('package.json declares engines.node of >= 20', () => {
    const pkgPath = path.join(SERVICE_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      engines?: { node?: string };
    };

    const nodeEngine = pkg.engines?.node;
    expect(nodeEngine, 'package.json must declare engines.node').toBeTruthy();

    // Accept `>=20`, `>= 20`, `>=20.0.0`, etc. and confirm the floor is >= 20.
    const floor = nodeEngine?.match(/(\d+)/);
    expect(floor, `engines.node ('${nodeEngine}') should specify a numeric version floor`).not.toBeNull();
    expect(Number(floor?.[1]), `engines.node ('${nodeEngine}') must require Node 20 or later`).toBeGreaterThanOrEqual(20);
    expect(/>=?\s*20/.test(nodeEngine ?? ''), `engines.node ('${nodeEngine}') must require >= 20`).toBe(true);
  });
});

describe('Roza agent — isolation smoke test (Req 3.4, 4.8, 9.4)', () => {
  const sourceFiles = collectSourceFiles(SRC_DIR);

  it('discovers source files to scan', () => {
    // Guards against a silently-empty scan (e.g. wrong path) masking real coupling.
    expect(sourceFiles.length, `no .ts source files found under ${SRC_DIR}`).toBeGreaterThan(0);
  });

  it('no source module imports from the Opays HQ project', () => {
    const violations: string[] = [];

    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, 'utf8');
      const rel = path.relative(SERVICE_ROOT, file);

      // (a) No import specifier references the Opays-HQ directory, whether via a
      //     bare path or a relative path escaping the service root.
      for (const spec of importSpecifiers(content)) {
        if (/opays-hq/i.test(spec)) {
          violations.push(`${rel}: imports Opays HQ project via '${spec}'`);
        }
      }

      // (b) No raw reference to the Opays-HQ directory token anywhere in the file
      //     (the hyphenated form is the directory name; "Opays HQ" prose is fine).
      if (/opays-hq/i.test(content)) {
        violations.push(`${rel}: contains an 'Opays-HQ' path reference`);
      }
    }

    expect(violations, `isolation breach — coupling to Opays HQ:\n${violations.join('\n')}`).toEqual([]);
  });

  it('no source module imports a Phase-1-excluded integration (voice/avatar/Telegram/Gmail/X)', () => {
    const violations: string[] = [];

    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, 'utf8');
      const rel = path.relative(SERVICE_ROOT, file);

      for (const spec of importSpecifiers(content)) {
        if (!isExternalPackage(spec)) continue;
        for (const { label, pattern } of FORBIDDEN_INTEGRATIONS) {
          if (pattern.test(spec)) {
            violations.push(`${rel}: imports excluded ${label} integration via '${spec}'`);
          }
        }
      }
    }

    expect(
      violations,
      `Phase-1 scope breach — excluded integration import found:\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
