import {
  frozenLineup,
  isStarterSlot,
  matchScoringPlay,
  RosterSlotSchema,
  scorePlayerEvents,
  wantsPlay,
  type RosterSlot,
  type ScoringPlayCandidate
} from '@fantasy/core';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import { PlayerRefSchema, toPlayerRef, type Player, type PlayerRef } from '../players/model.js';
import type { ReferenceStore, StoredScoringEvent } from '../repos/reference.js';
import type { League, Matchup, Team } from '../repos/types.js';
import { gamesByTeam, resolveLineup, weekGames, type SeasonDeps } from './lineups.js';

/**
 * The matchup scoring log (#162). Scoring events are stored once per week for every league (the
 * player's whole line after each change, `SCORELOG#<season>#W05`); a matchup's log reads the events
 * of the players in either lineup and scores them with the league's own rules (core
 * `scorePlayerEvents`), so each league's points follow its settings and a player's entries always add
 * up to his week score. Reads are bounded by the two lineups: one query per player.
 *
 * Touchdowns and made field goals also get ESPN's play description when exactly one stored scoring
 * play fits (core `matchScoringPlay`: the player's role and name in the play, his team, and the
 * time; #164). That costs one more query for the week's plays, and only when an entry wants one.
 */

export const ScoringLogEntrySchema = z.object({
  id: z.string().describe('Stable entry id (time and player); entries are unique per matchup.'),
  at: z.string().describe('When the change was seen (ISO time).'),
  kind: z
    .enum(['live', 'correction'])
    .describe('`live` from the game feed; `correction` from the official final’s stat corrections.'),
  teamId: z.string().describe('The fantasy team whose lineup has the player.'),
  teamName: z.string(),
  slot: RosterSlotSchema.describe('His slot in that lineup (BN and IR are the bench).'),
  starter: z.boolean().describe('True when his points count toward the team score.'),
  player: PlayerRefSchema,
  changes: z
    .array(z.object({ stat: z.string(), delta: z.number() }))
    .describe('The scored stats that changed, as Sleeper stat keys and the amount (after − before).'),
  summary: z.string().describe('The changes in words, e.g. "+1 rec, +18 rec yds, +1 rec TD".'),
  points: z.number().describe("Points the change was worth under this league's scoring (may be negative)."),
  touchdown: z.boolean().describe('The change includes a touchdown.'),
  play: z
    .object({
      text: z
        .string()
        .describe(
          'The play as ESPN describes it, e.g. "Travis Kelce 18 Yd pass from Patrick Mahomes (Harrison Butker Kick)".'
        )
    })
    .nullable()
    .describe(
      'The scoring play behind a touchdown or a made field goal, when exactly one play in the game fits the player, his team, and the time. Null otherwise (most entries, and whenever the match is not certain).'
    )
});
export type ScoringLogEntry = z.infer<typeof ScoringLogEntrySchema>;

interface LogSide {
  team: Team;
  entries: { playerId: string; slot: RosterSlot }[];
}

/**
 * Each side's lineup as it scores (core `frozenLineup`, the same entries `scoreWeek` uses), so the
 * log's starters are exactly the players whose points count.
 */
async function logSides(
  deps: Pick<SeasonDeps, 'repos' | 'reference'>,
  league: League,
  teams: readonly Team[],
  matchup: Matchup,
  now: Date
): Promise<{ sides: LogSide[]; players: Map<string, Player> }> {
  const sideTeams = [matchup.homeTeamId, matchup.awayTeamId].flatMap((id) => {
    const team = teams.find((t) => t.id === id);
    return team === undefined ? [] : [team];
  });
  const [lineups, games] = await Promise.all([
    Promise.all(sideTeams.map((team) => resolveLineup(deps.repos, team, matchup.week))),
    weekGames(deps.reference, league.season, matchup.week)
  ]);
  const ids = new Set(lineups.flatMap((l) => [...l.stored, ...l.entries].map((e) => e.playerId)));
  const players = new Map((await deps.repos.players.getMany([...ids])).map((p) => [p.id, p] as const));
  const byTeam = gamesByTeam(games);
  const sides = sideTeams.map((team, i) => {
    const lineup = lineups[i] as (typeof lineups)[number];
    const entries = frozenLineup(
      league.settings,
      lineup.stored,
      lineup.entries,
      (id) => players.get(id)?.team,
      byTeam,
      now
    );
    return { team, entries };
  });
  return { sides, players };
}

/**
 * A matchup's whole scoring log, newest first: every event worth points for a player in either
 * lineup (starters only unless `includeBench`). Events worth nothing under this league's scoring
 * (a snap count, a target in a league that does not score them) are left out; they add nothing to
 * the score, so the entries still sum to each player's points.
 */
export async function matchupScoringLog(
  deps: Pick<SeasonDeps, 'repos' | 'reference'>,
  league: League,
  teams: readonly Team[],
  matchup: Matchup,
  now: Date,
  options: {
    includeBench: boolean;
    /** Only entries at or after this ISO time (the realtime push's recent entries). */
    since?: string;
    /** Only these players (the ones whose lines just changed), to keep the push's reads small. */
    onlyPlayers?: ReadonlySet<string>;
  }
): Promise<ScoringLogEntry[]> {
  const { sides, players } = await logSides(deps, league, teams, matchup, now);
  const owners = new Map<string, { team: Team; slot: RosterSlot }>();
  for (const side of sides) {
    for (const e of side.entries) {
      if (!options.includeBench && !isStarterSlot(e.slot)) continue;
      if (options.onlyPlayers !== undefined && !options.onlyPlayers.has(e.playerId)) continue;
      if (!owners.has(e.playerId)) owners.set(e.playerId, { team: side.team, slot: e.slot });
    }
  }
  if (owners.size === 0) return [];
  const events = await deps.reference.scoringLog.listPlayers(league.season, matchup.week, [...owners.keys()]);
  const byPlayer = new Map<string, StoredScoringEvent[]>();
  for (const e of events) byPlayer.set(e.playerId, [...(byPlayer.get(e.playerId) ?? []), e]);
  const entries: (ScoringLogEntry & { source: Player })[] = [];
  for (const [playerId, playerEvents] of byPlayer) {
    const owner = owners.get(playerId);
    const source = players.get(playerId);
    if (owner === undefined || source === undefined) continue;
    const player: PlayerRef = toPlayerRef(source);
    for (const scored of scorePlayerEvents(league.settings, playerEvents)) {
      if (scored.points === 0) continue;
      if (options.since !== undefined && scored.event.at < options.since) continue;
      entries.push({
        source,
        id: entryId(scored.event.at, playerId),
        at: scored.event.at,
        kind: scored.event.kind,
        teamId: owner.team.id,
        teamName: owner.team.name,
        slot: owner.slot,
        starter: isStarterSlot(owner.slot),
        player,
        changes: scored.changes,
        summary: scored.summary,
        points: scored.points,
        touchdown: scored.touchdown,
        play: null
      });
    }
  }
  const wanting = entries.filter((e) => e.kind === 'live' && wantsPlay(e.changes, e.player.position));
  const plays = wanting.length === 0 ? [] : await weekPlays(deps.reference, league.season, matchup.week);
  if (plays.length > 0) {
    for (const entry of wanting) {
      const { name, firstName, lastName, team, position } = entry.source;
      const play = matchScoringPlay(
        { at: entry.at, changes: entry.changes, player: { name, firstName, lastName, team, position } },
        plays
      );
      entry.play = play === null ? null : { text: play.text };
    }
  }
  return entries.map(({ source: _source, ...entry }) => entry).sort((a, b) => b.id.localeCompare(a.id));
}

/**
 * The week's stored scoring plays (#164). Best effort: descriptions are an extra, so a failed read
 * leaves every entry without one instead of failing the log.
 */
async function weekPlays(
  reference: Pick<ReferenceStore, 'nflPlays'>,
  season: number,
  week: number
): Promise<ScoringPlayCandidate[]> {
  try {
    return (await reference.nflPlays.listWeek(season, week)).flatMap((game) => game.plays);
  } catch {
    return [];
  }
}

/** `<at>#<playerId>`: sorts by time, then player, and is unique per matchup. */
function entryId(at: string, playerId: string): string {
  return `${at}#${playerId}`;
}

const encodeCursor = (id: string) => Buffer.from(id, 'utf8').toString('base64url');

function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^\d{4}-\d{2}-\d{2}T[^#]+#.+$/.test(id)) {
    throw new ApiError('INVALID_INPUT', 'That scoring log cursor is not valid.', {
      fix: 'Pass `nextCursor` exactly as the previous get_scoring_log response returned it, or leave `cursor` out for the newest entries.'
    });
  }
  return id;
}

/** One page of a newest-first log: the entries older than `cursor`, and the cursor for the next page. */
export function pageScoringLog(
  entries: readonly ScoringLogEntry[],
  limit: number,
  cursor: string | undefined
): { entries: ScoringLogEntry[]; nextCursor: string | null } {
  const after = cursor === undefined ? null : decodeCursor(cursor);
  const rest = after === null ? entries : entries.filter((e) => e.id < after);
  const page = rest.slice(0, limit);
  const last = page.at(-1);
  return {
    entries: page,
    nextCursor: rest.length > limit && last !== undefined ? encodeCursor(last.id) : null
  };
}
