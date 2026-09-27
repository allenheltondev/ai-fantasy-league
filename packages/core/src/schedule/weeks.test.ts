import { describe, expect, it } from 'vitest';
import { yahooDefaultSettings } from '../rules/settings.js';
import { latestStartWeek, leagueWeeks } from './weeks.js';

describe('leagueWeeks', () => {
  it('derives a full season from the defaults', () => {
    const r = leagueWeeks(yahooDefaultSettings(8));
    expect(r.ok && r.value).toEqual({
      startWeek: 1,
      regularSeason: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
      playoffs: [15, 16, 17],
      tradeDeadlineWeek: 11,
      midSeasonStart: false
    });
  });

  it('derives a mid-season start', () => {
    const r = leagueWeeks(yahooDefaultSettings(6, { startWeek: 8 }));
    expect(r.ok && r.value.regularSeason).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
    expect(r.ok && r.value.playoffs).toEqual([16, 17]);
    expect(r.ok && r.value.midSeasonStart).toBe(true);
  });

  it('rejects a start on or after the trade deadline with a fix', () => {
    const r = leagueWeeks(yahooDefaultSettings(8, { startWeek: 11 }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.map((i) => i.code)).toEqual(['START_AFTER_TRADE_DEADLINE']);
      expect(r.issues[0]!.fix).toBe('Set schedule.startWeek to 10 or earlier.');
    }
  });

  it('rejects a start that leaves no regular-season week', () => {
    const s = yahooDefaultSettings(8, { startWeek: 15 });
    const r = leagueWeeks(s);
    expect(!r.ok && r.issues.map((i) => i.code)).toEqual([
      'SEASON_HAS_NO_WEEKS',
      'START_AFTER_TRADE_DEADLINE'
    ]);
  });

  it('suggests moving the deadline when it is week 1', () => {
    const s = yahooDefaultSettings(8);
    s.trades.deadlineWeek = 1;
    const r = leagueWeeks(s);
    expect(!r.ok && r.issues[0]!.fix).toBe('Set trades.deadlineWeek to 2 or later.');
  });

  it('reports the latest start week', () => {
    expect(latestStartWeek(yahooDefaultSettings(8))).toBe(10);
  });
});
