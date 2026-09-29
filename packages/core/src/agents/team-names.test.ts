import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AGENT_TEAM_NAME,
  PERSONALITIES,
  REBRAND_PROMPTS,
  REBRAND_RULES,
  agentMayRename,
  clinchedPlayoffSpot,
  isGenericTeamName,
  losingStreak,
  rebrandOccasion,
  rebrandRoll,
  rebrandWindow,
  teamNameIssue,
  teamNameKey
} from './index.js';

const context = {
  self: { managerName: 'Marcus Hale' },
  others: [
    { name: 'Big Tuna', managerName: 'Allen' },
    { name: 'Team 4', managerName: 'Priya Okafor' },
    { name: 'Open Seat', managerName: null }
  ]
};

describe('isGenericTeamName', () => {
  it('flags placeholders and the manager-name defaults', () => {
    for (const name of ['Team 3', 'team  12', 'TEAM #7', 'Team No. 2', '', '   ', 'Team', "Allen's Team"]) {
      expect(isGenericTeamName(name), name).toBe(true);
    }
    expect(isGenericTeamName('marcus hale', { managerName: 'Marcus Hale' })).toBe(true);
    expect(isGenericTeamName('Team Marcus Hale', { managerName: 'Marcus Hale' })).toBe(true);
    expect(isGenericTeamName("Marcus Hale's Team", { managerName: 'Marcus Hale' })).toBe(true);
  });

  it('leaves real names alone', () => {
    for (const name of ['Big Tuna', 'Regression to the Mean', 'Team Chaos Theory', 'Teams of Destiny']) {
      expect(isGenericTeamName(name, { managerName: 'Marcus Hale' }), name).toBe(false);
    }
    expect(isGenericTeamName('Marcus Hale', { managerName: null })).toBe(false);
  });

  it('is true for every Team N and <manager>’s Team (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000 }), (n) => isGenericTeamName(`Team ${n}`)),
      { numRuns: 200 }
    );
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Z][a-z]{1,10}( [A-Z][a-z]{1,10})?$/), (manager) =>
        isGenericTeamName(`${manager}'s Team`, { managerName: manager })
      ),
      { numRuns: 200 }
    );
  });

  it('is never true for a name an agent may pick (property)', () => {
    const word = fc.stringMatching(/^[A-Z][a-z]{2,8}$/);
    fc.assert(
      fc.property(fc.array(word, { minLength: 2, maxLength: 3 }), (words) => {
        const name = words.join(' ');
        return teamNameIssue(name, context) !== null || !isGenericTeamName(name, context.self);
      }),
      { numRuns: 300 }
    );
    for (const p of PERSONALITIES) {
      for (const name of [p.teamNameSuggestion, ...p.teamNameIdeas]) {
        expect(teamNameIssue(name, context), `${p.id}: ${name}`).toBeNull();
      }
    }
  });
});

describe('teamNameIssue', () => {
  it('accepts a good name', () => {
    expect(teamNameIssue('  Regression to the Mean ', context)).toBeNull();
  });

  it('enforces the length on one line', () => {
    expect(teamNameIssue('Ab', context)?.code).toBe('length');
    expect(teamNameIssue('x'.repeat(AGENT_TEAM_NAME.max + 1), context)?.code).toBe('length');
    expect(teamNameIssue('Two\nLines', context)?.code).toBe('length');
  });

  it('refuses placeholders, taken names, and other managers’ names', () => {
    expect(teamNameIssue('Team 9', context)).toMatchObject({ code: 'generic' });
    expect(teamNameIssue('big  TUNA', context)).toMatchObject({ code: 'taken' });
    expect(teamNameIssue('Priya Okafor Fan Club', context)).toMatchObject({ code: 'impersonation' });
    expect(teamNameIssue("Allen's Nightmare", context)).toMatchObject({ code: 'impersonation' });
    // A manager name inside another word is not that manager.
    expect(teamNameIssue('Gallen Gridiron', context)).toBeNull();
  });

  it('blocks slurs and strong profanity, even disguised', () => {
    expect(teamNameIssue('Sh1t Show Offense', context)).toMatchObject({ code: 'blocked' });
    expect(teamNameIssue('Kill Yourself FC', context)).toMatchObject({ code: 'blocked' });
    const issue = teamNameIssue('Fuck Around Find Out', context);
    expect(issue?.code).toBe('blocked');
    expect(issue?.fix).toMatch(/Wordplay/);
  });

  it('normalizes keys like sameTeamName', () => {
    expect(teamNameKey('  The   Champs ')).toBe('the champs');
  });
});

describe('agentMayRename', () => {
  it('respects the seat toggle and a commissioner-locked name', () => {
    expect(agentMayRename(undefined, undefined)).toBe(true);
    expect(agentMayRename({}, 'default')).toBe(true);
    expect(agentMayRename({ namesTeam: true }, 'agent')).toBe(true);
    expect(agentMayRename({ namesTeam: false }, 'default')).toBe(false);
    expect(agentMayRename({ namesTeam: true }, 'commissioner')).toBe(false);
  });
});

describe('rebrand gate', () => {
  it('opens only in the regular season, once per cooldown', () => {
    expect(rebrandWindow({ phase: 'regular_season', week: 6, lastRenameWeek: null })).toBe('ok');
    expect(rebrandWindow({ phase: 'regular_season', week: 6, lastRenameWeek: 3 })).toBe('cooldown');
    expect(
      rebrandWindow({ phase: 'regular_season', week: 3 + REBRAND_RULES.cooldownWeeks, lastRenameWeek: 3 })
    ).toBe('ok');
    for (const phase of ['setup', 'drafting', 'playoffs', 'complete']) {
      expect(rebrandWindow({ phase, week: 16, lastRenameWeek: null })).toBe('phase');
    }
    expect(rebrandWindow({ phase: 'regular_season', week: null, lastRenameWeek: null })).toBe('phase');
  });

  it('rolls by personality, the same way for the same seed', () => {
    expect(rebrandRoll(0, 'any')).toBe(false);
    expect(rebrandRoll(1, 'any')).toBe(true);
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), fc.string(), (p, seed) => {
        return rebrandRoll(p, seed) === rebrandRoll(p, seed);
      })
    );
    const hits = Array.from({ length: 2000 }, (_, i) => rebrandRoll(0.3, `e${i}`)).filter(Boolean).length;
    expect(hits / 2000).toBeGreaterThan(0.25);
    expect(hits / 2000).toBeLessThan(0.35);
  });

  it('finds the occasion: a losing streak, a clinch, or the deadline', () => {
    const base = { week: 7, streak: 'W1', clinched: false, tradeDeadlineWeek: 11 };
    expect(rebrandOccasion(base)).toBeNull();
    expect(rebrandOccasion({ ...base, streak: 'L2' })).toBeNull();
    expect(rebrandOccasion({ ...base, streak: 'L3' })).toBe('losing_streak');
    expect(rebrandOccasion({ ...base, clinched: true })).toBe('clinched');
    expect(rebrandOccasion({ ...base, week: 11 })).toBe('trade_deadline');
    expect(losingStreak(null)).toBe(0);
    expect(losingStreak('L12')).toBe(12);
    expect(losingStreak('T2')).toBe(0);
    expect(Object.keys(REBRAND_PROMPTS).sort()).toEqual(['clinched', 'losing_streak', 'trade_deadline']);
  });

  it('clinches only when too few teams can still catch up', () => {
    const rows = [
      { teamId: 'a', wins: 9, losses: 1, ties: 0 },
      { teamId: 'b', wins: 8, losses: 2, ties: 0 },
      { teamId: 'c', wins: 5, losses: 5, ties: 0 },
      { teamId: 'd', wins: 2, losses: 8, ties: 0 }
    ];
    expect(clinchedPlayoffSpot(rows, 'a', 3, 2)).toBe(true); // only b can reach 9
    expect(clinchedPlayoffSpot(rows, 'a', 4, 2)).toBe(false); // c could tie it too
    expect(clinchedPlayoffSpot(rows, 'd', 0, 2)).toBe(false);
    expect(clinchedPlayoffSpot(rows, 'zz', 0, 2)).toBe(false);
    expect(clinchedPlayoffSpot(rows, 'a', 0, 0)).toBe(false);
    expect(clinchedPlayoffSpot(rows, 'd', 0, 4)).toBe(false); // everyone gets in: no clinch to celebrate
  });
});
