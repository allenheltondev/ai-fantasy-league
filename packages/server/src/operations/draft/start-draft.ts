import {
  createDraft,
  deadlineFor,
  draftRoundsFor,
  LAST_NFL_WEEK,
  leagueWeeks,
  parseLeagueSettings,
  randomizeAgentSeats,
  seededRandom,
  seededShuffle,
  type AgentSeatConfig,
  type LeagueSettings
} from '@fantasy/core';
import { z } from 'zod';
import { principalKey } from '../../auth/principal.js';
import type { Ctx } from '../../context.js';
import { ApiError } from '../../errors.js';
import { requireCommissioner } from '../../league/access.js';
import { nextUnlockedWeek } from '../../league/calendar.js';
import { announceTurn } from '../../league/draft.js';
import { cancelDraftSchedule } from '../../league/draft-schedule.js';
import { assertAction, transitionPhase } from '../../league/phase.js';
import { startSeasonSchedule } from '../../league/schedule.js';
import { settingsError } from '../../league/settings.js';
import { LeagueIdSchema, TeamIdSchema } from '../../league/views.js';
import { defineOperation, withWarnings, type Warning } from '../../registry/operation.js';
import { agentIdFor } from '../../repos/agents.js';
import type { DraftRecord, League, Team } from '../../repos/types.js';
import { buildBoard, DraftBoardSchema } from './board.js';

export const startDraft = defineOperation({
  name: 'start_draft',
  method: 'POST',
  path: '/leagues/{leagueId}/draft/start',
  summary: 'Start the draft now (commissioner only)',
  description: [
    'Starts the snake draft: the league moves from setup to drafting, the regular-season schedule is generated, and the first team is on the clock. Each team gets `settings.draft.pickSeconds` per pick; when the clock runs out, autopick picks for them.',
    "Round-1 order is the seats' draft slots, unless you pass `order` (every team id once) or `randomizeOrder: true`.",
    "Every seat must be taken: open human seats return SEATS_NOT_FILLED (invite someone, or make the seat an agent seat with set_seat_type). Agent seats without a configured agent get a random one. If the league's start week has already kicked off, the league starts with the next open week instead (a START_WEEK_MOVED warning).",
    'If the draft is scheduled (`settings.draft.scheduledAt`), it starts by itself at that time; calling this starts it now instead and cancels the scheduled start.',
    'Only the commissioner can call this, and only in setup. Starting a draft twice returns PHASE_NOT_ALLOWED.'
  ].join(' '),
  tags: ['draft'],
  mutation: true,
  auth: 'user',
  input: z.object({
    leagueId: LeagueIdSchema,
    order: z
      .array(TeamIdSchema)
      .optional()
      .describe('Round-1 draft order: every team id exactly once. Default: the draft slots.'),
    randomizeOrder: z
      .boolean()
      .default(false)
      .describe('Shuffle the round-1 order. Ignored when `order` is given.')
  }),
  output: DraftBoardSchema,
  handler: async (ctx, input) => {
    const access = await requireCommissioner(ctx, input.leagueId);
    assertAction('start_draft', access.league, access.actor, ctx.clock.now());
    const started = await startLeagueDraft(ctx, {
      league: access.league,
      teams: access.teams,
      order: input.order,
      randomize: input.randomizeOrder,
      by: principalKey(ctx.principal)
    });
    const board = await buildBoard(ctx, {
      record: started.record,
      teams: await ctx.repos.teams.list(access.league.id),
      settings: started.settings,
      yourTeamId: access.actor.kind === 'user' ? (access.actor.team?.id ?? null) : null,
      query: {}
    });
    return withWarnings(board, started.warnings);
  }
});

/** What the draft start needs: a request context, or the scheduled start's services. */
export type StartDraftDeps = Pick<Ctx, 'repos' | 'events' | 'clock' | 'log' | 'data'>;

export interface StartedDraft {
  record: DraftRecord;
  settings: LeagueSettings;
  warnings: Warning[];
}

/**
 * Starts a league's draft: the one path behind `start_draft` and the scheduled start
 * (`handleDraftStartScheduled`). Checks every seat is taken, moves a start week that has kicked
 * off, creates the draft, moves the league to drafting, builds the schedule, fills agent seats,
 * cancels any scheduled start, and puts the first team on the clock. `by` is who started it
 * (`user#<sub>` or `system`).
 */
export async function startLeagueDraft(
  deps: StartDraftDeps,
  input: {
    league: League;
    teams: readonly Team[];
    order?: readonly string[] | undefined;
    randomize: boolean;
    by: string;
  }
): Promise<StartedDraft> {
  const ctx = deps;
  const { league, teams } = input;
  const now = ctx.clock.now();
  const warnings: Warning[] = [];
  if (teams.length !== league.settings.teamCount) {
    throw new ApiError(
      'CONFLICT',
      `The league has ${teams.length} seats but its settings say ${league.settings.teamCount} teams.`,
      {
        fix: `Set teamCount to ${teams.length} with update_league_settings (or add seats) so every seat drafts.`
      }
    );
  }
  const open = teams.filter((t) => t.seatType === 'human' && t.ownerUserId === null);
  if (open.length > 0) {
    throw new ApiError(
      'SEATS_NOT_FILLED',
      `${open.length} human seat(s) are still open: ${open.map((t) => t.name).join(', ')}.`,
      {
        fix: 'Invite people to those seats (create_invite) and wait for them to join, or turn them into agent seats with set_seat_type, then start the draft.',
        details: { openTeamIds: open.map((t) => t.id) }
      }
    );
  }
  const settings = await playableSettings(ctx, league, now, warnings);
  const order = draftOrder(teams, input.order, input.randomize, `${league.id}:${now.toISOString()}`);
  const created = createDraft({
    teamIds: order,
    rounds: draftRoundsFor(settings),
    pickSeconds: settings.draft.pickSeconds
  });
  /* v8 ignore next -- the order has every team once and settings are valid, so createDraft cannot fail */
  if (!created.ok) throw settingsError(created.issues);

  // The draft item first (attribute_not_exists guards a double start), then the league. A start
  // interrupted between the two is finished by the next call, which finds the draft already made.
  const at = now.toISOString();
  const existing = await ctx.repos.drafts.get(league.id);
  let record: DraftRecord;
  if (existing === null) {
    record = {
      leagueId: league.id,
      state: created.value,
      status: 'in_progress',
      startedAt: at,
      deadline: (deadlineFor(created.value, now) as Date).toISOString(),
      pausedRemainingSeconds: null,
      completedAt: null,
      updatedAt: at,
      version: 1
    };
    await ctx.repos.drafts.create(record);
  } else {
    record = await restart(ctx, existing, now);
  }

  const updated = await ctx.repos.leagues.update({
    ...transitionPhase(league, 'drafting', now),
    settings,
    deadlines: { ...league.deadlines, draftStartsAt: record.startedAt }
  });
  await startSeasonSchedule(ctx, updated);
  await renumberSlots(ctx, teams, record.state.teamIds, now);
  const filled = await fillAgentSeats(ctx, league.id, teams, input.by);
  if (filled > 0) {
    warnings.push({
      code: 'AGENT_SEATS_FILLED',
      message: `${filled} agent seat(s) had no agent configured and got a random one (see get_agent_seat).`
    });
  }
  // A manual start supersedes a scheduled one.
  await cancelDraftSchedule(ctx, league.id);
  await announceTurn(ctx, record);
  return { record, settings, warnings };
}

/** A draft left by an interrupted start: its clock restarts now. */
async function restart(ctx: StartDraftDeps, record: DraftRecord, now: Date): Promise<DraftRecord> {
  const at = now.toISOString();
  return ctx.repos.drafts.update({
    ...record,
    startedAt: at,
    deadline: (deadlineFor({ ...record.state, picks: [] }, now) as Date).toISOString(),
    updatedAt: at
  });
}

/**
 * The settings the league will play under. A start week that has already kicked off moves to the
 * next open week (issue #85), and must still come before the trade deadline.
 */
async function playableSettings(
  ctx: StartDraftDeps,
  league: League,
  now: Date,
  warnings: Warning[]
): Promise<LeagueSettings> {
  const next = await nextUnlockedWeek(ctx.data.nflState, now, ctx.log);
  const current = league.settings.schedule.startWeek;
  const nextWeek = Math.min(next.week, LAST_NFL_WEEK);
  if (next.season !== league.season || current >= nextWeek) return league.settings;
  const parsed = parseLeagueSettings({
    ...league.settings,
    schedule: { ...league.settings.schedule, startWeek: nextWeek }
  });
  const weeks = parsed.ok ? leagueWeeks(parsed.settings) : null;
  if (!parsed.ok || weeks === null || !weeks.ok) {
    throw new ApiError(
      'INVALID_SETTINGS',
      `Week ${current} has kicked off, and week ${nextWeek} is too late to start this league.`,
      {
        fix: `Move the trade deadline (trades.deadlineWeek) and the regular-season end past week ${nextWeek} with update_league_settings, then start the draft.`,
        details: { startWeek: current, nextOpenWeek: nextWeek }
      }
    );
  }
  warnings.push({
    code: 'START_WEEK_MOVED',
    message: `Week ${current} has already kicked off, so the league starts in week ${nextWeek}.`
  });
  return parsed.settings;
}

function draftOrder(
  teams: readonly Team[],
  order: readonly string[] | undefined,
  randomize: boolean,
  seed: string
): string[] {
  const ids = teams.map((t) => t.id);
  if (order !== undefined) {
    const valid =
      order.length === ids.length &&
      new Set(order).size === ids.length &&
      order.every((id) => ids.includes(id));
    if (!valid) {
      throw new ApiError('INVALID_INPUT', '`order` must list every team id exactly once.', {
        fix: `Pass all ${ids.length} team ids once each, in round-1 order: ${ids.join(', ')}.`
      });
    }
    return [...order];
  }
  return randomize ? seededShuffle(ids, seededRandom(seed)) : ids;
}

/** Draft slots follow the round-1 order, so the league views show it. */
async function renumberSlots(
  ctx: StartDraftDeps,
  teams: readonly Team[],
  order: readonly string[],
  now: Date
): Promise<void> {
  for (const team of teams) {
    const slot = order.indexOf(team.id) + 1;
    if (team.draftSlot === slot) continue;
    await ctx.repos.teams.update({ ...team, draftSlot: slot, updatedAt: now.toISOString() });
  }
}

/** Gives every agent seat without a configured agent a random one, so every agent team drafts. */
async function fillAgentSeats(
  ctx: StartDraftDeps,
  leagueId: string,
  teams: readonly Team[],
  by: string
): Promise<number> {
  const configured = new Set((await ctx.repos.agents.listSeats(leagueId)).map((s) => s.teamId));
  const missing = teams.filter(
    (t) => t.seatType === 'agent' && t.ownerUserId === null && !configured.has(t.id)
  );
  const configs = randomizeAgentSeats(missing.length, `${leagueId}:draft`);
  for (const [i, team] of missing.entries()) {
    await ctx.repos.agents.putSeat({
      leagueId,
      teamId: team.id,
      agentId: agentIdFor(leagueId, team.id),
      config: configs[i] as AgentSeatConfig,
      version: 1,
      updatedAt: ctx.clock.now().toISOString(),
      updatedBy: by
    });
  }
  return missing.length;
}
