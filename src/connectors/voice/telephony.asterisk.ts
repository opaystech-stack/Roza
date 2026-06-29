/**
 * TelephonyGateway interface + Asterisk ARI/AudioSocket adapter (Component V7) —
 * Req 4.1, 4.6, 5.1, 5.4, 6.1, 6.2, 6.3, 6.4, 7.4, 9.1, 11.4.
 *
 * The {@link TelephonyGateway} is the single control-plane surface the
 * Voice_Connector uses to place, answer, feed audio to, and tear down calls. It
 * deliberately hides the underlying telephony technology: the only Asterisk
 * specifics live in {@link createAsteriskTelephonyGateway} below, so swapping
 * Asterisk for an embedded JsSIP/WebRTC client later means re-implementing only
 * this file behind the unchanged interface (Req 6.4).
 *
 * The adapter wires `ari-client` (Apache-2.0; Asterisk itself runs as a
 * separate process and is never linked into Roza's code) to a Stasis
 * application:
 *
 * - `StasisStart` → {@link TelephonyGateway.listen}'s `onInboundCall` (for
 *   channels we did not originate) or resolves a pending
 *   {@link TelephonyGateway.originate} (for channels we did) — Req 4.1, 5.1.
 * - `channels.answer` → {@link TelephonyGateway.answer} — Req 4.1.
 * - `channels.originate` with a ring-timeout timer that rejects and hangs up →
 *   {@link TelephonyGateway.originate} — Req 5.1, 5.4.
 * - An External Media / AudioSocket bridge carries RTP audio in/out as
 *   {@link AudioChunk}s in the negotiated {@link AudioFormat}.
 * - `StasisEnd` / `ChannelDestroyed` → {@link TelephonyGateway.onCallEnded} —
 *   Req 4.6, 9.1.
 *
 * Security: the SIP/ARI credentials arrive via injected `deps.sip` (sourced
 * from environment variables by the caller, Req 6.2, 7.1) and are passed only
 * to the ARI transport on connect. They are NEVER written to any log entry
 * (Req 7.4, 11.4). `ari-client`'s own verbose logging is gated by the `debug`
 * module's `DEBUG` environment variable, which this module never sets, so the
 * transport stays silent and cannot echo credentials.
 *
 * Testability: the ARI connection is fully injectable via `deps.connect`
 * (defaulting to `ari-client`'s `connect`), so tests substitute a mock client
 * and no real Asterisk, SIP, or RTP runs in CI (Req 14.5).
 */

import { randomUUID } from 'node:crypto';
import { connect as ariClientConnect } from 'ari-client';
import type { Logger } from '../../types.js';
import { type AudioChunk, type AudioFormat, isCompatible, TELEPHONY_PCM_8K } from './audio.js';

/**
 * Default ARI connect, adapting `ari-client`'s `connect` to the narrow
 * {@link AriClientLike} surface used here. The real client structurally exceeds
 * that surface, so the cast is safe; tests inject their own `connect` and never
 * reach this path. `ari-client`'s verbose logging is gated by the `debug`
 * module's `DEBUG` env variable, which this module never sets.
 */
const defaultAriConnect: AriConnect = async (baseUrl, user, pass) => {
  const client = await ariClientConnect(baseUrl, user, pass);
  return client as unknown as AriClientLike;
};

/**
 * A live call's stable identity as seen by the Voice_Connector. `callId` is the
 * Asterisk channel id; `callerIdentity` is the remote party (phone number or
 * SIP URI); `direction` records whether Roza received or placed the call.
 */
export interface CallHandle {
  readonly callId: string;
  readonly callerIdentity: string;
  readonly direction: 'inbound' | 'outbound';
}

/**
 * The control-plane surface for telephony. Every voice call is placed,
 * answered, fed audio, and torn down exclusively through this interface, so the
 * concrete telephony technology stays swappable (Req 6.4).
 */
export interface TelephonyGateway {
  /** Begin accepting inbound calls; invoke `onInboundCall` per ringing call (Req 4.1). */
  listen(onInboundCall: (call: CallHandle) => Promise<void>): Promise<void>;
  /** Answer a ringing inbound call and open the Audio_Stream (Req 4.1). */
  answer(callId: string): Promise<void>;
  /** Place an outbound call; resolves on answer, rejects on ring timeout (Req 5.1, 5.4). */
  originate(callerIdentity: string, opts: { ringTimeoutMs: number }): Promise<CallHandle>;
  /** Subscribe to inbound caller audio frames for a call. */
  onAudio(callId: string, onFrame: (chunk: AudioChunk) => void): void;
  /** Play synthesized audio to the caller (Req 4.4). */
  playAudio(callId: string, chunk: AudioChunk): Promise<void>;
  /** Tear down a call and release Audio_Stream resources (Req 4.6, 9.1). */
  hangup(callId: string, reason: string): Promise<void>;
  /** Invoked when a call drops/ends out-of-band (caller hangup, network drop — Req 4.6, 9.1). */
  onCallEnded(handler: (callId: string, reason: string) => void): void;
}

/**
 * Bidirectional media transport over the AudioSocket / External-Media RTP
 * plane for a single call. Audio frames cross this boundary as
 * {@link AudioChunk}s in the negotiated {@link AudioFormat}; the RTP/AudioSocket
 * wire transport itself lives outside this control-plane adapter.
 */
export interface MediaChannel {
  /** Register a callback invoked for each inbound caller frame. */
  onFrame(handler: (chunk: AudioChunk) => void): void;
  /** Send a synthesized frame to the caller. */
  send(chunk: AudioChunk): Promise<void>;
  /** Tear down the media transport and release its resources. */
  close(): Promise<void>;
}

/**
 * Opens the media plane for an answered call. Injectable so tests can supply an
 * in-memory transport; the default keeps frames in process (the real RTP plane
 * is provisioned out of band by the External Media channel below).
 */
export type MediaChannelFactory = (callId: string, format: AudioFormat) => MediaChannel;

/**
 * The injectable ARI connect function. Defaults to `ari-client`'s `connect`;
 * tests pass a stub returning a mock {@link AriClientLike}.
 */
export type AriConnect = (baseUrl: string, user: string, pass: string) => Promise<AriClientLike>;

/** SIP/ARI trunk credentials, supplied via environment variables by the caller (Req 6.2, 7.1). */
export interface SipCredentials {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly realm: string;
}

/** Dependencies for {@link createAsteriskTelephonyGateway}. */
export interface AsteriskTelephonyDeps {
  /** SIP/ARI trunk credentials (env-sourced). Passed only to the transport, never logged. */
  sip: SipCredentials;
  /** Base ARI URL; defaults to `http://<sip.host>:8088`. */
  ariUrl?: string;
  /** Stasis application name; defaults to `roza`. */
  appName?: string;
  /** Injectable ARI connect; defaults to `ari-client`'s `connect`. */
  connect?: AriConnect;
  /** Structured logger; must never receive credentials. */
  logger?: Logger;
  /** Negotiated audio format for the media plane; defaults to 8 kHz narrowband PCM. */
  audioFormat?: AudioFormat;
  /** Injectable media-plane factory; defaults to an in-process transport. */
  createMediaChannel?: MediaChannelFactory;
  /**
   * `host:port` of the AudioSocket / External Media server. When provided, the
   * adapter provisions an ARI External Media channel per call; when omitted the
   * media plane stays in-process (the typical CI/test configuration).
   */
  externalMediaHost?: string;
}

/* --------------------------------------------------------------------------
 * Minimal local ARI surface.
 *
 * `@types/ari-client` models the full ARI with many overloads; we adapt just
 * the bits this adapter uses into narrow structural interfaces so the wiring
 * stays readable and the injected mock in tests is trivial to build.
 * ----------------------------------------------------------------------- */

/** Caller-id snapshot on an ARI channel. */
export interface AriCallerId {
  readonly name?: string;
  readonly number?: string;
}

/** The subset of an ARI channel resource this adapter uses. */
export interface AriChannelLike {
  readonly id: string;
  readonly name?: string;
  readonly caller?: AriCallerId;
  answer(): Promise<void>;
  hangup(params?: { reason?: string }): Promise<void>;
}

/** The subset of ARI's `channels` resource this adapter uses. */
export interface AriChannelsLike {
  originate(params: {
    endpoint: string;
    app?: string;
    appArgs?: string;
    callerId?: string;
    timeout?: number;
    channelId?: string;
  }): Promise<AriChannelLike>;
  hangup(params: { channelId: string; reason?: string }): Promise<void>;
  externalMedia(params: {
    app: string;
    external_host: string;
    format: string;
    channelId?: string;
    encapsulation?: string;
    transport?: string;
    connection_type?: string;
    direction?: string;
  }): Promise<AriChannelLike>;
}

/** Payload shape of an ARI `StasisStart` event (only the fields we read). */
export interface AriStasisStartLike {
  readonly args?: string | string[];
}

/** Payload shape of an ARI `ChannelDestroyed` event (only the fields we read). */
export interface AriChannelDestroyedLike {
  readonly cause_txt?: string;
}

/** The subset of an ARI client this adapter uses. */
export interface AriClientLike {
  on(event: 'StasisStart', listener: (event: AriStasisStartLike, channel: AriChannelLike) => void): void;
  on(event: 'StasisEnd', listener: (event: unknown, channel: AriChannelLike) => void): void;
  on(
    event: 'ChannelDestroyed',
    listener: (event: AriChannelDestroyedLike, channel: AriChannelLike) => void,
  ): void;
  start(apps: string | string[]): Promise<void>;
  stop?(): void;
  channels: AriChannelsLike;
}

/** No-op logger so the gateway works without an injected logger. */
const NO_OP_LOGGER: Logger = {
  info: () => undefined,
  error: () => undefined,
};

/**
 * Map a PCM {@link AudioFormat} to the Asterisk media format token used by the
 * External Media channel: narrowband (8 kHz) → `slin`, wideband (16 kHz) →
 * `slin16`. Both are signed-linear, matching the `pcm_s16le` contract.
 */
function asteriskFormat(format: AudioFormat): string {
  return format.sampleRate === 16000 ? 'slin16' : 'slin';
}

/**
 * Build an ARI endpoint string from a {@link CallHandle.callerIdentity}. A value
 * already in `tech/resource` form (e.g. `PJSIP/alice`) is used verbatim; a bare
 * number or address is dialed over PJSIP against the configured trunk.
 */
function toEndpoint(callerIdentity: string): string {
  return callerIdentity.includes('/') ? callerIdentity : `PJSIP/${callerIdentity}`;
}

/** Default in-process media transport: frames are dispatched to registered handlers. */
function createInProcessMediaChannel(): MediaChannel {
  const handlers: Array<(chunk: AudioChunk) => void> = [];
  let closed = false;
  return {
    onFrame(handler) {
      if (!closed) {
        handlers.push(handler);
      }
    },
    async send() {
      // The real RTP/AudioSocket egress is provisioned by the External Media
      // channel; in-process there is no wire to write to, so this resolves.
    },
    async close() {
      closed = true;
      handlers.length = 0;
    },
  };
}

/** Internal per-call state tracked by the adapter. */
interface CallState {
  readonly handle: CallHandle;
  readonly channel: AriChannelLike;
  media: MediaChannel | null;
  /** Frame handlers registered before the media plane was opened. */
  readonly pendingFrameHandlers: Array<(chunk: AudioChunk) => void>;
  finalized: boolean;
}

/** Internal state for an in-flight outbound origination awaiting answer. */
interface PendingOutbound {
  readonly callerIdentity: string;
  readonly resolve: (handle: CallHandle) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Create an Asterisk-backed {@link TelephonyGateway}.
 *
 * The returned gateway connects lazily on the first {@link TelephonyGateway.listen}
 * or {@link TelephonyGateway.originate} call, registers the Stasis event
 * handlers, and exposes the control-plane operations. All Asterisk specifics are
 * confined here (Req 6.4).
 */
export function createAsteriskTelephonyGateway(deps: AsteriskTelephonyDeps): TelephonyGateway {
  const logger = deps.logger ?? NO_OP_LOGGER;
  const appName = deps.appName ?? 'roza';
  const audioFormat = deps.audioFormat ?? TELEPHONY_PCM_8K;
  const ariUrl = deps.ariUrl ?? `http://${deps.sip.host}:8088`;
  const connect = deps.connect ?? defaultAriConnect;
  const createMediaChannel = deps.createMediaChannel ?? (() => createInProcessMediaChannel());

  const calls = new Map<string, CallState>();
  const pendingOutbound = new Map<string, PendingOutbound>();
  const callEndedHandlers: Array<(callId: string, reason: string) => void> = [];
  let inboundHandler: ((call: CallHandle) => Promise<void>) | null = null;

  let clientPromise: Promise<AriClientLike> | null = null;

  /** Connect once and register the Stasis event handlers. Memoized. */
  function ensureClient(): Promise<AriClientLike> {
    if (clientPromise === null) {
      clientPromise = (async () => {
        // Credentials are handed only to the transport here — never logged.
        const client = await connect(ariUrl, deps.sip.user, deps.sip.password);
        registerHandlers(client);
        await client.start(appName);
        logger.info('telephony.ari.connected', { app: appName });
        return client;
      })().catch((err: unknown) => {
        clientPromise = null;
        logger.error('telephony.ari.connect_failed', { error: errorMessage(err) });
        throw err instanceof Error ? err : new Error(String(err));
      });
    }
    return clientPromise;
  }

  /** Wire the Stasis lifecycle events to the gateway callbacks. */
  function registerHandlers(client: AriClientLike): void {
    client.on('StasisStart', (_event, channel) => {
      const pending = pendingOutbound.get(channel.id);
      if (pending) {
        // Our originated channel was answered (Req 5.1).
        clearTimeout(pending.timer);
        pendingOutbound.delete(channel.id);
        const handle: CallHandle = {
          callId: channel.id,
          callerIdentity: pending.callerIdentity,
          direction: 'outbound',
        };
        calls.set(channel.id, newCallState(handle, channel));
        pending.resolve(handle);
        logger.info('telephony.call.answered', { callId: channel.id, direction: 'outbound' });
        return;
      }
      // An inbound call is ringing (Req 4.1).
      const handle: CallHandle = {
        callId: channel.id,
        callerIdentity: channel.caller?.number || channel.id,
        direction: 'inbound',
      };
      calls.set(channel.id, newCallState(handle, channel));
      logger.info('telephony.call.inbound', { callId: handle.callId, callerIdentity: handle.callerIdentity });
      const handler = inboundHandler;
      if (handler) {
        handler(handle).catch((err: unknown) => {
          logger.error('telephony.inbound.handler_failed', {
            callId: handle.callId,
            error: errorMessage(err),
          });
        });
      }
    });

    client.on('StasisEnd', (_event, channel) => {
      finalizeCall(channel.id, 'stasis_end', true);
    });

    client.on('ChannelDestroyed', (event, channel) => {
      finalizeCall(channel.id, event?.cause_txt || 'channel_destroyed', true);
    });
  }

  function newCallState(handle: CallHandle, channel: AriChannelLike): CallState {
    return { handle, channel, media: null, pendingFrameHandlers: [], finalized: false };
  }

  /**
   * Open the media plane for a call on first use: build the in-process transport,
   * drain any frame handlers registered before answer, and (when an AudioSocket
   * host is configured) provision the ARI External Media channel.
   */
  function ensureMedia(state: CallState): MediaChannel {
    if (state.media) {
      return state.media;
    }
    const media = createMediaChannel(state.handle.callId, audioFormat);
    state.media = media;
    for (const handler of state.pendingFrameHandlers) {
      media.onFrame(handler);
    }
    state.pendingFrameHandlers.length = 0;

    const host = deps.externalMediaHost;
    if (host) {
      void ensureClient()
        .then((client) =>
          client.channels.externalMedia({
            app: appName,
            external_host: host,
            format: asteriskFormat(audioFormat),
          }),
        )
        .then(() => {
          logger.info('telephony.media.bridged', { callId: state.handle.callId });
        })
        .catch((err: unknown) => {
          logger.error('telephony.media.bridge_failed', {
            callId: state.handle.callId,
            error: errorMessage(err),
          });
        });
    }
    return media;
  }

  /**
   * Idempotently end a call: close its media plane, drop its state, and — when
   * `notify` is set (out-of-band drops) — fire the `onCallEnded` handlers exactly
   * once (Req 4.6, 9.1). A second call for the same id is a no-op.
   */
  function finalizeCall(callId: string, reason: string, notify: boolean): void {
    const state = calls.get(callId);
    if (!state || state.finalized) {
      return;
    }
    state.finalized = true;
    calls.delete(callId);
    if (state.media) {
      void state.media.close().catch((err: unknown) => {
        logger.error('telephony.media.close_failed', { callId, error: errorMessage(err) });
      });
    }
    if (notify) {
      logger.info('telephony.call.ended', { callId, reason });
      for (const handler of callEndedHandlers) {
        try {
          handler(callId, reason);
        } catch (err: unknown) {
          logger.error('telephony.call_ended.handler_failed', { callId, error: errorMessage(err) });
        }
      }
    }
  }

  return {
    async listen(onInboundCall) {
      inboundHandler = onInboundCall;
      await ensureClient();
      logger.info('telephony.listening', { app: appName });
    },

    async answer(callId) {
      const state = calls.get(callId);
      if (!state) {
        throw new Error(`telephony.answer: unknown call ${callId}`);
      }
      await state.channel.answer();
      ensureMedia(state);
      logger.info('telephony.call.answered', { callId, direction: state.handle.direction });
    },

    async originate(callerIdentity, opts) {
      const client = await ensureClient();
      const callId = randomUUID();
      return new Promise<CallHandle>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingOutbound.delete(callId);
          // Ring timeout: terminate the attempt and release resources (Req 5.4).
          void client.channels
            .hangup({ channelId: callId, reason: 'ring_timeout' })
            .catch(() => undefined);
          logger.info('telephony.originate.ring_timeout', { callId, callerIdentity });
          reject(new Error(`telephony.originate: ring timeout for ${callerIdentity}`));
        }, opts.ringTimeoutMs);

        pendingOutbound.set(callId, { callerIdentity, resolve, reject, timer });

        client.channels
          .originate({
            endpoint: toEndpoint(callerIdentity),
            app: appName,
            callerId: deps.sip.user,
            timeout: Math.ceil(opts.ringTimeoutMs / 1000),
            channelId: callId,
          })
          .catch((err: unknown) => {
            const pending = pendingOutbound.get(callId);
            if (pending) {
              clearTimeout(pending.timer);
              pendingOutbound.delete(callId);
            }
            logger.error('telephony.originate.failed', { callId, callerIdentity, error: errorMessage(err) });
            reject(err instanceof Error ? err : new Error(String(err)));
          });
      });
    },

    onAudio(callId, onFrame) {
      const state = calls.get(callId);
      if (!state) {
        throw new Error(`telephony.onAudio: unknown call ${callId}`);
      }
      if (state.media) {
        state.media.onFrame(onFrame);
      } else {
        state.pendingFrameHandlers.push(onFrame);
      }
    },

    async playAudio(callId, chunk) {
      const state = calls.get(callId);
      if (!state) {
        throw new Error(`telephony.playAudio: unknown call ${callId}`);
      }
      if (!isCompatible(chunk.format, audioFormat)) {
        throw new Error('telephony.playAudio: incompatible audio format');
      }
      const media = ensureMedia(state);
      await media.send(chunk);
    },

    async hangup(callId, reason) {
      const state = calls.get(callId);
      if (!state) {
        // Already gone (e.g. caller hung up first) — nothing to release.
        return;
      }
      try {
        await state.channel.hangup({ reason });
      } catch (err: unknown) {
        logger.error('telephony.hangup.failed', { callId, error: errorMessage(err) });
      } finally {
        // We initiated this teardown, so release locally without re-notifying;
        // the resulting StasisEnd/ChannelDestroyed becomes a no-op.
        finalizeCall(callId, reason, false);
      }
    },

    onCallEnded(handler) {
      callEndedHandlers.push(handler);
    },
  };
}

/** Extract a safe, credential-free message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
