/**
 * MeetSession interface + Playwright Google Meet adapter (Component A7) —
 * Req 6.1, 6.2, 6.3, 6.5, 8.1, 8.7, 9.3.
 *
 * Defines the injectable {@link MeetSession} boundary the Avatar_Connector uses
 * to make Roza appear in a Google Meet call, plus the default
 * {@link createPlaywrightMeetSession} adapter that drives a **headless
 * Chromium** browser via Playwright to the Meet web UI. The adapter selects the
 * self-hosted Virtual_Camera/Virtual_Microphone as the meeting's camera and
 * microphone inputs and authenticates with the operator-provided
 * `Meet_Credentials` (env-only secrets — Req 8.1).
 *
 * **Stated honestly (Req 6.5):** headless Meet automation is fragile, may
 * conflict with Google's Terms of Service, and may require a real Google
 * Workspace account. The Meet integration therefore lives entirely behind this
 * swappable interface (Req 6.1) — the Virtual_Camera/Virtual_Microphone
 * pipeline is the robust core, and this adapter is a best-effort presence layer
 * over it. Swapping the adapter (Puppeteer, a different meeting backend) touches
 * only this file.
 *
 * Untrusted input (Req 8.7): `meetUrl` is treated as **data**. It is only ever
 * handed to `page.goto(...)` as a navigation target — it is **never**
 * interpreted as a Roza command, a shell argument, or a config change.
 *
 * Fault isolation (Req 9.3): a join/maintain failure or a browser crash rejects
 * so the Avatar_Connector can log the failure id, release this session's
 * resources, and keep the service plus the other channels running. The browser
 * resources are always released on failure.
 *
 * Secret discipline: this module NEVER logs the `Meet_Credentials`
 * (account/password). Only non-sensitive identifiers (the meet host, backend,
 * and the descriptor) ever appear in logs.
 *
 * Testability: the Playwright `chromium` browser launcher is injectable via
 * deps, so tests drive the adapter against a mocked Playwright API — **no real
 * browser or Google Meet ever runs in CI** (Req 12.5). When no launcher is
 * injected, Playwright is imported **lazily** at launch time so the module
 * typechecks even though Playwright browsers are not installed in CI.
 */

import type { Browser, BrowserContext, BrowserType, Page } from 'playwright';
import type { Logger } from '../../types.js';

/** Operator-provided Google account credentials (env-only secrets — Req 8.1). */
export interface MeetCredentials {
  account: string;
  password: string;
}

/**
 * The swappable Google Meet presence boundary the Avatar_Connector delegates to
 * (Req 6.1). The concrete browser-automation technology stays confined to the
 * adapter behind this interface.
 */
export interface MeetSession {
  /**
   * Join `meetUrl` using `creds`, selecting the Virtual_Camera/Virtual_Microphone
   * as the meeting's camera and mic (Req 6.2). `meetUrl` is UNTRUSTED data and is
   * only ever used as a navigation target, never executed as a command (Req 8.7).
   * Rejects on a join/maintain failure or a browser crash so the connector can
   * isolate it (Req 6.6, 9.3).
   */
  join(meetUrl: string, creds: MeetCredentials): Promise<void>;
  /** Mute Roza's microphone in the meeting (Req 6.3). */
  mute(): Promise<void>;
  /** Leave the meeting and release the browser resources (Req 6.3). */
  leave(): Promise<void>;
  /** Static descriptor for the license manifest + logs (carries no secrets). */
  readonly descriptor: { backend: 'playwright'; license: string };
}

/**
 * The slice of Playwright's `chromium` browser launcher the adapter needs.
 * Injecting this (rather than the whole module) lets tests supply a mock that
 * returns a fake {@link Browser} — no real Chromium binary is required.
 */
export type ChromiumLauncher = Pick<BrowserType, 'launch'>;

/** Dependencies for {@link createPlaywrightMeetSession}; every external edge is injectable. */
export interface PlaywrightMeetSessionDeps {
  /**
   * Playwright `chromium` browser launcher. Defaults to a **lazy** `import('playwright')`
   * at launch time so the module typechecks without Playwright browsers installed.
   * Tests inject a mock so no real browser launches (Req 12.5).
   */
  chromium?: ChromiumLauncher;
  /** Virtual_Camera device label to select as the meeting camera (`cfg.avatar.devices.camera`). */
  cameraDevice?: string;
  /** Virtual_Microphone device label to select as the meeting mic (`cfg.avatar.devices.microphone`). */
  microphoneDevice?: string;
  /** Whether to launch Chromium headless. Defaults to `true`. */
  headless?: boolean;
  /** Optional structured logger; NEVER receives the Meet_Credentials. */
  logger?: Logger;
}

/** SPDX license of the selected Meet backend (Playwright). */
const MEET_LICENSE = 'Apache-2.0';
/** Human-readable backend name recorded in the descriptor. */
const MEET_BACKEND = 'playwright' as const;

/** Google sign-in entry point used to authenticate before joining. */
const GOOGLE_SIGNIN_URL = 'https://accounts.google.com/ServiceLogin';

/** No-op logger so the adapter works without an injected logger. */
const NO_OP_LOGGER: Logger = {
  info: () => undefined,
  error: () => undefined,
};

/** Extract a safe, credential-free message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Extract the host of an untrusted `meetUrl` for safe, non-sensitive logging.
 * Returns `'invalid'` when the value is not a parseable URL — the raw,
 * untrusted string is never logged verbatim.
 */
function safeHost(meetUrl: string): string {
  try {
    return new URL(meetUrl).host;
  } catch {
    return 'invalid';
  }
}

/**
 * Create a Playwright-backed {@link MeetSession}.
 *
 * `join(meetUrl, creds)` launches a headless Chromium (auto-accepting the
 * media-permission prompt so the configured Virtual_Camera/Virtual_Microphone
 * can be used), authenticates with `creds`, navigates to the untrusted
 * `meetUrl` as a pure navigation target, selects the virtual devices as the
 * meeting inputs, and joins. Any failure — launch error, authentication
 * failure, navigation/join failure, or a browser crash/disconnect — releases
 * the browser and rejects so the Avatar_Connector can isolate the fault
 * (Req 6.6, 9.3). `mute()`/`leave()` drive the corresponding Meet UI controls.
 *
 * The `chromium` launcher is injectable so tests run against a mocked Playwright
 * API with no real browser (Req 12.5). The `Meet_Credentials` are never logged.
 */
export function createPlaywrightMeetSession(deps: PlaywrightMeetSessionDeps = {}): MeetSession {
  const logger = deps.logger ?? NO_OP_LOGGER;
  const headless = deps.headless ?? true;
  const cameraDevice = deps.cameraDevice;
  const microphoneDevice = deps.microphoneDevice;

  // Live browser session state, or null when not in a meeting.
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  // Set when the browser disconnects/crashes mid-session so callers fail fast.
  let crashed = false;

  /** Resolve the chromium launcher, importing Playwright lazily when not injected. */
  async function resolveLauncher(): Promise<ChromiumLauncher> {
    if (deps.chromium) {
      return deps.chromium;
    }
    // Lazy import keeps the module typechecking even though Playwright browsers
    // are not installed in CI — this path only runs in a real deployment.
    const playwright = await import('playwright');
    return playwright.chromium;
  }

  /** Release the browser resources, swallowing teardown errors. */
  async function releaseBrowser(): Promise<void> {
    const current = browser;
    browser = null;
    context = null;
    page = null;
    crashed = false;
    if (!current) {
      return;
    }
    try {
      await current.close();
    } catch (err: unknown) {
      // A crashed/already-closed browser may throw on close; isolation still
      // succeeds because the references are cleared above.
      logger.error('avatar.meet.close_error', { backend: MEET_BACKEND, error: errorMessage(err) });
    }
  }

  /**
   * Authenticate the Google account using `creds`. The credential values are
   * filled into the login form and are NEVER logged (Req 8.4).
   */
  async function authenticate(activePage: Page, creds: MeetCredentials): Promise<void> {
    await activePage.goto(GOOGLE_SIGNIN_URL, { waitUntil: 'load' });
    // Account (email) step.
    await activePage.fill('input[type="email"]', creds.account);
    await activePage.click('#identifierNext, button:has-text("Next")');
    // Password step.
    await activePage.fill('input[type="password"]', creds.password);
    await activePage.click('#passwordNext, button:has-text("Next")');
    await activePage.waitForLoadState('load');
  }

  /**
   * Select the configured Virtual_Camera/Virtual_Microphone as the meeting's
   * inputs on the Meet pre-join screen (Req 6.2). Device selection is keyed by
   * the human-readable device label so the v4l2loopback camera and the PipeWire
   * null sink are chosen.
   */
  async function selectVirtualDevices(activePage: Page): Promise<void> {
    if (microphoneDevice) {
      await activePage.selectOption('select[aria-label*="Microphone" i]', { label: microphoneDevice });
    }
    if (cameraDevice) {
      await activePage.selectOption('select[aria-label*="Camera" i]', { label: cameraDevice });
    }
  }

  return {
    descriptor: { backend: MEET_BACKEND, license: MEET_LICENSE },

    async join(meetUrl: string, creds: MeetCredentials): Promise<void> {
      if (browser) {
        throw new Error('MeetSession is already in a meeting');
      }

      const launcher = await resolveLauncher();

      let launched: Browser;
      try {
        // `--use-fake-ui-for-media-stream` auto-accepts the camera/mic permission
        // prompt so the real virtual devices can be selected without a dialog.
        launched = await launcher.launch({
          headless,
          args: ['--use-fake-ui-for-media-stream'],
        });
      } catch (err: unknown) {
        logger.error('avatar.meet.launch_failed', {
          backend: MEET_BACKEND,
          error: errorMessage(err),
        });
        throw new Error(`MeetSession failed to launch browser: ${errorMessage(err)}`);
      }

      browser = launched;
      crashed = false;
      // A browser crash/disconnect mid-session must surface as a fault the
      // connector can isolate (Req 6.6, 9.3).
      launched.on('disconnected', () => {
        crashed = true;
        logger.error('avatar.meet.browser_crashed', { backend: MEET_BACKEND });
      });

      try {
        context = await launched.newContext({
          permissions: ['camera', 'microphone'],
        });
        page = await context.newPage();

        // Authenticate with the operator-provided Meet_Credentials (never logged).
        await authenticate(page, creds);

        // UNTRUSTED meetUrl: used ONLY as a navigation target, never as a command (Req 8.7).
        await page.goto(meetUrl, { waitUntil: 'load' });

        // Select the self-hosted virtual devices as the meeting inputs (Req 6.2).
        await selectVirtualDevices(page);

        // Join the call.
        await page.click('button:has-text("Join now"), button:has-text("Ask to join")');

        if (crashed) {
          throw new Error('browser disconnected during join');
        }

        logger.info('avatar.meet.joined', { backend: MEET_BACKEND, host: safeHost(meetUrl) });
      } catch (err: unknown) {
        const message = errorMessage(err);
        // Release the browser so the connector can isolate the fault (Req 9.3).
        await releaseBrowser();
        logger.error('avatar.meet.join_failed', {
          backend: MEET_BACKEND,
          host: safeHost(meetUrl),
          error: message,
        });
        throw new Error(`MeetSession failed to join meeting: ${message}`);
      }
    },

    async mute(): Promise<void> {
      const activePage = page;
      if (!activePage || crashed) {
        throw new Error('MeetSession is not in a meeting');
      }
      try {
        // Toggle the microphone off via the Meet control (Ctrl+D is the shortcut).
        await activePage.click('button[aria-label*="Turn off microphone" i], [data-tooltip*="microphone" i]');
        logger.info('avatar.meet.muted', { backend: MEET_BACKEND });
      } catch (err: unknown) {
        const message = errorMessage(err);
        logger.error('avatar.meet.mute_failed', { backend: MEET_BACKEND, error: message });
        throw new Error(`MeetSession failed to mute: ${message}`);
      }
    },

    async leave(): Promise<void> {
      const activePage = page;
      // Best-effort: click the leave control if the page is still alive, then
      // always release the browser resources so isolation never leaks a process.
      if (activePage && !crashed) {
        try {
          await activePage.click('button[aria-label*="Leave call" i], button[aria-label*="Leave" i]');
        } catch (err: unknown) {
          logger.error('avatar.meet.leave_click_error', {
            backend: MEET_BACKEND,
            error: errorMessage(err),
          });
        }
      }
      await releaseBrowser();
      logger.info('avatar.meet.left', { backend: MEET_BACKEND });
    },
  };
}
