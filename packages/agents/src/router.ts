import { canonicalEvent, scheduleName } from '@fantasy/server';
import { banterContinues, banterVerdict, hashString, isDmRoomId, resolveAgentConfig } from '@fantasy/core';
import {
  AGENT_CHAT_BUDGETS,
  agentChatBudget,
  listInSeason,
  type AgentSeatRecord,
  type EventDetailOf,
  type FantasyEventType,
  type Services
} from '@fantasy/server';
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
 * | Waiver Window Opened (once per league week)  | waivers        | every agent team in the league          | no     |
 * | Trade Proposed / Trade Countered             | trade_response | `detail.toTeamId` (the team to answer)  | yes    |
 * | Trade Accepted (league-vote review)          | trade_vote     | agent teams not in the trade            | yes    |
 * | Week Rolled Over (once per league week)      | trade_proposal | every agent team in the league          | no     |
 * | Player News Alert                            | lineup         | teams rostering any `detail.playerIds`  | no     |
 * | Player Status Changed                        | lineup         | teams rostering `detail.playerId`       | no     |
 * | Lineup Lock Approaching                      | lineup         | every agent team in the league          | yes    |
 * | Chat Mention (any room; every DM message)    | chat_reply     | `detail.mentionedTeamIds` (see banter)  | no     |
 * | Chat Moment                                  | chat_moment    | up to 2 agent teams, picked by event id | no     |
 * | Draft Completed (once per draft)             | post_draft     | every agent team, staggered             | yes    |
 *
 * The post-draft kickoff (#175) is one task per agent: it sets the lineup, posts one draft reaction
 * in the league chat, and scans for roster holes; a high-appetite archetype then takes one early
 * trade look (a follow-up task, see tasks/post-draft.ts). Its rule has a `delay`: each agent's task
 * is scheduled (`scheduleAt`) rather than published, spaced out (`POST_DRAFT_KICKOFF`), so the
 * agents do not all fire at once, nor on top of the draft's last pick. A replayed or recovered
 * `Draft Completed` (the stalled-draft watchdog finishing a draft) is a `repeat`: the once-per key
 * is the draft's completion time.
 *
 * Chat tasks carry the `roomId` of the mention or moment and answer there. A matchup-room moment
 * (`detail.teamIds`) goes to the agents playing in that game when there are any.
 *
 * Rules read the typed event contract (`EventDetailOf` from `@fantasy/server`), so a field an
 * emitter does not send fails typecheck here. The cross-stream contract suite
 * (`test/contract/events.test.ts`) feeds real emitter details through this router.
 *
 * Gating, in order: the team must have an agent seat; the task kind must be registered (kinds
 * not built yet are skipped, so feature streams turn triggers on by registering a kind); a `oncePer`
 * rule fires once per league and key (waiver windows: once per league week, though the waivers job
 * opens one every day); non-urgent triggers respect the difficulty's cooldown, kept per agent and
 * task kind (`cooldownSlot`), so a waiver look never delays a lineup decision. Chat triggers have their own cooldowns instead
 * (`CHAT_COOLDOWNS`: per agent, and per league for chat moments), so banter never delays a waiver
 * or lineup decision. Per-trigger action budgets are enforced when the task runs (the tool binding
 * stops mutations at `actionsPerTrigger`). Every decision is logged.
 *
 * Agent-to-agent banter (#153): a mention in a message written by an agent triggers a retort only
 * when the thread is still shallow (`replyToAgentDepth` below `BANTER_LIMITS.maxTriggerDepth`; each
 * retort is posted as a reply, one deeper, so a spat ends after a few rounds), the room is not a DM, the league's daily banter
 * budget is not used up (`banterRemaining`, counted server-side), and the mentioned agent's
 * personality bites (`banter` propensity, a roll seeded by the event and team, so it replays the
 * same). People come first: a retort yields while the agent is answering a person (its chat slot
 * fired within the reply cooldown), and it keeps its own cooldown slot (`CHAT_COOLDOWNS.banter`),
 * so it never spends the reply cooldown a person's mention needs. The daily chat budgets apply on
 * top (the chat task checks them). So two agents can never talk each other into an endless thread.
 */

/** What a rule reads: the event's contract detail, every field optional (details are untrusted). */
export type RuleDetail<T extends FantasyEventType> = Partial<EventDetailOf<T>>;

export interface TriggerRule<T extends FantasyEventType = FantasyEventType> {
  kind: string;
  urgent: boolean;
  /** Its own cooldown instead of the difficulty's (chat); may depend on the event (banter). */
  cooldown?: ChatCooldown | ((detail: RuleDetail<T>) => ChatCooldown);
  /**
   * A per-team gate checked before cooldowns (banter): null lets the team through, otherwise the
   * decision to log instead of a task.
   */
  admit?(input: AdmitInput<T>): Promise<GateDecision | null>;
  /**
   * Fire at most once per league per key (for example once per week): later events with the same
   * key are skipped (`repeat`). Undefined means no such limit.
   */
  oncePer?(detail: RuleDetail<T>): string | undefined;
  /**
   * Milliseconds to wait before the `index`-th affected team's task runs. When set, the task is
   * scheduled with `scheduleAt` instead of published, so a rule can stagger its teams.
   */
  delay?(index: number): number;
  /** Player events: the players whose rostering teams are affected (found through the roster index). */
  players?(detail: RuleDetail<T>): string[];
  /** Which of the league's agent teams this event affects (rules without `players`). */
  teams(detail: RuleDetail<T>, agentTeams: readonly string[], eventId: string): string[];
  payload(detail: RuleDetail<T>): Record<string, unknown>;
}

/** Why a rule's `admit` turned a team away. */
export type GateDecision = 'budget' | 'declined' | 'yield';

export interface AdmitInput<T extends FantasyEventType = FantasyEventType> {
  services: Services;
  detail: RuleDetail<T>;
  seat: AgentSeatRecord;
  leagueId: string;
  eventId: string;
  now: Date;
}

/** A rule with its cooldown worked out for one event. */
type ResolvedRule = Omit<TriggerRule, 'cooldown'> & { cooldown?: ChatCooldown };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const only = (ids: readonly (string | undefined)[], agentTeams: readonly string[]) => [
  ...new Set(ids.filter((id): id is string => id !== undefined && agentTeams.includes(id)))
];

/** How many agents may react to one chat moment. */
export const CHAT_MOMENT_AGENTS = 2;

export interface ChatCooldown {
  /** Trigger-state slot, so chat cooldowns are separate from decision cooldowns. */
  scope: string;
  /** Minimum minutes between two chat tasks for one agent. */
  agentMinutes: number;
  /** Minimum minutes between two triggers of this rule in one league. */
  leagueMinutes?: number;
}

/** Chat cooldowns, per agent and per league. Daily message budgets are enforced by the chat tasks. */
export const CHAT_COOLDOWNS = {
  reply: { scope: 'chat', agentMinutes: 2 },
  moment: { scope: 'chat', agentMinutes: 20, leagueMinutes: 10 },
  /** Retorts to other agents: a slot of their own, so they never hold up an answer to a person. */
  banter: { scope: 'banter', agentMinutes: 5 },
  /**
   * Answering a retort inside a spat already under way: no wait, so the two can go back and forth;
   * the depth cap and the daily budgets bound it. Same slot, so it still starts the banter cooldown.
   */
  rebuttal: { scope: 'banter', agentMinutes: 0 }
} as const satisfies Record<string, ChatCooldown>;

/**
 * Pacing of the post-draft kickoff (#175): the first agent goes a minute after the draft ends
 * (clear of the last pick and the recap), the rest follow at this spacing. The early trade look
 * follows its own agent's kickoff by `tradeLookMs`.
 */
export const POST_DRAFT_KICKOFF = { firstMs: 60_000, spacingMs: 45_000, tradeLookMs: 120_000 } as const;

/** A mention an agent wrote. */
function agentMention(d: RuleDetail<'Chat Mention'>): boolean {
  return d.authorType === 'agent';
}
/** A retort is possible only below the depth cap; a missing depth counts as deep, so it triggers nothing. */
const mentionDepth = (d: RuleDetail<'Chat Mention'>) =>
  typeof d.replyToAgentDepth === 'number' ? d.replyToAgentDepth : Number.POSITIVE_INFINITY;

/**
 * Banter gate for one mentioned agent: yields to a person first, then the league's banter budget,
 * then the personality's appetite (seeded by event and team).
 */
async function admitBanter(input: AdmitInput<'Chat Mention'>): Promise<GateDecision | null> {
  const { services, detail, seat, leagueId, eventId, now } = input;
  if (!agentMention(detail)) return null;
  const chat = await services.repos.agents.getTriggerState(
    leagueId,
    `${seat.agentId}#${CHAT_COOLDOWNS.reply.scope}`
  );
  if (
    chat !== null &&
    now.getTime() - new Date(chat.lastTriggeredAt).getTime() < CHAT_COOLDOWNS.reply.agentMinutes * 60_000
  )
    return 'yield';
  const activity = await services.repos.chat.activity(
    leagueId,
    new Date(now.getTime() - AGENT_CHAT_BUDGETS.windowMs).toISOString()
  );
  const verdict = banterVerdict({
    depth: mentionDepth(detail),
    roomId: str(detail.roomId) ?? '',
    banterRemaining: agentChatBudget(activity, seat.teamId, now).banterRemaining,
    propensity: resolveAgentConfig(seat.config).personality.banter,
    seed: `${eventId}:${seat.teamId}`
  });
  if (verdict === 'ok') return null;
  return verdict === 'budget' ? 'budget' : 'declined';
}

const tradeRule: TriggerRule<'Trade Proposed' | 'Trade Countered'> = {
  kind: 'trade_response',
  urgent: true,
  teams: (d, agents) => only([str(d.toTeamId)], agents),
  payload: (d) => ({ tradeId: d.tradeId, fromTeamId: d.fromTeamId })
};

type RuleMap = { readonly [T in FantasyEventType]?: TriggerRule<T> };

export const TRIGGER_RULES: RuleMap = {
  'Draft Turn Started': {
    kind: 'draft_pick',
    urgent: true,
    teams: (d, agents) => only([str(d.teamId)], agents),
    payload: (d) => ({ pick: d.pick, round: d.round, deadline: d.deadline })
  },
  // The waivers job opens a window every day; agents look once a week, on the first window of the
  // league's week (the run after the rollover).
  'Waiver Window Opened': {
    kind: 'waivers',
    urgent: false,
    oncePer: (d) => (typeof d.week === 'number' ? `week-${d.week}` : undefined),
    teams: (_d, agents) => [...agents],
    payload: (d) => ({ week: d.week, closesAt: d.closesAt })
  },
  'Trade Proposed': tradeRule,
  'Trade Countered': tradeRule,
  // Every agent team outside the trade reviews it while league voting is open (the vote itself is
  // deterministic; see tasks/trade-vote.ts). Urgent: the review period is short and votes must
  // not wait behind a cooldown.
  'Trade Accepted': {
    kind: 'trade_vote',
    urgent: true,
    teams: (d, agents) =>
      d.review === 'league_vote' && d.status === 'in_review'
        ? agents.filter((t) => !strs(d.teamIds).includes(t))
        : [],
    payload: (d) => ({ tradeId: d.tradeId })
  },
  // Agents shop for trades once a league week, paced by their archetype's trade appetite (the
  // task decides how many offers, if any). The NFL-wide rollover has no leagueId and routes nowhere.
  'Week Rolled Over': {
    kind: 'trade_proposal',
    urgent: false,
    oncePer: (d) => (typeof d.week === 'number' ? `week-${d.week}` : undefined),
    teams: (_d, agents) => [...agents],
    payload: (d) => ({ week: d.week })
  },
  'Player News Alert': {
    kind: 'lineup',
    urgent: false,
    players: (d) => strs(d.playerIds),
    teams: () => [],
    payload: (d) => ({ reason: 'news', playerId: strs(d.playerIds)[0], newsId: d.newsId, title: d.title })
  },
  'Player Status Changed': {
    kind: 'lineup',
    urgent: false,
    players: (d) => strs([d.playerId]),
    teams: () => [],
    payload: (d) => ({ reason: 'status', playerId: d.playerId })
  },
  'Lineup Lock Approaching': {
    kind: 'lineup',
    urgent: true,
    // A game window locks every team's players in it: every agent team checks its lineup.
    teams: (_d, agents) => [...agents],
    payload: (d) => ({ reason: 'lock', week: d.week })
  },
  'Chat Mention': {
    kind: 'chat_reply',
    urgent: false,
    cooldown: (d) =>
      agentMention(d)
        ? mentionDepth(d) > 0
          ? CHAT_COOLDOWNS.rebuttal
          : CHAT_COOLDOWNS.banter
        : CHAT_COOLDOWNS.reply,
    // An agent's mention reaches other agents only below the banter depth cap, outside a DM.
    teams: (d, agents) =>
      agentMention(d) && (!banterContinues(mentionDepth(d)) || isDmRoomId(str(d.roomId) ?? 'dm-'))
        ? []
        : only(
            strs(d.mentionedTeamIds).filter((id) => id !== d.authorTeamId),
            agents
          ),
    admit: admitBanter,
    payload: (d) => ({ messageId: d.messageId, roomId: d.roomId })
  },
  'Chat Moment': {
    kind: 'chat_moment',
    urgent: false,
    cooldown: CHAT_COOLDOWNS.moment,
    teams: (d, agents, eventId) => {
      const playing = only(strs(d.teamIds), agents);
      return [...(playing.length > 0 ? playing : agents)]
        .sort((a, b) => hashString(`${eventId}:${a}`) - hashString(`${eventId}:${b}`) || a.localeCompare(b))
        .slice(0, CHAT_MOMENT_AGENTS);
    },
    payload: (d) => ({ moment: d.moment, subjectTeamId: d.teamId, messageId: d.messageId, roomId: d.roomId })
  },
  // The post-draft kickoff: once per draft, every agent team, one after another. Urgent: a
  // cooldown left by a lineup or chat task during the draft must not skip it.
  'Draft Completed': {
    kind: 'post_draft',
    urgent: true,
    oncePer: (d) => (typeof d.completedAt === 'string' ? `draft-${d.completedAt}` : undefined),
    teams: (_d, agents) => [...agents],
    delay: (index) => POST_DRAFT_KICKOFF.firstMs + index * POST_DRAFT_KICKOFF.spacingMs,
    payload: (d) => ({ week: d.week, completedAt: d.completedAt })
  }
};

/** Which league teams roster a player (`leagueRosterIndex` in production; events may also carry `rosteredBy`). */
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

/**
 * Rosters from the league tables: every in-season league's teams holding the player (two GSI2
 * phase queries plus one team query per league). A `rosteredBy` list on the event still wins.
 */
export function leagueRosterIndex(services: Services): RosterIndex {
  return {
    async teamsWithPlayer(playerId, detail) {
      const listed = await detailRosterIndex.teamsWithPlayer(playerId, detail);
      if (listed.length > 0) return listed;
      const found: { leagueId: string; teamId: string }[] = [];
      for (const league of await listInSeason(services.repos)) {
        for (const team of await services.repos.teams.list(league.id)) {
          if (team.roster.includes(playerId)) found.push({ leagueId: league.id, teamId: team.id });
        }
      }
      return found;
    }
  };
}

export type RouteDecision =
  | { teamId: string; leagueId: string; decision: 'requested'; taskId: string; kind: string }
  | {
      teamId: string;
      leagueId: string;
      decision: 'no_handler' | 'cooldown' | 'repeat' | GateDecision;
      kind: string;
    };

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
  event = canonicalEvent(event);
  const { services } = deps;
  const detailType = event['detail-type'];
  const log = services.log.child({ eventId: event.id, detailType });
  const raw = TRIGGER_RULES[detailType as FantasyEventType] as TriggerRule | undefined;
  const detail = (event.detail ?? {}) as RuleDetail<FantasyEventType>;
  if (raw === undefined || event.source !== 'fantasy') {
    log.info('agent trigger ignored', { reason: 'not_a_trigger' });
    return [];
  }
  const { cooldown, ...rest } = raw;
  const rule: ResolvedRule = {
    ...rest,
    ...(cooldown === undefined
      ? {}
      : { cooldown: typeof cooldown === 'function' ? cooldown(detail) : cooldown })
  };

  // (leagueId, seats) pairs this event touches.
  const targets: { leagueId: string; teams: string[] }[] = [];
  if (rule.players !== undefined) {
    const index = deps.rosterIndex ?? detailRosterIndex;
    const byLeague = new Map<string, Set<string>>();
    for (const playerId of new Set(rule.players(detail))) {
      for (const r of await index.teamsWithPlayer(playerId, detail as Record<string, unknown>)) {
        byLeague.set(r.leagueId, (byLeague.get(r.leagueId) ?? new Set()).add(r.teamId));
      }
    }
    for (const [leagueId, teams] of byLeague) targets.push({ leagueId, teams: [...teams] });
  } else {
    const leagueId = str((detail as { leagueId?: unknown }).leagueId);
    if (leagueId !== undefined) targets.push({ leagueId, teams: [] });
  }

  const decisions: RouteDecision[] = [];
  const now = services.clock.now();
  for (const target of targets) {
    const seats = await services.repos.agents.listSeats(target.leagueId);
    const agentTeams = seats.map((s) => s.teamId);
    const teams =
      rule.players !== undefined ? only(target.teams, agentTeams) : rule.teams(detail, agentTeams, event.id);
    const gate =
      teams.length === 0
        ? null
        : (await repeated(deps, rule, target.leagueId, detail, now))
          ? 'repeat'
          : (await leagueCooldown(deps, rule, target.leagueId, now))
            ? 'cooldown'
            : null;
    for (const [index, teamId] of teams.entries()) {
      if (gate !== null) {
        decisions.push({ teamId, leagueId: target.leagueId, decision: gate, kind: rule.kind });
        continue;
      }
      const seat = seats.find((s) => s.teamId === teamId) as AgentSeatRecord;
      const turnedAway =
        rule.admit === undefined || deps.kinds.get(rule.kind) === undefined
          ? null
          : await rule.admit({ services, detail, seat, leagueId: target.leagueId, eventId: event.id, now });
      if (turnedAway !== null) {
        decisions.push({ teamId, leagueId: target.leagueId, decision: turnedAway, kind: rule.kind });
        continue;
      }
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
      await requestTask(services, request, rule.delay?.(index));
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

/**
 * Sends a task to the runner: right away, or after `delayMs` through the deferred-event scheduler
 * (named by the task id, so a redelivered trigger moves the schedule instead of doubling it).
 */
export async function requestTask(
  services: Services,
  request: AgentActionRequested,
  delayMs?: number
): Promise<void> {
  if (delayMs === undefined) {
    await services.events.publish('Agent Action Requested', request);
    return;
  }
  await services.events.scheduleAt({
    at: new Date(services.clock.now().getTime() + delayMs),
    name: scheduleName('agent-task', request.taskId),
    whenPast: 'send',
    event: { detailType: 'Agent Action Requested', detail: request }
  });
}

/**
 * The agent's cooldown slot: one per agent and task kind, so a waiver look never delays a lineup
 * decision. Chat kinds share one chat slot (`CHAT_COOLDOWNS`).
 */
export function cooldownSlot(agentId: string, rule: Pick<ResolvedRule, 'kind' | 'cooldown'>): string {
  return `${agentId}#${rule.cooldown?.scope ?? rule.kind}`;
}

async function decide(
  deps: RouterDeps,
  rule: ResolvedRule,
  seat: AgentSeatRecord,
  now: Date
): Promise<'requested' | 'no_handler' | 'cooldown'> {
  if (deps.kinds.get(rule.kind) === undefined) return 'no_handler';
  const agents = deps.services.repos.agents;
  const slot = cooldownSlot(seat.agentId, rule);
  if (!rule.urgent) {
    const state = await agents.getTriggerState(seat.leagueId, slot);
    const minutes = rule.cooldown?.agentMinutes ?? resolveAgentConfig(seat.config).levers.cooldownMinutes;
    if (state !== null && now.getTime() - new Date(state.lastTriggeredAt).getTime() < minutes * 60_000)
      return 'cooldown';
  }
  await agents.putTriggerState({
    leagueId: seat.leagueId,
    agentId: slot,
    lastTriggeredAt: now.toISOString()
  });
  return 'requested';
}

/** True when the rule fired in this league too recently; otherwise starts a new league window. */
async function leagueCooldown(
  deps: RouterDeps,
  rule: ResolvedRule,
  leagueId: string,
  now: Date
): Promise<boolean> {
  const minutes = rule.cooldown?.leagueMinutes;
  if (minutes === undefined || deps.kinds.get(rule.kind) === undefined) return false;
  const agents = deps.services.repos.agents;
  const slot = `league#${rule.kind}`;
  const state = await agents.getTriggerState(leagueId, slot);
  if (state !== null && now.getTime() - new Date(state.lastTriggeredAt).getTime() < minutes * 60_000)
    return true;
  await agents.putTriggerState({ leagueId, agentId: slot, lastTriggeredAt: now.toISOString() });
  return false;
}

/** True when a `oncePer` rule already fired in this league for this key; otherwise records the key. */
async function repeated(
  deps: RouterDeps,
  rule: ResolvedRule,
  leagueId: string,
  detail: RuleDetail<FantasyEventType>,
  now: Date
): Promise<boolean> {
  const key = rule.oncePer?.(detail);
  if (key === undefined || deps.kinds.get(rule.kind) === undefined) return false;
  const agents = deps.services.repos.agents;
  const slot = `league#${rule.kind}#${key}`;
  if ((await agents.getTriggerState(leagueId, slot)) !== null) return true;
  await agents.putTriggerState({ leagueId, agentId: slot, lastTriggeredAt: now.toISOString() });
  return false;
}
