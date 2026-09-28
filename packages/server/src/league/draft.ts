import {
  autopick,
  currentPick,
  deadlineFor,
  draftRecap,
  draftRosterIssue,
  formatDraftRecap,
  isComplete,
  LAST_NFL_WEEK,
  makePick,
  nextWaiverRun,
  notablePick,
  picksUntilTurn,
  teamPicks,
  type DraftablePlayer,
  type DraftRecap,
  type Position,
  type DraftPick,
  type DraftState,
  type PickSlot,
  type RuleIssue
} from '@fantasy/core';
import type { Ctx } from '../context.js';
import { ApiError, isApiError } from '../errors.js';
import { scheduleName } from '../events/schedule-name.js';
import { toPlayerRef, type Player } from '../players/model.js';
import type { DraftRecord, League, Team } from '../repos/types.js';
import { startLeagueSeason } from '../season/cycle.js';
import { currentNflWeek } from './calendar.js';
import { transitionPhase } from './phase.js';

/**
 * The live draft (issues #46, #47): recording a pick (by a person, an agent, or the clock),
 * announcing the next turn with its deadline, and finishing the draft. The snake order, the clock
 * math, and autopick are pure functions in `@fantasy/core`; this file stores and announces them.
 */

/** What the draft needs from a request context. The pick-clock handler has no principal. */
export type DraftDeps = Pick<Ctx, 'repos' | 'events' | 'clock' | 'log' | 'data'>;

/** The longest reason a pick keeps (make_draft_pick `reason`). */
export const MAX_PICK_REASON = 280;

/** rsc-core schedule name for a pick's deadline: re-scheduling the same pick moves it. */
export function deadlineScheduleName(leagueId: string, overall: number): string {
  return scheduleName('draft', leagueId, overall);
}

export function requireDraft(record: DraftRecord | null): DraftRecord {
  if (record === null) {
    throw new ApiError('DRAFT_NOT_STARTED', 'The draft has not started yet.', {
      fix: 'Wait for the commissioner to start the draft (start_draft). get_league_state shows the phase.'
    });
  }
  return record;
}

/** Players who can be drafted: on an NFL roster and not inactive, best-ranked first. */
export async function draftPool(deps: DraftDeps): Promise<Player[]> {
  const all = await deps.data.players.all();
  return all
    .filter((p) => p.team !== null && p.status !== 'inactive')
    .sort(
      (a, b) =>
        (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id)
    );
}

export function draftable(player: Player): DraftablePlayer {
  return { playerId: player.id, positions: [player.position] };
}

function teamName(teams: readonly Team[], teamId: string): string {
  return teams.find((t) => t.id === teamId)?.name ?? teamId;
}

/** A core rule issue from `makePick` as an API error, with team names instead of ids. */
function pickError(issue: RuleIssue, state: DraftState, teams: readonly Team[], teamId: string): ApiError {
  const slot = currentPick(state);
  switch (issue.code) {
    case 'NOT_YOUR_TURN': {
      const until = picksUntilTurn(state, teamId);
      /* v8 ignore next -- makePick only reports NOT_YOUR_TURN while a pick is on the clock */
      const on = slot === null ? '' : teamName(teams, slot.teamId);
      return new ApiError('NOT_YOUR_TURN', `It is ${on}'s pick (round ${slot?.round}, pick ${slot?.pick}).`, {
        fix:
          until === null
            ? 'You have no picks left in this draft.'
            : `You pick in ${until} more pick(s). Queue players in the meantime and check get_draft_board again when you are on the clock.`,
        details: { onTheClock: slot?.teamId, picksUntilYourTurn: until }
      });
    }
    case 'PLAYER_ALREADY_DRAFTED': {
      const d = issue.details as { draftedBy: string; round: number; pick: number };
      return new ApiError(
        'PLAYER_ALREADY_DRAFTED',
        `That player was already drafted by ${teamName(teams, d.draftedBy)} (round ${d.round}, pick ${d.pick}).`,
        {
          fix: 'Pick someone still available: get_draft_board lists the best available players.',
          details: { ...d }
        }
      );
    }
    case 'ROSTER_POSITION_LIMIT':
      return new ApiError('ROSTER_POSITION_LIMIT', issue.message, { fix: issue.fix, details: issue.details });
    default:
      return new ApiError('DRAFT_COMPLETE', issue.message, { fix: issue.fix });
  }
}

export interface PickOutcome {
  record: DraftRecord;
  pick: DraftPick;
  completed: boolean;
}

/**
 * Records `teamId`'s pick of `player` with a version-checked write of the draft item. Of two
 * racing picks, the second gets CONFLICT (or NOT_YOUR_TURN once it re-reads). Then it syncs the
 * team's roster, emits `Draft Pick Made`, and either announces the next turn or finishes the draft.
 */
export async function recordPick(
  deps: DraftDeps,
  input: {
    league: League;
    teams: readonly Team[];
    record: DraftRecord;
    teamId: string;
    player: Player;
    auto: boolean;
    /** The overall pick the caller means to make; a pick that has passed is NOT_YOUR_TURN. */
    expectedPick?: number | undefined;
    /** Why the team made the pick (an agent's reasoning); kept for the recap and notable-pick chat. */
    reason?: string | undefined;
  }
): Promise<PickOutcome> {
  const { league, teams, record, teamId, player } = input;
  if (record.status === 'paused') {
    throw new ApiError('DRAFT_PAUSED', 'The commissioner paused the draft.', {
      fix: 'Wait for the commissioner to resume it (resume_draft); your pick clock is frozen until then.'
    });
  }
  const slot = currentPick(record.state);
  if (input.expectedPick !== undefined && slot !== null && slot.overall !== input.expectedPick) {
    const passed = slot.overall > input.expectedPick;
    throw new ApiError(
      'NOT_YOUR_TURN',
      `Pick ${input.expectedPick} is ${passed ? 'already made' : 'not up yet'}; pick ${slot.overall} is on the clock.`,
      {
        fix: 'Call get_draft_board for the current pick. Only pass `pick` for the pick you are on the clock for.',
        details: { onTheClock: slot.teamId, currentPick: slot.overall }
      }
    );
  }
  const now = deps.clock.now();
  const made = makePick(record.state, teamId, player.id, {
    positions: [player.position],
    now,
    auto: input.auto
  });
  if (!made.ok) throw pickError(made.issues[0] as RuleIssue, record.state, teams, teamId);
  const rosterIssue = draftRosterIssue(record.state, teamId, [player.position], league.settings);
  if (rosterIssue !== null) {
    throw new ApiError('ROSTER_WOULD_BE_INVALID', rosterIssue.message, {
      fix: rosterIssue.fix,
      details: rosterIssue.details
    });
  }

  // The pick keeps the player's rank at the time (the board's ADP stand-in) and the team's reason.
  const pick: DraftPick = {
    ...made.value.pick,
    adp: player.rank,
    ...(input.reason === undefined ? {} : { reason: input.reason })
  };
  const state: DraftState = {
    ...made.value.draft,
    picks: [...made.value.draft.picks.slice(0, -1), pick]
  };
  const completed = isComplete(state);
  const at = now.toISOString();
  const saved = await deps.repos.drafts.update({
    ...record,
    state,
    status: completed ? 'complete' : record.status,
    deadline: completed ? null : (deadlineFor(state, record.startedAt) as Date).toISOString(),
    completedAt: completed ? at : null,
    updatedAt: at
  });
  await syncRoster(deps, league.id, teamId, state, now);
  await deps.events.publish('Draft Pick Made', {
    leagueId: league.id,
    teamId,
    playerId: player.id,
    player: toPlayerRef(player),
    overall: pick.overall,
    round: pick.round,
    pick: pick.pick,
    auto: pick.auto,
    adp: player.rank,
    notable: notablePick({
      overall: pick.overall,
      round: pick.round,
      adp: player.rank,
      position: player.position,
      byAgent: isAgentSeat(teams, teamId),
      teamCount: state.teamIds.length
    }),
    reason: input.reason ?? null
  });
  if (completed) await finishDraft(deps, league.id, saved);
  else await announceTurn(deps, saved);
  return { record: saved, pick, completed };
}

/** Sets a team's roster to its draft picks. Idempotent; retries a version conflict. */
async function syncRoster(
  deps: DraftDeps,
  leagueId: string,
  teamId: string,
  state: DraftState,
  now: Date
): Promise<void> {
  const roster = teamPicks(state, teamId).map((p) => p.playerId);
  for (let attempt = 0; ; attempt++) {
    const team = await deps.repos.teams.get(leagueId, teamId);
    if (team === null || sameIds(team.roster, roster)) return;
    try {
      await deps.repos.teams.update({ ...team, roster, updatedAt: now.toISOString() });
      return;
    } catch (error) {
      if (!isApiError(error) || error.code !== 'CONFLICT' || attempt >= 2) throw error;
    }
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Emits `Draft Turn Started` for the pick on the clock and schedules its deadline. */
export async function announceTurn(deps: DraftDeps, record: DraftRecord): Promise<void> {
  const slot = currentPick(record.state);
  if (slot === null || record.deadline === null) return;
  await deps.events.publish('Draft Turn Started', {
    leagueId: record.leagueId,
    teamId: slot.teamId,
    pick: slot.overall,
    round: slot.round,
    pickInRound: slot.pick,
    deadline: record.deadline,
    pickSeconds: record.state.pickSeconds
  });
  await scheduleDeadline(deps, record);
}

/** (Re)schedules the current pick's deadline event. Same name, so a repeat moves it, never doubles it. */
export async function scheduleDeadline(deps: DraftDeps, record: DraftRecord): Promise<void> {
  const slot = currentPick(record.state);
  if (slot === null || record.deadline === null) return;
  await deps.events.scheduleAt({
    at: new Date(record.deadline),
    name: deadlineScheduleName(record.leagueId, slot.overall),
    whenPast: 'send',
    event: {
      detailType: 'Draft Pick Deadline',
      detail: { leagueId: record.leagueId, pick: slot.overall, deadline: record.deadline }
    }
  });
}

/**
 * Finishes a complete draft: every roster matches its picks, waiver priority is the reverse of the
 * draft order, and the league moves to the regular season at `max(startWeek, current NFL week)`.
 * Idempotent, so the pick-clock handler can finish a draft whose last pick was interrupted.
 */
export async function finishDraft(deps: DraftDeps, leagueId: string, record: DraftRecord): Promise<void> {
  const now = deps.clock.now();
  const order = record.state.teamIds;
  for (const teamId of order) {
    await syncRoster(deps, leagueId, teamId, record.state, now);
  }
  await setReverseDraftPriority(deps, leagueId, order, now);
  const current = await currentNflWeek(deps.data.nflState, now, deps.log);
  let started: League | null = null;
  let week = 0;
  for (let attempt = 0; started === null; attempt++) {
    const league = await deps.repos.leagues.get(leagueId);
    if (league === null || league.phase !== 'drafting') return;
    week = Math.min(
      Math.max(league.settings.schedule.startWeek, current.week),
      league.settings.schedule.regularSeasonEndWeek,
      LAST_NFL_WEEK
    );
    const postDraftWaiversUntil =
      league.settings.waivers.postDraftPlayers === 'waivers' ? nextWaiverRun(now) : null;
    try {
      started = await deps.repos.leagues.update({
        ...transitionPhase(league, 'regular_season', now),
        week,
        deadlines: { ...league.deadlines, postDraftWaiversUntil }
      });
    } catch (error) {
      if (!isApiError(error) || error.code !== 'CONFLICT' || attempt >= 2) throw error;
    }
  }
  // The season loop takes over: the first week's lineup lock and its lock warnings. Only the move
  // to the regular season above retries on a conflict; a failure here is not swallowed.
  await startSeasonWithRetry(deps, started, now);
  const recap = await recapDraft(deps, leagueId, record.state);
  await deps.events.publish('Draft Completed', {
    leagueId,
    picks: record.state.picks.length,
    rounds: record.state.rounds,
    week,
    completedAt: record.completedAt ?? now.toISOString(),
    recap: recap.recap,
    recapText: recap.text
  });
}

export function isAgentSeat(teams: readonly Team[], teamId: string): boolean {
  return teams.find((t) => t.id === teamId)?.seatType === 'agent';
}

/** The draft's steals, reaches, and each agent's first pick with its reasoning (core `draftRecap`). */
export function draftRecapOf(
  state: DraftState,
  teams: readonly Team[],
  players: ReadonlyMap<string, Pick<Player, 'position'>>
): DraftRecap {
  return draftRecap(
    state.picks.map((p) => ({
      overall: p.overall,
      round: p.round,
      teamId: p.teamId,
      playerId: p.playerId,
      position: players.get(p.playerId)?.position ?? (p.positions[0] as Position),
      adp: p.adp ?? null,
      reason: p.reason ?? null,
      byAgent: isAgentSeat(teams, p.teamId)
    })),
    state.teamIds.length
  );
}

async function recapDraft(
  deps: DraftDeps,
  leagueId: string,
  state: DraftState
): Promise<{ recap: DraftRecap; text: string }> {
  const [teams, all] = await Promise.all([deps.repos.teams.list(leagueId), deps.data.players.all()]);
  const players = new Map(all.map((p) => [p.id, p]));
  const recap = draftRecapOf(state, teams, players);
  const text = formatDraftRecap(recap, {
    team: (id) => teams.find((t) => t.id === id)?.name ?? id,
    player: (id) => players.get(id)?.name ?? id
  });
  return { recap, text };
}

/** Starts the season loop, re-reading the league when another write got to it first. */
async function startSeasonWithRetry(deps: DraftDeps, league: League, now: Date): Promise<void> {
  const seasonDeps = {
    repos: deps.repos,
    reference: deps.data.reference,
    events: deps.events,
    log: deps.log
  };
  let current = league;
  for (let attempt = 1; ; attempt++) {
    try {
      await startLeagueSeason(seasonDeps, current, now);
      return;
    } catch (error) {
      const latest = await deps.repos.leagues.get(league.id);
      if (
        !isApiError(error) ||
        error.code !== 'CONFLICT' ||
        attempt >= 3 ||
        latest === null ||
        latest.version === current.version
      ) {
        throw error;
      }
      current = latest;
    }
  }
}

/**
 * Waiver priority after the draft is the reverse of the draft order: the team that picked last in
 * round 1 claims first. `order` is the round-1 order the draft ran with (after any start_draft
 * reorder), not the teams' original slots.
 */
async function setReverseDraftPriority(
  deps: DraftDeps,
  leagueId: string,
  order: readonly string[],
  now: Date
): Promise<void> {
  for (const [index, teamId] of [...order].reverse().entries()) {
    for (let attempt = 0; ; attempt++) {
      const team = await deps.repos.teams.get(leagueId, teamId);
      if (team === null || team.waiverPriority === index + 1) break;
      try {
        await deps.repos.teams.update({ ...team, waiverPriority: index + 1, updatedAt: now.toISOString() });
        break;
      } catch (error) {
        if (!isApiError(error) || error.code !== 'CONFLICT' || attempt >= 2) throw error;
      }
    }
  }
}

/** What the pick-clock handler did with a deadline event. */
export type DeadlineOutcome = 'autopicked' | 'stale' | 'early' | 'paused' | 'completed' | 'ignored' | 'raced';

/**
 * Handles `Draft Pick Deadline`. If the pick is still open and its deadline has passed, autopick
 * (core `autopick`: fill an empty starting slot with the best-ranked player, else best available).
 * A deadline for a pick already made is a no-op, except that it re-asserts the current pick's
 * deadline, so a draft interrupted between a pick and its announcement cannot stall. A deadline that
 * fires early (the draft was paused and resumed) waits for the rescheduled one.
 */
export async function handleDraftDeadline(
  deps: DraftDeps,
  detail: { leagueId: string; pick: number }
): Promise<DeadlineOutcome> {
  const league = await deps.repos.leagues.get(detail.leagueId);
  const record = await deps.repos.drafts.get(detail.leagueId);
  if (league === null || record === null || league.phase !== 'drafting') return 'ignored';
  if (record.status === 'complete') {
    await finishDraft(deps, league.id, record);
    return 'completed';
  }
  if (record.status === 'paused') return 'paused';
  const slot = currentPick(record.state) as PickSlot;
  const now = deps.clock.now();
  const overdue = record.deadline !== null && now.getTime() >= new Date(record.deadline).getTime();
  if (!overdue) {
    await scheduleDeadline(deps, record);
    return slot.overall === detail.pick ? 'early' : 'stale';
  }
  const pool = await draftPool(deps);
  const byId = new Map(pool.map((p) => [p.id, p]));
  const choice = autopick(
    record.state,
    pool.map(draftable),
    pool.map((p) => p.id),
    league.settings
  );
  if (choice === null) {
    deps.log.error('autopick found no player', { leagueId: league.id, pick: slot.overall });
    return 'ignored';
  }
  const teams = await deps.repos.teams.list(league.id);
  try {
    await recordPick(deps, {
      league,
      teams,
      record,
      teamId: slot.teamId,
      player: byId.get(choice.playerId) as Player,
      auto: true
    });
  } catch (error) {
    if (isApiError(error) && error.code === 'CONFLICT') return 'raced';
    throw error;
  }
  deps.log.info('draft clock expired; autopicked', {
    leagueId: league.id,
    pick: slot.overall,
    teamId: slot.teamId,
    playerId: choice.playerId,
    reason: choice.reason
  });
  return 'autopicked';
}

/** Seconds left on the clock for the current pick (0 once the deadline passes). */
export function secondsLeft(record: DraftRecord, now: Date): number | null {
  if (record.status === 'paused') return record.pausedRemainingSeconds;
  if (record.deadline === null) return null;
  return Math.max(0, Math.ceil((new Date(record.deadline).getTime() - now.getTime()) / 1000));
}
