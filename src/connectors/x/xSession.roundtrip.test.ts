import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Browser } from 'playwright';
import {
  createPlaywrightXSession,
  type ChromiumLauncher,
  type XStateFs,
} from './xSession.js';

// Feature: roza-step5-x-twitter, Property 6: X_Session_State round-trip persistence and restoration
// Validates: Requirements 3.1, 3.2, 3.3
//
// For any X_Session_State, persisting it to the configured durable path through
// the injectable `fs` seam and then restoring it yields an equivalent
// authenticated state (Req 3.1): persist writes EXACTLY what a subsequent
// restore reads back. When a valid stored state is present, `open()` restores it
// into the BrowserContext (`newContext` receives `{ storageState }`) and
// `isAuthenticated()` reports authenticated WITHOUT a fresh login (Req 3.2).
// When no/invalid state is present, the connector path drives `login(creds)`
// which then persists the resulting state for the next session (Req 3.3).
//
// The Playwright `chromium` launcher and the `fs` seam are both injected, so NO
// real browser, X network, or filesystem session-state I/O ever runs (Req 13.6).

const STORAGE_PATH = '/data/x_storage_state.json';

/** Build an in-memory {@link XStateFs} seam backed by a Map<path, json>. */
function makeMemFs(): XStateFs & {
  has(path: string): boolean;
  raw(path: string): string | null;
} {
  const store = new Map<string, string>();
  return {
    readState(path: string): string | null {
      return store.has(path) ? (store.get(path) as string) : null;
    },
    writeState(path: string, json: string): void {
      store.set(path, json);
    },
    has(path: string): boolean {
      return store.has(path);
    },
    raw(path: string): string | null {
      return store.has(path) ? (store.get(path) as string) : null;
    },
  };
}

/**
 * Build a fake Playwright stack. The fake `Browser.newContext` records the
 * options it receives (so the test can assert a restored `{ storageState }`),
 * the fake `BrowserContext.storageState()` returns the generated `liveState`,
 * and the fake `Page` simulates X's auth redirect: navigating to /home while
 * unauthenticated lands on the login flow, while a restored/just-logged-in
 * session stays on /home.
 */
function makeFakeStack(liveState: unknown): {
  launcher: ChromiumLauncher;
  newContextOptions(): unknown;
  newContextCalls(): number;
  fillCalls(): ReadonlyArray<{ selector: string; value: string }>;
} {
  let recordedOptions: unknown;
  let contextCalls = 0;
  let authed = false;
  let currentUrl = 'https://x.com';
  const fills: Array<{ selector: string; value: string }> = [];

  const page = {
    async goto(url: string): Promise<void> {
      if (url.includes('/login') || url.includes('/i/flow/login')) {
        currentUrl = url;
      } else if (url.includes('/home')) {
        // Simulate X redirecting an unauthenticated session to the login flow.
        currentUrl = authed ? url : 'https://x.com/i/flow/login';
      } else {
        currentUrl = url;
      }
    },
    url(): string {
      return currentUrl;
    },
    async fill(selector: string, value: string): Promise<void> {
      fills.push({ selector, value });
    },
    async click(selector: string): Promise<void> {
      // A successful login click authenticates the session.
      if (selector.includes('Log in') || selector.includes('Login')) {
        authed = true;
      }
    },
    async waitForLoadState(): Promise<void> {
      /* no-op */
    },
    async $$eval(): Promise<unknown[]> {
      return [];
    },
  };

  const context = {
    async newPage() {
      return page;
    },
    async storageState() {
      return liveState;
    },
  };

  const browser = {
    async newContext(options?: unknown) {
      contextCalls += 1;
      recordedOptions = options;
      if (
        options !== undefined &&
        options !== null &&
        typeof options === 'object' &&
        'storageState' in (options as Record<string, unknown>)
      ) {
        // A restored, still-valid state authenticates the session (Req 3.2).
        authed = true;
      }
      return context;
    },
    on(): void {
      /* disconnected listener — unused in these scenarios */
    },
    async close(): Promise<void> {
      /* no-op */
    },
  };

  const launcher: ChromiumLauncher = {
    async launch() {
      return browser as unknown as Browser;
    },
  };

  return {
    launcher,
    newContextOptions: () => recordedOptions,
    newContextCalls: () => contextCalls,
    fillCalls: () => fills,
  };
}

// JSON-serializable X_Session_State resembling Playwright `storageState`.
const cookieArb = fc.record({
  name: fc.string({ maxLength: 24 }),
  value: fc.string({ maxLength: 48 }),
  domain: fc.constantFrom('.x.com', 'x.com', '.twitter.com'),
  path: fc.constant('/'),
  expires: fc.integer({ min: -1, max: 2_000_000_000 }),
  httpOnly: fc.boolean(),
  secure: fc.boolean(),
  sameSite: fc.constantFrom('Strict', 'Lax', 'None'),
});
const originArb = fc.record({
  origin: fc.constantFrom('https://x.com', 'https://twitter.com'),
  localStorage: fc.array(
    fc.record({ name: fc.string({ maxLength: 16 }), value: fc.string({ maxLength: 32 }) }),
    { maxLength: 4 },
  ),
});
const sessionStateArb = fc.record({
  cookies: fc.array(cookieArb, { maxLength: 6 }),
  origins: fc.array(originArb, { maxLength: 3 }),
});

const credsArb = fc.record({
  username: fc.string({ minLength: 1, maxLength: 24 }),
  password: fc.string({ minLength: 1, maxLength: 24 }),
});

describe('xSession — X_Session_State round-trip persistence and restoration', () => {
  it('Property 6a: persist writes exactly what a subsequent restore reads back', async () => {
    await fc.assert(
      fc.asyncProperty(sessionStateArb, async (state) => {
        const seam = makeMemFs();
        const stack = makeFakeStack(state);
        const session = createPlaywrightXSession({
          chromium: stack.launcher,
          storageStatePath: STORAGE_PATH,
          fs: seam,
        });

        await session.open();
        await session.persistState();

        // What persist wrote is exactly what a restore reads back (Req 3.1).
        const raw = seam.raw(STORAGE_PATH);
        expect(raw).not.toBeNull();
        expect(JSON.parse(raw as string)).toEqual(state);

        // A fresh session restoring that persisted state hands the equivalent
        // X_Session_State to the BrowserContext via `{ storageState }` (Req 3.2).
        const restoreStack = makeFakeStack(state);
        const restored = createPlaywrightXSession({
          chromium: restoreStack.launcher,
          storageStatePath: STORAGE_PATH,
          fs: seam,
        });
        await restored.open();
        const options = restoreStack.newContextOptions() as { storageState?: unknown };
        expect(options).toBeDefined();
        expect(options.storageState).toEqual(state);
      }),
      { numRuns: 100 },
    );
  });

  it('Property 6b: a valid restored state reports authenticated with no fresh login', async () => {
    await fc.assert(
      fc.asyncProperty(sessionStateArb, async (state) => {
        const seam = makeMemFs();
        // Seed a valid stored X_Session_State at the durable path.
        seam.writeState(STORAGE_PATH, JSON.stringify(state));
        const stack = makeFakeStack(state);
        const session = createPlaywrightXSession({
          chromium: stack.launcher,
          storageStatePath: STORAGE_PATH,
          fs: seam,
        });

        await session.open();

        // open() restored the state into the context (Req 3.2).
        const options = stack.newContextOptions() as { storageState?: unknown };
        expect(options).toBeDefined();
        expect(options.storageState).toEqual(state);

        // The session reports authenticated...
        const authenticated = await session.isAuthenticated();
        expect(authenticated).toBe(true);
        // ...WITHOUT performing any fresh login (no credential form fills).
        expect(stack.fillCalls()).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });

  it('Property 6c: an absent state drives login(creds) which then persists the state', async () => {
    await fc.assert(
      fc.asyncProperty(sessionStateArb, credsArb, async (state, creds) => {
        const seam = makeMemFs();
        // No stored state present.
        const stack = makeFakeStack(state);
        const session = createPlaywrightXSession({
          chromium: stack.launcher,
          storageStatePath: STORAGE_PATH,
          fs: seam,
        });

        await session.open();

        // With no restored state the context is opened with no `storageState`
        // and the session is not authenticated (Req 3.2 fallback).
        const options = stack.newContextOptions();
        expect(
          options === undefined ||
            !(typeof options === 'object' && options !== null && 'storageState' in options),
        ).toBe(true);
        expect(await session.isAuthenticated()).toBe(false);
        expect(seam.has(STORAGE_PATH)).toBe(false);

        // The connector path drives a fresh login that then persists state (Req 3.3).
        await session.login(creds);

        // login persisted the resulting X_Session_State for the next session.
        const raw = seam.raw(STORAGE_PATH);
        expect(raw).not.toBeNull();
        expect(JSON.parse(raw as string)).toEqual(state);

        // The credentials were submitted through the login form.
        const fillValues = stack.fillCalls().map((c) => c.value);
        expect(fillValues).toContain(creds.username);
        expect(fillValues).toContain(creds.password);
      }),
      { numRuns: 100 },
    );
  });
});
