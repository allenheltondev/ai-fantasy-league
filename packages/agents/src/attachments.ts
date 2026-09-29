import {
  PositionSchema,
  activeAttachments,
  observePerformance,
  observeRoster,
  recordAcquisition,
  recordDeparture,
  type PlayerAttachments
} from '@fantasy/core';
import {
  EVENT_DETAIL_SCHEMAS,
  canonicalEvent,
  seatTenureStart,
  type Services,
  type Team
} from '@fantasy/server';
import { z } from 'zod';
import type { BusEvent } from './events.js';
import type { TaskContext } from './tasks/kinds.js';

/**
 * Player attachments in the runtime (#216). Core (`attachments.ts`) owns the state and the policy;
 * this file writes it from authoritative league records and hands it to trade decisions.
 *
 * - Creation (`recordAttachments`, from `ingestLeagueEvent`): `Draft Completed` reads the draft
 *   record and attaches each agent to the players it picked itself (never an autopick) during its
 *   own tenure and still rosters; `Trade Processed` attaches it to players it received and ends the
 *   attachment to players it sent or dropped. Each write is keyed by the pick or trade, so a
 *   redelivered event changes nothing. No model is involved and no chat text is read.
 * - Revision (`refreshAttachments`, before a trade decision): an authoritative roster read ends
 *   attachments to players who left, and the previous week's final results against projection
 *   (one `get_roster` read, only while something is held) revise conviction. Re-reading a week (a
 *   stat correction) replaces that week in core.
 * - Use: trade proposals, answers, and the check-in's trade scouting get the state on
 *   `ctx.attachments`; core `attachmentAdjustment` turns it into a capped bar premium.
 *
 * Failures are logged and never block ingestion or a decision: a task without attachments decides
 * exactly as before.
 */

/** Task kinds whose trade decisions read attachments (chat-sourced ones included: public evidence). */
export const ATTACHMENT_KINDS: ReadonlySet<string> = new Set([
  'trade_proposal',
  'trade_response',
  'check_in'
]);

/** League events that create or end attachments; both are already ingested (routing or memory). */
export const ATTACHMENT_EVENTS = ['Draft Completed', 'Trade Processed'] as const;

interface Holder {
  team: Team;
  agentId: string;
  tenure: string;
}

/** The agent seated on each team now, with its tenure. Human seats hold no attachments. */
async function holders(services: Services, leagueId: string, teamIds: readonly string[]): Promise<Holder[]> {
  const seats = await services.repos.agents.listSeats(leagueId);
  const out: Holder[] = [];
  for (const teamId of teamIds) {
    const seat = seats.find((s) => s.teamId === teamId);
    const team = seat === undefined ? null : await services.repos.teams.get(leagueId, teamId);
    if (seat === undefined || team?.seatType !== 'agent') continue;
    out.push({ team, agentId: seat.agentId, tenure: seatTenureStart(team) });
  }
  return out;
}

/** True when a record from `at` belongs to the current occupant (a new occupant inherits nothing). */
const inTenure = (holder: Holder, at: string) => Date.parse(at) >= Date.parse(holder.tenure);

/**
 * Writes the attachments a league event creates or ends. Returns how many agents were updated.
 * Idempotent on redelivery (every source is keyed by its pick or trade and player).
 */
export async function recordAttachments(services: Services, event: BusEvent): Promise<number> {
  event = canonicalEvent(event);
  if (event.source !== 'fantasy') return 0;
  const detailType = event['detail-type'];
  if (detailType === 'Draft Completed') {
    const parsed = EVENT_DETAIL_SCHEMAS['Draft Completed'].safeParse(event.detail);
    if (!parsed.success) return 0;
    const { leagueId } = parsed.data;
    const draft = await services.repos.drafts.get(leagueId);
    if (draft === null) return 0;
    const picks = draft.state.picks;
    const agents = await holders(services, leagueId, [...new Set(picks.map((p) => p.teamId))]);
    const players = new Map(
      (await services.repos.players.getMany([...new Set(picks.map((p) => p.playerId))])).map((p) => [p.id, p])
    );
    let updated = 0;
    for (const holder of agents) {
      const mine = picks.filter(
        (p) =>
          p.teamId === holder.team.id &&
          !p.auto &&
          p.madeAt !== null &&
          inTenure(holder, p.madeAt) &&
          holder.team.roster.includes(p.playerId)
      );
      if (mine.length === 0) continue;
      await services.repos.agents.updateAttachments(leagueId, holder.agentId, holder.tenure, (state) =>
        mine.reduce<PlayerAttachments>((next, p) => {
          const position = PositionSchema.safeParse(p.positions[0] ?? players.get(p.playerId)?.position);
          if (!position.success) return next;
          return recordAcquisition(next, {
            sourceId: `draft:${leagueId}:${p.overall}`,
            kind: 'drafted',
            playerId: p.playerId,
            name: players.get(p.playerId)?.name ?? p.playerId,
            position: position.data,
            at: p.madeAt as string,
            round: p.round
          });
        }, state)
      );
      updated += 1;
    }
    return updated;
  }
  if (detailType === 'Trade Processed') {
    const parsed = EVENT_DETAIL_SCHEMAS['Trade Processed'].safeParse(event.detail);
    if (!parsed.success) return 0;
    const trade = parsed.data;
    const at = event.time ?? services.clock.now().toISOString();
    const sides = [
      {
        teamId: trade.fromTeamId,
        received: trade.toPlayers,
        sent: [...trade.fromPlayers, ...trade.fromDrops]
      },
      { teamId: trade.toTeamId, received: trade.fromPlayers, sent: [...trade.toPlayers, ...trade.toDrops] }
    ];
    const agents = await holders(services, trade.leagueId, [trade.fromTeamId, trade.toTeamId]);
    let updated = 0;
    for (const side of sides) {
      const holder = agents.find((h) => h.team.id === side.teamId);
      if (holder === undefined || !inTenure(holder, at)) continue;
      await services.repos.agents.updateAttachments(
        trade.leagueId,
        holder.agentId,
        holder.tenure,
        (state) => {
          let next = side.sent.reduce(
            (s, p) =>
              recordDeparture(s, {
                sourceId: `trade:${trade.tradeId}:out:${p.id}`,
                playerId: p.id,
                at,
                reason: `Traded away (${trade.tradeId}).`
              }),
            state
          );
          // Only players still on the roster: a later move already ended a late-arriving pickup.
          for (const p of side.received.filter((r) => holder.team.roster.includes(r.id)))
            next = recordAcquisition(next, {
              sourceId: `trade:${trade.tradeId}:${p.id}`,
              kind: 'traded_for',
              playerId: p.id,
              name: p.name,
              position: p.position,
              at
            });
          return next;
        }
      );
      updated += 1;
    }
    return updated;
  }
  return 0;
}

const LastWeekSchema = z.object({
  week: z.number().int(),
  players: z.array(
    z.object({
      player: z.object({ id: z.string() }),
      points: z.number().nullable(),
      projectedPoints: z.number().nullable(),
      game: z.object({ state: z.string() }).nullable().optional()
    })
  )
});

/**
 * The agent's attachments for this decision, revised from an authoritative roster read and last
 * week's final results. Undefined (and logged) when they cannot be read: the task decides without.
 * Adds no model call; one roster read, only while the agent holds an attachment.
 */
export async function refreshAttachments(
  services: Services,
  ctx: TaskContext
): Promise<PlayerAttachments | undefined> {
  try {
    const at = ctx.clock.now().toISOString();
    const team = await services.repos.teams.get(ctx.league.id, ctx.principal.teamId);
    // The runner read the league for this task; only the roster and seat need a fresh look.
    const league = ctx.league;
    if (team?.seatType !== 'agent') return undefined;
    const tenure = seatTenureStart(team);
    const { agents } = services.repos;
    const stored = await agents.getAttachments(league.id, ctx.seat.agentId, tenure);
    if (stored.preferences.every((p) => p.status !== 'held')) return stored;
    let observation: Parameters<typeof observePerformance>[1] | undefined;
    const lastWeek = (league.week ?? 0) - 1;
    const season = league.phase === 'regular_season' || league.phase === 'playoffs';
    if (
      season &&
      lastWeek >= league.settings.schedule.startWeek &&
      activeAttachments(stored, at).length > 0
    ) {
      const response = await ctx.tools.call('get_roster', { teamId: team.id, week: lastWeek });
      const read = 'error' in response ? null : LastWeekSchema.safeParse(response.data).data;
      if (read?.week === lastWeek)
        observation = {
          at,
          week: lastWeek,
          results: read.players.flatMap((p) =>
            p.game?.state === 'final' && p.points !== null && p.projectedPoints !== null
              ? [{ playerId: p.player.id, points: p.points, projected: p.projectedPoints }]
              : []
          )
        };
    }
    const revise = (current: PlayerAttachments) => {
      const held = observeRoster(current, { at, playerIds: team.roster });
      return observation === undefined ? held : observePerformance(held, observation);
    };
    // Most looks change nothing (core returns the same state): no write for those.
    if (revise(stored) === stored) return stored;
    return await agents.updateAttachments(league.id, ctx.seat.agentId, tenure, revise);
  } catch (error) {
    ctx.log.warn('agent attachments unavailable; deciding without them', { taskId: ctx.taskId, error });
    return undefined;
  }
}
