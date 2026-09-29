import {
  PlayerStatusSchema,
  PositionSchema,
  RosterSlotSchema,
  SLOT_ELIGIBILITY,
  rosterHoles,
  reconcileAgenda,
  type AgentAgenda,
  type LeagueSettings,
  type RosterSlot
} from '@fantasy/core';
import { seatTenureStart, type Services } from '@fantasy/server';
import { z } from 'zod';
import type { TaskContext } from './tasks/kinds.js';

/** Only tasks that manage the roster consume private operational priorities. */
export const AGENDA_KINDS = new Set([
  'check_in',
  'lineup',
  'waivers',
  'trade_proposal',
  'trade_response',
  'post_draft'
]);

const RosterSchema = z.object({
  week: z.number().int().positive(),
  players: z.array(
    z.object({
      player: z.object({ id: z.string(), position: PositionSchema }),
      status: PlayerStatusSchema,
      slot: RosterSlotSchema,
      kickoff: z.string().nullable(),
      game: z.object({ state: z.enum(['upcoming', 'live', 'final', 'bye']) }).optional()
    })
  )
});
type Roster = z.infer<typeof RosterSchema>;

/** Locked starters occupy their actual slots. Locked bench players cannot repair an open slot. */
export function agendaHoles(settings: LeagueSettings, roster: Roster, at: string): RosterSlot[] {
  const slots = { ...settings.roster.slots };
  const available = roster.players.filter((p) => {
    const locked =
      p.game?.state === 'live' ||
      p.game?.state === 'final' ||
      (p.kickoff !== null && Date.parse(p.kickoff) <= Date.parse(at));
    if (locked && p.slot !== 'BN' && p.slot !== 'IR') slots[p.slot] = Math.max(0, (slots[p.slot] ?? 0) - 1);
    return !locked && p.slot !== 'IR' && p.game?.state !== 'bye';
  });
  return rosterHoles(
    { roster: { ...settings.roster, slots } },
    available.map((p) => ({
      positions: [p.player.position],
      status: p.status
    }))
  );
}

/**
 * Reconcile from a fresh authorized roster read, never from model claims or previous prompt memory.
 * On an unavailable/stale read, preserve storage but withhold its priorities from this turn.
 * This adds no model call, action, follow-up task, or public output.
 */
export async function refreshAgenda(services: Services, ctx: TaskContext): Promise<AgentAgenda | undefined> {
  try {
    const at = ctx.clock.now().toISOString();
    const team = await services.repos.teams.get(ctx.league.id, ctx.principal.teamId);
    const league = await services.repos.leagues.get(ctx.league.id);
    if (team?.seatType !== 'agent' || league === null) return undefined;
    const tenure = seatTenureStart(team);
    if (league.phase === 'complete')
      return await services.repos.agents.updateAgenda(league.id, ctx.seat.agentId, tenure, (current) =>
        reconcileAgenda(current, { at, taskId: ctx.taskId, week: league.week, complete: true, holes: [] })
      );
    if (league.phase !== 'regular_season' && league.phase !== 'playoffs') return undefined;
    const response = await ctx.tools.call('get_roster', { teamId: team.id });
    if ('error' in response) return undefined;
    const roster = RosterSchema.parse(response.data);
    if (roster.week !== league.week) return undefined;
    // A move or takeover while reading invalidates this snapshot; the next turn will reconcile.
    const latest = await services.repos.teams.get(league.id, team.id);
    if (latest?.version !== team.version || latest.seatType !== 'agent' || seatTenureStart(latest) !== tenure)
      return undefined;
    const weights = ctx.config.valuation.positionWeights;
    const importance = (slot: RosterSlot) =>
      Math.max(...SLOT_ELIGIBILITY[slot].map((position) => weights?.[position] ?? 1));
    const holes = agendaHoles(league.settings, roster, at).sort(
      (a, b) => importance(b) - importance(a) || a.localeCompare(b)
    );
    return await services.repos.agents.updateAgenda(league.id, ctx.seat.agentId, tenure, (current) =>
      reconcileAgenda(current, { at, taskId: ctx.taskId, week: roster.week, complete: false, holes })
    );
  } catch (error) {
    // Missing agenda context cannot prevent a deadline-critical lineup from being set.
    ctx.log.warn('agent agenda unavailable; using current task facts', { taskId: ctx.taskId, error });
    return undefined;
  }
}
