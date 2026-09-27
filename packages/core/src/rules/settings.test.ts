import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  LeagueSettingsSchema,
  activeRosterSize,
  applySettingsPatch,
  leagueSettingsPreset,
  playoffRounds,
  requiredByes,
  slotCount,
  starterCount,
  vetoVotesRequired,
  yahooDefaultSettings
} from './settings.js';
import { parseLeagueSettings } from './validate-settings.js';

describe('yahooDefaultSettings', () => {
  const s = yahooDefaultSettings();

  it('matches the Yahoo public-league defaults for 8 teams', () => {
    expect(s.teamCount).toBe(8);
    expect(s.roster.slots).toEqual({ QB: 1, WR: 3, RB: 2, TE: 1, 'W/R/T': 1, K: 1, DEF: 1, BN: 6, IR: 1 });
    expect(s.scoring.perStat.rec).toBe(0.5);
    expect(s.waivers).toMatchObject({
      type: 'faab',
      faabBudget: 100,
      waiverPeriodDays: 2,
      allowZeroBids: true
    });
    expect(s.trades).toMatchObject({
      review: 'league_vote',
      reviewPeriodDays: 2,
      deadlineWeek: 11,
      offerExpiryHours: 48,
      expireAtNextLineupLock: true
    });
    expect(s.playoffs).toEqual({ teams: 6, byes: 2, startWeek: 15, endWeek: 17, tiebreaker: 'points_for' });
    expect(s.schedule).toEqual({ startWeek: 1, regularSeasonEndWeek: 14 });
  });

  it('uses a 4-team playoff in weeks 16-17 for leagues of 6 or fewer', () => {
    for (const n of [4, 5, 6]) {
      const small = yahooDefaultSettings(n);
      expect(small.playoffs).toMatchObject({ teams: 4, byes: 0, startWeek: 16, endWeek: 17 });
      expect(small.schedule.regularSeasonEndWeek).toBe(15);
    }
    expect(yahooDefaultSettings(7).playoffs.teams).toBe(6);
  });

  it('is valid with no warnings for every even team count 8-12 and every preset', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(8, 10, 12),
        fc.constantFrom('yahoo_standard', 'full_ppr', 'standard' as const),
        (n, preset) => {
          const result = parseLeagueSettings(leagueSettingsPreset(preset, n));
          expect(result).toEqual({ ok: true, settings: leagueSettingsPreset(preset, n), warnings: [] });
        }
      )
    );
  });

  it('is valid for 4 and 6 teams (a short-season warning is not expected with 15 weeks)', () => {
    for (const n of [4, 6])
      expect(parseLeagueSettings(yahooDefaultSettings(n))).toMatchObject({ ok: true, warnings: [] });
  });

  it('rejects every odd team count', () => {
    for (const n of [5, 7, 9, 11]) {
      const result = parseLeagueSettings(yahooDefaultSettings(n));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.map((i) => i.code)).toContain('ODD_TEAM_COUNT');
    }
  });

  it('supports a mid-season start week', () => {
    const s = yahooDefaultSettings(8, { startWeek: 6 });
    expect(s.schedule.startWeek).toBe(6);
    expect(parseLeagueSettings(s).ok).toBe(true);
  });

  it('round-trips through the schema', () => {
    expect(LeagueSettingsSchema.parse(s)).toEqual(s);
  });
});

describe('leagueSettingsPreset', () => {
  it('selects reception points by preset', () => {
    expect(leagueSettingsPreset('full_ppr').scoring.perStat.rec).toBe(1);
    expect(leagueSettingsPreset('standard').scoring.perStat.rec).toBeUndefined();
    expect(leagueSettingsPreset('yahoo_standard', 10).teamCount).toBe(10);
  });
});

describe('derived helpers', () => {
  const s = yahooDefaultSettings();

  it('counts roster sizes', () => {
    expect(activeRosterSize(s)).toBe(16);
    expect(starterCount(s)).toBe(10);
    expect(slotCount(s, 'IR')).toBe(1);
    expect(slotCount(s, 'Q/W/R/T')).toBe(0);
  });

  it('computes playoff rounds and byes', () => {
    expect([2, 3, 4, 5, 6, 7, 8].map((t) => [playoffRounds({ teams: t }), requiredByes(t)])).toEqual([
      [1, 0],
      [2, 1],
      [2, 0],
      [3, 3],
      [3, 2],
      [3, 1],
      [3, 0]
    ]);
  });

  it('computes the Yahoo veto threshold (a third of the league, capped at eligible voters)', () => {
    const at = (teamCount: number, vetoVotes: number | null = null): number =>
      vetoVotesRequired({ teamCount, trades: { ...s.trades, vetoVotes } });
    expect([4, 6, 8, 10, 12].map((n) => at(n))).toEqual([2, 2, 3, 4, 4]);
    expect(at(8, 5)).toBe(5);
    expect(at(4, 5)).toBe(2);
  });
});

describe('applySettingsPatch', () => {
  const base = yahooDefaultSettings();

  it('merges nested objects key by key', () => {
    const next = applySettingsPatch(base, {
      scoring: { perStat: { rec: 1 } },
      trades: { review: 'commissioner' }
    });
    const parsed = LeagueSettingsSchema.parse(next);
    expect(parsed.scoring.perStat.rec).toBe(1);
    expect(parsed.scoring.perStat.pass_td).toBe(4);
    expect(parsed.trades.review).toBe('commissioner');
    expect(parsed.trades.deadlineWeek).toBe(11);
  });

  it('replaces arrays and ignores undefined values', () => {
    const next = LeagueSettingsSchema.parse(
      applySettingsPatch(base, { roster: { irEligibleStatuses: ['ir'] }, teamCount: undefined })
    );
    expect(next.roster.irEligibleStatuses).toEqual(['ir']);
    expect(next.teamCount).toBe(8);
  });

  it('does not mutate the base', () => {
    applySettingsPatch(base, { roster: { slots: { QB: 2 } } });
    expect(base.roster.slots.QB).toBe(1);
  });
});
