import { z } from 'zod';
import { ScoringSettingsSchema, scoringPreset, type ScoringPreset } from '../scoring/settings.js';
import {
  DEFAULT_IR_ELIGIBLE_STATUSES,
  PlayerStatusSchema,
  RosterSlotSchema,
  type RosterSlot
} from './positions.js';

export const MIN_TEAMS = 4;
export const MAX_TEAMS = 12;
/** Last week of the NFL regular season (fantasy playoffs cannot run past it). */
export const LAST_NFL_WEEK = 18;

const week = z.int().min(1).max(LAST_NFL_WEEK);

export const RosterSettingsSchema = z.strictObject({
  /** Count of each slot. Omitted or 0 means the league does not use that slot. */
  slots: z.partialRecord(RosterSlotSchema, z.int().min(0).max(15)),
  /** Player statuses allowed in an IR slot. */
  irEligibleStatuses: z.array(PlayerStatusSchema).min(1)
});
export type RosterSettings = z.infer<typeof RosterSettingsSchema>;

export const WaiverTypeSchema = z.enum(['faab', 'rolling']);
export const WaiverSettingsSchema = z.strictObject({
  /** `faab`: blind bidding from a season budget. `rolling`: Yahoo continual rolling priority list. */
  type: WaiverTypeSchema,
  /** Season FAAB budget in whole dollars (ignored for rolling waivers). */
  faabBudget: z.int().min(0).max(1000),
  /** Whether a $0 bid is a legal claim. */
  allowZeroBids: z.boolean(),
  /** Days a dropped player spends on waivers before becoming a free agent. */
  waiverPeriodDays: z.int().min(0).max(7),
  /**
   * How equal FAAB bids are broken. `waiver_priority` uses the rolling priority list (the winner
   * moves to the back); `reverse_standings` favours the team with the worse record; `earliest_claim`
   * favours the claim submitted first.
   */
  faabTiebreak: z.enum(['waiver_priority', 'reverse_standings', 'earliest_claim']),
  /** Initial order of the priority list: reverse of the draft order, or reset weekly by standings. */
  priorityOrder: z.enum(['reverse_draft_continual', 'reverse_standings_weekly']),
  /** Undrafted players after the draft go through waivers first (Yahoo default) or are free agents. */
  postDraftPlayers: z.enum(['waivers', 'free_agents']),
  /** Maximum adds per team per week; null means unlimited. */
  maxAcquisitionsPerWeek: z.int().min(1).max(50).nullable()
});
export type WaiverSettings = z.infer<typeof WaiverSettingsSchema>;

export const TradeReviewSchema = z.enum(['league_vote', 'commissioner', 'none']);
export type TradeReview = z.infer<typeof TradeReviewSchema>;

export const TradeSettingsSchema = z.strictObject({
  review: TradeReviewSchema,
  /** Days an accepted trade waits for review before it processes. */
  reviewPeriodDays: z.int().min(0).max(7),
  /**
   * Veto votes needed to cancel a trade under `league_vote`. `null` uses the Yahoo rule computed by
   * `vetoVotesRequired` (one third of the league, rounded up, capped at the eligible voters).
   */
  vetoVotes: z.int().min(1).max(MAX_TEAMS).nullable(),
  /** No trades may be processed once this week's first game kicks off. */
  deadlineWeek: week,
  /** Hours an offer stays open before it expires. */
  offerExpiryHours: z
    .int()
    .min(1)
    .max(24 * 14),
  /** Offers also expire at the next lineup lock when that comes first. */
  expireAtNextLineupLock: z.boolean()
});
export type TradeSettings = z.infer<typeof TradeSettingsSchema>;

export const PlayoffSettingsSchema = z.strictObject({
  teams: z.int().min(2).max(8),
  /** Top seeds that skip the first round. */
  byes: z.int().min(0).max(6),
  startWeek: week,
  endWeek: week,
  /** Seeding tiebreaker for equal records. */
  tiebreaker: z.enum(['points_for', 'head_to_head'])
});
export type PlayoffSettings = z.infer<typeof PlayoffSettingsSchema>;

export const ScheduleSettingsSchema = z.strictObject({
  /** First NFL week the league plays. Later than 1 for a mid-season start. */
  startWeek: week,
  /** Last regular-season week; playoffs start the week after. */
  regularSeasonEndWeek: week
});
export type ScheduleSettings = z.infer<typeof ScheduleSettingsSchema>;

export const LeagueSettingsSchema = z.strictObject({
  teamCount: z.int().min(MIN_TEAMS).max(MAX_TEAMS),
  schedule: ScheduleSettingsSchema,
  roster: RosterSettingsSchema,
  scoring: ScoringSettingsSchema,
  waivers: WaiverSettingsSchema,
  trades: TradeSettingsSchema,
  playoffs: PlayoffSettingsSchema
});
export type LeagueSettings = z.infer<typeof LeagueSettingsSchema>;

/** Yahoo public-league roster: QB, 3 WR, 2 RB, TE, W/R/T, K, DEF, 6 BN, 1 IR. */
export function yahooDefaultRosterSlots(): Partial<Record<RosterSlot, number>> {
  return { QB: 1, WR: 3, RB: 2, TE: 1, 'W/R/T': 1, K: 1, DEF: 1, BN: 6, IR: 1 };
}

/** Yahoo playoff defaults: 6 teams with 2 byes in weeks 15-17; 4 teams in weeks 16-17 for small leagues. */
export function yahooDefaultPlayoffs(teamCount: number): PlayoffSettings {
  return teamCount <= 6
    ? { teams: 4, byes: 0, startWeek: 16, endWeek: 17, tiebreaker: 'points_for' }
    : { teams: 6, byes: 2, startWeek: 15, endWeek: 17, tiebreaker: 'points_for' };
}

export interface DefaultSettingsOptions {
  scoring?: ScoringPreset;
  /** First week of a mid-season start (default 1). */
  startWeek?: number;
}

/**
 * League settings matching a Yahoo public league. The commissioner can change any of it before the
 * draft (see `SETTINGS_EDITABILITY` for what stays editable afterwards).
 */
export function yahooDefaultSettings(teamCount = 8, options: DefaultSettingsOptions = {}): LeagueSettings {
  const playoffs = yahooDefaultPlayoffs(teamCount);
  return {
    teamCount,
    schedule: { startWeek: options.startWeek ?? 1, regularSeasonEndWeek: playoffs.startWeek - 1 },
    roster: { slots: yahooDefaultRosterSlots(), irEligibleStatuses: [...DEFAULT_IR_ELIGIBLE_STATUSES] },
    scoring: scoringPreset(options.scoring ?? 'yahoo_standard'),
    waivers: {
      type: 'faab',
      faabBudget: 100,
      allowZeroBids: true,
      waiverPeriodDays: 2,
      faabTiebreak: 'waiver_priority',
      priorityOrder: 'reverse_draft_continual',
      postDraftPlayers: 'waivers',
      maxAcquisitionsPerWeek: null
    },
    trades: {
      review: 'league_vote',
      reviewPeriodDays: 2,
      vetoVotes: null,
      deadlineWeek: 11,
      offerExpiryHours: 48,
      expireAtNextLineupLock: true
    },
    playoffs
  };
}

export const LEAGUE_PRESETS = ['yahoo_standard', 'full_ppr', 'standard'] as const;
export type LeaguePreset = (typeof LEAGUE_PRESETS)[number];

/** Yahoo default settings with the named scoring preset. */
export function leagueSettingsPreset(preset: LeaguePreset, teamCount = 8): LeagueSettings {
  return yahooDefaultSettings(teamCount, { scoring: preset });
}

/**
 * Veto votes needed to cancel a trade under league vote. Uses `trades.vetoVotes` when set, otherwise
 * the Yahoo rule: one third of the league rounded up, never more than the teams not in the trade.
 */
export function vetoVotesRequired(settings: Pick<LeagueSettings, 'teamCount' | 'trades'>): number {
  const eligibleVoters = Math.max(1, settings.teamCount - 2);
  const wanted = settings.trades.vetoVotes ?? Math.ceil(settings.teamCount / 3);
  return Math.min(wanted, eligibleVoters);
}

/** Number of each slot, 0 when unused. */
export function slotCount(settings: Pick<LeagueSettings, 'roster'>, slot: RosterSlot): number {
  return settings.roster.slots[slot] ?? 0;
}

/** Active roster size: every slot except IR. */
export function activeRosterSize(settings: Pick<LeagueSettings, 'roster'>): number {
  return Object.entries(settings.roster.slots).reduce(
    (n, [slot, count]) => (slot === 'IR' ? n : n + (count ?? 0)),
    0
  );
}

/** Starting lineup size: every slot except BN and IR. */
export function starterCount(settings: Pick<LeagueSettings, 'roster'>): number {
  return activeRosterSize(settings) - slotCount(settings, 'BN');
}

/** Number of playoff rounds (one week each). */
export function playoffRounds(playoffs: Pick<PlayoffSettings, 'teams'>): number {
  return Math.ceil(Math.log2(playoffs.teams));
}

/** Byes a single-elimination bracket of `teams` needs so every later round is a power of two. */
export function requiredByes(teams: number): number {
  return 2 ** Math.ceil(Math.log2(teams)) - teams;
}

type Plain = Record<string, unknown>;
function isPlain(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Recursive partial used for commissioner edits. Arrays are replaced, objects are merged. */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;
export type LeagueSettingsPatch = DeepPartial<LeagueSettings>;

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlain(base) || !isPlain(patch)) return patch === undefined ? base : structuredClone(patch);
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) out[k] = deepMerge(base[k], v);
  }
  return out;
}

/**
 * Applies a commissioner patch to settings. Objects merge key by key (so `{ scoring: { perStat: { rec: 1 } } }`
 * only changes reception points); arrays are replaced. The result is not validated; run
 * `parseLeagueSettings` on it.
 */
export function applySettingsPatch(base: LeagueSettings, patch: LeagueSettingsPatch): unknown {
  return deepMerge(structuredClone(base), patch);
}
