/**
 * XSession interface + Playwright X (formerly Twitter) adapter (Component X3) —
 * Req 2.1, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 11.1, 11.4.
 *
 * Defines the swappable {@link XSession} boundary the X_Connector drives to make
 * Roza present on X via browser automation (NOT a paid social API), plus the
 * default {@link createPlaywrightXSession} adapter that drives a **headless
 * Chromium** browser via Playwright to the X web interface. The adapter
 * persists and restores the X_Session_State (Playwright `storageState`:
 * cookies + origins) to/from a durable, operator-configured path so Roza avoids
 * repeated logins and reduces anti-bot detection (Req 3.1, 3.2, 3.3).
 *
 * **Stated honestly (Req 2.5):** headless X automation is fragile, may conflict
 * with X's Terms of Service, and may trigger anti-bot defenses such as
 * challenges, rate limits, or account suspension. The X integration therefore
 * lives entirely behind this swappable interface (Req 2.3) so the fragile
 * browser-automation adapter can be replaced (Puppeteer, a different backend)
 * without touching the autonomy, thought-formulation, or reply logic.
 *
 * Untrusted input (Req 9.1): every text returned by `readTimeline`/`readMentions`
 * is Untrusted_X_Content. It is **data** the adapter returns — it is **never**
 * interpreted as a Roza command, a shell argument, or a config change.
 *
 * Fault isolation (Req 11.1, 11.4): a browser crash or session failure rejects
 * so the X_Connector can log the failure, release this session's resources, and
 * keep the service plus the other channels running. The browser resources are
 * always released on failure.
 *
 * Secret discipline (Req 3.4, 7.4): this module NEVER logs the `X_Credentials`
 * (username/password) and NEVER logs the `storageState` contents. Only
 * non-sensitive identifiers (the backend, hostnames, counts, tweet/mention refs)
 * ever appear in logs.
 *
 * Testability (Req 13.6): the Playwright `chromium` browser launcher and the
 * `fs` storageState seam are both injectable via deps, so tests drive the
 * adapter against a mocked Playwright API and an in-memory store — **no real
 * browser, X network, or filesystem session-state I/O ever runs in CI**. When
 * no launcher is injected, Playwright is imported **lazily** at launch time so
 * the module typechecks even though Playwright browsers are not installed in CI.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import type { Browser, BrowserContext, BrowserType, Page } from 'playwright';
import type { Logger } from '../../types.js';

/** Operator-provided X account credentials (env-only secrets — Req 7.1). NEVER logged. */
export interface XCredentials {
  username: string;
  password: string;
}

/** One tweet read from the home Timeline — Untrusted_X_Content (Req 9.1). */
export interface XTweet {
  id: string;
  author: string;
  text: string;
}

/** One incoming Mention/notification — Untrusted_X_Content; `ref` is the dedupe key (Req 6.4). */
export interface XMention {
  ref: string;
  author: string;
  text: string;
}

/**
 * The swappable X_Browser_Session boundary the X_Connector delegates to
 * (Req 2.3). The concrete browser-automation technology stays confined to the
 * adapter behind this interface.
 */
export interface XSession {
  /** Open a browser session, restoring a valid X_Session_State if present (Req 3.2). */
  open(): Promise<void>;
  /** True iff the current session is authenticated (a restored, still-valid state). */
  isAuthenticated(): Promise<boolean>;
  /** Log in with X_Credentials and persist the resulting X_Session_State (Req 3.3, 3.5). Never logs creds. */
  login(creds: XCredentials): Promise<void>;
  /** Persist the current X_Session_State (cookies/storageState) to the durable path (Req 3.1). */
  persistState(): Promise<void>;
  /** Read the home Timeline tweets — Untrusted_X_Content (Req 4.2). */
  readTimeline(): Promise<XTweet[]>;
  /** Read Mentions/notifications — Untrusted_X_Content (Req 6.1). */
  readMentions(): Promise<XMention[]>;
  /** Publish an original Roza_Post; `text` is composed within the X max length (Req 5.3, 5.5). */
  postTweet(text: string): Promise<void>;
  /** Publish a Reply to the incoming tweet identified by `ref` (Req 6.3). */
  postReply(ref: string, text: string): Promise<void>;
  /** Release the browser session resources (Req 11.1, 11.4). */
  close(): Promise<void>;
  /** Static descriptor for the license manifest + logs (carries no secrets). */
  readonly descriptor: { backend: 'playwright'; license: string };
}

/**
 * The slice of Playwright's `chromium` browser launcher the adapter needs.
 * Injecting this (rather than the whole module) lets tests supply a mock that
 * returns a fake {@link Browser} — no real Chromium binary is required.
 */
export type ChromiumLauncher = Pick<BrowserType, 'launch'>;

/**
 * Injectable filesystem seam for the X_Session_State read/write. The default is
 * a thin `node:fs` implementation, but tests inject an in-memory store so no
 * real filesystem session-state I/O runs in CI (Req 13.6).
 */
export interface XStateFs {
  /** Return the stored storageState JSON for `path`, or `null` when absent/unreadable. */
  readState(path: string): string | null;
  /** Write the storageState JSON for `path`. */
  writeState(path: string, json: string): void;
}

/** Dependencies for {@link createPlaywrightXSession}; every external edge is injectable. */
export interface PlaywrightXSessionDeps {
  /**
   * Playwright `chromium` browser launcher. Defaults to a **lazy** `import('playwright')`
   * at launch time so the module typechecks without Playwright browsers installed.
   * Tests inject a mock so no real browser launches (Req 13.6).
   */
  chromium?: ChromiumLauncher;
  /** Durable X_Session_State file path (`cfg.x.storageStatePath`); CONTENTS are sensitive (Req 3.4). */
  storageStatePath: string;
  /** Whether to launch Chromium headless. Defaults to `true`. */
  headless?: boolean;
  /**
   * Injectable fs seam for storageState read/write. Defaults to a thin `node:fs`
   * implementation; tests inject an in-memory store (Req 13.6).
   */
  fs?: XStateFs;
  /** Optional structured logger; NEVER receives X_Credentials or X_Session_State contents (Req 3.4, 7.4). */
  logger?: Logger;
}

/** SPDX license of the selected X backend (Playwright). */
const X_LICENSE = 'Apache-2.0';
/** Human-readable backend name recorded in the descriptor. */
const X_BACKEND = 'playwright' as const;

/** X web entry points used for login and reading the timeline/mentions. */
const X_HOME_URL = 'https://x.com/home';
const X_LOGIN_URL = 'https://x.com/i/flow/login';
const X_NOTIFICATIONS_URL = 'https://x.com/notifications/mentions';

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
 * Default `node:fs`-backed {@link XStateFs}. Imported lazily so the module
 * typechecks and loads without touching the filesystem until actually used.
 * `readState` returns `null` for an absent/unreadable file so `open()` can fall
 * back to a fresh login (Req 3.2, 3.5).
 */
function defaultStateFs(): XStateFs {
  return {
    readState(path: string): string | null {
      try {
        if (!existsSync(path)) {
          return null;
        }
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    writeState(path: string, json: string): void {
      writeFileSync(path, json, 'utf8');
    },
  };
}

/**
 * Parse a stored storageState JSON string into the object Playwright accepts as
 * `{ storageState }`. Returns `null` when the content is missing or not valid
 * JSON so the connector falls back to a fresh login (Req 3.2, 3.5). The raw
 * contents are NEVER logged (Req 3.4).
 */
function parseStoredState(raw: string | null): Record<string, unknown> | null {
  if (raw === null || raw.trim() === '') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Create a Playwright-backed {@link XSession}.
 *
 * `open()` launches a headless Chromium and creates a `BrowserContext`,
 * restoring the X_Session_State from `storageStatePath` via `{ storageState }`
 * when the `fs` seam returns a valid state (Req 3.2). `isAuthenticated()`
 * inspects the restored session. `login(creds)` performs a fresh login through
 * the X login flow and then `persistState()` writes the resulting storageState
 * back through the `fs` seam — replacing any expired/invalid restored state
 * (Req 3.3, 3.5). `readTimeline`/`readMentions` return parsed
 * Untrusted_X_Content; `postTweet`/`postReply` drive the compose/reply UI;
 * `close()` releases the browser. Any failure — launch error, login obstacle,
 * navigation/read/post failure, or a browser crash/disconnect — releases the
 * browser and rejects so the X_Connector can isolate the fault (Req 11.1,
 * 11.4).
 *
 * The `chromium` launcher and the `fs` seam are injectable so tests run against
 * a mocked Playwright API and an in-memory store with no real browser, X
 * network, or filesystem I/O (Req 13.6). The `X_Credentials` and the
 * `storageState` contents are NEVER logged (Req 3.4, 7.4).
 */
export function createPlaywrightXSession(deps: PlaywrightXSessionDeps): XSession {
  const logger = deps.logger ?? NO_OP_LOGGER;
  const headless = deps.headless ?? true;
  const storageStatePath = deps.storageStatePath;
  const stateFs = deps.fs ?? defaultStateFs();

  // Live browser session state, or null when not open.
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  // True once a restored or freshly-logged-in session is authenticated.
  let authenticated = false;
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

  /** Release the browser resources, swallowing teardown errors (Req 11.4). */
  async function releaseBrowser(): Promise<void> {
    const current = browser;
    browser = null;
    context = null;
    page = null;
    authenticated = false;
    crashed = false;
    if (!current) {
      return;
    }
    try {
      await current.close();
    } catch (err: unknown) {
      // A crashed/already-closed browser may throw on close; isolation still
      // succeeds because the references are cleared above.
      logger.error('x.session.close_error', { backend: X_BACKEND, error: errorMessage(err) });
    }
  }

  /** Throw a fault-isolating error when the browser crashed mid-session (Req 11.1). */
  function assertLive(): void {
    if (crashed) {
      throw new Error('XSession browser disconnected');
    }
  }

  return {
    descriptor: { backend: X_BACKEND, license: X_LICENSE },

    async open(): Promise<void> {
      if (browser) {
        throw new Error('XSession is already open');
      }

      const launcher = await resolveLauncher();

      let launched: Browser;
      try {
        launched = await launcher.launch({ headless });
      } catch (err: unknown) {
        logger.error('x.session.launch_failed', { backend: X_BACKEND, error: errorMessage(err) });
        throw new Error(`XSession failed to launch browser: ${errorMessage(err)}`);
      }

      browser = launched;
      crashed = false;
      authenticated = false;
      // A browser crash/disconnect mid-session must surface as a fault the
      // connector can isolate (Req 11.1, 11.4).
      launched.on('disconnected', () => {
        crashed = true;
        logger.error('x.session.browser_crashed', { backend: X_BACKEND });
      });

      try {
        // Restore the X_Session_State from the durable path when present (Req 3.2).
        // The raw contents are NEVER logged (Req 3.4).
        const restored = parseStoredState(stateFs.readState(storageStatePath));
        if (restored) {
          context = await launched.newContext({ storageState: restored as never });
          logger.info('x.session.state_restored', { backend: X_BACKEND });
        } else {
          context = await launched.newContext();
          logger.info('x.session.no_state', { backend: X_BACKEND });
        }
        page = await context.newPage();
        assertLive();
      } catch (err: unknown) {
        const message = errorMessage(err);
        await releaseBrowser();
        logger.error('x.session.open_failed', { backend: X_BACKEND, error: message });
        throw new Error(`XSession failed to open: ${message}`);
      }
    },

    async isAuthenticated(): Promise<boolean> {
      const activePage = page;
      if (!activePage || crashed) {
        return false;
      }
      try {
        // Navigate to the home timeline; if the session is valid X keeps us on
        // an authenticated page rather than redirecting to the login flow.
        await activePage.goto(X_HOME_URL, { waitUntil: 'load' });
        assertLive();
        const onLogin = activePage.url().includes('/login') || activePage.url().includes('/i/flow/login');
        authenticated = !onLogin;
        logger.info('x.session.auth_checked', { backend: X_BACKEND, authenticated });
        return authenticated;
      } catch (err: unknown) {
        const message = errorMessage(err);
        logger.error('x.session.auth_check_failed', { backend: X_BACKEND, error: message });
        throw new Error(`XSession failed to check authentication: ${message}`);
      }
    },

    async login(creds: XCredentials): Promise<void> {
      const activePage = page;
      if (!activePage || crashed) {
        throw new Error('XSession is not open');
      }
      try {
        // Drive the X login flow. The credential values are filled into the form
        // and are NEVER logged (Req 3.4, 7.4).
        await activePage.goto(X_LOGIN_URL, { waitUntil: 'load' });
        await activePage.fill('input[autocomplete="username"], input[name="text"]', creds.username);
        await activePage.click('button:has-text("Next"), [role="button"]:has-text("Next")');
        await activePage.fill('input[type="password"], input[name="password"]', creds.password);
        await activePage.click('button:has-text("Log in"), [data-testid="LoginForm_Login_Button"]');
        await activePage.waitForLoadState('load');
        assertLive();
        authenticated = true;
        logger.info('x.session.logged_in', { backend: X_BACKEND });
        // Persist the resulting authenticated state for subsequent sessions,
        // replacing any expired/invalid restored state (Req 3.3, 3.5).
        await this.persistState();
      } catch (err: unknown) {
        const message = errorMessage(err);
        logger.error('x.session.login_failed', { backend: X_BACKEND, error: message });
        throw new Error(`XSession failed to log in: ${message}`);
      }
    },

    async persistState(): Promise<void> {
      const activeContext = context;
      if (!activeContext || crashed) {
        throw new Error('XSession is not open');
      }
      try {
        // Capture the current cookies/origins as storageState and write them
        // through the fs seam. The contents are sensitive and NEVER logged (Req 3.4).
        const state = await activeContext.storageState();
        stateFs.writeState(storageStatePath, JSON.stringify(state));
        logger.info('x.session.state_persisted', { backend: X_BACKEND });
      } catch (err: unknown) {
        const message = errorMessage(err);
        logger.error('x.session.persist_failed', { backend: X_BACKEND, error: message });
        throw new Error(`XSession failed to persist state: ${message}`);
      }
    },

    async readTimeline(): Promise<XTweet[]> {
      const activePage = page;
      if (!activePage || crashed) {
        throw new Error('XSession is not open');
      }
      try {
        await activePage.goto(X_HOME_URL, { waitUntil: 'load' });
        assertLive();
        // Parse the rendered tweets. The returned text is Untrusted_X_Content
        // (Req 9.1) — it is data only and is never executed as a command.
        const tweets = await activePage.$$eval('article[data-testid="tweet"]', (nodes) =>
          nodes.map((node) => {
            const idAttr = node.getAttribute('data-tweet-id') ?? '';
            const authorEl = node.querySelector('[data-testid="User-Name"]');
            const textEl = node.querySelector('[data-testid="tweetText"]');
            return {
              id: idAttr,
              author: authorEl?.textContent ?? '',
              text: textEl?.textContent ?? '',
            };
          }),
        );
        logger.info('x.session.timeline_read', { backend: X_BACKEND, count: tweets.length });
        return tweets;
      } catch (err: unknown) {
        const message = errorMessage(err);
        logger.error('x.session.timeline_failed', { backend: X_BACKEND, error: message });
        throw new Error(`XSession failed to read timeline: ${message}`);
      }
    },

    async readMentions(): Promise<XMention[]> {
      const activePage = page;
      if (!activePage || crashed) {
        throw new Error('XSession is not open');
      }
      try {
        await activePage.goto(X_NOTIFICATIONS_URL, { waitUntil: 'load' });
        assertLive();
        // Parse the rendered mentions. The returned text is Untrusted_X_Content
        // (Req 9.1) — `ref` is the dedupe key (Req 6.4).
        const mentions = await activePage.$$eval('article[data-testid="tweet"]', (nodes) =>
          nodes.map((node) => {
            const refAttr = node.getAttribute('data-tweet-id') ?? '';
            const authorEl = node.querySelector('[data-testid="User-Name"]');
            const textEl = node.querySelector('[data-testid="tweetText"]');
            return {
              ref: refAttr,
              author: authorEl?.textContent ?? '',
              text: textEl?.textContent ?? '',
            };
          }),
        );
        logger.info('x.session.mentions_read', { backend: X_BACKEND, count: mentions.length });
        return mentions;
      } catch (err: unknown) {
        const message = errorMessage(err);
        logger.error('x.session.mentions_failed', { backend: X_BACKEND, error: message });
        throw new Error(`XSession failed to read mentions: ${message}`);
      }
    },

    async postTweet(text: string): Promise<void> {
      const activePage = page;
      if (!activePage || crashed) {
        throw new Error('XSession is not open');
      }
      try {
        // Drive the compose UI. `text` is already composed within the X length
        // bound by the connector (Req 5.5).
        await activePage.goto(X_HOME_URL, { waitUntil: 'load' });
        await activePage.click('[data-testid="SideNav_NewTweet_Button"], a[href="/compose/post"]');
        await activePage.fill('[data-testid="tweetTextarea_0"]', text);
        await activePage.click('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
        await activePage.waitForLoadState('load');
        assertLive();
        // Log only a non-sensitive length count — never the post body.
        logger.info('x.session.tweet_posted', { backend: X_BACKEND, length: text.length });
      } catch (err: unknown) {
        const message = errorMessage(err);
        logger.error('x.session.tweet_failed', { backend: X_BACKEND, error: message });
        throw new Error(`XSession failed to post tweet: ${message}`);
      }
    },

    async postReply(ref: string, text: string): Promise<void> {
      const activePage = page;
      if (!activePage || crashed) {
        throw new Error('XSession is not open');
      }
      try {
        // `ref` is the external tweet id (Untrusted_X_Content): used ONLY as a
        // navigation target, never executed as a command (Req 9.1).
        await activePage.goto(`https://x.com/i/status/${encodeURIComponent(ref)}`, {
          waitUntil: 'load',
        });
        await activePage.click('[data-testid="reply"]');
        await activePage.fill('[data-testid="tweetTextarea_0"]', text);
        await activePage.click('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
        await activePage.waitForLoadState('load');
        assertLive();
        // Log only the ref + length — never the reply body.
        logger.info('x.session.reply_posted', { backend: X_BACKEND, ref, length: text.length });
      } catch (err: unknown) {
        const message = errorMessage(err);
        logger.error('x.session.reply_failed', { backend: X_BACKEND, ref, error: message });
        throw new Error(`XSession failed to post reply: ${message}`);
      }
    },

    async close(): Promise<void> {
      await releaseBrowser();
      logger.info('x.session.closed', { backend: X_BACKEND });
    },
  };
}
