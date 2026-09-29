import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PICK_SECONDS,
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
import {
  checkDraftSchedule,
  checkSettingsChange,
  MAX_DRAFT_SCHEDULE_DAYS,
  parseLeagueSettings,
  settingEditability
} from './validate-settings.js';

describe('yahooDefaultSettings', () => {
  const s = yahooDefaultSettings();

  it('matches the Yahoo public-league defaults for 8 teams', () => {
    expect(s.teamCount).toBe(8);
    expect(s.roster.slots).toEqual({ QB: 1, WR: 3, RB: 2, TE: 1, 'W/R/T': 1, K: 1, DEF: 1, BN: 6, IR: 1 });
    expect(s.scoring.perStat.rec).toBe(0.5);
    expect(s.waivers).toMatchObject({
      type: 'rolling',
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
    expect(s.playoffs).toEqual({
      teams: 6,
      byes: 2,
      startWeek: 15,
      endWeek: 17,
      tiebreaker: 'points_for',
      reseed: false,
      consolation: false
    });
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

describe('draft settings', () => {
  it('defaults the pick clock to 90 seconds, and reads settings stored without it as the default', () => {
    const settings = yahooDefaultSettings(8);
    expect(settings.draft).toEqual({
      pickSeconds: DEFAULT_PICK_SECONDS,
      scheduledAt: null,
      orderMode: 'slots'
    });
    const legacy: Record<string, unknown> = { ...settings };
    delete legacy.draft;
    const parsed = parseLeagueSettings(legacy);
    expect(parsed.ok && parsed.settings.draft.pickSeconds).toBe(90);
    // Settings stored before the draft could be scheduled read as a manual draft in slot order.
    const older = parseLeagueSettings({ ...settings, draft: { pickSeconds: 60 } });
    expect(older.ok && older.settings.draft).toEqual({
      pickSeconds: 60,
      scheduledAt: null,
      orderMode: 'slots'
    });
  });

  it('bounds the pick clock and names the valid keys for a typo', () => {
    const tooFast = parseLeagueSettings({ ...yahooDefaultSettings(8), draft: { pickSeconds: 5 } });
    expect(tooFast.ok ? [] : tooFast.issues.map((i) => i.path)).toEqual(['draft.pickSeconds']);
    const typo = parseLeagueSettings({ ...yahooDefaultSettings(8), draft: { pickSecs: 60 } });
    expect(typo.ok ? '' : typo.issues[0]?.fix).toContain('pickSeconds');
  });

  it('locks the pick clock and the draft time once the draft starts', () => {
    expect(settingEditability('draft.pickSeconds')).toBe('pre_draft');
    expect(settingEditability('draft.scheduledAt')).toBe('pre_draft');
    expect(settingEditability('draft.orderMode')).toBe('pre_draft');
  });

  it('takes a scheduled time with a zone and an order mode, and refuses anything else', () => {
    const at = (draft: Record<string, unknown>) =>
      parseLeagueSettings({ ...yahooDefaultSettings(8), draft: { pickSeconds: 90, ...draft } });
    expect(at({ scheduledAt: '2026-09-05T00:00:00Z', orderMode: 'random' }).ok).toBe(true);
    expect(at({ scheduledAt: '2026-09-04T20:00:00-04:00' }).ok).toBe(true);
    for (const bad of [
      { scheduledAt: 'saturday' },
      { scheduledAt: '2026-09-05T00:00:00' },
      { orderMode: 'snake' }
    ]) {
      expect(at(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('checkDraftSchedule', () => {
  const now = new Date('2026-09-01T12:00:00.000Z');

  it('allows no schedule, and a time after now within the horizon', () => {
    expect(checkDraftSchedule(null, now)).toEqual([]);
    expect(checkDraftSchedule('2026-09-01T12:00:01.000Z', now)).toEqual([]);
    expect(checkDraftSchedule('2026-10-31T12:00:00.000Z', now)).toEqual([]);
  });

  it('refuses a time that has passed or is too far ahead, each with a fix', () => {
    expect(checkDraftSchedule('2026-09-01T12:00:00.000Z', now)).toEqual([
      expect.objectContaining({
        code: 'DRAFT_TIME_IN_PAST',
        path: 'draft.scheduledAt',
        fix: expect.stringContaining('null')
      })
    ]);
    const tooFar = checkDraftSchedule('2026-10-31T12:00:00.001Z', now);
    expect(tooFar).toEqual([expect.objectContaining({ code: 'DRAFT_TIME_TOO_FAR' })]);
    expect(tooFar[0]?.message).toContain(`${MAX_DRAFT_SCHEDULE_DAYS} days`);
  });

  it('checks a changed draft time in a settings change, only when a clock is given', () => {
    const current = yahooDefaultSettings(8);
    const past = { ...current, draft: { ...current.draft, scheduledAt: '2026-08-01T00:00:00.000Z' } };
    const codes = (context: Parameters<typeof checkSettingsChange>[2]) =>
      checkSettingsChange(current, past, context).map((i) => i.code);
    expect(codes({ phase: 'pre_draft', now })).toEqual(['DRAFT_TIME_IN_PAST']);
    expect(codes({ phase: 'pre_draft' })).toEqual([]);
    // Unchanged, it is not checked again (a stored time that has since passed can stay).
    expect(checkSettingsChange(past, past, { phase: 'pre_draft', now })).toEqual([]);
  });
});
