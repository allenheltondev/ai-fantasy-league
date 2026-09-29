import { describe, expect, it } from 'vitest';
import { withIdpScoring } from '../scoring/settings.js';
import type { RuleIssue } from './issues.js';
import { hasErrors } from './issues.js';
import {
  applySettingsPatch,
  yahooDefaultSettings,
  type LeagueSettings,
  type LeagueSettingsPatch
} from './settings.js';
import {
  SETTINGS_EDITABILITY,
  checkSettingsChange,
  diffSettingPaths,
  parseLeagueSettings,
  settingEditability,
  validateLeagueSettings
} from './validate-settings.js';

const base = yahooDefaultSettings();
const patched = (patch: LeagueSettingsPatch): LeagueSettings =>
  applySettingsPatch(base, patch) as LeagueSettings;
const codes = (issues: RuleIssue[]): string[] => issues.map((i) => i.code);

function parseIssues(input: unknown): RuleIssue[] {
  const r = parseLeagueSettings(input);
  if (r.ok) throw new Error('expected failure');
  return r.issues;
}

describe('parseLeagueSettings: schema errors with fix hints', () => {
  it('rejects out-of-range team counts with a fix', () => {
    const [issue] = parseIssues(patched({ teamCount: 14 }));
    expect(issue).toMatchObject({ code: 'SETTING_OUT_OF_RANGE', path: 'teamCount', severity: 'error' });
    expect(issue?.fix).toBe('Set `teamCount` to at most 12.');
    const [low] = parseIssues(patched({ teamCount: 2 }));
    expect(low?.fix).toBe('Set `teamCount` to at least 4.');
  });

  it('rejects odd team counts, since head-to-head needs an opponent for every team', () => {
    const issues = parseIssues(patched({ teamCount: 7 }));
    const odd = issues.find((i) => i.code === 'ODD_TEAM_COUNT');
    expect(odd).toMatchObject({ path: 'teamCount', severity: 'error' });
    expect(odd?.fix).toContain('6 or 8');
  });

  it('names valid keys for unknown settings', () => {
    const [issue] = parseIssues({ ...base, waivers: { ...base.waivers, budget: 100 } });
    expect(issue?.code).toBe('UNKNOWN_SETTING');
    expect(issue?.fix).toContain('faabBudget');
    const [top] = parseIssues({ ...base, extra: true });
    expect(top?.message).toContain('the settings object');
    expect(top?.fix).toContain('teamCount');
  });

  it('lists roster slots for an unknown slot', () => {
    const [issue] = parseIssues({
      ...base,
      roster: { ...base.roster, slots: { ...base.roster.slots, FLEX: 1 } }
    });
    expect(issue?.path).toBe('roster.slots');
    expect(issue?.fix).toContain('W/R/T');
  });

  it('suggests enum values', () => {
    const [issue] = parseIssues(patched({ trades: { review: 'vote' as never } }));
    expect(issue).toMatchObject({ code: 'INVALID_SETTING', path: 'trades.review' });
    expect(issue?.fix).toBe('Use one of: "league_vote", "commissioner", "none".');
  });

  it('distinguishes missing from mistyped fields', () => {
    const { teamCount: _t, ...missing } = base;
    expect(parseIssues(missing)[0]).toMatchObject({
      code: 'MISSING_SETTING',
      fix: 'Provide `teamCount` as a number.'
    });
    expect(parseIssues({ ...base, teamCount: 'eight' })[0]?.code).toBe('INVALID_SETTING');
    expect(parseIssues({ ...base, teamCount: 8.5 })[0]?.fix).toContain('whole number');
    expect(parseIssues({ ...base, waivers: { ...base.waivers, allowZeroBids: 'yes' } })[0]?.fix).toBe(
      'Provide `waivers.allowZeroBids` as a boolean.'
    );
  });

  it('reports exclusive bounds and other issue kinds', () => {
    expect(parseIssues(null)[0]?.message).toContain('the settings object');
    const regex = parseIssues({ ...base, scoring: { ...base.scoring, perStat: { 'Bad Key': 1 } } });
    expect(regex[0]).toMatchObject({ code: 'INVALID_SETTING' });
    expect(regex[0]?.fix).toContain('Correct');
  });

  it('returns warnings on success', () => {
    const r = parseLeagueSettings(patched({ schedule: { startWeek: 10 } }));
    expect(r).toMatchObject({ ok: true, warnings: [{ code: 'SHORT_REGULAR_SEASON' }] });
  });

  it('fails on semantic errors', () => {
    expect(codes(parseIssues(patched({ playoffs: { teams: 7 } })))).toContain('PLAYOFF_BYES_INVALID');
  });
});

describe('validateLeagueSettings: cross-field rules', () => {
  it('playoff teams must not exceed team count', () => {
    const s = yahooDefaultSettings(4);
    const issues = validateLeagueSettings({
      ...s,
      playoffs: { ...s.playoffs, teams: 6, byes: 2, startWeek: 16, endWeek: 18 }
    });
    const issue = issues.find((i) => i.code === 'PLAYOFF_TEAMS_EXCEED_TEAMS');
    expect(issue?.fix).toContain('4 or fewer');
    const eight = validateLeagueSettings(patched({ teamCount: 5 }));
    expect(eight.find((i) => i.code === 'PLAYOFF_TEAMS_EXCEED_TEAMS')?.fix).toContain('(4 is the default');
    const seven = validateLeagueSettings({
      ...patched({ teamCount: 7 }),
      playoffs: { ...base.playoffs, teams: 8, byes: 0 }
    });
    expect(seven.find((i) => i.code === 'PLAYOFF_TEAMS_EXCEED_TEAMS')?.fix).toContain('(6 is the default');
  });

  it('byes must fit the bracket', () => {
    const issues = validateLeagueSettings(patched({ playoffs: { byes: 0 } }));
    expect(issues).toMatchObject([{ code: 'PLAYOFF_BYES_INVALID', fix: 'Set playoffs.byes to 2.' }]);
  });

  it('playoff weeks must match the rounds', () => {
    expect(validateLeagueSettings(patched({ playoffs: { endWeek: 18 } }))).toMatchObject([
      { code: 'PLAYOFF_WEEKS_MISMATCH', fix: 'Set playoffs.endWeek to 17.' }
    ]);
    const late = validateLeagueSettings(
      patched({ schedule: { regularSeasonEndWeek: 16 }, playoffs: { startWeek: 17, endWeek: 18 } })
    );
    expect(late.find((i) => i.code === 'PLAYOFF_WEEKS_MISMATCH')?.fix).toBe(
      'Set playoffs.startWeek to 16 and playoffs.endWeek to 18.'
    );
  });

  it('playoffs must start right after the regular season', () => {
    expect(codes(validateLeagueSettings(patched({ schedule: { regularSeasonEndWeek: 13 } })))).toEqual([
      'PLAYOFFS_NOT_AFTER_REGULAR_SEASON'
    ]);
  });

  it('trade deadline must come before the playoffs', () => {
    const issues = validateLeagueSettings(patched({ trades: { deadlineWeek: 15 } }));
    expect(issues).toMatchObject([{ code: 'TRADE_DEADLINE_IN_PLAYOFFS', path: 'trades.deadlineWeek' }]);
  });

  it('league must start before the deadline and have weeks', () => {
    expect(codes(validateLeagueSettings(patched({ schedule: { startWeek: 11 } })))).toContain(
      'START_AFTER_TRADE_DEADLINE'
    );
    expect(codes(validateLeagueSettings(patched({ schedule: { startWeek: 15 } })))).toEqual([
      'SEASON_HAS_NO_WEEKS',
      'START_AFTER_TRADE_DEADLINE'
    ]);
    const first = validateLeagueSettings(
      patched({ schedule: { startWeek: 1 }, trades: { deadlineWeek: 1 } })
    );
    expect(first.find((i) => i.code === 'START_AFTER_TRADE_DEADLINE')?.fix).toBe(
      'Set trades.deadlineWeek to 2 or later.'
    );
    const mid = validateLeagueSettings(patched({ schedule: { startWeek: 12 } }));
    expect(mid.find((i) => i.code === 'START_AFTER_TRADE_DEADLINE')?.fix).toBe(
      'Set schedule.startWeek to 10 or earlier, or set trades.deadlineWeek to 13 or later.'
    );
  });

  it('warns when veto votes exceed eligible voters', () => {
    expect(validateLeagueSettings(patched({ trades: { vetoVotes: 7 } }))).toMatchObject([
      { code: 'VETO_VOTES_UNREACHABLE', severity: 'warning' }
    ]);
  });

  it('roster limits', () => {
    expect(codes(validateLeagueSettings(patched({ roster: { slots: { BN: 15, WR: 5 } } })))).toEqual([
      'ROSTER_TOO_LARGE'
    ]);
    expect(codes(validateLeagueSettings(patched({ roster: { slots: { IR: 5 } } })))).toEqual([
      'TOO_MANY_IR_SLOTS'
    ]);
    const none = { QB: 0, WR: 0, RB: 0, TE: 0, 'W/R/T': 0, K: 0, DEF: 0 };
    expect(codes(validateLeagueSettings(patched({ roster: { slots: none } })))).toEqual([
      'NO_STARTING_SLOTS'
    ]);
    const twelve = validateLeagueSettings(patched({ teamCount: 12, roster: { slots: { DEF: 3 } } }));
    expect(twelve).toMatchObject([
      { code: 'PLAYER_POOL_TOO_SMALL', fix: 'Set roster.slots.DEF to 2 or fewer.' }
    ]);
  });

  it('warns without a QB-eligible slot, but superflex counts', () => {
    expect(codes(validateLeagueSettings(patched({ roster: { slots: { QB: 0 } } })))).toEqual(['NO_QB_SLOT']);
    expect(validateLeagueSettings(patched({ roster: { slots: { QB: 0, 'Q/W/R/T': 1 } } }))).toEqual([]);
  });

  it('FAAB must allow at least one legal bid', () => {
    expect(
      codes(
        validateLeagueSettings(patched({ waivers: { type: 'faab', faabBudget: 0, allowZeroBids: false } }))
      )
    ).toEqual(['FAAB_NO_LEGAL_BID']);
    expect(
      validateLeagueSettings(patched({ waivers: { type: 'rolling', faabBudget: 0, allowZeroBids: false } }))
    ).toEqual([]);
  });

  it('warns when IDP slots have no IDP scoring', () => {
    const idp = patched({ roster: { slots: { LB: 1, DL: 1, DB: 1 } } });
    expect(codes(validateLeagueSettings(idp))).toEqual(['IDP_SLOTS_WITHOUT_IDP_SCORING']);
    expect(validateLeagueSettings({ ...idp, scoring: withIdpScoring(idp.scoring) })).toEqual([]);
  });

  it('includes scoring validation', () => {
    expect(codes(validateLeagueSettings(patched({ scoring: { perStat: { made_up: 1 } } })))).toEqual([
      'UNKNOWN_STAT_KEY'
    ]);
  });
});

describe('editability', () => {
  it('classifies paths by longest prefix, treating unknown paths as locked', () => {
    expect(settingEditability('scoring.perStat.rec')).toBe('pre_draft');
    expect(settingEditability('trades.deadlineWeek')).toBe('any_time');
    expect(settingEditability('waivers.faabBudget')).toBe('pre_draft');
    expect(settingEditability('waivers.waiverPeriodDays')).toBe('any_time');
    expect(settingEditability('roster.irEligibleStatuses')).toBe('any_time');
    expect(settingEditability('roster.slots.QB')).toBe('pre_draft');
    expect(settingEditability('mystery')).toBe('pre_draft');
    expect(settingEditability('tradesX')).toBe('pre_draft');
  });

  it('covers every top-level setting', () => {
    for (const key of Object.keys(base)) {
      expect(Object.keys(SETTINGS_EDITABILITY).some((k) => k === key || k.startsWith(`${key}.`))).toBe(true);
    }
  });

  it('diffs leaf paths', () => {
    expect(diffSettingPaths(base, base)).toEqual([]);
    const next = patched({ scoring: { perStat: { rec: 1 } }, roster: { irEligibleStatuses: ['ir'] } });
    expect(diffSettingPaths(base, next)).toEqual(['roster.irEligibleStatuses', 'scoring.perStat.rec']);
    expect(diffSettingPaths({ a: 1 }, { a: 1, b: 2 })).toEqual(['b']);
  });
});

describe('checkSettingsChange', () => {
  it('allows anything valid before the draft', () => {
    expect(
      checkSettingsChange(base, patched({ scoring: { perStat: { rec: 1 } } }), { phase: 'pre_draft' })
    ).toEqual([]);
  });

  it('locks draft-time settings once the draft starts', () => {
    const issues = checkSettingsChange(
      base,
      patched({ scoring: { perStat: { rec: 1 } }, waivers: { faabBudget: 200 } }),
      {
        phase: 'drafting'
      }
    );
    expect(issues).toMatchObject([
      { code: 'SETTING_LOCKED', path: 'scoring.perStat.rec' },
      { code: 'SETTING_LOCKED', path: 'waivers.faabBudget' }
    ]);
    expect(issues[0]?.fix).toContain('trades');
  });

  it('allows mid-season-safe edits', () => {
    const next = patched({ trades: { review: 'none', deadlineWeek: 12 }, waivers: { waiverPeriodDays: 1 } });
    expect(checkSettingsChange(base, next, { phase: 'in_season', currentWeek: 5 })).toEqual([]);
    expect(checkSettingsChange(base, next, { phase: 'in_season' })).toEqual([]);
  });

  it('refuses to move a passed deadline or set one in the past', () => {
    expect(
      codes(
        checkSettingsChange(base, patched({ trades: { deadlineWeek: 13 } }), {
          phase: 'in_season',
          currentWeek: 11
        })
      )
    ).toEqual(['TRADE_DEADLINE_PASSED']);
    expect(
      codes(
        checkSettingsChange(base, patched({ trades: { deadlineWeek: 5 } }), {
          phase: 'in_season',
          currentWeek: 6
        })
      )
    ).toEqual(['TRADE_DEADLINE_IN_PAST']);
  });

  it('still validates the resulting settings', () => {
    const issues = checkSettingsChange(base, patched({ trades: { deadlineWeek: 16 } }), {
      phase: 'pre_draft'
    });
    expect(hasErrors(issues)).toBe(true);
    expect(codes(issues)).toEqual(['TRADE_DEADLINE_IN_PLAYOFFS']);
  });
});
