import { canonicalEvent, type AgentDispatch, type TriggerGate } from '@fantasy/server';
import {
  CHECK_INS_PER_WEEK,
  IMMEDIATE_RESPONSE,
  agentMayRename,
  banterContinues,
  banterVerdict,
  hashString,
  isDmRoomId,
  isGenericTeamName,
  rebrandRoll,
  rebrandWindow,
  resolveAgentConfig,
  responseDelay,
  type DifficultyLevers,
  type ResponseDelayClass
} from '@fantasy/core';
import {
  AGENT_CHAT_BUDGETS,
  agentChatBudget,
  listInSeason,
  nextLockAt,
  teamNameSetBy,
  type AgentSeatRecord,
  type EventDetailOf,
  type FantasyEventType,
  type Services
} from '@fantasy/server';
import { z } from 'zod';
import { dispatchTask, sendDispatch, type DispatchOutcome } from './dispatch.js';
import type { AgentActionRequested, BusEvent } from './events.js';
import type { TaskKindRegistry } from './tasks/kinds.js';

/**
 * The trigger router (issue #40): an EventBridge consumer that turns league events into
 * `Agent Action Requested` tasks, only for the agent teams an event affects. Agents act only on
 * triggers (SPEC §8).
 *
 * | Event                                        | Task kind      | Teams                                   | Urgent | Delay (class, clamp)                   |
 * |----------------------------------------------|----------------|-----------------------------------------|--------|----------------------------------------|
 * | Draft Turn Started                           | draft_pick     | `detail.teamId` (on the clock)          | yes    | deadline: think time, ≤ 40% of clock   |
 * | Waiver Window Opened (once per league week)  | waivers        | every agent team in the league          | no     | roster, ≤ half the time to `closesAt`  |
 * | Trade Proposed / Trade Countered             | trade_response | `detail.toTeamId` (the team to answer)  | yes    | trade, ≤ half the time to `expiresAt`  |
 * | Trade Accepted (league-vote review)          | trade_vote     | agent teams not in the trade            | yes    | none (prompt)                          |
 * | Week Rolled Over (once per league week)      | trade_proposal | every agent team in the league          | no     | roster                                 |
 * | Player News Alert                            | lineup         | teams rostering any `detail.playerIds`  | no     | roster, ≤ half the time to next lock   |
 * | Player Status Changed                        | lineup         | teams rostering `detail.playerId`       | no     | roster, ≤ half the time to next lock   |
 * | Lineup Lock Approaching                      | lineup         | every agent team in the league          | yes    | none (the deadline is the point)       |
 * | Chat Mention (any room; every DM message)    | chat_reply     | `detail.mentionedTeamIds` (see banter)  | no     | none (chat cooldowns pace it)          |
 * | Chat Moment                                  | chat_moment    | up to 2 agent teams, picked by event id | no     | none (chat cooldowns pace it)          |
 * | Draft Completed (once per draft)             | post_draft     | every agent team, staggered             | yes    | stagger + post_draft jitter            |
 * | Manager Check-In (once per date and slot)    | check_in       | every agent team (+ `naming`, #196)     | no     | roster, ≤ half the time to next check-in or lock |
 * | Member Left / Agent Seat Changed             | team_identity  | `detail.teamId`, if it needs a name     | no     | roster                                 |
 * | Week Rolled Over (once per league week)      | team_identity  | placeholder names; rare rebrand rolls   | no     | roster                                 |
 *
 * Response delays (#189): a person does not answer the instant an offer lands, so neither does an
 * agent. A rule's `delay` gives each task a human-like wait from core `responseDelay`: a roll of
 * the difficulty's `responseDelay.immediateChance` answers at once, otherwise a right-skewed sample
 * around the class's median, times the tier's multiplier, capped, and clamped to a share of the time
 * left before the event's deadline (a trade's `expiresAt`, the waiver run, the next lineup lock, the
 * pick clock) so a delayed agent never misses it. The roll is seeded by event and team, so a
 * replayed event gets the same delay. A delayed task is scheduled (`scheduleAt`, named by the task
 * id, at the time fixed when it was reserved, so a redelivered trigger neither moves nor doubles
 * it); cooldowns are still checked and spent here, at route time. The task re-reads the league
 * when it runs, so one that went stale meanwhile (an offer withdrawn or answered, a message already answered, a pick already made) is a
 * no-op. Chat is not delayed: an agent answers a mention or reacts to a moment at once, and the
 * chat cooldowns and budgets pace it. Each `requested` decision logs its `delayMs`. Delays are on only when `RouterDeps` says
 * so (`responseDelays`): the router Lambda turns them on (`AGENT_RESPONSE_DELAYS`, on unless
 * `off`), and the in-process loop of the dev server, the e2e suite, and the season simulator keeps
 * them off, so tests and demos never wait.
 *
 * The post-draft kickoff (#175) is one task per agent: it sets the lineup, posts one draft reaction
 * in the league chat, and scans for roster holes; a high-appetite archetype then takes one early
 * trade look (a follow-up task, see tasks/post-draft.ts). Its rule has a `delay`: each agent's task
 * is scheduled (`scheduleAt`) rather than published, spaced out (`POST_DRAFT_KICKOFF`), so the
 * agents do not all fire at once, nor on top of the draft's last pick. A replayed or recovered
 * `Draft Completed` (the stalled-draft watchdog finishing a draft) is a `repeat`: the once-per key
 * is the draft's completion time.
 *
 * Manager check-ins (#195): the check-in job publishes one `Manager Check-In` per league three
 * times a day; every agent gets a `check_in` task (its own cooldown slot, so a check-in never holds
 * up a lineup or trade answer), after its own roster-class delay clamped to half the time before
 * the next check-in and the next lineup lock, so each manager wanders in at its own time. An agent
 * that has had neither a post-draft kickoff nor a check-in yet (a league drafted before #175) gets
 * `firstLook: true` (`teamPayload`).
 *
 * Team names (#194): an AI manager names its own team (`team_identity`, see
 * tasks/team-identity.ts). The naming gate (`admitNaming`) lets a team through only when its seat
 * names its team, the name is not one the commissioner locked, and the league is past the draft
 * and not complete; then either the name is still a placeholder ("Team 3"), or, on the weekly
 * rollover only, a rebrand is allowed (regular season, none in the last `REBRAND_RULES.cooldownWeeks`
 * weeks) and the personality's `rebrandPropensity` roll hits (seeded by league, team, and week). The task
 * then looks for the moment itself (a losing streak, a clinch, the trade deadline). There is no
 * "seat configured" event before the draft, so the draft's own kickoff names teams (folded into
 * `post_draft`, one model call); `Member Left` covers a seat a person gives back, `Agent Seat
 * Changed` a seat the commissioner changes after the draft, and the rollover is the safety net.
 * At most once per team per day (`NAMING_COOLDOWN`), with the roster-class response delay.
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
 *
 * Bursts (#215): a person's message to an agent (a mention, a DM, or an untagged follow-up that
 * continues a conversation, `addressedBy: continuation`) that the reply cooldown turns away is not
 * dropped. One reply is deferred to when the cooldown ends (`deferReply`): scheduled through the
 * outbox, it takes the agent's chat slot at that time, so replies stay paced and never run side by
 * side, and a pointer per agent, room, and person (`CHAT_BURST`) holds until it runs, so the rest of
 * the burst joins it (`coalesced`) instead of scheduling more. Every reply to a person, at once or
 * deferred, answers their newest message still open with the burst in view (tasks/chat.ts,
 * `coalesce`), so a message that lands before the first reply is written joins it. Another room or person gets a reply of
 * its own, one cooldown later, so a DM is never lost to a public room or the other way round.
 *
 * Durable dispatch (#207): every gate is an atomic conditional write owned by what passed it
 * (`admitTrigger`): a `oncePer` key and a league cooldown by the event, an agent's cooldown slot by
 * the task. Racing events cannot both pass one gate, and a redelivered event passes its own gates
 * again, so a retry after a failure partway through a league's fan-out reaches the teams that were
 * left, instead of finding them all `repeat`. Each team's task is reserved in the dispatch outbox
 * together with its cooldown slot (`dispatchTask`), then sent; a redelivery finds the reservation
 * and only resends one that was never sent. A send that fails is `reserved` (the decision says so)
 * and the recovery sweep resends it (see dispatch.ts).
 */

/** What a rule reads: the event's contract detail, every field optional (details are untrusted). */
export type RuleDetail<T extends FantasyEventType> = Partial<EventDetailOf<T>>;

export interface TriggerRule<T extends FantasyEventType = FantasyEventType> {
  kind: string;
  urgent: boolean;
  /** Its own cooldown instead of the difficulty's (chat); may depend on the event (banter). */
  cooldown?: ChatCooldown | ((detail: RuleDetail<T>) => ChatCooldown);
  /**
   * True when a task the agent's cooldown turns away is deferred to the cooldown's end instead,
   * one per agent, room, and author (`deferReply`): a person's message to an agent.
   */
  coalesce?(detail: RuleDetail<T>): boolean;
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
   * Milliseconds to wait before a team's task runs (a response delay, or a stagger over the
   * `index`-th affected team). Above 0, the task is scheduled with `scheduleAt` instead of published.
   */
  delay?(input: DelayInput<T>): number;
  /** Clamp the delay to the league's next lineup lock too (`DelayInput.lockAt`). */
  lockBound?: boolean;
  /**
   * Payload fields for one team that need a lookup (the check-in's `firstLook`), read before the
   * team's cooldown slot is spent.
   */
  teamPayload?(input: AdmitInput<T>): Promise<Record<string, unknown>>;
  /** Player events: the players whose rostering teams are affected (found through the roster index). */
  players?(detail: RuleDetail<T>): string[];
  /** Which of the league's agent teams this event affects (rules without `players`). */
  teams(detail: RuleDetail<T>, agentTeams: readonly string[], eventId: string): string[];
  payload(detail: RuleDetail<T>): Record<string, unknown>;
}

/** What a rule's `delay` reads. */
export interface DelayInput<T extends FantasyEventType = FantasyEventType> {
  /** The team's place among the teams this event affects. */
  index: number;
  eventId: string;
  teamId: string;
  detail: RuleDetail<T>;
  /** The seat's levers; `responseDelay` is `IMMEDIATE_RESPONSE` when delays are off. */
  levers: DifficultyLevers;
  now: Date;
  /** The league's next lineup lock, for `lockBound` rules (null when unknown or not asked for). */
  lockAt: Date | null;
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
 * Deferred replies to bursts (#215): the pointer slot per agent, room, and author that holds while
 * a deferred reply waits, and how often a reservation is retried when another deferral moved the
 * chat slot first.
 */
export const CHAT_BURST = { scope: 'chat-burst', attempts: 3 } as const;

/**
 * Pacing of the post-draft kickoff (#175): the first agent goes a minute after the draft ends
 * (clear of the last pick and the recap), the rest follow at this spacing. The early trade look
 * follows its own agent's kickoff by `tradeLookMs`.
 */
export const POST_DRAFT_KICKOFF = { firstMs: 60_000, spacingMs: 45_000, tradeLookMs: 120_000 } as const;

/**
 * A rule's response delay (core `responseDelay`) for an event class, clamped to the event's own
 * deadline and, for `lockBound` rules, to the next lineup lock.
 */
function humanDelay<T extends FantasyEventType>(
  eventClass: ResponseDelayClass,
  options: { deadline?: (d: RuleDetail<T>) => unknown } = {}
) {
  return (input: DelayInput<T>): number => {
    const own = str(options.deadline?.(input.detail));
    const soonest = Math.min(
      ...[own === undefined ? Number.NaN : Date.parse(own), input.lockAt?.getTime() ?? Number.NaN].filter(
        (at) => Number.isFinite(at)
      )
    );
    return responseDelay({
      eventClass,
      seed: `${input.eventId}:${input.teamId}`,
      lever: input.levers.responseDelay,
      now: input.now,
      deadline: Number.isFinite(soonest) ? new Date(soonest) : null
    }).delayMs;
  };
}

const postDraftJitter = humanDelay<'Draft Completed'>('post_draft');

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

/**
 * A check-in is the agent's first look when it has had neither a post-draft kickoff nor a check-in
 * (its league was drafted before #175 shipped).
 */
async function firstLook(input: AdmitInput<'Manager Check-In'>): Promise<Record<string, unknown>> {
  const { agents } = input.services.repos;
  const seen = await Promise.all(
    ['post_draft', 'check_in'].map((kind) =>
      agents.getTriggerState(input.leagueId, cooldownSlot(input.seat.agentId, { kind }))
    )
  );
  return { firstLook: seen.every((state) => state === null) };
}

const tradeRule: TriggerRule<'Trade Proposed' | 'Trade Countered'> = {
  kind: 'trade_response',
  urgent: true,
  // Mulls it over, but always answers well before the offer expires.
  delay: humanDelay('trade', { deadline: (d) => d.expiresAt }),
  teams: (d, agents) => only([str(d.toTeamId)], agents),
  payload: (d) => ({ tradeId: d.tradeId, fromTeamId: d.fromTeamId })
};

/** One rule per event, or several (the rollover shops for trades and checks team names). */
type RuleMap = { readonly [T in FantasyEventType]?: TriggerRule<T> | readonly TriggerRule<T>[] };

/** Every rule for an event type. */
export function rulesFor(detailType: string): TriggerRule[] {
  const found = TRIGGER_RULES[detailType as FantasyEventType] as
    TriggerRule | readonly TriggerRule[] | undefined;
  return found === undefined ? [] : Array.isArray(found) ? [...found] : [found as TriggerRule];
}

/** Every task kind some rule requests. */
export function triggerKinds(): string[] {
  return [...new Set(Object.keys(TRIGGER_RULES).flatMap((t) => rulesFor(t).map((r) => r.kind)))];
}

/** Naming tasks: at most one per team a day, in their own slot. */
export const NAMING_COOLDOWN = {
  scope: 'team_identity',
  agentMinutes: 24 * 60
} as const satisfies ChatCooldown;

/**
 * The naming gate (#194): the team must be played by its AI manager, whose seat names its team,
 * with a name the commissioner did not lock, in a league past its draft and not complete. A
 * placeholder name goes through; a real name only on the rollover (`rebrand`), inside the rebrand
 * window, when the personality's roll hits.
 */
function admitNaming(rebrand: boolean) {
  return async (input: AdmitInput): Promise<GateDecision | null> =>
    (await namingNeed(
      input,
      // One roll per team and week, whatever else happened: a redelivered rollover rolls the same.
      rebrand ? (week) => ({ seed: `${input.leagueId}:${input.seat.teamId}:week-${week}`, share: 1 }) : null
    )) === null
      ? 'declined'
      : null;
}

/**
 * Why the team should be named now, or null: `placeholder` for a generic name, `rebrand` when the
 * rebrand window is open and the personality's roll (`roll`: its seed, and the share of the weekly
 * propensity it spends) hits. Null for a seat that may not rename.
 */
async function namingNeed(
  input: AdmitInput,
  roll: ((week: number | null) => { seed: string; share: number }) | null
): Promise<'placeholder' | 'rebrand' | null> {
  const { services, seat, leagueId } = input;
  const [league, team] = await Promise.all([
    services.repos.leagues.get(leagueId),
    services.repos.teams.get(leagueId, seat.teamId)
  ]);
  if (league === null || team === null || team.ownerUserId !== null || team.seatType !== 'agent') return null;
  if (league.phase === 'setup' || league.phase === 'drafting' || league.phase === 'complete') return null;
  if (!agentMayRename(seat.config, teamNameSetBy(team))) return null;
  const config = resolveAgentConfig(seat.config, { managerKey: seat.agentId });
  if (isGenericTeamName(team.name, { managerName: config.name })) return 'placeholder';
  if (roll === null) return null;
  const last = (team.renames ?? []).filter((r) => r.by === 'agent').at(-1);
  const window = rebrandWindow({
    phase: league.phase,
    week: league.week,
    lastRenameWeek: last?.week ?? null
  });
  if (window !== 'ok') return null;
  const { seed, share } = roll(league.week);
  return rebrandRoll(config.personality.rebrandPropensity * share, seed) ? 'rebrand' : null;
}

/**
 * A check-in's team payload (#195, #196): whether this is the agent's first look, and whether it
 * should (re)name its team. A check-in spends a twenty-first of the weekly rebrand propensity, so
 * over a week the check-ins rebrand about as often as one weekly roll would.
 */
async function checkInPayload(input: AdmitInput<'Manager Check-In'>): Promise<Record<string, unknown>> {
  const { detail } = input;
  const need = await namingNeed(input as AdmitInput, () => ({
    seed: `check-in:${input.leagueId}:${input.seat.teamId}:${String(detail.date)}-${String(detail.slot)}`,
    share: 1 / CHECK_INS_PER_WEEK
  }));
  // The naming cooldown (`NAMING_COOLDOWN`, shared with team_identity): at most one a day.
  const naming = need !== null && (await takeNamingSlot(input)) ? need : null;
  return { ...(await firstLook(input)), ...(naming === null ? {} : { naming }) };
}

/** Takes the naming cooldown for a check-in, atomically; the check-in's redelivery gets the same answer. */
async function takeNamingSlot(input: AdmitInput): Promise<boolean> {
  return input.services.repos.agents.admitTrigger(input.leagueId, {
    slot: cooldownSlot(input.seat.agentId, { kind: 'team_identity', cooldown: NAMING_COOLDOWN }),
    owner: input.eventId,
    now: input.now,
    windowMs: NAMING_COOLDOWN.agentMinutes * 60_000
  });
}

const namingRule = <T extends FantasyEventType>(
  teams: TriggerRule<T>['teams'],
  rebrand: boolean
): TriggerRule<T> => ({
  kind: 'team_identity',
  urgent: false,
  cooldown: NAMING_COOLDOWN,
  admit: admitNaming(rebrand) as TriggerRule<T>['admit'],
  delay: humanDelay('roster'),
  teams,
  payload: (d) => ({ rebrand, week: (d as { week?: unknown }).week })
});

export const TRIGGER_RULES: RuleMap = {
  'Draft Turn Started': {
    kind: 'draft_pick',
    urgent: true,
    // A short think time, bounded by the pick clock.
    delay: humanDelay('deadline', { deadline: (d) => d.deadline }),
    teams: (d, agents) => only([str(d.teamId)], agents),
    payload: (d) => ({ pick: d.pick, round: d.round, deadline: d.deadline })
  },
  // The waivers job opens a window every day; agents look once a week, on the first window of the
  // league's week (the run after the rollover).
  'Waiver Window Opened': {
    kind: 'waivers',
    urgent: false,
    oncePer: (d) => (typeof d.week === 'number' ? `week-${d.week}` : undefined),
    delay: humanDelay('roster', { deadline: (d) => d.closesAt }),
    teams: (_d, agents) => [...agents],
    payload: (d) => ({ week: d.week, closesAt: d.closesAt })
  },
  'Trade Proposed': tradeRule,
  'Trade Countered': tradeRule,
  // Every agent team outside the trade reviews it while league voting is open (the vote itself is
  // deterministic; see tasks/trade-vote.ts). Urgent: the review period is short and votes must
  // not wait behind a cooldown, nor behind a response delay.
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
  'Week Rolled Over': [
    {
      kind: 'trade_proposal',
      urgent: false,
      oncePer: (d) => (typeof d.week === 'number' ? `week-${d.week}` : undefined),
      delay: humanDelay('roster'),
      teams: (_d, agents) => [...agents],
      payload: (d) => ({ week: d.week })
    },
    // The naming safety net, and now and then an in-character rebrand.
    {
      ...namingRule<'Week Rolled Over'>((_d, agents) => [...agents], true),
      oncePer: (d) => (typeof d.week === 'number' ? `week-${d.week}` : undefined)
    }
  ],
  // A seat an agent takes back ("Team N" again), or one the commissioner changes after the draft.
  'Member Left': namingRule((d, agents) => only([str(d.teamId)], agents), false),
  'Agent Seat Changed': namingRule((d, agents) => only([str(d.teamId)], agents), false),
  'Player News Alert': {
    kind: 'lineup',
    urgent: false,
    lockBound: true,
    delay: humanDelay('roster'),
    players: (d) => strs(d.playerIds),
    teams: () => [],
    payload: (d) => ({ reason: 'news', playerId: strs(d.playerIds)[0], newsId: d.newsId, title: d.title })
  },
  'Player Status Changed': {
    kind: 'lineup',
    urgent: false,
    lockBound: true,
    delay: humanDelay('roster'),
    players: (d) => strs([d.playerId]),
    teams: () => [],
    payload: (d) => ({ reason: 'status', playerId: d.playerId })
  },
  'Lineup Lock Approaching': {
    kind: 'lineup',
    urgent: true,
    // A kickoff locks the players in its games: every agent team checks its lineup, at once. The
    // task skips (no model call) when none of its players kick off then (#193).
    teams: (_d, agents) => [...agents],
    payload: (d) => ({ reason: 'lock', week: d.week, nflTeams: strs(d.nflTeams) })
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
    // A person's message waits out the reply cooldown instead of being dropped; banter does not.
    coalesce: (d) => !agentMention(d),
    // Its reply, at once or deferred, answers the person's newest open message with the rest (#215).
    payload: (d) => ({
      messageId: d.messageId,
      roomId: d.roomId,
      ...(agentMention(d) ? {} : { coalesce: true })
    })
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
    delay: (input) =>
      POST_DRAFT_KICKOFF.firstMs + input.index * POST_DRAFT_KICKOFF.spacingMs + postDraftJitter(input),
    payload: (d) => ({ week: d.week, completedAt: d.completedAt })
  },
  // Three times a day every agent looks at its team (#195), once per league, date, and slot.
  'Manager Check-In': {
    kind: 'check_in',
    urgent: false,
    oncePer: (d) =>
      typeof d.date === 'string' && typeof d.slot === 'string' ? `${d.date}-${d.slot}` : undefined,
    lockBound: true,
    delay: humanDelay('roster', { deadline: (d) => d.nextAt }),
    teams: (_d, agents) => [...agents],
    teamPayload: checkInPayload,
    payload: (d) => ({ slot: d.slot, date: d.date, week: d.week })
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
  | {
      teamId: string;
      leagueId: string;
      /** Sent, now or by an earlier delivery of the event. */
      decision: 'requested';
      taskId: string;
      kind: string;
      /** How long the task waits before it runs (0: right away). */
      delayMs: number;
    }
  | {
      teamId: string;
      leagueId: string;
      /** `reserved`: admitted, but the send failed; the relay resends it. `abandoned`: every send failed. */
      decision: 'reserved' | 'abandoned';
      taskId: string;
      kind: string;
      delayMs: number;
    }
  | {
      teamId: string;
      leagueId: string;
      /** `coalesced`: a deferred reply to the same person in the same room is already waiting. */
      decision: 'no_handler' | 'cooldown' | 'repeat' | 'coalesced' | GateDecision;
      kind: string;
    };

export interface RouterDeps {
  services: Services;
  kinds: TaskKindRegistry;
  rosterIndex?: RosterIndex;
  /**
   * Human-like response delays (#189). Off unless true: the in-process loop (dev server, e2e, the
   * simulator) stays immediate; the router Lambda turns them on.
   */
  responseDelays?: boolean;
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
  const rules = rulesFor(detailType);
  if (rules.length === 0 || event.source !== 'fantasy') {
    log.info('agent trigger ignored', { reason: 'not_a_trigger' });
    return [];
  }
  const decisions: RouteDecision[] = [];
  for (const raw of rules) decisions.push(...(await routeRule(deps, event, raw, log)));
  return decisions;
}

async function routeRule(
  deps: RouterDeps,
  event: BusEvent,
  raw: TriggerRule,
  log: Services['log']
): Promise<RouteDecision[]> {
  const { services } = deps;
  const detailType = event['detail-type'];
  const detail = (event.detail ?? {}) as RuleDetail<FantasyEventType>;
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
  const { agents } = services.repos;
  for (const target of targets) {
    const seats = await agents.listSeats(target.leagueId);
    const agentTeams = seats.map((s) => s.teamId);
    const teams =
      rule.players !== undefined ? only(target.teams, agentTeams) : rule.teams(detail, agentTeams, event.id);
    const lockAt =
      teams.length > 0 && rule.lockBound === true && deps.responseDelays === true
        ? await leagueLockAt(services, target.leagueId, now)
        : null;
    const gate =
      teams.length === 0
        ? null
        : (await repeated(deps, rule, target.leagueId, detail, event.id, now))
          ? 'repeat'
          : (await leagueCooldown(deps, rule, target.leagueId, event.id, now))
            ? 'cooldown'
            : null;
    for (const [index, teamId] of teams.entries()) {
      const base = { teamId, leagueId: target.leagueId, kind: rule.kind };
      if (gate !== null) {
        decisions.push({ ...base, decision: gate });
        continue;
      }
      if (deps.kinds.get(rule.kind) === undefined) {
        decisions.push({ ...base, decision: 'no_handler' });
        continue;
      }
      const taskId = taskIdFor(event.id, teamId, rule.kind);
      const coalesce = rule.coalesce?.(detail) === true;
      // A redelivery: the task (or its deferred reply) was admitted and reserved before; send it
      // if it never went out.
      const earlier =
        (await agents.getDispatch(taskId)) ??
        (coalesce ? await agents.getDispatch(burstTaskId(event.id, teamId, rule.kind)) : null);
      if (earlier !== null) {
        decisions.push(dispatched(base, earlier.taskId, await resend(services, earlier)));
        continue;
      }
      const seat = seats.find((s) => s.teamId === teamId) as AgentSeatRecord;
      const turnedAway =
        rule.admit === undefined
          ? null
          : await rule.admit({ services, detail, seat, leagueId: target.leagueId, eventId: event.id, now });
      if (turnedAway !== null) {
        decisions.push({ ...base, decision: turnedAway });
        continue;
      }
      const levers = resolveAgentConfig(seat.config).levers;
      const extra =
        rule.teamPayload === undefined
          ? {}
          : await rule.teamPayload({
              services,
              detail,
              seat,
              leagueId: target.leagueId,
              eventId: event.id,
              now
            });
      const request: AgentActionRequested = {
        taskId,
        leagueId: target.leagueId,
        teamId,
        agentId: seat.agentId,
        kind: rule.kind,
        trigger: { detailType, eventId: event.id, urgent: rule.urgent },
        payload: Object.fromEntries(
          Object.entries({ ...rule.payload(detail), ...extra }).filter(([, v]) => v !== undefined)
        ),
        requestedAt: now.toISOString()
      };
      const delayMs =
        rule.delay?.({
          index,
          eventId: event.id,
          teamId,
          detail,
          levers: deps.responseDelays === true ? levers : { ...levers, responseDelay: IMMEDIATE_RESPONSE },
          now,
          lockAt
        }) ?? 0;
      const outcome = await dispatchTask(services, request, {
        ...(delayMs > 0 ? { delayMs } : {}),
        gate: cooldownGate(rule, seat, levers, taskId, now)
      });
      if (outcome.status !== 'gated') decisions.push(dispatched(base, taskId, outcome));
      else if (!coalesce) decisions.push({ ...base, decision: 'cooldown' });
      else decisions.push(await deferReply(services, { base, request, seat, rule, detail, now }));
    }
  }
  for (const d of decisions) log.info('agent trigger decision', { ...d, urgent: rule.urgent });
  if (decisions.length === 0)
    log.info('agent trigger decision', { decision: 'no_agent_teams', kind: rule.kind });
  return decisions;
}

/** The deferred reply's task id for (event, team, kind): one per event, so a redelivery finds it. */
export function burstTaskId(eventId: string, teamId: string, kind: string): string {
  return taskIdFor(`${eventId}#burst`, teamId, kind);
}

/**
 * Defers a person's message the reply cooldown turned away (see the module comment): one reply
 * per agent, room, and author, when the chat slot next frees. The pointer is taken with the
 * reply's run time, so it opens again only once that time has passed (or at once when every
 * reservation attempt lost the chat slot: a held pointer always has a reply behind it); the reply's reservation takes
 * the chat slot at that time (its gate opens only then), so a later message, from anyone, waits a
 * cooldown after it.
 */
async function deferReply(
  services: Services,
  input: {
    base: { teamId: string; leagueId: string; kind: string };
    request: AgentActionRequested;
    seat: AgentSeatRecord;
    rule: ResolvedRule;
    detail: RuleDetail<FantasyEventType>;
    now: Date;
  }
): Promise<RouteDecision> {
  const { base, request, seat, rule, now } = input;
  const detail = input.detail as RuleDetail<'Chat Mention'>;
  const { agents } = services.repos;
  const windowMs = (rule.cooldown?.agentMinutes ?? 0) * 60_000;
  const taskId = burstTaskId(request.trigger.eventId, base.teamId, base.kind);
  const deferred: AgentActionRequested = {
    ...request,
    taskId,
    payload: { ...request.payload, coalesce: true }
  };
  const slot = cooldownSlot(seat.agentId, rule);
  const pointer = `${seat.agentId}#${CHAT_BURST.scope}#${str(detail.roomId) ?? ''}#${str(detail.authorTeamId) ?? ''}`;
  for (let attempt = 0; attempt < CHAT_BURST.attempts; attempt++) {
    const state = await agents.getTriggerState(base.leagueId, slot);
    const last = state === null ? 0 : Date.parse(state.lastTriggeredAt);
    const at = Math.max(now.getTime(), last + windowMs);
    // Open when no reply waits for this person here (or the one that did has had its time).
    const own = await agents.admitTrigger(base.leagueId, {
      slot: pointer,
      owner: taskId,
      now: new Date(at),
      windowMs: Math.max(1, at - now.getTime())
    });
    if (!own) return { ...base, decision: 'coalesced' };
    const outcome = await dispatchTask(services, deferred, {
      delayMs: at - now.getTime(),
      gate: { slot, owner: taskId, now: new Date(at), windowMs }
    });
    if (outcome.status !== 'gated') return dispatched(base, taskId, outcome);
  }
  // Never hold the pointer without a reply behind it: the person's next message must not join a
  // reply that was never scheduled. That reply still sees this one (its burst lists it).
  await agents.releaseTrigger(base.leagueId, pointer, taskId);
  return { ...base, decision: 'cooldown' };
}

/** Resends an earlier reservation that never went out; reports one that did. */
async function resend(services: Services, dispatch: AgentDispatch): Promise<SentOutcome> {
  if (dispatch.state !== 'reserved') return { status: dispatch.state, delayMs: dispatch.delayMs };
  return {
    status: (await sendDispatch(services, dispatch)) ? 'dispatched' : 'pending',
    delayMs: dispatch.delayMs
  };
}

function dispatched(
  base: { teamId: string; leagueId: string; kind: string },
  taskId: string,
  outcome: SentOutcome
): RouteDecision {
  if (outcome.status === 'dispatched')
    return { ...base, decision: 'requested', taskId, delayMs: outcome.delayMs };
  return {
    ...base,
    decision: outcome.status === 'pending' ? 'reserved' : 'abandoned',
    taskId,
    delayMs: outcome.delayMs
  };
}

type SentOutcome = Exclude<DispatchOutcome, { status: 'gated' }>;

/**
 * The agent's cooldown slot: one per agent and task kind, so a waiver look never delays a lineup
 * decision. Chat kinds share one chat slot (`CHAT_COOLDOWNS`).
 */
export function cooldownSlot(agentId: string, rule: Pick<ResolvedRule, 'kind' | 'cooldown'>): string {
  return `${agentId}#${rule.cooldown?.scope ?? rule.kind}`;
}

/**
 * The gate a team's task takes with its reservation: the agent's cooldown slot, owned by the task.
 * Urgent triggers go through any cooldown (`windowMs` 0) but still start one.
 */
function cooldownGate(
  rule: ResolvedRule,
  seat: AgentSeatRecord,
  levers: DifficultyLevers,
  taskId: string,
  now: Date
): TriggerGate {
  const minutes = rule.cooldown?.agentMinutes ?? levers.cooldownMinutes;
  return {
    slot: cooldownSlot(seat.agentId, rule),
    owner: taskId,
    now,
    windowMs: rule.urgent ? 0 : minutes * 60_000
  };
}

/** The league's next lineup lock, or null when the league or its schedule is unknown. */
async function leagueLockAt(services: Services, leagueId: string, now: Date): Promise<Date | null> {
  const league = await services.repos.leagues.get(leagueId);
  if (league === null) return null;
  const at = await nextLockAt(services.data.reference, league, now);
  return at === null ? null : new Date(at);
}

/**
 * True when the rule fired in this league too recently (for another event); otherwise this event
 * takes the league window, atomically.
 */
async function leagueCooldown(
  deps: RouterDeps,
  rule: ResolvedRule,
  leagueId: string,
  eventId: string,
  now: Date
): Promise<boolean> {
  const minutes = rule.cooldown?.leagueMinutes;
  if (minutes === undefined || deps.kinds.get(rule.kind) === undefined) return false;
  return !(await deps.services.repos.agents.admitTrigger(leagueId, {
    slot: `league#${rule.kind}`,
    owner: eventId,
    now,
    windowMs: minutes * 60_000
  }));
}

/**
 * True when a `oncePer` rule already fired in this league for this key, for another event;
 * otherwise this event takes the key, atomically (its own redelivery passes again).
 */
async function repeated(
  deps: RouterDeps,
  rule: ResolvedRule,
  leagueId: string,
  detail: RuleDetail<FantasyEventType>,
  eventId: string,
  now: Date
): Promise<boolean> {
  const key = rule.oncePer?.(detail);
  if (key === undefined || deps.kinds.get(rule.kind) === undefined) return false;
  return !(await deps.services.repos.agents.admitTrigger(leagueId, {
    slot: `league#${rule.kind}#${key}`,
    owner: eventId,
    now,
    windowMs: null
  }));
}
