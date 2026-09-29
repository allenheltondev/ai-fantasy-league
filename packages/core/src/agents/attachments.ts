import { z } from 'zod';
import { PositionSchema, SLOT_ELIGIBILITY, type RosterSlot } from '../rules/positions.js';
import type { AgentAgenda } from './agenda.js';
import { MemoryVisibilitySchema, mayHear, type MemoryAudience } from './memory.js';

/**
 * Player attachments (#216): a small, typed record of the players this manager is invested in
 * because of something it actually did in this league, kept beside natural-language memory (#210)
 * and the agenda (#214). The first slice has one preference type, `attachment`, from two sources:
 * a player the manager drafted itself (not an autopick) and a player it acquired in a processed
 * trade. Relationships between managers stay in #210.
 *
 * - Evidence, never beliefs: every preference names the league events it came from (`sources`,
 *   keyed by the event, so a redelivery or a replay never strengthens it) and the weekly results it
 *   was revised by (`performance`, one entry per week, so a stat correction replaces a week instead
 *   of adding one). A model's words cannot create or change one.
 * - Tenure: the store is keyed by league, agent, and seat tenure (like the agenda). A new occupant
 *   starts empty, and a source from before its tenure is never recorded for it.
 * - Bounded: at most `ATTACHMENT_LIMITS.active` held players and `history` former ones; a few
 *   sources, weeks, and revisions each.
 * - Evolution: conviction decays slowly with time (never below `decayFloor` of the source strength
 *   by time alone), moves by at most `weekWeight` per week of results against projection, and at most
 *   `maxPerformanceShift` in all, so a single unlucky week cannot establish or erase it. A material
 *   change keeps a short causal record (`revisions`) that a later conversation can admit to.
 * - Effects: `attachmentAdjustment` turns preferences into a small, capped reservation premium on
 *   trades that send an attached player away. It only ever raises the agent's bar; it never lowers a
 *   floor, and legality, locks, and action limits are checked elsewhere as before. One transparent
 *   override: a pressing agenda need (#214) that the incoming players repair waives the premium on
 *   attached players who cannot fill that need.
 */

export const ATTACHMENT_LIMITS = {
  /** Preferences for players the manager holds now. */
  active: 5,
  /** Preferences for players it no longer holds (kept for the causal record). */
  history: 10,
  /** Source events kept per preference. */
  sources: 4,
  /** Weekly results kept per preference (the newest weeks win). */
  weeks: 6,
  /** Revision records kept per preference. */
  revisions: 3,
  /** Source keys remembered for idempotency, including ones that created no preference. */
  seen: 96,
  /** Characters kept of a player's name or a revision reason. */
  text: 120
} as const;

/** Calibration constants (#211 evaluates them); the tests pin their limits. */
export const ATTACHMENT_POLICY = {
  /** The most one attached player adds to the trade bar, in trade-score points. */
  maxPlayerPremium: 4,
  /** The most all attachments together add to one decision's bar. */
  maxPremium: 6,
  /** Below this conviction a preference no longer affects decisions (it is still remembered). */
  minConviction: 0.2,
  /** Time decay: half-life in days of the decaying share... */
  halfLifeDays: 42,
  /** ...and the share of the source strength that time alone never erodes. */
  decayFloor: 0.5,
  /** The most one week of results moves conviction... */
  weekWeight: 0.1,
  /** ...and the most all kept weeks together move it. */
  maxPerformanceShift: 0.5,
  /** A conviction change at least this large is kept as a revision. */
  revisionDelta: 0.15,
  /** Strength of a player traded for (a draft pick's depends on its round: `draftStrength`). */
  tradedFor: 0.45,
  /** Days until a preference is due for review again after it changes. */
  reviewDays: 7
} as const;

const Text = z.string().max(ATTACHMENT_LIMITS.text);

export const ATTACHMENT_SOURCE_KINDS = ['drafted', 'traded_for'] as const;
export type AttachmentSourceKind = (typeof ATTACHMENT_SOURCE_KINDS)[number];

export const AttachmentSourceSchema = z.object({
  /** The event it came from, e.g. `draft:<leagueId>:<overall>`: applied once. */
  id: z.string(),
  kind: z.enum(ATTACHMENT_SOURCE_KINDS),
  at: z.string(),
  /** A draft pick's round. */
  round: z.number().int().positive().optional()
});
export type AttachmentSource = z.infer<typeof AttachmentSourceSchema>;

/** One week of results against projection (evidence). A later read of the same week replaces it. */
export const AttachmentWeekSchema = z.object({
  week: z.number().int().positive(),
  points: z.number(),
  projected: z.number(),
  /** `(points - projected) / max(projected, 5)`, clamped to [-1, 1]. */
  signal: z.number().min(-1).max(1),
  observedAt: z.string()
});
export type AttachmentWeek = z.infer<typeof AttachmentWeekSchema>;

export const AttachmentRevisionSchema = z.object({
  at: z.string(),
  from: z.number(),
  to: z.number(),
  reason: Text
});
export type AttachmentRevision = z.infer<typeof AttachmentRevisionSchema>;

export const PlayerAttachmentSchema = z.object({
  playerId: z.string(),
  name: Text,
  position: PositionSchema,
  type: z.literal('attachment'),
  status: z.enum(['held', 'departed']),
  /** The strongest source's strength (0-1). Sources never add up. */
  strength: z.number().min(0).max(1),
  /** Conviction when last updated (`attachmentConviction` gives it at any time). */
  conviction: z.number().min(0).max(1),
  /** How much evidence backs the conviction: grows with weeks of results. */
  confidence: z.number().min(0).max(1),
  sources: z.array(AttachmentSourceSchema).max(ATTACHMENT_LIMITS.sources),
  performance: z.array(AttachmentWeekSchema).max(ATTACHMENT_LIMITS.weeks),
  revisions: z.array(AttachmentRevisionSchema).max(ATTACHMENT_LIMITS.revisions),
  createdAt: z.string(),
  updatedAt: z.string(),
  reviewAt: z.string(),
  /** The latest acquisition: time decay runs from here. */
  heldSince: z.string(),
  departedAt: z.string().nullable(),
  /** Who may hear about it (#206). Every source so far is a public move. */
  visibility: MemoryVisibilitySchema
});
export type PlayerAttachment = z.infer<typeof PlayerAttachmentSchema>;

export const PlayerAttachmentsSchema = z.object({
  schemaVersion: z.literal(1),
  preferences: z.array(PlayerAttachmentSchema).max(ATTACHMENT_LIMITS.active + ATTACHMENT_LIMITS.history),
  seen: z.array(z.string()).max(ATTACHMENT_LIMITS.seen)
});
export type PlayerAttachments = z.infer<typeof PlayerAttachmentsSchema>;

export const emptyAttachments = (): PlayerAttachments => ({ schemaVersion: 1, preferences: [], seen: [] });

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : 0));
const round2 = (x: number) => Math.round(x * 100) / 100;
const round1 = (x: number) => Math.round(x * 10) / 10;
const DAY_MS = 86_400_000;
const later = (a: string, b: string) => Date.parse(a) > Date.parse(b);
const addDays = (at: string, days: number) => new Date(Date.parse(at) + days * DAY_MS).toISOString();
const clip = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, ATTACHMENT_LIMITS.text);

/** A draft pick's strength: 0.7 for a first-rounder, 0.05 less a round, never under 0.4. */
export function draftStrength(round: number): number {
  return round2(Math.max(0.4, 0.7 - 0.05 * (Math.max(1, round) - 1)));
}

/** How strongly results have moved a preference, in conviction units (capped both ways). */
export function performanceShift(pref: Pick<PlayerAttachment, 'performance'>): number {
  const sum = pref.performance.reduce((total, w) => total + w.signal * ATTACHMENT_POLICY.weekWeight, 0);
  return clamp(sum, -ATTACHMENT_POLICY.maxPerformanceShift, ATTACHMENT_POLICY.maxPerformanceShift);
}

/** Conviction at `at`: the source strength decayed with time (bounded), plus the results' shift. */
export function attachmentConviction(pref: PlayerAttachment, at: string): number {
  if (pref.status !== 'held') return 0;
  const days = Math.max(0, (Date.parse(at) - Date.parse(pref.heldSince)) / DAY_MS);
  const { decayFloor, halfLifeDays } = ATTACHMENT_POLICY;
  const decayed = pref.strength * (decayFloor + (1 - decayFloor) * 0.5 ** (days / halfLifeDays));
  return round2(clamp(decayed + performanceShift(pref), 0, 1));
}

const confidenceOf = (pref: Pick<PlayerAttachment, 'performance'>) =>
  round2(Math.min(0.9, 0.5 + 0.1 * pref.performance.length));

/**
 * Re-derives the stored numbers. A roster change is always kept as a revision; evidence is kept
 * when conviction has moved materially since the last revision (or the source strength), or has
 * crossed the point where it stops or starts to count. Slow drift is caught once it adds up.
 */
function settle(
  before: PlayerAttachment,
  next: PlayerAttachment,
  at: string,
  reason: string,
  always = false
) {
  const conviction = attachmentConviction(next, at);
  const from = before.revisions.at(-1)?.to ?? before.strength;
  const { minConviction, revisionDelta, reviewDays } = ATTACHMENT_POLICY;
  const material =
    always ||
    Math.abs(conviction - from) >= revisionDelta ||
    from >= minConviction !== conviction >= minConviction;
  return {
    ...next,
    conviction,
    confidence: confidenceOf(next),
    updatedAt: at,
    reviewAt: addDays(at, reviewDays),
    revisions: material
      ? [...next.revisions, { at, from, to: conviction, reason: clip(reason) }].slice(
          -ATTACHMENT_LIMITS.revisions
        )
      : next.revisions
  };
}

/** Held preferences first (strongest first), then the newest former ones, within the limits. */
function bound(state: PlayerAttachments, seen: readonly string[]): PlayerAttachments {
  const held = state.preferences
    .filter((p) => p.status === 'held')
    .sort((a, b) => b.strength - a.strength || a.createdAt.localeCompare(b.createdAt));
  const former = state.preferences
    .filter((p) => p.status !== 'held')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.playerId.localeCompare(b.playerId));
  return {
    schemaVersion: 1,
    preferences: [...held.slice(0, ATTACHMENT_LIMITS.active), ...former.slice(0, ATTACHMENT_LIMITS.history)],
    seen: [...new Set(seen)].slice(-ATTACHMENT_LIMITS.seen)
  };
}

export interface Acquisition {
  /** Unique per event and player: a repeat is ignored. */
  sourceId: string;
  kind: AttachmentSourceKind;
  playerId: string;
  name: string;
  position: z.infer<typeof PositionSchema>;
  at: string;
  /** A draft pick's round (sets its strength). */
  round?: number;
}

/**
 * A player this manager drafted or traded for. Idempotent by `sourceId`. Several sources for one
 * player keep the strongest strength (they never add up). An acquisition older than the player's
 * departure (delivered out of order) is recorded as evidence but does not bring him back.
 */
export function recordAcquisition(state: PlayerAttachments, acquisition: Acquisition): PlayerAttachments {
  const { sourceId, at } = acquisition;
  if (state.seen.includes(sourceId)) return state;
  const strength =
    acquisition.kind === 'drafted' ? draftStrength(acquisition.round ?? 1) : ATTACHMENT_POLICY.tradedFor;
  const source: AttachmentSource = {
    id: sourceId,
    kind: acquisition.kind,
    at,
    ...(acquisition.round === undefined ? {} : { round: acquisition.round })
  };
  const previous = state.preferences.find((p) => p.playerId === acquisition.playerId);
  const others = state.preferences.filter((p) => p.playerId !== acquisition.playerId);
  const seen = [...state.seen, sourceId];
  if (previous === undefined) {
    const created: PlayerAttachment = {
      playerId: acquisition.playerId,
      name: clip(acquisition.name),
      position: acquisition.position,
      type: 'attachment',
      status: 'held',
      strength,
      conviction: strength,
      confidence: 0.5,
      sources: [source],
      performance: [],
      revisions: [],
      createdAt: at,
      updatedAt: at,
      reviewAt: addDays(at, ATTACHMENT_POLICY.reviewDays),
      heldSince: at,
      departedAt: null,
      visibility: 'public'
    };
    return bound({ ...state, preferences: [...others, created] }, seen);
  }
  const sources = [...previous.sources, source]
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-ATTACHMENT_LIMITS.sources);
  const returns =
    previous.status === 'departed' && previous.departedAt !== null && later(at, previous.departedAt);
  const current = previous.status === 'held' || returns;
  const next: PlayerAttachment = {
    ...previous,
    sources,
    strength: current ? Math.max(previous.strength, strength) : previous.strength,
    ...(returns ? { status: 'held' as const, heldSince: at, departedAt: null, performance: [] } : {})
  };
  const reason = returns ? `Back on the roster (${acquisition.kind.replace('_', ' ')}).` : 'Acquired again.';
  return bound({ ...state, preferences: [...others, settle(previous, next, at, reason, returns)] }, seen);
}

/**
 * A player who left this manager's roster (traded away, released, or seen missing from its roster).
 * Only a departure after the player's latest acquisition counts. Idempotent by `sourceId`.
 */
export function recordDeparture(
  state: PlayerAttachments,
  departure: { sourceId: string; playerId: string; at: string; reason: string }
): PlayerAttachments {
  if (state.seen.includes(departure.sourceId)) return state;
  const seen = [...state.seen, departure.sourceId];
  const previous = state.preferences.find((p) => p.playerId === departure.playerId);
  if (previous === undefined || previous.status !== 'held' || !later(departure.at, previous.heldSince))
    return bound(state, seen);
  const next: PlayerAttachment = { ...previous, status: 'departed', departedAt: departure.at };
  return bound(
    {
      ...state,
      preferences: [
        ...state.preferences.filter((p) => p.playerId !== departure.playerId),
        settle(previous, next, departure.at, departure.reason, true)
      ]
    },
    seen
  );
}

/** Held preferences whose player is no longer on the roster, as of an authoritative roster read. */
export function observeRoster(
  state: PlayerAttachments,
  roster: { at: string; playerIds: readonly string[] }
): PlayerAttachments {
  const on = new Set(roster.playerIds);
  return state.preferences
    .filter((p) => p.status === 'held' && !on.has(p.playerId))
    .reduce(
      (next, p) =>
        recordDeparture(next, {
          sourceId: `roster:${p.playerId}:${p.heldSince}`,
          playerId: p.playerId,
          at: roster.at,
          reason: 'No longer on the roster.'
        }),
      state
    );
}

export interface WeekResult {
  playerId: string;
  points: number;
  projected: number;
}

/**
 * One week of results for held players (evidence-driven revision). Keyed by week: a later read of
 * the same week (a stat correction) replaces the earlier one instead of counting twice, and a read
 * older than the one kept (delivered out of order) is ignored. A week with no projection says
 * nothing about expectations and is skipped.
 */
export function observePerformance(
  state: PlayerAttachments,
  observation: { at: string; week: number; results: readonly WeekResult[] }
): PlayerAttachments {
  const { at, week } = observation;
  let changed = false;
  const preferences = state.preferences.map((pref) => {
    const result = observation.results.find((r) => r.playerId === pref.playerId);
    if (pref.status !== 'held' || result === undefined || !(result.projected > 0)) return pref;
    const kept = pref.performance.find((w) => w.week === week);
    if (kept !== undefined && !later(at, kept.observedAt)) return pref;
    if (kept?.points === result.points && kept.projected === result.projected) return pref;
    const signal = round2(clamp((result.points - result.projected) / Math.max(result.projected, 5), -1, 1));
    const entry: AttachmentWeek = {
      week,
      points: result.points,
      projected: result.projected,
      signal,
      observedAt: at
    };
    const performance = [...pref.performance.filter((w) => w.week !== week), entry]
      .sort((a, b) => a.week - b.week)
      .slice(-ATTACHMENT_LIMITS.weeks);
    changed = true;
    return settle(pref, { ...pref, performance }, at, performanceReason(performance, kept !== undefined));
  });
  return changed ? bound({ ...state, preferences }, state.seen) : state;
}

/** Why results moved a conviction, in words a later conversation can admit to. */
function performanceReason(weeks: readonly AttachmentWeek[], corrected: boolean): string {
  const short = weeks.filter((w) => w.signal < 0).length;
  const beat = weeks.length - short;
  const tally =
    short > beat
      ? `Fell short of projection in ${short} of the last ${weeks.length} weeks.`
      : `Met or beat projection in ${beat} of the last ${weeks.length} weeks.`;
  return corrected ? `${tally} (after a stat correction)` : tally;
}

/** Held preferences that still count, strongest first. */
export function activeAttachments(state: PlayerAttachments | undefined, at: string): PlayerAttachment[] {
  return (state?.preferences ?? [])
    .map((p) => ({ pref: p, conviction: attachmentConviction(p, at) }))
    .filter(({ conviction }) => conviction >= ATTACHMENT_POLICY.minConviction)
    .sort((a, b) => b.conviction - a.conviction || a.pref.playerId.localeCompare(b.pref.playerId))
    .map(({ pref }) => pref);
}

/**
 * The personality factor: a cautious archetype holds on harder than a trade-happy one (1.1 at
 * `tradeFrequency` 0.2, down to 0.58 at 0.9). Never above 1.25.
 */
export function attachmentScale(tradeFrequency: number): number {
  return round2(1.25 - 0.75 * clamp(tradeFrequency, 0, 1));
}

type PlayerSide = readonly { id: string; position: string }[];

export interface AttachmentPolicyInput {
  attachments: PlayerAttachments | undefined;
  at: string;
  /** Players this agent would give up. */
  sends: PlayerSide;
  /** Players it would get. */
  receives: PlayerSide;
  /** Its verified agenda (#214), when the task may use it. */
  agenda?: AgentAgenda | undefined;
  tradeFrequency: number;
}

export interface AttachmentAdjustment {
  /** Premium on the attached players sent, before the override (capped, >= 0). */
  premium: number;
  /** The part of it a pressing need set aside. */
  waived: number;
  /** What the decision adds to its base bar: `premium - waived` (never negative). */
  adjustment: number;
  players: { playerId: string; name: string; conviction: number; premium: number; waived: boolean }[];
  /** The agenda goal that outweighed the attachment, when one did. */
  override: { goalId: string; slot: RosterSlot } | null;
}

const NO_ADJUSTMENT: AttachmentAdjustment = {
  premium: 0,
  waived: 0,
  adjustment: 0,
  players: [],
  override: null
};

/**
 * The policy (pure): how much more a trade must be worth before this agent sends away players it is
 * attached to. `base bar + adjustment` is the reservation value, so base, adjustment, and result can
 * each be inspected. The premium only raises the bar (a preference is never a reason to accept a
 * worse deal) and is capped per player and in all.
 *
 * Override rule: when the players received can fill an active agenda goal (a pressing need this
 * week), the premium on attached players who could not fill that slot themselves is waived. Moving
 * a favorite to repair a hole is allowed; it still has to clear the base bar and floor.
 */
export function attachmentAdjustment(input: AttachmentPolicyInput): AttachmentAdjustment {
  const held = activeAttachments(input.attachments, input.at);
  const sent = held.filter((p) => input.sends.some((s) => s.id === p.playerId));
  if (sent.length === 0) return NO_ADJUSTMENT;
  const { maxPlayerPremium, maxPremium } = ATTACHMENT_POLICY;
  const scale = attachmentScale(input.tradeFrequency);
  const goal = input.agenda?.goals.find(
    (g) =>
      g.status === 'active' &&
      g.week === input.agenda?.week &&
      input.receives.some((r) => (SLOT_ELIGIBILITY[g.slot] as readonly string[]).includes(r.position))
  );
  const players = sent.map((p) => {
    const conviction = attachmentConviction(p, input.at);
    return {
      playerId: p.playerId,
      name: p.name,
      conviction,
      premium: round1(Math.min(maxPlayerPremium, conviction * maxPlayerPremium * scale)),
      // A player who could fill the need himself is not moved for it.
      waived: goal !== undefined && !(SLOT_ELIGIBILITY[goal.slot] as readonly string[]).includes(p.position)
    };
  });
  const premium = round1(
    Math.min(
      maxPremium,
      players.reduce((t, p) => t + p.premium, 0)
    )
  );
  const adjustment = round1(
    Math.min(
      premium,
      players.filter((p) => !p.waived).reduce((t, p) => t + p.premium, 0)
    )
  );
  const waived = round1(premium - adjustment);
  return {
    premium,
    waived,
    adjustment,
    players,
    override: goal === undefined || waived === 0 ? null : { goalId: goal.id, slot: goal.slot }
  };
}

/** The activity-summary line for an adjustment: which way the conflict went (never the premium). */
export function attachmentSummary(adjustment: AttachmentAdjustment): string {
  if (adjustment.players.length === 0) return '';
  const names = (list: typeof adjustment.players) => list.map((p) => p.name).join(', ');
  const kept = adjustment.players.filter((p) => !p.waived);
  const set = adjustment.players.filter((p) => p.waived);
  return [
    kept.length === 0
      ? ''
      : `Held ${names(kept)} to a higher bar: I'm attached to ${kept.length === 1 ? 'him' : 'them'}.`,
    adjustment.override === null
      ? ''
      : `Set aside my attachment to ${names(set)} for the ${adjustment.override.slot} need (${adjustment.override.goalId}).`
  ]
    .filter((line) => line.length > 0)
    .join(' ');
}

/**
 * Compact prompt lines for the held attachments an audience may hear about (#206; a seal is treated
 * as holding). The why is the evidence (drafted, traded for, results), never the numbers: premiums
 * and bars stay private.
 */
export function attachmentPrompt(
  state: PlayerAttachments | undefined,
  at: string,
  audience: MemoryAudience,
  playerIds?: readonly string[],
  max = 3
): string[] {
  return activeAttachments(state, at)
    .filter((p) => playerIds === undefined || playerIds.includes(p.playerId))
    .filter((p) => mayHear(p.visibility, audience, () => true))
    .slice(0, max)
    .map((p) => {
      const source = p.sources.at(-1);
      const how =
        source?.kind === 'drafted'
          ? `you drafted him${source.round === undefined ? '' : ` in round ${source.round}`}`
          : 'you traded for him';
      const revision = p.revisions.at(-1);
      return `${p.name} (${p.position}): ${how} and still believe in him${revision === undefined ? '' : `; ${revision.reason.replace(/\.$/, '')}`}. You would want a clearly better offer to move him.`;
    });
}
