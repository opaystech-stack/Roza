// Feature: roza-step4-avatar-video, Property 6: Graceful degradation and audio-only fallback
//
// Validates: Requirements 2.7, 2.8, 5.5, 9.1, 9.2, 9.3, 9.4, 10.3, 12.4
//
// Property 6 asserts that the pure Avatar_Connector reducer
// `transition(state, event)` degrades gracefully and is total: it never throws,
// always returns a valid `{ next, effects }`, and it NEVER silently terminates
// the avatar presence (a move into `tearing_down`/`ended` without a
// `releaseResources` effect AND a log). Concretely, driving arbitrary
// (AvatarState, AvatarEvent) pairs — including `device_failed` with both the
// camera and the microphone — through `transition`:
//   1. Totality — for every one of the 8 states and every event in the full
//      union, `transition` returns `{ next, effects }` where `next` is a valid
//      `AvatarState` and `effects` is an array; it never throws, and identical
//      inputs yield identical outputs (Req 9.1, 12.4).
//   2. A `render_failed` (renderer failure / non-zero exit / latency overrun)
//      from ANY active state emits an `audioOnlyFallback` effect plus an error
//      `log` and moves to `audio_only`; the reply is never left blocked
//      (Req 2.7, 2.8, 9.1, 9.2).
//   3. A `device_failed` from ANY active state emits an error `log` that NAMES
//      the failed device plus the `audioOnlyFallback` effect and moves to
//      `audio_only` — a virtual-device fault degrades, it never crashes the
//      connector (Req 5.5, 9.2).
//   4. `activate_failed` / `error` / `deactivate` from ANY active state move
//      toward `ended` via `tearing_down` with a `releaseResources` effect plus
//      a log — teardown is never silent (Req 9.3, 9.4, 10.3).
//   5. In `audio_only`, a `reply` still emits `audioOnlyFallback` so no reply is
//      ever left blocked while degraded (Req 9.2).
//   6. The terminal `ended` state absorbs ANY event defensively: it stays
//      `ended` and emits a single diagnostic log, never re-running teardown.
//   7. Every unmodelled `(state, event)` pair is preserved defensively: the
//      state is unchanged and exactly one diagnostic `info` log is emitted.
//   8. No `(state, event)` ever yields a "silent terminate": any move INTO
//      `tearing_down`/`ended` carries BOTH a `releaseResources` effect and a log
//      (Req 9.3, 9.4, 10.3).

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  transition,
  type AvatarState,
  type AvatarEvent,
  type AvatarEffect,
  type AvatarTransitionResult,
} from './avatarConnector.js';

/** The complete set of valid avatar states (mirrors the `AvatarState` union). */
const ALL_STATES: readonly AvatarState[] = [
  'inactive',
  'activating',
  'idle',
  'rendering',
  'presenting',
  'audio_only',
  'tearing_down',
  'ended',
];
const STATE_SET = new Set<AvatarState>(ALL_STATES);

/**
 * The "active" states: every state that is neither the terminal `ended` nor the
 * transitional `tearing_down`. The degradation/teardown rules in the design are
 * specified to fire "from any active state".
 */
const ACTIVE_STATES: readonly AvatarState[] = ALL_STATES.filter(
  (s) => s !== 'ended' && s !== 'tearing_down',
);

/** Generator over every valid `AvatarState`. */
const avatarStateArb: fc.Arbitrary<AvatarState> = fc.constantFrom(...ALL_STATES);

/** Generator over every active `AvatarState`. */
const activeStateArb: fc.Arbitrary<AvatarState> = fc.constantFrom(...ACTIVE_STATES);

/**
 * Generator over the FULL `AvatarEvent` union, including `device_failed` for
 * BOTH the `camera` and the `microphone` device.
 */
const avatarEventArb: fc.Arbitrary<AvatarEvent> = fc.oneof(
  fc.constant<AvatarEvent>({ kind: 'activate' }),
  fc.constant<AvatarEvent>({ kind: 'activated' }),
  fc.constant<AvatarEvent>({ kind: 'activate_failed' }),
  fc.constantFrom<AvatarEvent>(
    { kind: 'device_failed', device: 'camera' },
    { kind: 'device_failed', device: 'microphone' },
  ),
  fc.constant<AvatarEvent>({ kind: 'reply' }),
  fc.constant<AvatarEvent>({ kind: 'render_ok' }),
  fc.constant<AvatarEvent>({ kind: 'render_failed' }),
  fc.constant<AvatarEvent>({ kind: 'presented' }),
  fc.constant<AvatarEvent>({ kind: 'deactivate' }),
  fc.constant<AvatarEvent>({ kind: 'error' }),
);

/** True iff `result.effects` contains an effect of the given kind. */
function hasEffect(result: AvatarTransitionResult, kind: AvatarEffect['kind']): boolean {
  return result.effects.some((e) => e.kind === kind);
}

/** True iff `result.effects` contains a `log` effect at the given level. */
function hasLog(result: AvatarTransitionResult, level?: 'info' | 'error'): boolean {
  return result.effects.some(
    (e) => e.kind === 'log' && (level === undefined || e.level === level),
  );
}

/** The single diagnostic-log marker the defensive (unmodelled-pair) handler emits. */
function isDefensiveResult(result: AvatarTransitionResult): boolean {
  return (
    result.effects.length === 1 &&
    result.effects[0]!.kind === 'log' &&
    result.effects[0]!.level === 'info' &&
    result.effects[0]!.message.startsWith('unhandled event')
  );
}

describe('transition totality (Property 6)', () => {
  it('never throws and always returns a valid AvatarState and an effects array', () => {
    fc.assert(
      fc.property(avatarStateArb, avatarEventArb, (state, event) => {
        const result = transition(state, event);
        expect(STATE_SET.has(result.next)).toBe(true);
        expect(Array.isArray(result.effects)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('is deterministic: identical inputs yield identical outputs', () => {
    fc.assert(
      fc.property(avatarStateArb, avatarEventArb, (state, event) => {
        expect(transition(state, event)).toEqual(transition(state, event));
      }),
      { numRuns: 200 },
    );
  });

  it('every emitted effect is a valid, well-formed AvatarEffect', () => {
    const EFFECT_KINDS = new Set<AvatarEffect['kind']>([
      'initDevices',
      'render',
      'presentVideo',
      'presentAudio',
      'audioOnlyFallback',
      'releaseResources',
      'log',
    ]);
    fc.assert(
      fc.property(avatarStateArb, avatarEventArb, (state, event) => {
        for (const effect of transition(state, event).effects) {
          expect(EFFECT_KINDS.has(effect.kind)).toBe(true);
          if (effect.kind === 'log') {
            expect(['info', 'error']).toContain(effect.level);
            expect(typeof effect.message).toBe('string');
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('render failure degrades to audio-only (Property 6, Req 2.7, 2.8, 9.1, 9.2)', () => {
  it('render_failed from any active state emits audioOnlyFallback + an error log and moves to audio_only', () => {
    fc.assert(
      fc.property(activeStateArb, (state) => {
        const result = transition(state, { kind: 'render_failed' });
        expect(result.next).toBe<AvatarState>('audio_only');
        expect(hasEffect(result, 'audioOnlyFallback')).toBe(true);
        expect(hasLog(result, 'error')).toBe(true);
        // The reply is never left blocked: it is delivered as audio, never released/torn down.
        expect(hasEffect(result, 'releaseResources')).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});

describe('device failure degrades to audio-only (Property 6, Req 5.5, 9.2)', () => {
  it('device_failed from any active state emits audioOnlyFallback + an error log NAMING the device, moving to audio_only', () => {
    fc.assert(
      fc.property(
        activeStateArb,
        fc.constantFrom<'camera' | 'microphone'>('camera', 'microphone'),
        (state, device) => {
          const result = transition(state, { kind: 'device_failed', device });
          // Degrades, never a terminal crash/teardown.
          expect(result.next).toBe<AvatarState>('audio_only');
          expect(hasEffect(result, 'audioOnlyFallback')).toBe(true);
          expect(hasEffect(result, 'releaseResources')).toBe(false);
          // The error log NAMES the failed device (Req 5.5).
          const errorLog = result.effects.find(
            (e) => e.kind === 'log' && e.level === 'error',
          );
          expect(errorLog).toBeDefined();
          expect(errorLog!.kind === 'log' && errorLog!.message.includes(device)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('teardown is never silent (Property 6, Req 9.3, 9.4, 10.3)', () => {
  it('activate_failed / error / deactivate from any active state move to tearing_down with releaseResources + a log', () => {
    const teardownEventArb = fc.constantFrom<AvatarEvent>(
      { kind: 'activate_failed' },
      { kind: 'error' },
      { kind: 'deactivate' },
    );
    fc.assert(
      fc.property(activeStateArb, teardownEventArb, (state, event) => {
        const result = transition(state, event);
        // Moves toward `ended` via the transitional `tearing_down`.
        expect(result.next).toBe<AvatarState>('tearing_down');
        // Always releases resources and logs — never a silent terminate.
        expect(hasEffect(result, 'releaseResources')).toBe(true);
        expect(hasLog(result)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('NO (state, event) ever yields a silent terminate: any move into tearing_down/ended carries releaseResources + a log', () => {
    fc.assert(
      fc.property(avatarStateArb, avatarEventArb, (state, event) => {
        const result = transition(state, event);
        const movedToTeardown =
          (result.next === 'tearing_down' || result.next === 'ended') && result.next !== state;
        if (movedToTeardown) {
          expect(hasEffect(result, 'releaseResources')).toBe(true);
          expect(hasLog(result)).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe('audio-only never blocks a reply (Property 6, Req 9.2)', () => {
  it('a reply while audio_only still emits audioOnlyFallback and stays audio_only', () => {
    fc.assert(
      fc.property(fc.constant<AvatarEvent>({ kind: 'reply' }), (event) => {
        const result = transition('audio_only', event);
        expect(result.next).toBe<AvatarState>('audio_only');
        expect(hasEffect(result, 'audioOnlyFallback')).toBe(true);
        expect(hasEffect(result, 'releaseResources')).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

describe('terminal state absorbs events defensively (Property 6)', () => {
  it('the ended state stays ended for ANY event and emits a single diagnostic log', () => {
    fc.assert(
      fc.property(avatarEventArb, (event) => {
        const result = transition('ended', event);
        expect(result.next).toBe<AvatarState>('ended');
        expect(isDefensiveResult(result)).toBe(true);
        // Never re-runs teardown from the terminal state.
        expect(hasEffect(result, 'releaseResources')).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

describe('unmodelled pairs are preserved defensively (Property 6)', () => {
  it('every defensive result preserves the state unchanged with exactly one info log', () => {
    fc.assert(
      fc.property(avatarStateArb, avatarEventArb, (state, event) => {
        const result = transition(state, event);
        if (isDefensiveResult(result)) {
          // State is preserved unchanged and only the single diagnostic log is emitted.
          expect(result.next).toBe(state);
          expect(result.effects.length).toBe(1);
          // A defensive (unmodelled) pair never does real work or tears down.
          expect(hasEffect(result, 'releaseResources')).toBe(false);
          expect(hasEffect(result, 'audioOnlyFallback')).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });
});
