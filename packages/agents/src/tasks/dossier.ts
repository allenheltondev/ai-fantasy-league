import { fitLines } from '@fantasy/core';
import { z } from 'zod';
import type { TaskContext } from './kinds.js';

/**
 * A chat task's dossier on the team it is talking to: record, rank, streak, points, recent results,
 * this week's opponent and score, and the roster with this week's lineup. Plus one line on the
 * agent's own team, for bragging. Loaded before the model runs, so the trash talk can cite real
 * facts without the model having to think of looking them up.
 *
 * Every read goes through the agent's own tool box (the same reads any member may make). A read
 * that fails leaves its part out; a dossier never stops the chat. Names come from people and from
 * outside data, so each is flattened to one line with no fence markers.
 */

/** A dossier stays within this many characters (lines past it are dropped whole). */
export const DOSSIER_MAX_CHARS = 1400;

function clean(text: string, max = 40): string {
  const flat = text
    .replace(/\s+/g, ' ')
    .replace(/<<<|>>>|```/g, "''")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const pts = (n: number | null | undefined) =>
  n === null || n === undefined ? '-' : String(Math.round(n * 10) / 10);

const StandingsSchema = z.object({
  throughWeek: z.number().nullable(),
  standings: z.array(
    z
      .object({
        rank: z.number(),
        teamId: z.string(),
        teamName: z.string(),
        record: z.string(),
        pointsFor: z.number(),
        pointsAgainst: z.number(),
        streak: z.string().nullable(),
        results: z
          .array(
            z.object({
              week: z.number(),
              opponentTeamId: z.string(),
              result: z.string(),
              pointsFor: z.number(),
              pointsAgainst: z.number()
            })
          )
          .optional()
      })
      .loose()
  )
});
type Standings = z.infer<typeof StandingsSchema>;

const PlayerSchema = z
  .object({
    player: z
      .object({ name: z.string(), position: z.string(), team: z.string().nullable().optional() })
      .loose(),
    slot: z.string(),
    injuryStatus: z.string().nullable().optional(),
    onBye: z.boolean().optional(),
    projectedPoints: z.number().nullable().optional(),
    points: z.number().nullable().optional(),
    recentPoints: z.object({ average: z.number() }).loose().nullable().optional()
  })
  .loose();

const RosterSchema = z.object({ week: z.number(), players: z.array(PlayerSchema) }).loose();

const SideSchema = z
  .object({ teamId: z.string(), teamName: z.string(), score: z.number().nullable() })
  .loose();
const MatchupSchema = z
  .object({
    week: z.number(),
    matchup: z.object({ status: z.string(), home: SideSchema, away: SideSchema }).loose().nullable(),
    lineups: z
      .object({
        home: z.object({ teamId: z.string(), points: z.number() }).loose(),
        away: z.object({ teamId: z.string(), points: z.number() }).loose()
      })
      .loose()
      .nullable()
  })
  .loose();

async function read<T>(
  ctx: TaskContext,
  name: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>
): Promise<T | null> {
  const response = await ctx.tools.call(name, args);
  if ('error' in response) return null;
  const parsed = schema.safeParse(response.data);
  return parsed.success ? parsed.data : null;
}

function standingLine(standings: Standings, teamId: string): string | null {
  const row = standings.standings.find((r) => r.teamId === teamId);
  if (row === undefined || standings.throughWeek === null) return null;
  return `Record ${row.record}, ${row.rank} of ${standings.standings.length}${row.streak === null ? '' : `, streak ${row.streak}`}, ${pts(row.pointsFor)} points for and ${pts(row.pointsAgainst)} against through week ${standings.throughWeek}.`;
}

function recentLine(standings: Standings, teamId: string): string | null {
  const row = standings.standings.find((r) => r.teamId === teamId);
  const results = row?.results ?? [];
  if (results.length === 0) return null;
  const name = (id: string) => clean(standings.standings.find((r) => r.teamId === id)?.teamName ?? id, 28);
  return `Last games: ${results
    .slice(-3)
    .reverse()
    .map(
      (g) =>
        `week ${g.week} ${g.result} vs ${name(g.opponentTeamId)} ${pts(g.pointsFor)}-${pts(g.pointsAgainst)}`
    )
    .join('; ')}.`;
}

function matchupLine(m: z.infer<typeof MatchupSchema>, teamId: string): string | null {
  if (m.matchup === null) return null;
  const home = m.matchup.home.teamId === teamId;
  const us = home ? m.matchup.home : m.matchup.away;
  const them = home ? m.matchup.away : m.matchup.home;
  const live = m.lineups === null ? null : home ? m.lineups : { home: m.lineups.away, away: m.lineups.home };
  const score =
    m.matchup.status === 'scheduled'
      ? 'not started'
      : `${pts(live?.home.points ?? us.score)}-${pts(live?.away.points ?? them.score)} (${m.matchup.status.replace('_', ' ')})`;
  return `Week ${m.week}: vs ${clean(them.teamName)}, ${score}.`;
}

function rosterLines(roster: z.infer<typeof RosterSchema>): string[] {
  const describe = (p: z.infer<typeof PlayerSchema>, withSlot: boolean) => {
    const flags = [
      ...(p.onBye === true ? ['BYE'] : []),
      ...(p.injuryStatus === null || p.injuryStatus === undefined ? [] : [clean(p.injuryStatus, 12)])
    ];
    const numbers = [
      ...(p.points === null || p.points === undefined ? [] : [`${pts(p.points)} pts`]),
      ...(p.projectedPoints === null || p.projectedPoints === undefined
        ? []
        : [`proj ${pts(p.projectedPoints)}`]),
      ...(p.recentPoints === null || p.recentPoints === undefined
        ? []
        : [`avg ${pts(p.recentPoints.average)}`])
    ];
    return `${withSlot ? `${p.slot} ` : ''}${clean(p.player.name, 24)} (${p.player.position}${p.player.team ? ` ${p.player.team}` : ''})${
      numbers.length === 0 ? '' : ` ${numbers.join(', ')}`
    }${flags.length === 0 ? '' : ` [${flags.join(', ')}]`}`;
  };
  const starters = roster.players.filter((p) => p.slot !== 'BN' && p.slot !== 'IR');
  const bench = roster.players.filter((p) => p.slot === 'BN' || p.slot === 'IR');
  return [
    ...(starters.length === 0
      ? []
      : [`Week ${roster.week} starters: ${starters.map((p) => describe(p, true)).join('; ')}.`]),
    ...(bench.length === 0 ? [] : [`Bench: ${bench.map((p) => describe(p, p.slot === 'IR')).join('; ')}.`])
  ];
}

/**
 * The dossier lines: the team talked to (`teamId`, null for none), then the agent's own team in
 * one line. Empty when nothing could be read.
 */
export async function teamDossier(ctx: TaskContext, teamId: string | null): Promise<string[]> {
  const self = ctx.principal.teamId;
  const standings = await read(ctx, 'get_standings', { detail: true }, StandingsSchema);
  const summary: string[] = [];
  let roster: string[] = [];
  if (teamId !== null && teamId !== self) {
    const matchup = await read(ctx, 'get_matchup', { teamId }, MatchupSchema);
    const players = await read(ctx, 'get_roster', { teamId }, RosterSchema);
    summary.push(
      ...[
        standings === null ? null : standingLine(standings, teamId),
        standings === null ? null : recentLine(standings, teamId),
        matchup === null ? null : matchupLine(matchup, teamId)
      ].filter((l): l is string => l !== null)
    );
    roster = players === null ? [] : rosterLines(players);
  }
  const own = await read(ctx, 'get_matchup', {}, MatchupSchema);
  const mine = [
    standings === null ? null : standingLine(standings, self),
    own === null ? null : matchupLine(own, self)
  ].filter((l): l is string => l !== null);
  const lines: string[] = [];
  if (summary.length + roster.length > 0) {
    const name = clean(standings?.standings.find((r) => r.teamId === teamId)?.teamName ?? teamId ?? '');
    lines.push(`The team you are talking to, ${name} (${teamId}):`, ...summary);
  }
  // Your own line before the long roster lines: the budget drops lines from the end.
  if (mine.length > 0) lines.push(`Your own team: ${mine.join(' ')}`);
  // Roster lines are only ever the other team's: "Their week 6 starters: …", "Their bench: …".
  lines.push(...roster.map((l) => `Their ${l.charAt(0).toLowerCase()}${l.slice(1)}`));
  return fitLines(lines, DOSSIER_MAX_CHARS);
}
