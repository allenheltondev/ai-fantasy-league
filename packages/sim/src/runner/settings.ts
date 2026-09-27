import { hasErrors, validateLeagueSettings, yahooDefaultSettings, type LeagueSettings } from '@fantasy/core';

/** Thrown when the requested weeks cannot form a league season. */
export class ReplaySettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplaySettingsError';
  }
}

/**
 * League settings for a replay from `startWeek` through `lastWeek`.
 *
 * When the archive reaches the default playoff end (week 17), these are the Yahoo defaults (with the
 * start week, for a mid-season start). A shorter replay keeps every default except the calendar: the
 * last two weeks become a 4-team playoff (a 2-team final for a 3-week replay), the regular season is
 * everything before, and the trade deadline is the last regular-season week.
 */
export function replaySettings(teamCount: number, startWeek: number, lastWeek: number): LeagueSettings {
  const base = yahooDefaultSettings(teamCount, { startWeek });
  let settings: LeagueSettings;
  if (lastWeek >= base.playoffs.endWeek) {
    settings = base;
  } else {
    const span = lastWeek - startWeek + 1;
    if (span < 3) {
      throw new ReplaySettingsError(
        `A replay needs at least 3 weeks (2 regular-season weeks and a final); weeks ${startWeek}-${lastWeek} is ${span}.`
      );
    }
    const playoffs =
      span >= 4
        ? { teams: 4, byes: 0, startWeek: lastWeek - 1, endWeek: lastWeek }
        : { teams: 2, byes: 0, startWeek: lastWeek, endWeek: lastWeek };
    const regularSeasonEndWeek = playoffs.startWeek - 1;
    settings = {
      ...base,
      schedule: { startWeek, regularSeasonEndWeek },
      playoffs: { ...base.playoffs, ...playoffs },
      trades: { ...base.trades, deadlineWeek: regularSeasonEndWeek }
    };
  }
  const issues = validateLeagueSettings(settings);
  if (hasErrors(issues)) {
    throw new ReplaySettingsError(
      issues
        .filter((i) => i.severity === 'error')
        .map((i) => `${i.message} ${i.fix}`)
        .join(' ')
    );
  }
  return settings;
}
