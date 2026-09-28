import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { seededRandom } from '../schedule/random.js';
import {
  AgentSeatConfigSchema,
  AvatarSeedSchema,
  MANAGER_FIRST_NAMES,
  MANAGER_LAST_NAMES,
  MANAGER_NAME_MAX,
  MAX_RANDOM_SEATS,
  ManagerNameSchema,
  PERSONALITY_IDS,
  PERSONALITY_NICKNAMES,
  effectiveManager,
  randomizeAgentSeats,
  resolveAgentConfig,
  rollAvatarSeed,
  rollManagerName
} from './index.js';

const personalityArb = fc.constantFrom(...PERSONALITY_IDS);

describe('manager name pool', () => {
  it('has distinct names and a nickname list for every personality', () => {
    expect(new Set(MANAGER_FIRST_NAMES).size).toBe(MANAGER_FIRST_NAMES.length);
    expect(new Set(MANAGER_LAST_NAMES).size).toBe(MANAGER_LAST_NAMES.length);
    for (const id of PERSONALITY_IDS) expect(PERSONALITY_NICKNAMES[id].length).toBeGreaterThan(0);
  });

  it('fits the longest possible name within the limit', () => {
    const longest = (xs: readonly string[]) => Math.max(...xs.map((x) => x.length));
    const nick = longest(Object.values(PERSONALITY_NICKNAMES).flat());
    expect(longest(MANAGER_FIRST_NAMES) + nick + longest(MANAGER_LAST_NAMES) + 4).toBeLessThanOrEqual(
      MANAGER_NAME_MAX
    );
  });
});

describe('rollManagerName', () => {
  it('is deterministic, valid, and never returns an avoided name', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.option(personalityArb, { nil: undefined }),
        fc.array(fc.string(), { maxLength: 5 }),
        (seed, personalityId, extra) => {
          const avoid = [...extra, rollManagerName(seededRandom(seed))];
          const opts = personalityId === undefined ? { avoid } : { avoid, personalityId };
          const name = rollManagerName(seededRandom(seed), opts);
          expect(rollManagerName(seededRandom(seed), opts)).toBe(name);
          expect(ManagerNameSchema.safeParse(name).success).toBe(true);
          expect(avoid.map((a) => a.toLowerCase())).not.toContain(name.toLowerCase());
        }
      )
    );
  });

  it('adds personality nicknames some of the time', () => {
    const random = seededRandom('nicknames');
    const names = Array.from({ length: 60 }, () => rollManagerName(random, { personalityId: 'stats-nerd' }));
    expect(names.some((n) => n.includes('"'))).toBe(true);
    expect(names.some((n) => !n.includes('"'))).toBe(true);
  });

  it('still finds a name when almost every pair is taken, and throws when none is left', () => {
    const all = MANAGER_FIRST_NAMES.flatMap((f) => MANAGER_LAST_NAMES.map((l) => `${f} ${l}`));
    const [free, ...taken] = all;
    expect(rollManagerName(seededRandom('x'), { avoid: taken })).toBe(free);
    expect(() => rollManagerName(seededRandom('x'), { avoid: all })).toThrow(RangeError);
  });
});

describe('rollAvatarSeed', () => {
  it('rolls valid, repeatable seeds', () => {
    fc.assert(
      fc.property(fc.string(), (seed) => {
        const avatar = rollAvatarSeed(seededRandom(seed));
        expect(AvatarSeedSchema.safeParse(avatar).success).toBe(true);
        expect(rollAvatarSeed(seededRandom(seed))).toBe(avatar);
      })
    );
  });
});

describe('effectiveManager', () => {
  it('prefers the stored name and avatar', () => {
    expect(effectiveManager({ name: 'Ruth Carter', avatarSeed: 'abc' }, 'k')).toEqual({
      name: 'Ruth Carter',
      avatarSeed: 'abc'
    });
  });

  it('gives a stable, valid default per key', () => {
    fc.assert(
      fc.property(fc.string(), (key) => {
        const manager = effectiveManager(null, key);
        expect(effectiveManager({}, key)).toEqual(manager);
        expect(ManagerNameSchema.safeParse(manager.name).success).toBe(true);
        expect(AvatarSeedSchema.safeParse(manager.avatarSeed).success).toBe(true);
      })
    );
    expect(effectiveManager(null, 'league-1.team-1')).not.toEqual(effectiveManager(null, 'league-1.team-2'));
  });
});

describe('seat config names', () => {
  const base = { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'balanced' } as const;

  it('keeps configs stored without a name or avatar valid', () => {
    expect(AgentSeatConfigSchema.parse(base)).toEqual(base);
  });

  it('trims names and refuses empty, long, or multi-line names and odd avatar seeds', () => {
    expect(AgentSeatConfigSchema.parse({ ...base, name: '  Ana Soto ' }).name).toBe('Ana Soto');
    for (const name of ['', '   ', 'x'.repeat(MANAGER_NAME_MAX + 1), 'Ana\nSoto', 'Ana\u0007']) {
      expect(AgentSeatConfigSchema.safeParse({ ...base, name }).success).toBe(false);
    }
    for (const avatarSeed of ['', 'has space', 'x'.repeat(41)]) {
      expect(AgentSeatConfigSchema.safeParse({ ...base, avatarSeed }).success).toBe(false);
    }
  });

  it('puts the name in the persona prompt and keeps the personality', () => {
    const resolved = resolveAgentConfig({ ...base, name: 'Marcus "Spreadsheet" Hale' });
    expect(resolved.name).toBe('Marcus "Spreadsheet" Hale');
    expect(resolved.prompt.persona).toContain('Your name is Marcus "Spreadsheet" Hale.');
    expect(resolved.prompt.persona).toContain('You play the part of "The Spreadsheet"');
  });

  it('names a stored seat without a name from its manager key', () => {
    const a = resolveAgentConfig(base, { managerKey: 'lg.team-2' });
    expect(a.name).toBe(effectiveManager(null, 'lg.team-2').name);
    expect(a.prompt.persona).toContain(`Your name is ${a.name}.`);
    expect(resolveAgentConfig(base).name).toBe(effectiveManager(null, 'stats-nerd').name);
  });
});

describe('randomizeAgentSeats names', () => {
  it('gives unique, valid names and avatars, deterministically', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_RANDOM_SEATS }),
        fc.string(),
        fc.array(fc.string({ minLength: 1 }), { maxLength: 3 }),
        (count, seed, avoid) => {
          const seats = randomizeAgentSeats(count, seed, avoid);
          expect(randomizeAgentSeats(count, seed, avoid)).toEqual(seats);
          const names = seats.map((s) => (s.name as string).toLowerCase());
          expect(new Set(names).size).toBe(count);
          for (const a of avoid) expect(names).not.toContain(a.trim().toLowerCase());
          for (const s of seats) {
            expect(ManagerNameSchema.safeParse(s.name).success).toBe(true);
            expect(AvatarSeedSchema.safeParse(s.avatarSeed).success).toBe(true);
          }
        }
      )
    );
  });
});
