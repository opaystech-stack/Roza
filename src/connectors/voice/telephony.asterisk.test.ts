// Feature: roza-step3-voice-telephony, Task 9.6 — mocked-integration test for the Asterisk ARI adapter.
//
// Validates: Requirements 4.1, 5.1, 5.4, 6.4, 7.4, 14.5
//
// These tests drive `createAsteriskTelephonyGateway` against a FAKE ARI client
// injected through `deps.connect`. No real Asterisk, SIP, or RTP runs — the
// fake client exposes only the narrow surface the adapter actually touches
// (a StasisStart/StasisEnd/ChannelDestroyed event emitter plus
// channels.originate/hangup/externalMedia and per-channel answer/hangup). The
// suite asserts the ARI lifecycle maps onto the TelephonyGateway interface and
// that no SIP credential value is ever written to a log line (Req 7.4).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createAsteriskTelephonyGateway,
  type AriClientLike,
  type AriCallerId,
  type AriChannelLike,
  type AriConnect,
  type AriChannelDestroyedLike,
  type SipCredentials,
} from './telephony.asterisk.js';
import type { Logger } from '../../types.js';

/** SIP credentials whose values must never surface in any log line (Req 7.4). */
const SIP: SipCredentials = {
  host: 'sip-host-SECRETVALUE',
  port: 5060,
  user: 'sip-user-SECRETVALUE',
  password: 'sip-pass-SECRETVALUE',
  realm: 'sip-realm-SECRETVALUE',
};

/** The distinctive sentinel substring shared by every SIP credential value. */
const CREDENTIAL_SENTINEL = 'SECRETVALUE';

/** A fake ARI channel exposing only the fields/methods the adapter uses. */
class FakeChannel implements AriChannelLike {
  readonly id: string;
  readonly name?: string;
  readonly caller?: AriCallerId;
  readonly answer = vi.fn(async (): Promise<void> => undefined);
  readonly hangup = vi.fn(async (_params?: { reason?: string }): Promise<void> => undefined);

  constructor(id: string, opts: { name?: string; caller?: AriCallerId } = {}) {
    this.id = id;
    if (opts.name !== undefined) this.name = opts.name;
    if (opts.caller !== undefined) this.caller = opts.caller;
  }
}

type StasisStartListener = (event: unknown, channel: AriChannelLike) => void;
type StasisEndListener = (event: unknown, channel: AriChannelLike) => void;
type ChannelDestroyedListener = (event: AriChannelDestroyedLike, channel: AriChannelLike) => void;

/** Build an injectable fake ARI client plus handles to drive its events. */
function makeFakeAri() {
  const stasisStart: StasisStartListener[] = [];
  const stasisEnd: StasisEndListener[] = [];
  const channelDestroyed: ChannelDestroyedListener[] = [];

  const originate = vi.fn(
    async (params: { channelId?: string; endpoint: string }): Promise<AriChannelLike> =>
      new FakeChannel(params.channelId ?? 'originated'),
  );
  const hangup = vi.fn(async (_params: { channelId: string; reason?: string }): Promise<void> => undefined);
  const externalMedia = vi.fn(async (): Promise<AriChannelLike> => new FakeChannel('external-media'));
  const start = vi.fn(async (_apps: string | string[]): Promise<void> => undefined);

  const client = {
    on(event: string, listener: (...args: never[]) => void): void {
      if (event === 'StasisStart') stasisStart.push(listener as StasisStartListener);
      else if (event === 'StasisEnd') stasisEnd.push(listener as StasisEndListener);
      else if (event === 'ChannelDestroyed') channelDestroyed.push(listener as ChannelDestroyedListener);
    },
    start,
    channels: { originate, hangup, externalMedia },
  };

  const connect: AriConnect = vi.fn(async () => client as unknown as AriClientLike);

  return {
    connect,
    start,
    originate,
    hangup,
    externalMedia,
    emitStasisStart: (channel: AriChannelLike, event: unknown = {}) => {
      for (const l of stasisStart) l(event, channel);
    },
    emitStasisEnd: (channel: AriChannelLike, event: unknown = {}) => {
      for (const l of stasisEnd) l(event, channel);
    },
    emitChannelDestroyed: (channel: AriChannelLike, event: AriChannelDestroyedLike = {}) => {
      for (const l of channelDestroyed) l(event, channel);
    },
  };
}

/** Capturing logger: records every message + serialized meta for credential audits. */
function makeSpyLogger() {
  const lines: string[] = [];
  const record = (message: string, meta?: Record<string, unknown>): void => {
    lines.push(`${message} ${meta ? JSON.stringify(meta) : ''}`);
  };
  const logger: Logger = { info: vi.fn(record), error: vi.fn(record) };
  return { logger, lines };
}

/** Resolve after pending microtasks/the originate await-chain have settled. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('createAsteriskTelephonyGateway — Asterisk ARI adapter (Task 9.6)', () => {
  let fake: ReturnType<typeof makeFakeAri>;
  let spy: ReturnType<typeof makeSpyLogger>;

  beforeEach(() => {
    fake = makeFakeAri();
    spy = makeSpyLogger();
  });

  it('listen: a StasisStart for an inbound channel invokes onInboundCall with an inbound CallHandle (Req 4.1)', async () => {
    const inbound: Array<{ callId: string; callerIdentity: string; direction: string }> = [];
    const gateway = createAsteriskTelephonyGateway({ sip: SIP, connect: fake.connect, logger: spy.logger });

    await gateway.listen(async (call) => {
      inbound.push(call);
    });

    // Connecting registers the Stasis app under the default name 'roza'.
    expect(fake.start).toHaveBeenCalledWith('roza');

    const channel = new FakeChannel('inbound-channel-1', { caller: { number: '+15550001111' } });
    fake.emitStasisStart(channel);
    await flush();

    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({
      callId: 'inbound-channel-1',
      callerIdentity: '+15550001111',
      direction: 'inbound',
    });
  });

  it('answer: answering a known inbound call calls the ARI channel answer (Req 4.1)', async () => {
    const gateway = createAsteriskTelephonyGateway({ sip: SIP, connect: fake.connect, logger: spy.logger });
    await gateway.listen(async () => undefined);

    const channel = new FakeChannel('inbound-channel-2', { caller: { number: '+15550002222' } });
    fake.emitStasisStart(channel);
    await flush();

    await gateway.answer('inbound-channel-2');
    expect(channel.answer).toHaveBeenCalledTimes(1);
  });

  it('originate: resolves an outbound CallHandle when the originated channel answers (Req 5.1)', async () => {
    const gateway = createAsteriskTelephonyGateway({ sip: SIP, connect: fake.connect, logger: spy.logger });

    const pending = gateway.originate('+15557654321', { ringTimeoutMs: 1000 });
    await flush();

    // The adapter originated a channel with a self-assigned channelId.
    expect(fake.originate).toHaveBeenCalledTimes(1);
    const params = fake.originate.mock.calls[0]![0];
    const channelId = params.channelId!;
    expect(params.endpoint).toBe('PJSIP/+15557654321');

    // The originated channel entering Stasis (answered) resolves the promise.
    fake.emitStasisStart(new FakeChannel(channelId));
    const handle = await pending;

    expect(handle).toMatchObject({
      callId: channelId,
      callerIdentity: '+15557654321',
      direction: 'outbound',
    });
  });

  it('originate: rejects on ring timeout and hangs up the channel (Req 5.4)', async () => {
    const gateway = createAsteriskTelephonyGateway({ sip: SIP, connect: fake.connect, logger: spy.logger });

    // No StasisStart is emitted, so the ring-timeout timer must fire.
    const pending = gateway.originate('+15550009999', { ringTimeoutMs: 30 });

    await expect(pending).rejects.toThrow(/ring timeout/i);

    expect(fake.hangup).toHaveBeenCalledTimes(1);
    expect(fake.hangup).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'ring_timeout' }),
    );
  });

  it('StasisEnd and ChannelDestroyed each trigger the onCallEnded handler (Req 4.6)', async () => {
    const ended: Array<{ callId: string; reason: string }> = [];
    const gateway = createAsteriskTelephonyGateway({ sip: SIP, connect: fake.connect, logger: spy.logger });
    gateway.onCallEnded((callId, reason) => ended.push({ callId, reason }));
    await gateway.listen(async () => undefined);

    // StasisEnd path.
    const chA = new FakeChannel('ended-via-stasis-end', { caller: { number: '+15551110000' } });
    fake.emitStasisStart(chA);
    fake.emitStasisEnd(chA);

    // ChannelDestroyed path with a cause string used as the reason.
    const chB = new FakeChannel('ended-via-destroyed', { caller: { number: '+15552220000' } });
    fake.emitStasisStart(chB);
    fake.emitChannelDestroyed(chB, { cause_txt: 'Normal Clearing' });

    expect(ended).toEqual([
      { callId: 'ended-via-stasis-end', reason: 'stasis_end' },
      { callId: 'ended-via-destroyed', reason: 'Normal Clearing' },
    ]);
  });

  it('never writes any SIP credential value to a log line across the call lifecycle (Req 7.4)', async () => {
    const gateway = createAsteriskTelephonyGateway({ sip: SIP, connect: fake.connect, logger: spy.logger });

    // Exercise the logging-heavy paths: connect/listen, inbound, answer, hangup,
    // and a ring-timeout origination.
    await gateway.listen(async () => undefined);

    const channel = new FakeChannel('lifecycle-channel', { caller: { number: '+15553334444' } });
    fake.emitStasisStart(channel);
    await flush();
    await gateway.answer('lifecycle-channel');
    await gateway.hangup('lifecycle-channel', 'done');

    await expect(
      gateway.originate('+15558887777', { ringTimeoutMs: 20 }),
    ).rejects.toThrow(/ring timeout/i);

    // The logger received output...
    expect(spy.lines.length).toBeGreaterThan(0);
    // ...but no line contains any SIP credential value.
    for (const line of spy.lines) {
      expect(line).not.toContain(CREDENTIAL_SENTINEL);
      expect(line).not.toContain(SIP.password);
      expect(line).not.toContain(SIP.user);
      expect(line).not.toContain(SIP.realm);
      expect(line).not.toContain(SIP.host);
    }
  });
});
