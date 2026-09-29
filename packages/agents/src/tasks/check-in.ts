import {
  CHECK_IN_SLOTS,
  SLOT_ELIGIBILITY,
  WILL_NOT_PLAY_STATUSES,
  checkInTradeChance,
  instantMs,
  seededRandom,
  tradeAppetite,
  waiverMinGain,
  wantsEarlyTradeLook,
  type MemoryEvent,
  type RosterPlayer,
  type RosterSlot
} from '@fantasy/core';
import type { AgentTaskSeal, Envelope } from '@fantasy/server';
import { z } from 'zod';
import { quote } from './chat.js';
import {
  BaseDecisionSchema,
  defineTaskKind,
  type TaskContext,
  type TaskFollowUp,
  type TaskOutcome
} from './kinds.js';
import {
  SOCIAL_PROBES,
  SOCIAL_STEPS,
  fakeSocialActions,
  lookSocial,
  socialInstructions,
  type SocialLook
} from './check-in-social.js';
import { TaskUnavailableError, readLineup, setLineup, type LineupPrep } from './lineup.js';
import {
  EARLY_LOOK_OFFERS,
  describeCandidate,
  propose,
  scoutProposals,
  type ProposalPrep
} from './trade-proposal.js';
import {
  MAX_CANDIDATES,
  TRENDING_LOOKBACK_HOURS,
  openTeam,
  scanRosterHoles,
  scout,
  submitClaims,
  type Lead,
  type WaiverSuggestion
} from './waivers.js';

/**
 * Manager check-ins (#195): three times a day (core `checkInMoment`) every agent looks at its team
 * the way a real manager checks an app, whether or not anything happened in the league. One pass,
 * at most one model call:
 *
 * 1. The look (deterministic, no model): the lineup (starters who are out or on bye), the waiver
 *    wire (players on waivers or free agents, trending or top-ranked, projected against the
 *    weakest player on the roster, by the archetype's `waiverMinGain`; and pickups for starting
 *    slots nobody healthy can fill), a trade look when the archetype's appetite roll passes
 *    (`checkInTradeChance`) and it has offers left this week, and offers waiting on an answer.
 * 2. The pre-check: each probe in `CHECK_IN_PROBES` turns part of the look into a reason to think.
 *    No reason, no model call: the task is recorded as `nothing_to_do` with a one-line reason
 *    ("Looked at waivers; nobody beats my bench."). Doing nothing is a fine answer.
 * 3. The decision: the model sees the look (and the standings and its matchup) and answers with a
 *    list of typed actions (`CHECK_IN_ACTIONS`): set the lineup, add a free agent, claim a player on
 *    waivers, propose a vetted trade, or none. It can only pick from what the look vetted, through
 *    the same tools a person's app uses, within the difficulty's `actionsPerTrigger`, the weekly
 *    offer count (`tradeAppetite(config).proposalsPerWeek`, shared with the rollover's
 *    trade_proposal task), and one open offer per partner.
 * 4. The fallback (kill switch, budget spent, no model): the optimizer lineup and pickups for the
 *    starting slots nobody healthy can fill, nothing else.
 *
 * An offer that has waited on the agent for a while is handed to `trade_response` as a follow-up
 * (it no-ops if the offer was answered meanwhile). The first check-in of a league whose draft
 * ended before the post-draft kickoff existed (#175) runs as the kickoff would (`firstLook`, set by
 * the router): lineup, roster holes, and one trade look for a high-appetite archetype.
 *
 * The social side (#196, tasks/check-in-social.ts): a rename when the router asks for one
 * (`naming`), a board post, matchup talk, and a DM with a goal, all within the same decision.
 *
 * Extending the check-in: add a probe to `CHECK_IN_PROBES` for a new reason to think, and
 * an action type to `CHECK_IN_ACTIONS` with a step in `ACTION_STEPS` that carries it out. The
 * activity line and the final action are built from what the steps report (`Run.done`), so they
 * need no change.
 */

/** Offers a check-in may send, on top of the weekly count and the action budget. */
export const CHECK_IN_OFFERS = 1;
/** The least a check-in offer must give the other team by the trade value math: win-win only. */
export const CHECK_IN_PARTNER_FLOOR = 0;
/** An offer this old is answered at the next check-in (sooner, the router's own task answers it). */
export const OFFER_NUDGE_AFTER_MS = 2 * 60 * 60_000;
/** The window the weekly offer count looks back over. */
const OFFER_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** Trending pickups and top-ranked free agents per position looked at each check-in. */
const TRENDING_LEADS = 4;
const SEARCH_POSITIONS = ['QB', 'RB', 'WR', 'TE'] as const;

const PayloadSchema = z.object({
  slot: z.enum(CHECK_IN_SLOTS).default('afternoon'),
  date: z.string().optional(),
  week: z.number().int().nullable().optional(),
  /** The league's first look since its draft (#175 never ran for it): the kickoff's steps. */
  firstLook: z.boolean().default(false),
  /** The router found the team name generic, or the rebrand roll passed (#196). */
  naming: z.enum(['placeholder', 'rebrand']).optional()
});
type Payload = z.infer<typeof PayloadSchema>;

/** The action types a check-in decision may list, the social ones (#196) included. */
export const CHECK_IN_ACTIONS = [
  'set_lineup',
  'add_drop',
  'claim',
  'propose_trade',
  'rename_team',
  'post_chat',
  'matchup_post',
  'send_dm',
  'none'
] as const;
export type CheckInActionType = (typeof CHECK_IN_ACTIONS)[number];

export const CheckInActionSchema = z.object({
  type: z
    .enum(CHECK_IN_ACTIONS)
    .describe(
      'set_lineup: start the proposed lineup. add_drop: add a free agent now (`pickup`). claim: bid on a player on waivers (`pickup`, `bid`). propose_trade: send a trade offer (`candidate`, optional `message`). rename_team: rename your team (`teamName`). post_chat: post on a league board (`message`, optional `room`). matchup_post: talk in your matchup room (`message`). send_dm: a direct message for a listed goal (`goal`, `message`). none: do nothing.'
    ),
  pickup: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('add_drop and claim: the number of a pickup from the list.'),
  bid: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('claim: FAAB bid in whole dollars (default: the suggested bid).'),
  candidate: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('propose_trade: the number of a trade idea from the list.'),
  message: z
    .string()
    .max(300)
    .optional()
    .describe(
      'propose_trade: a short note to the other manager. post_chat, matchup_post, send_dm: the message, at most 280 characters.'
    ),
  teamName: z.string().max(60).optional().describe('rename_team: the new team name.'),
  room: z
    .string()
    .max(40)
    .optional()
    .describe('post_chat: the room, "trash-talk" (default), "league", "trades", or "waivers-news".'),
  goal: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('send_dm: the number of a direct-message goal from the list.')
});
export type CheckInAction = z.infer<typeof CheckInActionSchema>;

export const CheckInDecisionSchema = BaseDecisionSchema.extend({
  actions: z
    .array(CheckInActionSchema)
    .max(8)
    .describe('What to do, as a list of actions. `[{ "type": "none" }]` (or an empty list) does nothing.')
});
type CheckInDecision = z.infer<typeof CheckInDecisionSchema>;

/** A starter who will not play this week. */
export interface Unavailable {
  id: string;
  name: string;
  slot: RosterSlot;
  why: 'out' | 'bye';
}

/** A vetted pickup; `hole` is the starting slot it fills when nobody healthy can. */
export interface Pickup extends WaiverSuggestion {
  hole: RosterSlot | null;
}

export interface IncomingOffer {
  id: string;
  from: { id: string; name: string };
  proposedAt: string;
}

/** What the check-in saw before any model call. */
export interface CheckInLook {
  payload: Payload;
  /** Null when the roster could not be read. */
  lineup: LineupPrep | null;
  unavailable: Unavailable[];
  waivers: { open: boolean; faabRemaining: number; pickups: Pickup[]; holes: RosterSlot[] };
  trade: { shopping: boolean; offersLeft: number; prep: ProposalPrep | null };
  /** Offers waiting on this team's answer for at least `OFFER_NUDGE_AFTER_MS`, oldest first. */
  offers: IncomingOffer[];
  /** A rename, a board post, matchup talk, DMs (#196). */
  social: SocialLook;
}

export interface CheckInReason {
  code: string;
  /** In the agent's voice, for the activity log and the prompt. */
  line: string;
}

/** Turns part of the look into a reason to think it over (or null). */
export type CheckInProbe = (look: CheckInLook) => CheckInReason | null;

const names = (list: readonly { name: string }[]) => list.map((p) => quote(p.name, 40)).join(', ');

/** The pre-check, in order. Add a probe for each new reason a check-in should think. */
export const CHECK_IN_PROBES: readonly CheckInProbe[] = [
  (look) =>
    look.payload.firstLook
      ? { code: 'first_look', line: 'First real look at my team since the draft.' }
      : null,
  // A starter who will not play, when the bench can cover him (a hole with no cover is a pickup).
  (look) => {
    const lineup = look.lineup?.optimized.lineup ?? [];
    const covered = look.unavailable.filter((u) => lineup.find((e) => e.playerId === u.id)?.slot !== u.slot);
    return covered.length === 0
      ? null
      : {
          code: 'starter_unavailable',
          line: `Starters who will not play: ${covered.map((u) => `${quote(u.name, 40)} (${u.why})`).join(', ')}.`
        };
  },
  (look) =>
    look.waivers.pickups.length === 0
      ? null
      : {
          code: 'waiver_upgrade',
          line: `Worth a pickup: ${names(look.waivers.pickups.map((p) => p.player))}.`
        },
  (look) =>
    look.trade.prep === null
      ? null
      : { code: 'trade_look', line: `Shopping for trades: ${look.trade.prep.candidates.length} idea(s).` },
  (look) =>
    look.offers.length === 0
      ? null
      : { code: 'offer_pending', line: `Offer waiting on me from ${names(look.offers.map((o) => o.from))}.` },
  ...SOCIAL_PROBES,
  (look) =>
    look.payload.slot === 'morning' ? { code: 'first_of_day', line: 'Morning check on my team.' } : null
];

export function checkInReasons(look: CheckInLook, probes = CHECK_IN_PROBES): CheckInReason[] {
  return probes.map((probe) => probe(look)).filter((r): r is CheckInReason => r !== null);
}

/** The one line a check-in with nothing worth doing leaves in the activity log. */
export function nothingToDoLine(look: CheckInLook): string {
  const lineup = look.lineup === null ? "Couldn't read my roster." : 'Lineup is set.';
  const waivers = look.waivers.open ? 'Looked at waivers; nobody beats my bench.' : 'Waivers are closed.';
  const trades = look.trade.shopping ? 'No trade worth offering.' : 'Not shopping for trades today.';
  return `${lineup} ${waivers} ${trades}`;
}

function data<T>(envelope: Envelope, schema: z.ZodType<T>): T | null {
  return 'error' in envelope ? null : schema.parse(envelope.data);
}

const TrendingSchema = z.object({
  players: z.array(
    z.object({
      player: z.object({
        id: z.string(),
        name: z.string(),
        position: z.string(),
        team: z.string().nullable()
      }),
      count: z.number()
    })
  )
});
const FoundSchema = z.object({
  players: z.array(
    z.object({ id: z.string(), name: z.string(), position: z.string(), team: z.string().nullable() })
  )
});
const ClaimsSchema = z.object({
  claims: z.array(
    z.object({ player: z.object({ id: z.string() }), drop: z.object({ id: z.string() }).nullable() })
  )
});
const TradesSchema = z.object({
  trades: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      direction: z.string(),
      round: z.number().int(),
      proposedAt: z.string(),
      fromTeam: z.object({ id: z.string(), name: z.string() }),
      toTeam: z.object({ id: z.string() }),
      fromSends: z.array(z.object({ id: z.string() })),
      toSends: z.array(z.object({ id: z.string() }))
    })
  )
});

/**
 * Starters who will not play: out, on IR, or suspended, or on bye (when the week's games are known),
 * and not locked yet. Also every rostered player on bye.
 */
export function unavailableStarters(prep: LineupPrep): { unavailable: Unavailable[]; bye: Set<string> } {
  const { games, now } = prep.context;
  const gameOf = (team: string | null | undefined) => (team == null ? undefined : games?.[team]);
  const bye = new Set(
    games === undefined
      ? []
      : prep.roster.filter((p) => gameOf(p.nflTeam) === undefined).map((p) => p.playerId)
  );
  const players = new Map(prep.roster.map((p) => [p.playerId, p]));
  const unavailable: Unavailable[] = [];
  for (const entry of prep.current) {
    const player = players.get(entry.playerId) as RosterPlayer;
    const kickoff = gameOf(player.nflTeam)?.kickoff;
    const locked = kickoff !== undefined && now !== undefined && instantMs(kickoff) <= instantMs(now);
    if (entry.slot === 'BN' || entry.slot === 'IR' || locked) continue;
    const why = bye.has(player.playerId)
      ? 'bye'
      : WILL_NOT_PLAY_STATUSES.includes(player.status)
        ? 'out'
        : null;
    if (why !== null)
      unavailable.push({ id: player.playerId, name: player.name ?? player.playerId, slot: entry.slot, why });
  }
  return { unavailable, bye };
}

async function readLineupOrNull(ctx: TaskContext): Promise<LineupPrep | null> {
  try {
    return await readLineup(ctx, undefined);
  } catch (error) {
    if (error instanceof TaskUnavailableError) return null;
    /* v8 ignore next -- only a bug (a response that breaks its schema) gets here */
    throw error;
  }
}

/** Trending pickups, then the top-ranked healthy players available at each skill position. */
async function waiverLeads(ctx: TaskContext): Promise<Lead[]> {
  const trending =
    data(
      await ctx.tools.call('get_trending_players', {
        type: 'add',
        lookbackHours: TRENDING_LOOKBACK_HOURS,
        limit: 20
      }),
      TrendingSchema
    )?.players ?? [];
  const leads: Lead[] = trending.slice(0, TRENDING_LEADS).map((t) => ({ player: t.player, count: t.count }));
  for (const position of SEARCH_POSITIONS) {
    const found = data(
      await ctx.tools.call('search_players', {
        position,
        leagueId: ctx.league.id,
        availability: 'free_agent',
        injury: 'healthy',
        limit: 1
      }),
      FoundSchema
    );
    leads.push(...(found?.players ?? []).map((player) => ({ player, count: 0 })));
  }
  return leads
    .filter((l, i) => leads.findIndex((m) => m.player.id === l.player.id) === i)
    .slice(0, MAX_CANDIDATES);
}

/** Pickups for holes first (one per hole), then upgrades, never two for one player or one drop. */
async function lookAtWaivers(
  ctx: TaskContext,
  bye: Set<string>,
  keep: Set<string>
): Promise<CheckInLook['waivers']> {
  const team = await openTeam(ctx);
  if (team === null) return { open: false, faabRemaining: 0, pickups: [], holes: [] };
  const holes = await scanRosterHoles(ctx, { unavailable: bye, keep });
  const upgrades = await scout(
    ctx,
    team.faabRemaining,
    await waiverLeads(ctx),
    waiverMinGain(ctx.config.waiverAggressiveness),
    keep
  );
  // Players already claimed (or promised as drops) by a pending claim, or by a pickup below.
  const pending =
    data(
      await ctx.tools.call('list_waiver_claims', { teamId: ctx.principal.teamId, status: 'pending' }),
      ClaimsSchema
    )?.claims ?? [];
  const taken = new Set(pending.flatMap((c) => [c.player.id, ...(c.drop === null ? [] : [c.drop.id])]));
  const free = (s: WaiverSuggestion) => !taken.has(s.player.id) && (s.drop === null || !taken.has(s.drop.id));
  const take = (s: WaiverSuggestion) => {
    taken.add(s.player.id);
    if (s.drop !== null) taken.add(s.drop.id);
  };
  const pickups: Pickup[] = [];
  // Each hole pickup fills the first open slot he is eligible for, as `scanRosterHoles` matched them.
  const unfilled = [...holes.holes];
  for (const s of holes.suggestions) {
    const at = unfilled.findIndex((slot) =>
      (SLOT_ELIGIBILITY[slot] as readonly string[]).includes(s.player.position)
    );
    const hole = unfilled.splice(at, 1)[0] as RosterSlot;
    if (free(s)) pickups.push({ ...s, hole });
    take(s);
  }
  for (const s of upgrades.suggestions.filter(free)) {
    pickups.push({ ...s, hole: null });
    take(s);
  }
  return { open: true, faabRemaining: team.faabRemaining, pickups, holes: holes.holes };
}

/** Opening offers this team sent in the last week, and the offers waiting on its answer. */
async function lookAtOffers(
  ctx: TaskContext
): Promise<{ sentThisWeek: number; offered: Set<string>; waiting: IncomingOffer[] }> {
  const trades = data(await ctx.tools.call('list_trades', { limit: 100 }), TradesSchema)?.trades ?? [];
  const now = ctx.clock.now().getTime();
  const sent = trades.filter(
    (t) => t.direction === 'outgoing' && t.round === 0 && now - Date.parse(t.proposedAt) < OFFER_WINDOW_MS
  );
  const offered = new Set(
    sent.map((t) =>
      offerKey(
        t.toTeam.id,
        t.fromSends.map((p) => p.id),
        t.toSends.map((p) => p.id)
      )
    )
  );
  const waiting = trades
    .filter(
      (t) =>
        t.direction === 'incoming' &&
        t.status === 'proposed' &&
        now - Date.parse(t.proposedAt) >= OFFER_NUDGE_AFTER_MS
    )
    .map((t) => ({ id: t.id, from: t.fromTeam, proposedAt: t.proposedAt }))
    // list_trades is newest first.
    .reverse();
  return { sentThisWeek: sent.length, offered, waiting };
}

const offerKey = (teamId: string, send: readonly string[], receive: readonly string[]) =>
  `${teamId}|${[...send].sort().join(',')}|${[...receive].sort().join(',')}`;

/** A trade look when the appetite roll passes (or on the first look, for a dealer) and offers are left. */
async function lookAtTrades(
  ctx: TaskContext,
  payload: Payload,
  offers: { sentThisWeek: number; offered: Set<string> }
): Promise<CheckInLook['trade']> {
  const offersLeft = Math.max(0, tradeAppetite(ctx.config).proposalsPerWeek - offers.sentThisWeek);
  const roll = seededRandom(`check-in-trade:${ctx.trigger.eventId}:${ctx.principal.teamId}`)();
  const shopping =
    offersLeft > 0 &&
    (payload.firstLook
      ? wantsEarlyTradeLook(ctx.config)
      : roll < checkInTradeChance(ctx.config.tradeFrequency));
  if (!shopping) return { shopping, offersLeft, prep: null };
  const limit = Math.min(
    offersLeft,
    ctx.config.levers.actionsPerTrigger,
    payload.firstLook ? EARLY_LOOK_OFFERS : CHECK_IN_OFFERS
  );
  try {
    const scouted = await scoutProposals(ctx, limit);
    // Check-ins come often: only offers the other side's own math likes too, and never the same
    // offer twice in a week (after a rejection, say).
    const candidates = scouted.candidates.filter(
      (c) =>
        c.partnerScore >= CHECK_IN_PARTNER_FLOOR &&
        !offers.offered.has(offerKey(c.team.id, [c.send.id], [c.receive.id]))
    );
    return { shopping, offersLeft, prep: candidates.length === 0 ? null : { ...scouted, candidates } };
  } catch (error) {
    if (error instanceof TaskUnavailableError) return { shopping, offersLeft, prep: null };
    /* v8 ignore next -- only a bug (a response that breaks its schema) gets here */
    throw error;
  }
}

export interface CheckInPrep {
  look: CheckInLook;
  reasons: CheckInReason[];
  /** The standings and the week's matchup, for the prompt. */
  context: string[];
}

async function prepare(ctx: TaskContext, payload: Payload): Promise<CheckInPrep> {
  const lineup = await readLineupOrNull(ctx);
  const { unavailable, bye } =
    lineup === null ? { unavailable: [], bye: new Set<string>() } : unavailableStarters(lineup);
  // Never drop a player on bye or one who is hurt to make room (this week's zero projection says
  // nothing about him), nor one whose game has kicked off (he is locked).
  const now = ctx.clock.now().getTime();
  const games = lineup?.context.games ?? {};
  const keep = new Set([
    ...bye,
    ...(lineup?.roster ?? [])
      .filter((p) => {
        const kickoff = p.nflTeam == null ? undefined : games[p.nflTeam]?.kickoff;
        return (
          WILL_NOT_PLAY_STATUSES.includes(p.status) || (kickoff !== undefined && instantMs(kickoff) <= now)
        );
      })
      .map((p) => p.playerId)
  ]);
  const waivers = await lookAtWaivers(ctx, bye, keep);
  const offers = await lookAtOffers(ctx);
  const trade = await lookAtTrades(ctx, payload, offers);
  const social = await lookSocial(ctx, payload.naming, { trade });
  const look: CheckInLook = { payload, lineup, unavailable, waivers, trade, offers: offers.waiting, social };
  const reasons = checkInReasons(look);
  if (reasons.length === 0) throw new TaskUnavailableError('nothing_to_do', undefined, nothingToDoLine(look));
  return { look, reasons, context: await leagueContext(ctx) };
}

const StandingsSchema = z.object({
  standings: z.array(
    z.object({ rank: z.number(), teamId: z.string(), teamName: z.string(), record: z.string() })
  )
});
const MatchupSchema = z.object({
  matchup: z
    .object({
      home: z.object({ teamId: z.string(), teamName: z.string(), score: z.number().nullable() }),
      away: z.object({ teamId: z.string(), teamName: z.string(), score: z.number().nullable() })
    })
    .nullable()
});

/** The standings around this team and this week's matchup, as prompt lines (names are data). */
async function leagueContext(ctx: TaskContext): Promise<string[]> {
  const me = ctx.principal.teamId;
  const lines: string[] = [];
  const standings = data(await ctx.tools.call('get_standings', {}), StandingsSchema)?.standings ?? [];
  const mine = standings.find((r) => r.teamId === me);
  if (mine !== undefined)
    lines.push(
      `You are ${mine.rank} of ${standings.length} at ${mine.record}; the leader is ${quote(standings[0]?.teamName ?? '', 40)}.`
    );
  const matchup = data(await ctx.tools.call('get_matchup', {}), MatchupSchema)?.matchup ?? null;
  if (matchup !== null) {
    const [you, them] =
      matchup.home.teamId === me ? [matchup.home, matchup.away] : [matchup.away, matchup.home];
    const score = you.score === null || them.score === null ? '' : ` (${you.score}-${them.score})`;
    lines.push(`This week you play ${quote(them.teamName, 40)}${score}.`);
  }
  return lines;
}

/** One pickup as the model sees it: projected points only with projections research (#122). */
function describePickup(p: Pickup, i: number, projections: boolean): string {
  const how = p.kind === 'add_now' ? 'free agent: add_drop' : `on waivers: claim, suggested bid $${p.bid}`;
  const drop = p.drop === null ? '' : `, dropping ${quote(p.drop.name, 40)}`;
  const why =
    p.hole !== null
      ? `fills your empty ${p.hole} slot`
      : projections
        ? `+${p.gain} projected pts`
        : 'an upgrade';
  return `${i + 1}. ${quote(p.player.name, 40)} (${p.player.position}; ${how}${drop}; ${why}).`;
}

function instructions(ctx: TaskContext, prep: CheckInPrep): string {
  const { look } = prep;
  const lineup = look.lineup;
  const changes =
    lineup === null
      ? []
      : lineup.optimized.lineup
          .filter(
            (e) => lineup.current.find((c) => c.playerId === e.playerId)?.slot !== e.slot && e.slot !== 'BN'
          )
          .map(
            (e) =>
              `${quote(lineup.roster.find((p) => p.playerId === e.playerId)?.name ?? e.playerId, 40)} to ${e.slot}`
          );
  return [
    look.payload.firstLook
      ? 'Your first real look at your team since the draft: set your lineup, fill any holes, and see if a trade makes sense.'
      : `Your ${look.payload.slot} check-in on your team. Real managers check in a few times a day and usually change nothing: act only when it helps.`,
    `What caught your eye: ${prep.reasons.map((r) => r.line).join(' ')}`,
    ...prep.context,
    lineup === null
      ? 'Your roster could not be read, so leave the lineup alone.'
      : changes.length === 0
        ? 'Your lineup already matches the optimizer.'
        : `The optimizer would start: ${changes.join(', ')} (set_lineup).`,
    look.waivers.pickups.length === 0
      ? 'No pickups worth making.'
      : `Pickups your scouting vetted (FAAB left: $${look.waivers.faabRemaining}):\n${look.waivers.pickups.map((p, i) => describePickup(p, i, ctx.config.levers.research.projections)).join('\n')}`,
    look.trade.prep === null
      ? 'No trade offers to send this time.'
      : `Trade ideas (propose_trade, at most ${look.trade.prep.limit}):\n${look.trade.prep.candidates.map(describeCandidate).join('\n')}`,
    look.offers.length === 0
      ? ''
      : 'An offer waiting on you gets its own answer right after this; do not propose to that team now.',
    ...socialInstructions(ctx, prep),
    `Answer with \`actions\`: at most ${ctx.config.levers.actionsPerTrigger} pickups and trade offers in all, by their numbers. You cannot change the players in a pickup or a trade. Never start a player who is out or on bye. Chat actions are optional and at most one of each; they are in your own voice. Doing nothing (\`[{ "type": "none" }]\`) is a fine answer.`
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * What a run of the actions built up. Each step reports what it did as `{ action, line }`: the
 * activity log shows the lines after the decision's summary, and the task's final action names the
 * actions taken (`claim_waiver+set_lineup`), so a new action type needs no change here.
 */
export interface Run {
  actionsLeft: number;
  done: { action: string; line: string }[];
  /** The lineup gets set whatever the decision says (a starter who will not play, the first look). */
  lineupNeeded: boolean;
  /** A free agent joined the roster, so the lineup is set again. */
  added: boolean;
  waiverClaims: string[];
  trades: AgentTaskSeal['trades'];
  memory: MemoryEvent[];
}

/**
 * One step of acting on a decision: the action types it carries out, in the order the steps run
 * (roster moves before the lineup is set, so a pickup added now can start). Action types no step
 * lists (`none`) do nothing.
 */
export interface ActionStep {
  types: readonly CheckInActionType[];
  run(ctx: TaskContext, prep: CheckInPrep, actions: readonly CheckInAction[], run: Run): Promise<void>;
}

/** Pickups (free agents and claims), within the action budget. */
async function pickups(ctx: TaskContext, prep: CheckInPrep, actions: readonly CheckInAction[], run: Run) {
  const { waivers } = prep.look;
  const chosen = actions
    .map((a) => ({ a, p: a.pickup === undefined ? undefined : waivers.pickups[a.pickup - 1] }))
    .filter((c): c is { a: CheckInAction; p: Pickup } => c.p !== undefined)
    .filter((c, i, all) => all.findIndex((d) => d.p === c.p) === i)
    .slice(0, run.actionsLeft);
  if (chosen.length === 0) return;
  run.actionsLeft -= chosen.length;
  const byId = new Map(chosen.map((c) => [c.p.player.id, c.p]));
  const label = (id: string) => {
    const p = byId.get(id) as Pickup;
    const why =
      p.hole !== null ? ` for the ${p.hole} hole` : p.drop === null ? '' : ` over ${quote(p.drop.name, 40)}`;
    return `${quote(p.player.name, 40)} (${p.player.position})${why}`;
  };
  const outcome = await submitClaims(
    ctx,
    waivers,
    chosen.map(({ a, p }) => ({
      playerId: p.player.id,
      ...(p.drop === null ? {} : { dropPlayerId: p.drop.id }),
      bid: p.kind === 'add_now' ? 0 : (a.bid ?? p.bid)
    })),
    '',
    label
  );
  run.done.push({ action: outcome.action, line: outcome.summary });
  run.waiverClaims.push(...(outcome.sealed?.waiverClaims ?? []));
  run.added = chosen.some((c) => c.p.kind === 'add_now') && outcome.action === 'claim_waiver';
}

/** The optimizer lineup, re-read so pickups added just now can start; when asked, or when it must. */
async function lineup(ctx: TaskContext, _prep: CheckInPrep, actions: readonly CheckInAction[], run: Run) {
  if (actions.length === 0 && !run.lineupNeeded && !run.added) return;
  const fresh = await readLineupOrNull(ctx);
  if (fresh === null) return;
  const outcome = await setLineup(ctx, fresh, fresh.optimized.lineup, '');
  if (outcome.action === 'lineup_unchanged') return;
  run.done.push({
    action: outcome.action,
    line:
      outcome.action === 'set_lineup'
        ? `Set my lineup (${fresh.optimized.projectedPoints} projected pts).`
        : outcome.summary.trim()
  });
}

/** Trade offers from the vetted ideas, within the action budget and the look's offer limit. */
async function offers(ctx: TaskContext, prep: CheckInPrep, actions: readonly CheckInAction[], run: Run) {
  const trade = prep.look.trade.prep;
  const picks = actions.flatMap((a) =>
    a.candidate === undefined
      ? []
      : [{ candidate: a.candidate, ...(a.message === undefined ? {} : { message: a.message }) }]
  );
  if (trade === null || picks.length === 0 || run.actionsLeft === 0) return;
  const outcome = await propose(ctx, { ...trade, limit: Math.min(trade.limit, run.actionsLeft) }, picks, '');
  const sent = outcome.sealed?.trades ?? [];
  run.actionsLeft -= sent.length;
  run.trades.push(...sent);
  run.memory.push(...(outcome.memory ?? []));
  run.done.push({
    action: outcome.action,
    line: sent.length > 0 ? (outcome.memorySummary as string) : `No offer went out. ${outcome.summary}`.trim()
  });
}

/** How a decision's actions are carried out, the social steps (#196) last. */
export const ACTION_STEPS: readonly ActionStep[] = [
  { types: ['add_drop', 'claim'], run: pickups },
  { types: ['set_lineup'], run: lineup },
  { types: ['propose_trade'], run: offers },
  ...SOCIAL_STEPS
];

/** A `trade_response` follow-up for the oldest offer waiting on this team. */
function offerFollowUps(look: CheckInLook): TaskFollowUp[] {
  const oldest = look.offers[0];
  return oldest === undefined
    ? []
    : [{ kind: 'trade_response', payload: { tradeId: oldest.id, fromTeamId: oldest.from.id } }];
}

async function act(
  ctx: TaskContext,
  prep: CheckInPrep,
  actions: readonly CheckInAction[],
  lead: string
): Promise<TaskOutcome> {
  const { look } = prep;
  const run: Run = {
    actionsLeft: ctx.config.levers.actionsPerTrigger,
    done: [],
    lineupNeeded: look.unavailable.length > 0 || look.payload.firstLook,
    added: false,
    waiverClaims: [],
    trades: [],
    memory: []
  };
  for (const step of ACTION_STEPS) {
    await step.run(
      ctx,
      prep,
      actions.filter((a) => step.types.includes(a.type)),
      run
    );
  }
  const lines = run.done.map((d) => d.line);
  const summary = [lead, lines.length === 0 ? 'Changed nothing.' : lines.join(' ')]
    .filter((s) => s !== '')
    .join(' ');
  const secret = run.waiverClaims.length > 0 || run.trades.length > 0;
  const followUps = offerFollowUps(look);
  return {
    action: run.done.length === 0 ? 'none' : [...new Set(run.done.map((d) => d.action))].join('+'),
    summary,
    ...(run.memory.length === 0 ? {} : { memory: run.memory }),
    // The summary (the model's words included) may name who was claimed or offered: withheld.
    ...(secret
      ? {
          sealed: {
            summary: `Checked in and made ${run.waiverClaims.length} waiver claim(s) and ${run.trades.length} trade offer(s); they stay hidden until they resolve.`,
            trades: run.trades,
            waiverClaims: run.waiverClaims
          }
        }
      : {}),
    ...(followUps.length === 0 ? {} : { followUps })
  };
}

/**
 * The fake model's choice: the lineup when it needs fixing, every pickup, the best trade idea, and
 * each social action the look offers (canned lines).
 */
function fakeActions(ctx: TaskContext, prep: CheckInPrep): CheckInAction[] {
  const { look } = prep;
  const actions: CheckInAction[] = [
    ...look.waivers.pickups.map((p, i): CheckInAction => ({
      type: p.kind === 'add_now' ? 'add_drop' : 'claim',
      pickup: i + 1
    })),
    ...(look.trade.prep === null ? [] : [{ type: 'propose_trade' as const, candidate: 1 }]),
    ...fakeSocialActions(ctx, look)
  ];
  if (look.unavailable.length > 0) actions.unshift({ type: 'set_lineup' });
  return actions.length === 0 ? [{ type: 'none' }] : actions;
}

export const checkInTask = defineTaskKind<Payload, CheckInDecision, CheckInPrep>({
  kind: 'check_in',
  title: 'Check in on your team',
  modelRole: 'decision',
  // One model may also post publicly or send a DM, so it may update goals but never read them.
  agenda: 'refresh_only',
  payload: PayloadSchema,
  decision: CheckInDecisionSchema,
  // Research only: every move goes through the vetted lists in the decision.
  tools: [
    'get_league_state',
    'get_roster',
    'get_player',
    'search_players',
    'get_projections',
    'get_news',
    'get_trending_players',
    'get_matchup',
    'get_standings',
    'list_trades'
  ],
  prepare: (ctx, payload) => prepare(ctx, payload),
  instructions: (ctx, _payload, prep) => instructions(ctx, prep),
  // Recall first what it has with the teams it may talk or trade with (#210).
  memoryFocus: (_ctx, _payload, { look }) => [
    ...(look.social.matchup === null ? [] : [look.social.matchup.opponent.teamId]),
    ...look.social.dms.map((d) => d.teamId),
    ...look.offers.map((o) => o.from.id),
    ...(look.trade.prep?.candidates.map((c) => c.team.id) ?? [])
  ],
  apply: (ctx, _payload, prep, decision) => act(ctx, prep, decision.actions, decision.summary),
  fallback: (ctx, _payload, prep) =>
    act(
      ctx,
      prep,
      prep.look.waivers.pickups.flatMap((p, i): CheckInAction[] =>
        p.hole === null ? [] : [{ type: p.kind === 'add_now' ? 'add_drop' : 'claim', pickup: i + 1 }]
      ),
      'Autopilot check-in.'
    ),
  fakeScript: (ctx, _payload, prep) => ({
    steps: [],
    decision: {
      summary: prep.reasons.map((r) => r.line).join(' '),
      actions: fakeActions(ctx, prep)
    }
  })
});
