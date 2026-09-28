import type { ScheduledGame } from '@fantasy/data';
import { GAME_DURATION_MS, draftMoment, iso, weekMoments, type WeekMoments } from './moments.js';

/**
 * What happens at a moment of the simulated season, in the order a real week unfolds:
 * - `draft`: once, before the league's first week.
 * - `waiver_run`: waivers process for the coming week (claims are submitted just before).
 * - `lineup_lock`: a game window kicks off; its players lock.
 * - `games_final`: that window's games are final (live scores settle).
 * - `monday_night_final`: the week's last game is final; the week is provisionally final.
 * - `stat_correction`: the Thursday stat-correction run; the week is officially final.
 */
export const SIM_EVENT_KINDS = [
  'draft',
  'waiver_run',
  'lineup_lock',
  'games_final',
  'monday_night_final',
  'stat_correction'
] as const;
export type SimEventKind = (typeof SIM_EVENT_KINDS)[number];

export interface SimEvent {
  /** Position in the timeline (0-based). */
  seq: number;
  /** ISO 8601 instant. */
  at: string;
  kind: SimEventKind;
  /** Fantasy (and NFL regular-season) week the event belongs to. */
  week: number;
  /** For `lineup_lock` and `games_final`: the kickoff of the window and the NFL teams playing in it. */
  window?: { kickoff: string; teams: string[] };
}

export interface TimelineOptions {
  /** The weeks the league plays, ascending (see core `leagueWeeks`). The first gets the draft. */
  weeks: readonly number[];
}

const KIND_ORDER: Record<SimEventKind, number> = {
  draft: 0,
  waiver_run: 1,
  lineup_lock: 2,
  games_final: 3,
  monday_night_final: 4,
  stat_correction: 5
};

/** Thrown when a schedule cannot produce a consistent timeline (a week with no games, overlapping weeks). */
export class TimelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimelineError';
  }
}

function teamsAt(schedule: readonly ScheduledGame[], week: number, kickoff: number): string[] {
  return schedule
    .filter((g) => g.seasonType === 'regular' && g.week === week && Date.parse(g.kickoff) === kickoff)
    .flatMap((g) => [g.awayTeam, g.homeTeam])
    .sort();
}

/**
 * Builds the deterministic event timeline for the league's weeks from the NFL schedule. Events are
 * sorted by time, then by kind (the order above), then by week. Every week's waiver run precedes its
 * first lock, and every event of week W+1 that decides anything (locks) comes after week W is final.
 */
export function buildTimeline(schedule: readonly ScheduledGame[], options: TimelineOptions): SimEvent[] {
  const moments = weekMoments(schedule);
  const weeks = [...options.weeks].sort((a, b) => a - b);
  if (weeks.length === 0) throw new TimelineError('A timeline needs at least one week.');
  const raw: Omit<SimEvent, 'seq'>[] = [];
  const momentOf = (week: number): WeekMoments => {
    const m = moments.get(week);
    if (!m) throw new TimelineError(`The schedule has no regular-season games in week ${week}.`);
    return m;
  };
  raw.push({ at: iso(draftMoment(momentOf(weeks[0] as number))), kind: 'draft', week: weeks[0] as number });
  for (const week of weeks) {
    const m = momentOf(week);
    if (m.waiversAt >= m.firstKickoff) {
      throw new TimelineError(
        `Week ${week} kicks off before its waivers can run (too soon after week ${week - 1}).`
      );
    }
    raw.push({ at: iso(m.waiversAt), kind: 'waiver_run', week });
    for (const kickoff of m.windows) {
      const window = { kickoff: iso(kickoff), teams: teamsAt(schedule, week, kickoff) };
      raw.push({ at: iso(kickoff), kind: 'lineup_lock', week, window });
      raw.push({ at: iso(kickoff + GAME_DURATION_MS), kind: 'games_final', week, window });
    }
    raw.push({ at: iso(m.lastFinalAt), kind: 'monday_night_final', week });
    raw.push({ at: iso(m.correctionsAt), kind: 'stat_correction', week });
  }
  for (let i = 1; i < weeks.length; i++) {
    const prev = momentOf(weeks[i - 1] as number);
    const next = momentOf(weeks[i] as number);
    if (next.waiversAt <= prev.lastFinalAt || next.firstKickoff <= prev.correctionsAt) {
      throw new TimelineError(
        `Weeks ${weeks[i - 1]} and ${weeks[i]} overlap: week ${weeks[i]}'s waivers or first kickoff come before week ${weeks[i - 1]} is final.`
      );
    }
  }
  return raw
    .sort((a, b) => a.at.localeCompare(b.at) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.week - b.week)
    .map((e, seq) => ({ seq, ...e }));
}
