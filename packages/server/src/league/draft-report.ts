import {
  REPORT_CARD_GRADES,
  expectedWins,
  gradeForScore,
  isStarterSlot,
  lineupStdDev,
  optimizeLineup,
  pickValue,
  projectRecords,
  rankRecords,
  seasonPoints,
  slotCount,
  zScores,
  type ReportCardGrade,
  type Position,
  type ReportMatchup,
  type RosterPlayer,
  type WeekScore
} from '@fantasy/core';
import type { Ctx } from '../context.js';
import type { Player } from '../players/model.js';
import { loadResearch, type Research } from '../players/research.js';
import { toRosterPlayer } from '../season/lineups.js';
import type {
  DraftRecord,
  DraftReportCard,
  DraftReportTeam,
  League,
  SeatType,
  Team
} from '../repos/types.js';

/**
 * Draft report card inputs (post-draft grades and projected standings). Everything here is
 * deterministic: each drafted roster's best legal lineup, week by week, from this season's
 * projections; win odds for every scheduled matchup; and computed grades that stand in when the
 * model cannot grade (`computedReport`). The model's own grades and projections go through
 * `reconcileReport`, so whatever it answers, the published records add up across the league.
 */

export interface ReportPick {
  overall: number;
  round: number;
  playerId: string;
  name: string;
  position: Position;
  nflTeam: string | null;
  /** Consensus rank when picked (ADP stand-in), or null when unranked. */
  adp: number | null;
  /** Picks after ADP: positive when he fell to this pick, negative for a reach. */
  value: number | null;
  auto: boolean;
  /** Season projection under league scoring, or null when unprojected. */
  projectedPoints: number | null;
  lastSeasonPoints: number | null;
  /** Rank among drafted players at his position by projection, e.g. `RB7`. */
  positionRank: string | null;
  bye: number | null;
  /** The drafting agent's reasoning, when it gave one. */
  reason: string | null;
}

export interface ReportTeam {
  teamId: string;
  name: string;
  seatType: SeatType;
  managerName: string | null;
  draftSlot: number;
  picks: ReportPick[];
  /** Regular-season points from the best lineup each week. */
  projectedPoints: number;
  /** Average weekly starting-lineup projection. */
  weeklyAverage: number;
  /** Win probabilities summed over the schedule. */
  expectedWins: number;
  /** Sum of pick values against ADP (ranked picks only). */
  draftValue: number;
  /**
   * Starter-quality projection at each lineup position against the league average (1 = average),
   * from the top `slots` projections the team drafted there.
   */
  positionStrength: Partial<Record<Position, number>>;
}

export interface DraftReportInputs {
  leagueId: string;
  leagueName: string;
  season: number;
  firstWeek: number;
  lastWeek: number;
  schedule: ReportMatchup[];
  /** In draft order. */
  teams: ReportTeam[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Builds the report card inputs for a completed draft. */
export async function draftReportInputs(
  ctx: Pick<Ctx, 'repos' | 'data'>,
  league: League,
  record: DraftRecord
): Promise<DraftReportInputs> {
  const settings = league.settings;
  const [teams, matchups] = await Promise.all([
    ctx.repos.teams.list(league.id),
    ctx.repos.schedule.listMatchups(league.id)
  ]);
  const playerIds = [...new Set(record.state.picks.map((p) => p.playerId))];
  const [players, research] = await Promise.all([
    Promise.all(playerIds.map((id) => ctx.data.players.get(id))),
    loadResearch(ctx, settings.scoring, playerIds)
  ]);
  const playerBy = new Map(players.filter((p): p is Player => p !== null).map((p) => [p.id, p]));
  const firstWeek = settings.schedule.startWeek;
  const lastWeek = settings.schedule.regularSeasonEndWeek;
  const schedule = matchups
    .filter((m) => m.kind === 'regular' && m.week >= firstWeek && m.week <= lastWeek)
    .sort((a, b) => a.week - b.week || a.id.localeCompare(b.id))
    .map((m) => ({ week: m.week, homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId }));
  const weekly = new Map(playerIds.map((id) => [id, weeklyPoints(id, playerBy.get(id), research, settings)]));

  const order = record.state.teamIds;
  const teamBy = new Map(teams.map((t) => [t.id, t]));
  const scores = new Map<string, Map<number, WeekScore>>();
  const base = order.map((teamId) => {
    const picks = record.state.picks.filter((p) => p.teamId === teamId);
    // Season-long: this week's injury report would bench a player for every week, so everyone counts
    // as active and the weekly projections carry the expected absences.
    const roster: RosterPlayer[] = picks.map((p) => ({
      ...toRosterPlayer(p.playerId, playerBy.get(p.playerId)),
      status: 'active'
    }));
    const byWeek = new Map<number, WeekScore>();
    for (let week = firstWeek; week <= lastWeek; week++) {
      const points = Object.fromEntries(picks.map((p) => [p.playerId, weekly.get(p.playerId)!(week)]));
      const lineup = optimizeLineup(settings, roster, points);
      const starters = lineup.lineup.filter((e) => isStarterSlot(e.slot)).map((e) => points[e.playerId] ?? 0);
      byWeek.set(week, { projected: lineup.projectedPoints, stdDev: lineupStdDev(starters) });
    }
    scores.set(teamId, byWeek);
    const projectedPoints = round1([...byWeek.values()].reduce((a, s) => a + s.projected, 0));
    return { teamId, picks, projectedPoints, weeks: byWeek.size };
  });
  const expected = expectedWins(order, schedule, scores);

  const projectionOf = (id: string) => research.projection(id)?.points ?? null;
  const positionRanks = rankByPosition(record, projectionOf);
  const strength = positionStrength(league, record, projectionOf);
  return {
    leagueId: league.id,
    leagueName: league.name,
    season: league.season,
    firstWeek,
    lastWeek,
    schedule,
    teams: base.map(({ teamId, picks, projectedPoints, weeks }) => {
      const team = teamBy.get(teamId);
      const reportPicks: ReportPick[] = picks.map((p) => {
        const player = playerBy.get(p.playerId);
        const adp = p.adp ?? null;
        return {
          overall: p.overall,
          round: p.round,
          playerId: p.playerId,
          name: player?.name ?? p.playerId,
          position: p.positions[0] ?? player?.position ?? 'WR',
          nflTeam: player?.team ?? null,
          adp,
          value: pickValue(p.overall, adp),
          auto: p.auto,
          projectedPoints: projectionOf(p.playerId),
          lastSeasonPoints: research.lastSeason(p.playerId)?.points ?? null,
          positionRank: positionRanks.get(p.playerId) ?? null,
          bye: research.bye(player?.team ?? null),
          reason: p.reason ?? null
        };
      });
      return {
        teamId,
        name: team?.name ?? teamId,
        seatType: team?.seatType ?? 'human',
        managerName: managerName(team),
        draftSlot: team?.draftSlot ?? order.indexOf(teamId) + 1,
        picks: reportPicks,
        projectedPoints,
        weeklyAverage: round1(projectedPoints / Math.max(1, weeks)),
        expectedWins: round1(expected.get(teamId)!),
        draftValue: reportPicks.reduce((sum, p) => sum + (p.value ?? 0), 0),
        positionStrength: strength.get(teamId)!
      };
    })
  };
}

function managerName(team: Team | undefined): string | null {
  if (team === undefined) return null;
  return team.seatType === 'human' ? team.ownerName : null;
}

/**
 * A player's projected points for a week: his weekly projection, 0 on his bye, else his average
 * projected week (or last season's points per game when he has no projection).
 */
function weeklyPoints(
  playerId: string,
  player: Player | undefined,
  research: Research,
  settings: League['settings']
): (week: number) => number {
  const bye = research.bye(player?.team ?? null);
  const projection = research.projection(playerId);
  const byWeek = new Map<number, number>();
  let average = research.lastSeason(playerId)?.ppg ?? 0;
  if (projection !== null) {
    const scored = seasonPoints(settings.scoring, projection.lines.weeks).weekly;
    for (const w of scored) byWeek.set(w.week, w.points);
    const played = scored.filter((w) => w.week !== bye);
    if (played.length > 0) average = projection.points / played.length;
  }
  return (week) => (week === bye ? 0 : (byWeek.get(week) ?? average));
}

function rankByPosition(record: DraftRecord, projection: (id: string) => number | null): Map<string, string> {
  const byPosition = new Map<Position, { playerId: string; points: number }[]>();
  for (const pick of record.state.picks) {
    const position = pick.positions[0];
    const points = projection(pick.playerId);
    if (position === undefined || points === null) continue;
    const list = byPosition.get(position) ?? [];
    list.push({ playerId: pick.playerId, points });
    byPosition.set(position, list);
  }
  const ranks = new Map<string, string>();
  for (const [position, list] of byPosition) {
    list.sort((a, b) => b.points - a.points || a.playerId.localeCompare(b.playerId));
    list.forEach((entry, i) => ranks.set(entry.playerId, `${position}${i + 1}`));
  }
  return ranks;
}

function positionStrength(
  league: League,
  record: DraftRecord,
  projection: (id: string) => number | null
): Map<string, Partial<Record<Position, number>>> {
  const positions = [
    ...new Set(record.state.picks.map((p) => p.positions[0]).filter((p) => p !== undefined))
  ].filter((p) => slotCount(league.settings, p) > 0);
  const totals = new Map<string, Map<Position, number>>();
  for (const teamId of record.state.teamIds) {
    const byPosition = new Map<Position, number>();
    for (const position of positions) {
      const top = record.state.picks
        .filter((p) => p.teamId === teamId && p.positions[0] === position)
        .map((p) => projection(p.playerId) ?? 0)
        .sort((a, b) => b - a)
        .slice(0, slotCount(league.settings, position));
      byPosition.set(
        position,
        top.reduce((a, b) => a + b, 0)
      );
    }
    totals.set(teamId, byPosition);
  }
  const out = new Map<string, Partial<Record<Position, number>>>();
  for (const [teamId, byPosition] of totals) {
    const strength: Partial<Record<Position, number>> = {};
    for (const position of positions) {
      const all = [...totals.values()].map((t) => t.get(position) ?? 0);
      const mean = all.reduce((a, b) => a + b, 0) / Math.max(1, all.length);
      if (mean > 0) strength[position] = round2((byPosition.get(position) ?? 0) / mean);
    }
    out.set(teamId, strength);
  }
  return out;
}

/** A model's (or the computed) grade and projection for one team, before reconciliation. */
export interface TeamJudgement {
  teamId: string;
  grade: ReportCardGrade;
  headline: string;
  strengths: string[];
  weaknesses: string[];
  analysis: string;
  projectedWins: number;
  projectedRank: number;
}

/**
 * Turns per-team judgements into published report card teams: records that add up on the schedule
 * (the judged wins as targets) and ranks that follow records, with the judged ranking breaking ties.
 * Null when the judgements do not cover every team exactly once.
 */
export function reconcileReport(
  inputs: DraftReportInputs,
  judgements: readonly TeamJudgement[]
): DraftReportTeam[] | null {
  const ids = inputs.teams.map((t) => t.teamId);
  const byTeam = new Map(judgements.map((j) => [j.teamId, j]));
  if (judgements.length !== ids.length || byTeam.size !== ids.length || !ids.every((id) => byTeam.has(id)))
    return null;
  const records = projectRecords(
    ids,
    inputs.schedule,
    new Map(judgements.map((j) => [j.teamId, j.projectedWins]))
  );
  const preference = [...judgements]
    .sort((a, b) => a.projectedRank - b.projectedRank || b.projectedWins - a.projectedWins)
    .map((j) => j.teamId);
  const ranks = rankRecords(records, preference);
  return inputs.teams
    .map((team) => {
      const judged = byTeam.get(team.teamId)!;
      const record = records.find((r) => r.teamId === team.teamId)!;
      return {
        teamId: team.teamId,
        grade: judged.grade,
        headline: judged.headline,
        strengths: judged.strengths,
        weaknesses: judged.weaknesses,
        analysis: judged.analysis,
        projectedWins: record.wins,
        projectedLosses: record.losses,
        projectedRank: ranks.get(team.teamId)!,
        projectedPoints: team.projectedPoints,
        expectedWins: team.expectedWins
      };
    })
    .sort((a, b) => a.projectedRank - b.projectedRank);
}

const POSITION_NAMES: Partial<Record<Position, string>> = {
  QB: 'quarterback',
  RB: 'running back',
  WR: 'wide receiver',
  TE: 'tight end',
  K: 'kicker',
  DEF: 'defense'
};
const positionName = (p: Position) => POSITION_NAMES[p] ?? p;

/**
 * Computed judgements (the fallback, and the model's starting point): a grade from projected
 * points (75%) and draft value against ADP (25%), each as a z-score across the league; projected
 * wins from the schedule; strengths and weaknesses from position strength and the best and worst
 * values.
 */
export function computedJudgements(inputs: DraftReportInputs): TeamJudgement[] {
  const points = zScores(new Map(inputs.teams.map((t) => [t.teamId, t.projectedPoints])));
  const value = zScores(new Map(inputs.teams.map((t) => [t.teamId, t.draftValue])));
  const ranked = [...inputs.teams].sort(
    (a, b) => b.expectedWins - a.expectedWins || b.projectedPoints - a.projectedPoints
  );
  return inputs.teams.map((team) => {
    const score = 0.75 * (points.get(team.teamId) ?? 0) + 0.25 * (value.get(team.teamId) ?? 0);
    const grade = gradeForScore(score);
    const strengths = Object.entries(team.positionStrength) as [Position, number][];
    strengths.sort((a, b) => b[1] - a[1]);
    const best = strengths[0];
    const worst = strengths.at(-1);
    const valued = team.picks.filter((p) => p.value !== null && p.position !== 'K' && p.position !== 'DEF');
    const steal = [...valued].sort((a, b) => b.value! - a.value!)[0];
    const reach = [...valued].sort((a, b) => a.value! - b.value!)[0];
    const pros: string[] = [];
    const cons: string[] = [];
    if (best !== undefined && best[1] >= 1)
      pros.push(
        `Strong at ${positionName(best[0])}: ${Math.round((best[1] - 1) * 100)}% above the league average.`
      );
    if (steal !== undefined && steal.value! > 0)
      pros.push(`${steal.name} at pick ${steal.overall} was ${steal.value} spots after his ADP.`);
    if (worst !== undefined && worst !== best && worst[1] < 1)
      cons.push(
        `Thin at ${positionName(worst[0])}: ${Math.round((1 - worst[1]) * 100)}% below the league average.`
      );
    if (reach !== undefined && reach.value! < 0)
      cons.push(`${reach.name} at pick ${reach.overall} went ${-reach.value!} spots before his ADP.`);
    if (pros.length === 0) pros.push('A balanced roster without a glaring hole.');
    if (cons.length === 0) cons.push('No standout edge at any position.');
    const tier =
      REPORT_CARD_GRADES.indexOf(grade) <= 2
        ? 'a contender'
        : REPORT_CARD_GRADES.indexOf(grade) <= 8
          ? 'in the mix'
          : 'an uphill climb';
    return {
      teamId: team.teamId,
      grade,
      headline: `Projects for ${team.weeklyAverage} points a week: ${tier}.`,
      strengths: pros,
      weaknesses: cons,
      analysis:
        `${team.name} projects for ${team.projectedPoints} points over weeks ${inputs.firstWeek}-${inputs.lastWeek}, ` +
        `about ${team.expectedWins} expected wins on this schedule. ` +
        `Its picks landed a net ${team.draftValue >= 0 ? '+' : ''}${team.draftValue} spots against ADP.`,
      projectedWins: team.expectedWins,
      projectedRank: ranked.indexOf(team) + 1
    };
  });
}

/** The computed report card: the fallback when the model cannot grade. */
export function computedReport(
  inputs: DraftReportInputs,
  now: string,
  fallbackReason: string
): DraftReportCard {
  const teams = reconcileReport(inputs, computedJudgements(inputs))!;
  const top = teams[0];
  const name = (id: string | undefined) => inputs.teams.find((t) => t.teamId === id)?.name ?? '';
  return {
    leagueId: inputs.leagueId,
    status: 'ready',
    claimedUntil: null,
    source: 'computed',
    fallbackReason,
    modelKey: null,
    summary:
      top === undefined
        ? 'No teams to grade.'
        : `On projections alone, ${name(top.teamId)} comes out of the draft as the team to beat.`,
    teams,
    createdAt: now,
    updatedAt: now
  };
}
