// Feature: roza-step4-avatar-video, Task 8.7 — mocked-integration test for the Playwright Meet adapter
//
// Validates: Requirements 6.2, 6.3, 6.6, 8.4, 12.5
//
// These tests exercise `createPlaywrightMeetSession` against a FAKE Playwright
// API injected via `deps.chromium` — no real Chromium browser or Google Meet
// ever runs in CI (Req 12.5). They assert the adapter:
//   - drives the expected Playwright UI calls on join: launch → newContext →
//     newPage → goto(meetUrl) → select the Virtual_Camera/Virtual_Microphone as
//     the meeting inputs → click "Join now"; and that mute/leave invoke the
//     corresponding page/browser actions (Req 6.2, 6.3);
//   - NEVER emits a `Meet_Credentials` value (account/password) on any log line,
//     across the join/mute/leave happy path AND a failing join (Req 8.4);
//   - rejects on a join failure (a page action throwing) and on a browser
//     crash (the browser emitting `disconnected` mid-join), releasing the
//     browser so the connector can isolate the fault (Req 6.6).

import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import {
  createPlaywrightMeetSession,
  type ChromiumLauncher,
  type MeetCredentials,
} from './meetSession.js';
import type { Logger } from '../../types.js';

/** The untrusted meeting URL used as a pure navigation target (Req 8.7). */
const MEET_URL = 'https://meet.google.com/abc-defg-hij';
/** The configured virtual-device labels the adapter must select as inputs. */
const CAMERA_DEVICE = 'Roza Virtual Camera';
const MICROPHONE_DEVICE = 'Roza Virtual Microphone';

/** Distinctive secret values we scan the logs for — must NEVER appear (Req 8.4). */
const CREDS: MeetCredentials = {
  account: 'roza-bot@workspace.example',
  password: 'sup3r-S3cr3t-P@ssw0rd!',
};

/** Selectors the adapter uses; asserted to prove the expected UI drive sequence. */
const JOIN_SELECTOR = 'button:has-text("Join now"), button:has-text("Ask to join")';
const MUTE_SELECTOR = 'button[aria-label*="Turn off microphone" i], [data-tooltip*="microphone" i]';
const LEAVE_SELECTOR = 'button[aria-label*="Leave call" i], button[aria-label*="Leave" i]';
const MIC_SELECT = 'select[aria-label*="Microphone" i]';
const CAMERA_SELECT = 'select[aria-label*="Camera" i]';

/** A spy logger; both sinks are spies so we can scan everything they received. */
function createSpyLogger(): Logger & { info: Mock; error: Mock } {
  return { info: vi.fn(), error: vi.fn() };
}

interface FakePage {
  goto: Mock;
  fill: Mock;
  click: Mock;
  selectOption: Mock;
  waitForLoadState: Mock;
}

interface FakeContext {
  newPage: Mock;
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
    selectOption: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => undefined),
  };

  const context: FakeContext = {
    newPage: vi.fn(async () => page),
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

describe('createPlaywrightMeetSession.join (Task 8.7)', () => {
  it('drives the expected Playwright UI calls selecting the virtual devices (Req 6.2)', async () => {
    const fake = createFakeChromium();
    const session = createPlaywrightMeetSession({
      chromium: fake.chromium,
      cameraDevice: CAMERA_DEVICE,
      microphoneDevice: MICROPHONE_DEVICE,
    });

    await session.join(MEET_URL, CREDS);

    // launch → newContext → newPage object graph was built.
    expect(fake.launch).toHaveBeenCalledTimes(1);
    const launchArgs = fake.launch.mock.calls[0]![0] as { headless: boolean; args: string[] };
    expect(launchArgs.headless).toBe(true);
    expect(launchArgs.args).toContain('--use-fake-ui-for-media-stream');

    expect(fake.browser.newContext).toHaveBeenCalledTimes(1);
    const ctxArgs = fake.browser.newContext.mock.calls[0]![0] as { permissions: string[] };
    expect(ctxArgs.permissions).toEqual(expect.arrayContaining(['camera', 'microphone']));
    expect(fake.context.newPage).toHaveBeenCalledTimes(1);

    // The untrusted meetUrl was used ONLY as a navigation target (Req 8.7).
    const gotoTargets = fake.page.goto.mock.calls.map((c) => c[0] as string);
    expect(gotoTargets).toContain(MEET_URL);

    // The configured Virtual_Microphone/Virtual_Camera were selected as inputs.
    expect(fake.page.selectOption).toHaveBeenCalledWith(MIC_SELECT, { label: MICROPHONE_DEVICE });
    expect(fake.page.selectOption).toHaveBeenCalledWith(CAMERA_SELECT, { label: CAMERA_DEVICE });

    // The call was joined.
    expect(fake.page.click).toHaveBeenCalledWith(JOIN_SELECTOR);
  });

  it('drives mute and leave through the corresponding page/browser actions (Req 6.3)', async () => {
    const fake = createFakeChromium();
    const session = createPlaywrightMeetSession({
      chromium: fake.chromium,
      cameraDevice: CAMERA_DEVICE,
      microphoneDevice: MICROPHONE_DEVICE,
    });

    await session.join(MEET_URL, CREDS);
    await session.mute();
    await session.leave();

    // mute toggled the microphone control.
    expect(fake.page.click).toHaveBeenCalledWith(MUTE_SELECTOR);
    // leave clicked the leave control AND released the browser resources.
    expect(fake.page.click).toHaveBeenCalledWith(LEAVE_SELECTOR);
    expect(fake.browser.close).toHaveBeenCalledTimes(1);
  });

  it('never emits a Meet_Credentials value on any log line — happy path (Req 8.4)', async () => {
    const fake = createFakeChromium();
    const logger = createSpyLogger();
    const session = createPlaywrightMeetSession({
      chromium: fake.chromium,
      cameraDevice: CAMERA_DEVICE,
      microphoneDevice: MICROPHONE_DEVICE,
      logger,
    });

    await session.join(MEET_URL, CREDS);
    await session.mute();
    await session.leave();

    // The credentials reached the form via fill(), proving they were used...
    expect(fake.page.fill).toHaveBeenCalledWith('input[type="email"]', CREDS.account);
    expect(fake.page.fill).toHaveBeenCalledWith('input[type="password"]', CREDS.password);
    // ...but NEVER appear in any emitted log line.
    const logged = allLoggedText(logger);
    expect(logged).not.toContain(CREDS.account);
    expect(logged).not.toContain(CREDS.password);
    // The adapter does log non-sensitive activity, so the scan is meaningful.
    expect(logger.info).toHaveBeenCalled();
  });

  it('never emits a Meet_Credentials value on any log line — failing join (Req 8.4, 6.6)', async () => {
    const fake = createFakeChromium();
    const logger = createSpyLogger();
    // The join click fails (e.g. the Meet UI never reaches a joinable state).
    fake.page.click.mockRejectedValueOnce(new Error('join button not found'));
    const session = createPlaywrightMeetSession({ chromium: fake.chromium, logger });

    await expect(session.join(MEET_URL, CREDS)).rejects.toThrow(/failed to join/i);

    const logged = allLoggedText(logger);
    expect(logged).not.toContain(CREDS.account);
    expect(logged).not.toContain(CREDS.password);
    // The failure was logged AND the browser was released for fault isolation.
    expect(logger.error).toHaveBeenCalled();
    expect(fake.browser.close).toHaveBeenCalledTimes(1);
  });

  it('rejects and releases the browser when a page action throws (Req 6.6)', async () => {
    const fake = createFakeChromium();
    // Navigating to the untrusted meetUrl fails.
    fake.page.goto.mockImplementation(async (url: string) => {
      if (url === MEET_URL) {
        throw new Error('navigation timeout');
      }
      return undefined;
    });
    const session = createPlaywrightMeetSession({ chromium: fake.chromium });

    await expect(session.join(MEET_URL, CREDS)).rejects.toThrow(/navigation timeout/);
    // Browser resources released so the connector can isolate the fault.
    expect(fake.browser.close).toHaveBeenCalledTimes(1);
  });

  it('rejects when the browser crashes (emits disconnected) mid-join (Req 6.6)', async () => {
    const fake = createFakeChromium();
    const logger = createSpyLogger();
    // Simulate the browser crashing while the join click is in flight: the
    // captured `disconnected` handler fires, so the post-click crash check trips.
    fake.page.click.mockImplementationOnce(async () => {
      fake.emitDisconnected();
      return undefined;
    });
    const session = createPlaywrightMeetSession({ chromium: fake.chromium, logger });

    await expect(session.join(MEET_URL, CREDS)).rejects.toThrow(/disconnected during join/);
    expect(fake.browser.close).toHaveBeenCalledTimes(1);
  });

  it('rejects when the browser fails to launch (Req 6.6)', async () => {
    const fake = createFakeChromium();
    fake.launch.mockRejectedValueOnce(new Error('chromium executable missing'));
    const logger = createSpyLogger();
    const session = createPlaywrightMeetSession({ chromium: fake.chromium, logger });

    await expect(session.join(MEET_URL, CREDS)).rejects.toThrow(/failed to launch browser/i);
    expect(logger.error).toHaveBeenCalled();
  });
});
