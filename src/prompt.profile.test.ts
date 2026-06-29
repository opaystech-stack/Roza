import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildMessages, type PromptContext } from './prompt.js';
import { buildPersona } from './persona.js';
import {
  telegramSenderIdentity,
  mailSenderIdentity,
} from './connectors/connector.js';
import {
  DEFAULT_PROFILE,
  validateProfile,
  type ProfileLang,
  type RozaProfile,
} from './profile.js';
import type { HumanRelationship, Message } from './types.js';
import type { Lang, TaughtTerm } from './language.js';

/**
 * Property 15 — System_Prompt and channel identities are derived from the profile.
 *
 * For ANY loaded Roza_Profile, the constructed System_Prompt incorporates the
 * profile's display name, role titles, native/learnable languages, and persona
 * parameters (Req 3.1, 3.4); the Telegram sender identity equals the profile's
 * Telegram identity field and the Mail sender identity equals the profile's
 * email identity field (Req 3.2, 3.3, 6.5); and exactly one target response
 * language directive (French XOR English) is still produced, preserving the
 * Phase 1 language behavior unchanged.
 *
 * Generators
 *
 * Every profile text field that is substring-checked is a fixed-length,
 * prefix-tagged sentinel token with NO whitespace, so inclusion assertions are
 * unambiguous and distinct same-length tokens can never be a substring of one
 * another. Distinct prefixes keep the display name, role titles, and persona
 * parameters from colliding across the System_Prompt.
 */

/** A 13-char token `<prefix><12 hex>` — unique per draw, never a substring of a sibling, no whitespace. */
function token(prefix: string): fc.Arbitrary<string> {
  return fc.hexaString({ minLength: 12, maxLength: 12 }).map((h) => prefix + h);
}

/** ISO timestamp built from a bounded epoch so `toISOString()` never throws. */
const isoTimestampArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 4_102_444_800_000 })
  .map((n) => new Date(n).toISOString());

/**
 * An arbitrary VALID RozaProfile (passes {@link validateProfile}). Distinctive
 * tokens are used for the display name, role titles, persona tone/humor/
 * formality, the Telegram/email identities, the avatar path, and the timezone
 * ref so they can be substring-checked. Native languages always include fr+en
 * and learnable languages always include sw+ln, exercising the bilingual hooks.
 */
const validProfileArb: fc.Arbitrary<RozaProfile> = fc
  .record({
    displayName: token('D'),
    roleTitles: fc.uniqueArray(token('R'), { minLength: 1, maxLength: 4 }),
    nativeLanguages: fc.constantFrom<ProfileLang[]>(['fr', 'en'], ['en', 'fr']),
    learnableLanguages: fc.constantFrom<ProfileLang[]>(['sw', 'ln'], ['ln', 'sw']),
    tone: token('O'),
    humor: token('H'),
    formality: token('F'),
    telegramIdentity: token('T'),
    emailLocal: token('E'),
    avatarAssetPath: token('A'),
    timezoneRef: token('Z'),
  })
  .map((r) => ({
    displayName: r.displayName,
    roleTitles: r.roleTitles,
    nativeLanguages: r.nativeLanguages,
    learnableLanguages: r.learnableLanguages,
    persona: { tone: r.tone, humor: r.humor, formality: r.formality },
    telegramIdentity: r.telegramIdentity,
    emailIdentity: `${r.emailLocal}@example.com`,
    avatarAssetPath: r.avatarAssetPath,
    workingHours: { timezoneRef: r.timezoneRef },
  }));

const relationshipArb: fc.Arbitrary<HumanRelationship> = fc.record({
  id: fc.uuid(),
  user_id: fc.uuid(),
  full_name: fc.option(token('N'), { nil: null }),
  role: fc.option(token('L'), { nil: null }),
  affinity_score: fc.double({ min: 0, max: 1, noNaN: true }),
  personality_notes: fc.string(),
  last_language: fc.constantFrom<Lang | null>('fr', 'en', null),
  last_interaction: fc.option(isoTimestampArb, { nil: null }),
});

const recentMessagesArb: fc.Arbitrary<Message[]> = fc.uniqueArray(
  fc.record({
    id: fc.uuid(),
    conversation_id: fc.uuid(),
    sender_type: fc.constantFrom('user', 'roza') as fc.Arbitrary<Message['sender_type']>,
    content: token('M'),
    created_at: isoTimestampArb,
  }),
  { selector: (m) => m.content, minLength: 0, maxLength: 8 },
);

const taughtTermsArb: fc.Arbitrary<TaughtTerm[]> = fc.uniqueArray(
  fc.record({
    term: token('W'),
    meaning: token('G'),
    lang: fc.constantFrom('sw', 'ln') as fc.Arbitrary<TaughtTerm['lang']>,
  }),
  { selector: (t) => t.term, minLength: 0, maxLength: 8 },
);

const contextArb: fc.Arbitrary<PromptContext> = fc.record({
  profile: validProfileArb,
  relationship: relationshipArb,
  recentMessages: recentMessagesArb,
  taughtTerms: taughtTermsArb,
  targetLanguage: fc.constantFrom<Lang>('fr', 'en'),
});

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('prompt — profile-derived System_Prompt and channel identities', () => {
  // Feature: roza-step2-channels, Property 15: System_Prompt and channel identities are derived from the profile
  // Validates: Requirements 3.1, 3.2, 3.3, 3.4, 6.5
  it('Property 15: the System_Prompt incorporates the profile and exactly one language directive is produced', () => {
    fc.assert(
      fc.property(contextArb, fc.string(), (ctx, userMessage) => {
        // The generated profile must itself be valid (sanity on the generator).
        expect(validateProfile(ctx.profile).ok).toBe(true);

        const messages = buildMessages(ctx, userMessage);
        expect(messages.length).toBe(2);
        const systemMessage = messages[0];
        if (!systemMessage) {
          throw new Error('buildMessages must return a leading system message');
        }
        const system = systemMessage.content;
        const profile = ctx.profile;

        // The System_Prompt incorporates the profile's display name (Req 3.1).
        expect(system).toContain(profile.displayName);

        // ...each role title (Req 3.1).
        for (const role of profile.roleTitles) {
          expect(system).toContain(role);
        }

        // ...and the persona tone/humor/formality parameters (Req 3.1, 3.4).
        expect(system).toContain(profile.persona.tone);
        expect(system).toContain(profile.persona.humor);
        expect(system).toContain(profile.persona.formality);

        // Native (fr/en) and learnable (sw/ln) languages render by name (Req 3.4).
        expect(system).toContain('French');
        expect(system).toContain('English');
        expect(system).toContain('Swahili');
        expect(system).toContain('Lingala');

        // Phase 1 behavior preserved: exactly one directive naming exactly the
        // resolved target language, French XOR English (Req 7.5).
        const marker = 'LANGUAGE DIRECTIVE:';
        expect(countOccurrences(system, marker)).toBe(1);
        const directiveLine = system.split('\n').find((line) => line.includes(marker));
        expect(directiveLine).toBeDefined();
        const expectedLabel = ctx.targetLanguage === 'fr' ? 'French' : 'English';
        const otherLabel = ctx.targetLanguage === 'fr' ? 'English' : 'French';
        expect(directiveLine).toContain(expectedLabel);
        expect(directiveLine).not.toContain(otherLabel);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: roza-step2-channels, Property 15: System_Prompt and channel identities are derived from the profile
  // Validates: Requirements 3.2, 3.3, 6.5
  it('Property 15: channel sender identities equal the profile identity fields', () => {
    fc.assert(
      fc.property(validProfileArb, (profile) => {
        expect(telegramSenderIdentity(profile)).toBe(profile.telegramIdentity);
        expect(mailSenderIdentity(profile)).toBe(profile.emailIdentity);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: roza-step2-channels, Property 15: System_Prompt and channel identities are derived from the profile
  // Validates: Requirements 3.4
  it('Property 15: buildPersona renders native/learnable language names for the default profile', () => {
    const persona = buildPersona(DEFAULT_PROFILE);
    // Native fr/en and learnable sw/ln render by their prose names.
    expect(persona).toContain('French');
    expect(persona).toContain('English');
    expect(persona).toContain('Swahili');
    expect(persona).toContain('Lingala');
    // Default identity fields are carried through to the channel derivations.
    expect(telegramSenderIdentity(DEFAULT_PROFILE)).toBe(DEFAULT_PROFILE.telegramIdentity);
    expect(mailSenderIdentity(DEFAULT_PROFILE)).toBe(DEFAULT_PROFILE.emailIdentity);
  });
});
