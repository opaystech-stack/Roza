// Feature: roza-step5-x-twitter, Task 6.3 — mocked-integration test for the Playwright X adapter
//
// Validates: Requirements 2.1, 3.4, 3.5, 11.1, 13.6
//
// These tests exercise `createPlaywrightXSession` against a FAKE Playwright API
// injected via `deps.chromium` plus an in-memory `fs` seam injected via
// `deps.fs` — no real Chromium browser, X network, or filesystem session-state
// I/O ever runs in CI (Req 13.6). They assert the adapter:
//   - on `open()` restores the X_Session_State via `newContext({ storageState })`
//     when the fs seam has a stored state, and creates a plain context when it
//     is absent (Req 3.2, 3.5);
//   - on `login(creds)` drives the expected fill/click X login UI sequence and
//     persists the resulting storageState back through the fs seam (Req 3.3, 3.5);
//   - `readTimeline()`/`readMentions()` return the tweets/mentions parsed by the
//     mocked `$$eval` (Untrusted_X_Content, returned as data — Req 2.1);
//   - `postTweet()`/`postReply(ref, text)` drive the expected compose/reply UI
//     calls;
//   - NEVER emits an `X_Credentials` value (username/password) NOR any
//     `storageState` content on any log line, across happy and failing paths
//     (Req 3.4);
//   - rejects on a page-action failure and on a browser crash (the browser
//     emitting `disconnected`), so the X_Connector can isolate the fault
//     (Req 11.1).

import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import {
  createPlaywrightXSession,
  type ChromiumLauncher,
  type XCredentials,
  type XStateFs,
} from './xSession.js';
import type { Logger } from '../../types.js';

/** Durable X_Session_State path the fs seam is keyed by. */
const STATE_PATH = '/data/x_storage_state.json';

/** Distinctive secret values we scan every log line for — must NEVER appear (Req 3.4). */
const CREDS: XCredentials = {
  username: 'roza_thinker',
  password: 'sup3r-S3cr3t-X-P@ssw0rd!',
};

/**
 * A restored X_Session_State whose cookie value is a distinctive secret. The
 * adapter restores it into the context but must NEVER log its contents (Req 3.4).
 */
const RESTORED_COOKIE_SECRET = 'auth_token=SENSITIVE-SESSION-COOKIE-VALUE-9f3a';
const RESTORED_STATE_JSON = JSON.stringify({
  cookies: [{ name: 'auth_token', value: RESTORED_COOKIE_SECRET, domain: '.x.com' }],
  origins: [],
});

/** A freshly-captured storageState whose cookie value is a distinctive secret. */
const PERSISTED_COOKIE_SECRET = 'auth_token=FRESH-LOGIN-COOKIE-VALUE-7b21';
const PERSISTED_STATE_OBJECT = {
  cookies: [{ name: 'auth_token', value: PERSISTED_COOKIE_SECRET, domain: '.x.com' }],
  origins: [],
};

/** Selectors the adapter uses; asserted to prove the expected UI drive sequence. */
const LOGIN_USERNAME_FILL = 'input[autocomplete="username"], input[name="text"]';
const LOGIN_NEXT_CLICK = 'button:has-text("Next"), [role="button"]:has-text("Next")';
const LOGIN_PASSWORD_FILL = 'input[type="password"], input[name="password"]';
const LOGIN_SUBMIT_CLICK = 'button:has-text("Log in"), [data-testid="LoginForm_Login_Button"]';
const TWEET_ARTICLE_SELECTOR = 'article[data-testid="tweet"]';
const COMPOSE_OPEN_CLICK = '[data-testid="SideNav_NewTweet_Button"], a[href="/compose/post"]';
const COMPOSE_TEXTAREA_FILL = '[data-testid="tweetTextarea_0"]';
const COMPOSE_SUBMIT_CLICK = '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]';
const REPLY_OPEN_CLICK = '[data-testid="reply"]';

/** A spy logger; both sinks are spies so we can scan everything they received. */
function createSpyLogger(): Logger & { info: Mock; error: Mock } {
  return { info: vi.fn(), error: vi.fn() };
}

interface FakePage {
  goto: Mock;
  fill: Mock;
  click: Mock;
  $$eval: Mock;
  waitForLoadState: Mock;
  url: Mock;
}

interface FakeContext {
  newPage: Mock;
  storageState: Mock;
}

interface FakeBrowser {
  newContext: Mock;
  on: Mock;
  close: Mock;
}

interface FakeChromium {
  /** The injectable launcher passed to the adapter as `deps.chromium`. */
  chromium: ChromiumLauncher;
  launch: Mock;
  browser: FakeBrowser;
  context: FakeContext;
  page: FakePage;
  /** Invoke the captured `disconnected` handler to simulate a browser crash. */
  emitDisconnected(): void;
}

/**
 * Build a fully-wired fake Playwright object graph (launcher → browser →
 * context → page) with spy methods that resolve by default. The returned
 * handles let each test inspect calls or override a single method to reject.
 */
function createFakeChromium(): FakeChromium {
  const page: FakePage = {
    goto: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    // `$$eval` runs in the page against the DOM in production; the fake returns
    // canned parsed rows so no real browser/DOM is needed.
    $$eval: vi.fn(async () => []),
    waitForLoadState: vi.fn(async () => undefined),
    url: vi.fn(() => 'https://x.com/home'),
  };

  const context: FakeContext = {
    newPage: vi.fn(async () => page),
    storageState: vi.fn(async () => PERSISTED_STATE_OBJECT),
  };

  let disconnectedHandler: (() => void) | null = null;
  const browser: FakeBrowser = {
    newContext: vi.fn(async () => context),
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'disconnected') {
        disconnectedHandler = handler;
      }
    }),
    close: vi.fn(async () => undefined),
  };

  const launch = vi.fn(async () => browser);
  const chromium = { launch } as unknown as ChromiumLauncher;

  return {
    chromium,
    launch,
    browser,
    context,
    page,
    emitDisconnected(): void {
      disconnectedHandler?.();
    },
  };
}

/**
 * Build an in-memory {@link XStateFs} seam, optionally seeded with a stored
 * state for `STATE_PATH`. Both methods are spies so tests can assert the
 * restore/persist calls without touching the real filesystem (Req 13.6).
 */
function createMemoryFs(seed?: string): XStateFs & { readState: Mock; writeState: Mock; store: Map<string, string> } {
  const store = new Map<string, string>();
  if (seed !== undefined) {
    store.set(STATE_PATH, seed);
  }
  return {
    store,
    readState: vi.fn((path: string) => (store.has(path) ? store.get(path)! : null)),
    writeState: vi.fn((path: string, json: string) => {
      store.set(path, json);
    }),
  };
}

/** Flatten every (message + meta) pair a spy logger received into one string. */
function allLoggedText(logger: Logger & { info: Mock; error: Mock }): string {
  const lines: string[] = [];
  for (const call of [...logger.info.mock.calls, ...logger.error.mock.calls]) {
    for (const arg of call) {
      lines.push(typeof arg === 'string' ? arg : JSON.stringify(arg));
    }
  }
  return lines.join('\n');
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('createPlaywrightXSession.open (Task 6.3)', () => {
  it('restores the X_Session_State via newContext({ storageState }) when present (Req 3.2)', async () => {
    const fake = createFakeChromium();
    const fs = createMemoryFs(RESTORED_STATE_JSON);
    const session = createPlaywrightXSession({ chromium: fake.chromium, fs, storageStatePath: STATE_PATH });

    await session.open();

    // The fs seam was read for the durable state path...
    expect(fs.readState).toHaveBeenCalledWith(STATE_PATH);
    // ...and the parsed state was restored into a new context.
    expect(fake.launch).toHaveBeenCalledTimes(1);
    expect(fake.browser.newContext).toHaveBeenCalledTimes(1);
    const ctxArgs = fake.browser.newContext.mock.calls[0]![0] as { storageState: typeof PERSISTED_STATE_OBJECT };
    expect(ctxArgs.storageState).toEqual(JSON.parse(RESTORED_STATE_JSON));
    expect(fake.context.newPage).toHaveBeenCalledTimes(1);
  });

  it('creates a plain context (no storageState) when no state is present (Req 3.5)', async () => {
    const fake = createFakeChromium();
    const fs = createMemoryFs(); // empty store → readState returns null
    const session = createPlaywrightXSession({ chromium: fake.chromium, fs, storageStatePath: STATE_PATH });

    await session.open();

    expect(fs.readState).toHaveBeenCalledWith(STATE_PATH);
    expect(fake.browser.newContext).toHaveBeenCalledTimes(1);
    // A plain context is created with NO arguments when there is no stored state.
    expect(fake.browser.newContext.mock.calls[0]!.length).toBe(0);
  });

  it('rejects and releases the browser when opening the context fails (Req 11.1)', async () => {
    const fake = createFakeChromium();
    const fs = createMemoryFs();
    fake.browser.newContext.mockRejectedValueOnce(new Error('context boom'));
    const session = createPlaywrightXSession({ chromium: fake.chromium, fs, storageStatePath: STATE_PATH });

    await expect(session.open()).rejects.toThrow(/failed to open/i);
    // The browser is released so the connector can isolate the fault.
    expect(fake.browser.close).toHaveBeenCalledTimes(1);
  });

  it('rejects when the browser fails to launch (Req 11.1)', async () => {
    const fake = createFakeChromium();
    const fs = createMemoryFs();
    fake.launch.mockRejectedValueOnce(new Error('chromium executable missing'));
    const logger = createSpyLogger();
    const session = createPlaywrightXSession({ chromium: fake.chromium, fs, storageStatePath: STATE_PATH, logger });

    await expect(session.open()).rejects.toThrow(/failed to launch browser/i);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('createPlaywrightXSession.login (Task 6.3)', () => {
  it('drives the expected fill/click UI sequence and persists storageState through the fs seam (Req 3.3, 3.5)', async () => {
    const fake = createFakeChromium();
    const fs = createMemoryFs();
    const session = createPlaywrightXSession({ chromium: fake.chromium, fs, storageStatePath: STATE_PATH });

    await session.open();
    await session.login(CREDS);

    // The credentials were filled into the login form in order...
    expect(fake.page.fill).toHaveBeenCalledWith(LOGIN_USERNAME_FILL, CREDS.username);
    expect(fake.page.click).toHaveBeenCalledWith(LOGIN_NEXT_CLICK);
    expect(fake.page.fill).toHaveBeenCalledWith(LOGIN_PASSWORD_FILL, CREDS.password);
    expect(fake.page.click).toHaveBeenCalledWith(LOGIN_SUBMIT_CLICK);

    // ...and the resulting storageState was captured and persisted via the fs seam.
    expect(fake.context.storageState).toHaveBeenCalledTimes(1);
    expect(fs.writeState).toHaveBeenCalledWith(STATE_PATH, JSON.stringify(PERSISTED_STATE_OBJECT));
    expect(fs.store.get(STATE_PATH)).toBe(JSON.stringify(PERSISTED_STATE_OBJECT));
  });

  it('rejects when the login UI sequence fails (Req 11.1)', async () => {
    const fake = createFakeChromium();
    const fs = createMemoryFs();
    fake.page.click.mockRejectedValueOnce(new Error('Next button missing'));
    const session = createPlaywrightXSession({ chromium: fake.chromium, fs, storageStatePath: STATE_PATH });

    await session.open();
    await expect(session.login(CREDS)).rejects.toThrow(/failed to log in/i);
  });
});

describe('createPlaywrightXSession.readTimeline / readMentions (Task 6.3)', () => {
  it('returns the tweets parsed by the mocked $$eval (Req 2.1)', async () => {
    const fake = createFakeChromium();
    const fs = createMemoryFs(RESTORED_STATE_JSON);
    const parsedTweets = [
      { id: '1', author: 'Alice', text: 'first tweet' },
      { id: '2', author: 'Bob', text: 'second tweet' },
    ];
    fake.page.$$eval.mockResolvedValueOnce(parsedTweets);
    const session = createPlaywrightXSession({ chromium: fake.chromium, fs, storageStatePath: STATE_PATH });

    await session.open();
    const tweets = await session.readTimeline();

    expect(tweets).toEqual(parsedTweets);
    // The timeline was read from the tweet article selector.
    expect(fake.page.$$eval.mock.calls[0]![0]).toBe(TWEET_ARTICLE_SELECTOR);
  });

  it('returns the mentions parsed by the mocked $$eval (Req 2.1)', async () => {
    const fake = createFakeChromium();
    const fs = createMemoryFs(RESTORED_STATE_JSON);
    const parsedMentions = [
      { ref: 'm1', author: 'Carol', text: '@roza hello' },
      { ref: 'm2', author: 'Dave', text: '@roza what do you think?' },
    ];
    fake.page.$$eval.mockResolvedValueOnce(parsedMentions);
    const session = createPlaywrightXSession({ chromium: fake.chromium, fs, storageStatePath: STATE_PATH });

    await session.open();
    const mentions = await session.readMentions();

    expect(mentions).toEqual(parsedMentions);
    expect(fake.page.$$eval.mock.calls[0]![0]).toBe(TWEET_ARTICLE_SELECTOR);
  });

  it('rejects when a timeline read action fails (Req 11.1)', async () => {
    const fake = createFakeChromium();
    const fs = createMemoryFs(RESTORED_STATE_JSON);
    fake.page.$$eval.mockRejectedValueOnce(new Error('eval failed'));
    const session = createPlaywrightXSession({ chromium: fake.chromium, fs, storageStatePath: STATE_PATH });

    await session.open();
    await expect(session.readTimeline()).rejects.toThrow(/failed to read timeline/i);
  });
});

describe('createPlaywrightXSession.postTweet / postReply (Task 6.3)', () => {
  it('drives the expected compose UI calls for postTweet', async () => {
    const fake = createFakeChromium();
    const fs = createMemoryFs(RESTORED_STATE_JSON);
    const session = createPlaywrightXSession({ chromium: fake.chromium, fs, storageStatePath: STATE_PATH });

    await session.open();
    await session.postTweet('Hello world from Roza');

    expect(fake.page.click).toHaveBeenCalledWith(COMPOSE_OPEN_CLICK);
    expect(fake.page.fill).toHaveBeenCalledWith(COMPOSE_TEXTAREA_FILL, 'Hello world from Roza');
    expect(fake.page.click).toHaveBeenCalledWith(COMPOSE_SUBMIT_CLICK);
  });

  it('drives the expected reply UI calls for postReply, navigating to the ref status (Req 2.1)', async () => {
    const fake = createFakeChromium();
    const fs = createMemoryFs(RESTORED_STATE_JSON);
    const session = createPlaywrightXSession({ chromium: fake.chromium, fs, storageStatePath: STATE_PATH });

    await session.open();
    await session.postReply('tweet-42', 'A thoughtful reply');

    // The ref is used ONLY as a navigation target (Untrusted_X_Content — Req 9.1).
    const gotoTargets = fake.page.goto.mock.calls.map((c) => c[0] as string);
    expect(gotoTargets).toContain('https://x.com/i/status/tweet-42');
    expect(fake.page.click).toHaveBeenCalledWith(REPLY_OPEN_CLICK);
    expect(fake.page.fill).toHaveBeenCalledWith(COMPOSE_TEXTAREA_FILL, 'A thoughtful reply');
    expect(fake.page.click).toHaveBeenCalledWith(COMPOSE_SUBMIT_CLICK);
  });

  it('rejects when a post action fails (Req 11.1)', async () => {
    const fake = createFakeChromium();
    const fs = createMemoryFs(RESTORED_STATE_JSON);
    fake.page.click.mockRejectedValueOnce(new Error('compose button missing'));
    const session = createPlaywrightXSession({ chromium: fake.chromium, fs, storageStatePath: STATE_PATH });

    await session.open();
    await expect(session.postTweet('boom')).rejects.toThrow(/failed to post tweet/i);
  });
});

describe('createPlaywrightXSession secret discipline (Task 6.3, Req 3.4)', () => {
  it('never emits X_Credentials or storageState content on any log line — happy path', async () => {
    const fake = createFakeChromium();
    const fs = createMemoryFs(RESTORED_STATE_JSON);
    const logger = createSpyLogger();
    const session = createPlaywrightXSession({ chromium: fake.chromium, fs, storageStatePath: STATE_PATH, logger });

    await session.open(); // restores the secret-bearing state
    await session.login(CREDS); // fills + persists the secret-bearing fresh state
    await session.postTweet('a public thought');

    // The credentials reached the form via fill(), proving they were used...
    expect(fake.page.fill).toHaveBeenCalledWith(LOGIN_USERNAME_FILL, CREDS.username);
    expect(fake.page.fill).toHaveBeenCalledWith(LOGIN_PASSWORD_FILL, CREDS.password);

    // ...but NEITHER the credentials NOR any storageState content ever appear in logs.
    const logged = allLoggedText(logger);
    expect(logged).not.toContain(CREDS.username);
    expect(logged).not.toContain(CREDS.password);
    expect(logged).not.toContain(RESTORED_COOKIE_SECRET);
    expect(logged).not.toContain(PERSISTED_COOKIE_SECRET);
    // The adapter does log non-sensitive activity, so the scan is meaningful.
    expect(logger.info).toHaveBeenCalled();
  });

  it('never emits X_Credentials or storageState content on any log line — failing login', async () => {
    const fake = createFakeChromium();
    const fs = createMemoryFs(RESTORED_STATE_JSON);
    const logger = createSpyLogger();
    // The login submit fails after the credentials were already filled.
    fake.page.click.mockRejectedValue(new Error('login challenge presented'));
    const session = createPlaywrightXSession({ chromium: fake.chromium, fs, storageStatePath: STATE_PATH, logger });

    await session.open();
    await expect(session.login(CREDS)).rejects.toThrow(/failed to log in/i);

    const logged = allLoggedText(logger);
    expect(logged).not.toContain(CREDS.username);
    expect(logged).not.toContain(CREDS.password);
    expect(logged).not.toContain(RESTORED_COOKIE_SECRET);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('createPlaywrightXSession fault isolation (Task 6.3, Req 11.1)', () => {
  it('rejects a read when the browser crashes (emits disconnected) mid-operation', async () => {
    const fake = createFakeChromium();
    const fs = createMemoryFs(RESTORED_STATE_JSON);
    const logger = createSpyLogger();
    const session = createPlaywrightXSession({ chromium: fake.chromium, fs, storageStatePath: STATE_PATH, logger });

    await session.open();
    // Simulate the browser crashing while the timeline navigation is in flight:
    // the captured `disconnected` handler fires, so the post-goto crash check trips.
    fake.page.goto.mockImplementationOnce(async () => {
      fake.emitDisconnected();
      return undefined;
    });

    await expect(session.readTimeline()).rejects.toThrow(/failed to read timeline/i);
    // The crash was recorded so the connector can isolate the fault.
    expect(logger.error).toHaveBeenCalledWith('x.session.browser_crashed', expect.anything());
  });

  it('rejects subsequent operations once the browser has disconnected', async () => {
    const fake = createFakeChromium();
    const fs = createMemoryFs(RESTORED_STATE_JSON);
    const session = createPlaywrightXSession({ chromium: fake.chromium, fs, storageStatePath: STATE_PATH });

    await session.open();
    fake.emitDisconnected();

    // With the browser disconnected, a post must fail fast rather than act.
    await expect(session.postTweet('after crash')).rejects.toThrow(/not open/i);
  });
});
