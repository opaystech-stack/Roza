// Feature: roza-step3-voice-telephony, Property 9: Graceful degradation transitions
//
// Validates: Requirements 2.6, 4.6, 9.1, 9.2, 9.3, 9.4
//
// Property 9 asserts that the pure Call_Session reducer `transition(state, event)`
// degrades gracefully: it is total (never throws, always returns a valid result),
// and it NEVER silently terminates a call without emitting a teardown/log effect.
// Concretely, driving arbitrary (CallState, CallEvent) pairs through `transition`:
//   1. Totality — for every one of the 8 states and every event in the full union
//      (including `transcript`/`reply` carrying arbitrary text), `transition`
//      returns `{ next, effects }` where `next` is a valid `CallState` and
//      `effects` is an array; it never throws (Req 4.6, 9.1).
//   2. STT failure (`stt_failed` while `transcribing`) stays in-call (`listening`)
//      with a per-turn `sttFallback` effect and no service-terminating effect
//      (Req 9.2).
//   3. TTS failure (`tts_failed` while `speaking`) emits `ttsRetryThenText`, never
//      a service-terminating effect, and never lands in `ended` (Req 2.6, 9.3).
//   4. Engine failure (`engine_failed` while `thinking`) plays no reply this turn —
//      no `play` and no `synthesize` effect — and returns to `listening` (Req 9.4).
//   5. A `hangup` or `drop` from ANY active (non-`ended`) state moves toward
//      teardown (`tearing_down` or `ended`) AND emits `releaseResources` — never a
//      silent terminate (Req 4.6, 9.1).
//   6. Reaching `ended` from a non-`ended` state always carries a `releaseResources`
//      effect on that transition (Req 4.6, 9.1).

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  transition,
  type CallState,
  type CallEvent,
  type CallEffect,
  type TransitionResult,
} from './voiceConnector.js';

/** The complete set of valid Call_Session states (mirrors the `CallState` union). */
const ALL_STATES: readonly CallState[] = [
  'ringing',
  'answered',
  'listening',
  'transcribing',
  'thinking',
  'speaking',
  'tearing_down',
  'ended',
];
const STATE_SET = new Set<CallState>(ALL_STATES);

/**
 * Effects that terminate the Call_Session / release the service for that call.
 * The degradation paths (STT/TTS/engine failure) must never emit one of these.
 */
const TERMINATING_KINDS = new Set<CallEffect['kind']>(['releaseResources', 'reject']);

/** Generator over every valid `CallState`. */
const callStateArb: fc.Arbitrary<CallState> = fc.constantFrom(...ALL_STATES);

/**
 * Generator over the FULL `CallEvent` union, with `transcript`/`reply` carrying
 * arbitrary (untrusted) text — including empty strings and odd unicode.
 */
const callEventArb: fc.Arbitrary<CallEvent> = fc.oneof(
  fc.constant<CallEvent>({ kind: 'allowed' }),
  fc.constant<CallEvent>({ kind: 'rejected' }),
  fc.constant<CallEvent>({ kind: 'answered' }),
  fc.constant<CallEvent>({ kind: 'turn_end' }),
  fc.string().map<CallEvent>((text) => ({ kind: 'transcript', text })),
  fc.constant<CallEvent>({ kind: 'stt_failed' }),
  fc.string().map<CallEvent>((text) => ({ kind: 'reply', text })),
  fc.constant<CallEvent>({ kind: 'engine_failed' }),
  fc.constant<CallEvent>({ kind: 'tts_ok' }),
  fc.constant<CallEvent>({ kind: 'tts_failed' }),
  fc.constant<CallEvent>({ kind: 'played' }),
  fc.constant<CallEvent>({ kind: 'hangup' }),
  fc.constant<CallEvent>({ kind: 'drop' }),
);

/** True iff `result.effects` contains an effect of the given kind. */
function hasEffect(result: TransitionResult, kind: CallEffect['kind']): boolean {
  return result.effects.some((e) => e.kind === kind);
}

/** True iff `result.effects` contains any service-terminating effect. */
function hasTerminatingEffect(result: TransitionResult): boolean {
  return result.effects.some((e) => TERMINATING_KINDS.has(e.kind));
}

describe('transition totality (Property 9)', () => {
  it('never throws and always returns a valid CallState and an effects array', () => {
    fc.assert(
      fc.property(callStateArb, callEventArb, (state, event) => {
        const result = transition(state, event);
        expect(STATE_SET.has(result.next)).toBe(true);
        expect(Array.isArray(result.effects)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('is deterministic: identical inputs yield identical outputs', () => {
    fc.assert(
      fc.property(callStateArb, callEventArb, (state, event) => {
        expect(transition(state, event)).toEqual(transition(state, event));
      }),
      { numRuns: 200 },
    );
  });
});

describe('STT failure degradation (Property 9, Req 9.2)', () => {
  it('stt_failed while transcribing stays in-call with a per-turn sttFallback and no terminating effect', () => {
    fc.assert(
      fc.property(fc.constant<CallEvent>({ kind: 'stt_failed' }), (event) => {
        const result = transition('transcribing', event);
        expect(result.next).toBe<CallState>('listening');
        expect(hasEffect(result, 'sttFallback')).toBe(true);
        expect(hasTerminatingEffect(result)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

describe('TTS failure degradation (Property 9, Req 2.6, 9.3)', () => {
  it('tts_failed while speaking emits ttsRetryThenText, never terminates, and never ends the call', () => {
    fc.assert(
      fc.property(fc.constant<CallEvent>({ kind: 'tts_failed' }), (event) => {
        const result = transition('speaking', event);
        expect(hasEffect(result, 'ttsRetryThenText')).toBe(true);
        expect(hasTerminatingEffect(result)).toBe(false);
        expect(result.next).not.toBe<CallState>('ended');
      }),
      { numRuns: 100 },
    );
  });
});

describe('engine failure degradation (Property 9, Req 9.4)', () => {
  it('engine_failed while thinking plays no reply (no play, no synthesize) and returns to listening', () => {
    fc.assert(
      fc.property(fc.constant<CallEvent>({ kind: 'engine_failed' }), (event) => {
        const result = transition('thinking', event);
        expect(result.next).toBe<CallState>('listening');
        expect(hasEffect(result, 'play')).toBe(false);
        expect(hasEffect(result, 'synthesize')).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

describe('teardown is never silent (Property 9, Req 4.6, 9.1)', () => {
  it('hangup or drop from any active (non-ended) state moves toward teardown and releases resources', () => {
    const activeStateArb = fc.constantFrom(
      ...ALL_STATES.filter((s) => s !== 'ended'),
    );
    const teardownEventArb = fc.constantFrom<CallEvent>(
      { kind: 'hangup' },
      { kind: 'drop' },
    );
    fc.assert(
      fc.property(activeStateArb, teardownEventArb, (state, event) => {
        const result = transition(state, event);
        // Moves toward teardown — either releasing or already released.
        expect(['tearing_down', 'ended']).toContain(result.next);
        // Always emits a resource-release effect — never a silent terminate.
        expect(hasEffect(result, 'releaseResources')).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

describe('reaching ended always releases resources (Property 9, Req 4.6, 9.1)', () => {
  it('any transition from a non-ended state into ended carries a releaseResources effect', () => {
    fc.assert(
      fc.property(callStateArb, callEventArb, (state, event) => {
        const result = transition(state, event);
        if (state !== 'ended' && result.next === 'ended') {
          expect(hasEffect(result, 'releaseResources')).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('never silently terminates: any transition into ended also emits some effect', () => {
    fc.assert(
      fc.property(callStateArb, callEventArb, (state, event) => {
        const result = transition(state, event);
        if (state !== 'ended' && result.next === 'ended') {
          expect(result.effects.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 500 },
    );
  });
});
