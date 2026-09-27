import { hashString, resolveAgentConfig } from '@fantasy/core';
import type { AgentSeatRecord, FantasyEventType, Services } from '@fantasy/server';
import { z } from 'zod';
import type { AgentActionRequested, BusEvent } from './events.js';
import type { TaskKindRegistry } from './tasks/kinds.js';

/**
 * The trigger router (issue #40): an EventBridge consumer that turns league events into
 * `Agent Action Requested` tasks, only for the agent teams an event affects. Agents act only on
 * triggers (SPEC §8).
 *
 * | Event                                        | Task kind      | Teams                                   | Urgent |
 * |----------------------------------------------|----------------|-----------------------------------------|--------|
 * | Draft Turn Started                           | draft_pick     | `detail.teamId` (on the clock)          | yes    |
 * | Waiver Window Opened                         | waivers        | every agent team in the league          | no     |
 * | Trade Proposed / Trade Countered             | trade_response | `detail.toTeamId` (the team to answer)  | yes    |
 * | Player News Alert / Player Status Changed    | lineup         | teams rostering `detail.playerId`       | no     |
 * | Lineup Lock Approaching                      | lineup         | `detail.teamIds`, else every agent team | yes    |
 * | Chat Mention                                 | chat_reply     | `detail.mentionedTeamIds`               | no     |
 * | Chat Moment                                  | chat_moment    | up to 2 agent teams, picked by event id | no     |
 *
 * Gating, in order: the team must have an agent seat; the task kind must be registered (kinds
 * not built yet are skipped, so feature streams turn triggers on by registering a kind); non-urgent
 * triggers respect the difficulty's cooldown. Per-trigger action budgets are enforced when the task
 * runs (the tool binding stops mutations at `actionsPerTrigger`). Every decision is logged.
 */

export interface TriggerRule {
  kind: string;
  urgent: boolean;
  /** Which of the league's agent teams this event affects. */
  teams(detail: Record<string, unknown>, agentTeams: readonly string[], eventId: string): string[];
  payload(detail: Record<string, unknown>): Record<string, unknown>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const only = (ids: readonly (string | undefined)[], agentTeams: readonly string[]) => [
  ...new Set(ids.filter((id): id is string => id !== undefined && agentTeams.includes(id)))
];

/** How many agents may react to one chat moment. */
export const CHAT_MOMENT_AGENTS = 2;

const tradeRule: TriggerRule = {
  kind: 'trade_response',
  urgent: true,
  teams: (d, agents) => only([str(d.toTeamId)], agents),
  payload: (d) => ({ tradeId: d.tradeId, fromTeamId: d.fromTeamId })
};

const newsRule: TriggerRule = {
  kind: 'lineup',
  urgent: false,
  // Filled in by the router from the roster index; see `teamsForPlayer`.
  teams: () => [],
  payload: (d) => ({ reason: str(d.status) === undefined ? 'news' : 'status', playerId: d.playerId })
};

export const TRIGGER_RULES: Readonly<Partial<Record<FantasyEventType, TriggerRule>>> = {
  'Draft Turn Started': {
    kind: 'draft_pick',
    urgent: true,
    teams: (d, agents) => only([str(d.teamId)], agents),
    payload: (d) => ({ pick: d.pick, round: d.round, deadline: d.deadline })
  },
  'Waiver Window Opened': {
    kind: 'waivers',
    urgent: false,
    teams: (_d, agents) => [...agents],
    payload: (d) => ({ week: d.week, closesAt: d.closesAt })
  },
  'Trade Proposed': tradeRule,
  'Trade Countered': tradeRule,
  'Player News Alert': newsRule,
  'Player Status Changed': newsRule,
  'Lineup Lock Approaching': {
    kind: 'lineup',
    urgent: true,
    teams: (d, agents) => (Array.isArray(d.teamIds) ? only(strs(d.teamIds), agents) : [...agents]),
    payload: (d) => ({ reason: 'lock', week: d.week })
  },
  'Chat Mention': {
    kind: 'chat_reply',
    urgent: false,
    teams: (d, agents) => only([...strs(d.mentionedTeamIds), str(d.teamId)], agents),
    payload: (d) => ({ messageId: d.messageId, channel: d.channel })
  },
  'Chat Moment': {
    kind: 'chat_moment',
    urgent: false,
    teams: (_d, agents, eventId) =>
      [...agents]
        .sort((a, b) => hashString(`${eventId}:${a}`) - hashString(`${eventId}:${b}`) || a.localeCompare(b))
        .slice(0, CHAT_MOMENT_AGENTS),
    payload: (d) => ({ moment: d.moment, subjectTeamId: d.teamId })
  }
};

/** Which league teams roster a player. Rosters land with the lineup stream; until then events may carry `rosteredBy`. */
export interface RosterIndex {
  teamsWithPlayer(
    playerId: string,
    detail: Record<string, unknown>
  ): Promise<{ leagueId: string; teamId: string }[]>;
}

const RosteredBySchema = z.array(z.object({ leagueId: z.string(), teamId: z.string() }));

/** Reads `detail.rosteredBy: [{ leagueId, teamId }]` from player events. */
export const detailRosterIndex: RosterIndex = {
  async teamsWithPlayer(_playerId, detail) {
    const parsed = RosteredBySchema.safeParse(detail.rosteredBy);
    return parsed.success ? parsed.data : [];
  }
};

export type RouteDecision =
  | { teamId: string; leagueId: string; decision: 'requested'; taskId: string; kind: string }
  | { teamId: string; leagueId: string; decision: 'no_handler' | 'cooldown'; kind: string };

export interface RouterDeps {
  services: Services;
  kinds: TaskKindRegistry;
  rosterIndex?: RosterIndex;
}

/** Stable, short task id for (event, team, kind). */
export function taskIdFor(eventId: string, teamId: string, kind: string): string {
  return `${kind}.${hashString(`${eventId}|${teamId}`).toString(36)}.${hashString(`${teamId}|${eventId}|${kind}`).toString(36)}`;
}

export async function routeEvent(deps: RouterDeps, event: BusEvent): Promise<RouteDecision[]> {
  const { services } = deps;
  const detailType = event['detail-type'];
  const log = services.log.child({ eventId: event.id, detailType });
  const rule = TRIGGER_RULES[detailType as FantasyEventType];
  const detail = (event.detail ?? {}) as Record<string, unknown>;
  if (rule === undefined || event.source !== 'fantasy') {
    log.info('agent trigger ignored', { reason: 'not_a_trigger' });
    return [];
  }

  // (leagueId, seats) pairs this event touches.
  const targets: { leagueId: string; teams: string[] }[] = [];
  if (rule === newsRule) {
    const playerId = str(detail.playerId);
    const rostered =
      playerId === undefined
        ? []
        : await (deps.rosterIndex ?? detailRosterIndex).teamsWithPlayer(playerId, detail);
    const byLeague = new Map<string, string[]>();
    for (const r of rostered) byLeague.set(r.leagueId, [...(byLeague.get(r.leagueId) ?? []), r.teamId]);
    for (const [leagueId, teams] of byLeague) targets.push({ leagueId, teams });
  } else {
    const leagueId = str(detail.leagueId);
    if (leagueId !== undefined) targets.push({ leagueId, teams: [] });
  }

  const decisions: RouteDecision[] = [];
  const now = services.clock.now();
  for (const target of targets) {
    const seats = await services.repos.agents.listSeats(target.leagueId);
    const agentTeams = seats.map((s) => s.teamId);
    const teams =
      rule === newsRule ? only(target.teams, agentTeams) : rule.teams(detail, agentTeams, event.id);
    for (const teamId of teams) {
      const seat = seats.find((s) => s.teamId === teamId) as AgentSeatRecord;
      const decision = await decide(deps, rule, seat, now);
      if (decision !== 'requested') {
        decisions.push({ teamId, leagueId: target.leagueId, decision, kind: rule.kind });
        continue;
      }
      const request: AgentActionRequested = {
        taskId: taskIdFor(event.id, teamId, rule.kind),
        leagueId: target.leagueId,
        teamId,
        agentId: seat.agentId,
        kind: rule.kind,
        trigger: { detailType, eventId: event.id, urgent: rule.urgent },
        payload: Object.fromEntries(Object.entries(rule.payload(detail)).filter(([, v]) => v !== undefined)),
        requestedAt: now.toISOString()
      };
      await services.events.publish('Agent Action Requested', request);
      decisions.push({
        teamId,
        leagueId: target.leagueId,
        decision: 'requested',
        taskId: request.taskId,
        kind: rule.kind
      });
    }
  }
  for (const d of decisions) log.info('agent trigger decision', { ...d, urgent: rule.urgent });
  if (decisions.length === 0)
    log.info('agent trigger decision', { decision: 'no_agent_teams', kind: rule.kind });
  return decisions;
}

async function decide(
  deps: RouterDeps,
  rule: TriggerRule,
  seat: AgentSeatRecord,
  now: Date
): Promise<'requested' | 'no_handler' | 'cooldown'> {
  if (deps.kinds.get(rule.kind) === undefined) return 'no_handler';
  const agents = deps.services.repos.agents;
  if (!rule.urgent) {
    const state = await agents.getTriggerState(seat.leagueId, seat.agentId);
    const cooldownMs = resolveAgentConfig(seat.config).levers.cooldownMinutes * 60_000;
    if (state !== null && now.getTime() - new Date(state.lastTriggeredAt).getTime() < cooldownMs)
      return 'cooldown';
  }
  await agents.putTriggerState({
    leagueId: seat.leagueId,
    agentId: seat.agentId,
    lastTriggeredAt: now.toISOString()
  });
  return 'requested';
}
