import { yahooDefaultSettings } from '@fantasy/core';
import type { ScheduledGame } from '@fantasy/data';
import { startSeasonSchedule } from '../league/schedule.js';
import { newTeam } from '../league/seats.js';
import { agentIdFor } from '../repos/agents.js';
import type { ReferenceStore } from '../repos/reference.js';
import type { League, Repos } from '../repos/types.js';

/**
 * A playable in-season league for local dev and the e2e lineup flow, until the draft stream can
 * produce one: four teams (team-1 and team-2 with full rosters of fixture players), phase
 * `regular_season`, week 1 of 2026, the schedule generated, NFL games stored for weeks 1-18, and the
 * draft's closing announcement in the #draft chat room.
 * The season-loop tests use the same data (test/support/season.ts).
 */

export const SEASON = 2026;

export const TEAM1_ROSTER = [
  'fx-jallen',
  'fx-mahomes',
  'fx-cmc',
  'fx-bijan',
  'fx-bhall',
  'fx-chase',
  'fx-jjefferson',
  'fx-arsb',
  'fx-lamb',
  'fx-kelce',
  'fx-butker',
  'fx-def-sf',
  'fx-kwalker'
];
export const TEAM2_ROSTER = [
  'fx-lamar',
  'fx-hurts',
  'fx-jtaylor',
  'fx-jjacobs',
  'fx-kyrenw',
  'fx-ajbrown',
  'fx-mhj',
  'fx-tyhill',
  'fx-metcalf',
  'fx-laporta',
  'fx-tucker',
  'fx-def-buf',
  'fx-taysom'
];

/** Team-1's legal week-1 lineup (fx-mahomes, fx-bhall, fx-lamb, fx-kwalker on the bench). */
export const TEAM1_LINEUP = [
  { playerId: 'fx-jallen', slot: 'QB' },
  { playerId: 'fx-cmc', slot: 'RB' },
  { playerId: 'fx-bijan', slot: 'RB' },
  { playerId: 'fx-chase', slot: 'WR' },
  { playerId: 'fx-jjefferson', slot: 'WR' },
  { playerId: 'fx-arsb', slot: 'WR' },
  { playerId: 'fx-kelce', slot: 'W/R/T' },
  { playerId: 'fx-butker', slot: 'K' },
  { playerId: 'fx-def-sf', slot: 'DEF' }
] as const;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Week-1 games: Thursday KC-BAL, Sunday 1pm and 4:25, and Monday night. SEA and LAR are on bye. */
const WEEK1: [kickoff: string, home: string, away: string][] = [
  ['2026-09-11T00:20:00.000Z', 'KC', 'BAL'],
  ['2026-09-13T17:00:00.000Z', 'BUF', 'MIA'],
  ['2026-09-13T17:00:00.000Z', 'CIN', 'DET'],
  ['2026-09-13T17:00:00.000Z', 'SF', 'ARI'],
  ['2026-09-13T20:25:00.000Z', 'PHI', 'DAL'],
  ['2026-09-13T20:25:00.000Z', 'MIN', 'GB'],
  ['2026-09-15T00:15:00.000Z', 'NYJ', 'PIT'],
  ['2026-09-15T00:15:00.000Z', 'ATL', 'IND']
];

export const THURSDAY_KICKOFF = '2026-09-11T00:20:00.000Z';
export const SUNDAY_KICKOFF = '2026-09-13T17:00:00.000Z';
export const MONDAY_KICKOFF = '2026-09-15T00:15:00.000Z';

export function nflGames(weeks = 18): ScheduledGame[] {
  const games: ScheduledGame[] = [];
  for (let week = 1; week <= weeks; week++) {
    for (const [kickoff, homeTeam, awayTeam] of WEEK1) {
      games.push({
        gameId: `${SEASON}_${String(week).padStart(2, '0')}_${awayTeam}_${homeTeam}`,
        season: SEASON,
        seasonType: 'regular',
        week,
        kickoff: new Date(Date.parse(kickoff) + (week - 1) * WEEK_MS).toISOString(),
        homeTeam,
        awayTeam,
        status: 'scheduled'
      });
    }
  }
  return games;
}

export async function seedNflSchedule(reference: ReferenceStore): Promise<void> {
  await reference.schedule.putSeason(
    SEASON,
    nflGames(),
    { SEA: 1, LAR: 1, KC: 7 },
    new Date('2026-09-01T00:00:00Z')
  );
}

/**
 * Seeds the demo league (`FANTASY_LOCAL_SEASON_DEMO=<handle>` in the local server), owned by the
 * dev user `local-<handle>` on team-1. With a `rival`, a second person holds team-2 instead of an
 * AI manager (`FANTASY_LOCAL_TRADE_DEMO`, for the notification e2e: one person's trade offer lands
 * in the other's inbox). Does nothing when the league already exists.
 */
export async function seedDemoSeason(
  deps: { repos: Repos; reference: ReferenceStore },
  options: {
    leagueId: string;
    owner: { sub: string; name: string };
    rival?: { sub: string; name: string };
    now: Date;
  }
): Promise<League> {
  const existing = await deps.repos.leagues.get(options.leagueId);
  if (existing !== null) return existing;
  const settings = yahooDefaultSettings(4);
  const at = options.now.toISOString();
  const league: League = {
    id: options.leagueId,
    name: 'Demo Season',
    season: SEASON,
    phase: 'regular_season',
    week: 1,
    settings,
    commissionerId: options.owner.sub,
    commissionerName: options.owner.name,
    createdBy: options.owner.sub,
    scheduleSeed: options.leagueId,
    deadlines: { draftStartsAt: null, nextLineupLockAt: null, nextWaiverRunAt: null, tradeDeadlineAt: null },
    createdAt: at,
    updatedAt: at,
    version: 1
  };
  const rosters: Record<string, readonly string[]> = { 'team-1': TEAM1_ROSTER, 'team-2': TEAM2_ROSTER };
  const people = [options.owner, options.rival ?? null];
  const teams = [1, 2, 3, 4].map((slot) => {
    const person = people[slot - 1] ?? null;
    return {
      ...newTeam({
        leagueId: league.id,
        id: `team-${slot}`,
        draftSlot: slot,
        settings,
        now: options.now,
        ...(person === null
          ? {}
          : { owner: { userId: person.sub, name: person.name, teamName: `${person.name}'s Team` } })
      }),
      roster: [...(rosters[`team-${slot}`] ?? [])]
    };
  });
  await deps.repos.teams.create(teams);
  for (const [i, person] of people.entries()) {
    if (person === null) continue;
    await deps.repos.members.add({
      leagueId: league.id,
      userId: person.sub,
      teamId: `team-${i + 1}`,
      joinedAt: at
    });
  }
  await deps.repos.leagues.create(league);
  // Agents on the other seats, each on a different model family, so the model leaderboard and the
  // AI activity tab have something to show.
  const agentSeats = [
    ['team-2', 'pirate-captain', 'hall_of_famer', 'zero_rb'],
    ['team-3', 'stats-nerd', 'pro', 'analytics_only'],
    ['team-4', 'hype-man', 'rookie', 'waiver_hawk']
  ] as const;
  for (const [teamId, personalityId, difficulty, archetype] of agentSeats) {
    if (teamId === 'team-2' && options.rival !== undefined) continue;
    await deps.repos.agents.putSeat({
      leagueId: league.id,
      teamId,
      agentId: agentIdFor(league.id, teamId),
      config: { personalityId, difficulty, archetype },
      version: 1,
      updatedAt: at,
      updatedBy: `user#${options.owner.sub}`
    });
  }
  await seedNflSchedule(deps.reference);
  await startSeasonSchedule(deps, league);
  await deps.repos.lineups.put([
    {
      leagueId: league.id,
      teamId: 'team-1',
      week: 1,
      entries: TEAM1_LINEUP.map((e) => ({ ...e })),
      updatedAt: at,
      updatedBy: 'system'
    }
  ]);
  // The draft's closing announcement, in #draft where the draft's news goes (#144).
  await deps.repos.chat.put({
    id: `sys-demo-draft-${league.id}`,
    leagueId: league.id,
    roomId: 'draft',
    kind: 'system',
    author: { teamId: null, teamName: null, name: 'League' },
    text: 'The draft is complete. Good luck this season!',
    mentionedTeamIds: [],
    event: { detailType: 'Draft Completed', eventId: `demo-draft-${league.id}` },
    createdAt: at
  });
  return league;
}
