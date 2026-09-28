import { leagueWeeks, validateLeagueSettings, yahooDefaultSettings } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import { ReplaySettingsError, replaySettings } from './settings.js';

describe('replaySettings', () => {
  it('uses the Yahoo defaults for a full season, with the start week for a mid-season start', () => {
    expect(replaySettings(8, 1, 18)).toEqual(yahooDefaultSettings(8));
    expect(replaySettings(8, 5, 17).schedule.startWeek).toBe(5);
  });

  it('compresses a short replay into a regular season plus a 4-team playoff in the last two weeks', () => {
    const s = replaySettings(8, 1, 4);
    expect(s.schedule).toEqual({ startWeek: 1, regularSeasonEndWeek: 2 });
    expect(s.playoffs).toMatchObject({ teams: 4, byes: 0, startWeek: 3, endWeek: 4 });
    expect(s.trades.deadlineWeek).toBe(2);
    expect(validateLeagueSettings(s).filter((i) => i.severity === 'error')).toEqual([]);
    const weeks = leagueWeeks(s);
    expect(weeks.ok && [...weeks.value.regularSeason, ...weeks.value.playoffs]).toEqual([1, 2, 3, 4]);
  });

  it('uses a 2-team final for a 3-week replay and rejects anything shorter', () => {
    expect(replaySettings(8, 2, 4).playoffs).toMatchObject({ teams: 2, startWeek: 4, endWeek: 4 });
    expect(() => replaySettings(8, 1, 2)).toThrow(ReplaySettingsError);
  });

  it('rejects settings core would reject', () => {
    expect(() => replaySettings(8, 12, 18)).toThrow(/trade deadline/);
  });
});
