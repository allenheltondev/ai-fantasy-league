import type { PlayerRef } from './board';

/** Draft research views (#136): `get_player_card` and `get_draft_depth`, plus display helpers. */

export const BOARD_SORTS = ['rank', 'lastSeasonPoints', 'ppg', 'projection'] as const;
export type BoardSort = (typeof BOARD_SORTS)[number];

export interface NewsHeadline {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt: string;
}

/** One of his last games in detail: the points, the opponent, and where the points came from. */
export interface RecentGame {
  week: number;
  points: number;
  /** Points above (+) or below (-) his points per game this season. */
  vsAverage: number;
  opponent: { team: string; home: boolean } | null;
  breakdown: { stat: string; text: string; points: number }[];
}

/** A player's usage this season from nflverse's official weekly stats (get_player_card). */
export interface SeasonUsage {
  games: number;
  throughWeek: number;
  /** Fractions: 0.25 is 25%. */
  targetShare: number | null;
  airYardsShare: number | null;
  wopr: number | null;
  aDot: number | null;
  yacPerReception: number | null;
  /** Expected points added per game. */
  receivingEpa: number | null;
  rushingEpa: number | null;
  passingEpa: number | null;
  cpoe: number | null;
  passingAdot: number | null;
}

type UsageField = Exclude<keyof SeasonUsage, 'games' | 'throughWeek'>;

/** Each usage figure's label, what it means, and how it reads. */
const USAGE_FIELDS: Readonly<
  Record<UsageField, { label: string; title: string; format(v: number): string }>
> = {
  targetShare: {
    label: 'Target share',
    title: "Share of his team's targets",
    format: (v) => `${fmt(v * 100)}%`
  },
  airYardsShare: {
    label: 'Air yds share',
    title: "Share of his team's air yards",
    format: (v) => `${fmt(v * 100)}%`
  },
  wopr: {
    label: 'WOPR',
    title: 'Weighted opportunity rating: 1.5 × target share + 0.7 × air yards share',
    format: (v) => (Math.round(v * 100) / 100).toFixed(2)
  },
  aDot: { label: 'aDOT', title: 'Average depth of target, in air yards', format: (v) => fmt(v) },
  yacPerReception: { label: 'YAC/rec', title: 'Yards after the catch per reception', format: (v) => fmt(v) },
  receivingEpa: { label: 'Rec EPA/g', title: 'Receiving expected points added per game', format: signed },
  rushingEpa: { label: 'Rush EPA/g', title: 'Rushing expected points added per game', format: signed },
  passingEpa: { label: 'Pass EPA/g', title: 'Passing expected points added per game', format: signed },
  cpoe: { label: 'CPOE', title: 'Completion percentage over expected', format: signed },
  passingAdot: { label: 'Air yds/att', title: 'Air yards per pass attempt', format: (v) => fmt(v) }
};

const QB_USAGE: readonly UsageField[] = ['passingEpa', 'cpoe', 'passingAdot', 'rushingEpa'];
const SKILL_USAGE: readonly UsageField[] = [
  'targetShare',
  'airYardsShare',
  'wopr',
  'aDot',
  'yacPerReception',
  'receivingEpa',
  'rushingEpa'
];

function signed(v: number): string {
  return v > 0 ? `+${fmt(v)}` : fmt(v);
}

/** The usage figures worth showing for a position, in reading order, leaving out the unreported. */
export function usageEntries(
  usage: SeasonUsage,
  position: string
): { key: UsageField; label: string; title: string; value: string }[] {
  const fields = position === 'QB' ? QB_USAGE : position === 'K' || position === 'DEF' ? [] : SKILL_USAGE;
  return fields.flatMap((key) => {
    const value = usage[key];
    const field = USAGE_FIELDS[key];
    return value === null
      ? []
      : [{ key, label: field.label, title: field.title, value: field.format(value) }];
  });
}

export interface PlayerCardData {
  player: PlayerRef & { status?: string; injuryStatus?: string | null; rank?: number | null };
  scoring: { source: 'league' | 'default' };
  bye: number | null;
  injuryStatus: string | null;
  /** ESPN's note on his designation; null without one (older servers omit it). */
  injuryNote?: { text: string; reportedAt: string | null } | null;
  /** Age, seasons in the NFL before this one (0: rookie), and jersey number (older servers omit it). */
  bio?: { age: number | null; yearsExp: number | null; number: number | null };
  lastSeason: {
    season: number;
    points: number;
    ppg: number;
    games: number;
    weekly: { week: number; points: number }[];
    totals: Record<string, number>;
  } | null;
  projection: { season: number; points: number; totals: Record<string, number> } | null;
  /** This regular season so far; null before his first stat line (or on an older server). */
  thisSeason?: {
    season: number;
    points: number;
    ppg: number;
    games: number;
    weekly: { week: number; points: number }[];
    totals: Record<string, number>;
    /** His last three games played, newest first, in detail (older servers omit it). */
    recent?: RecentGame[];
    /** His usage from nflverse's official weekly stats; null before an official week (older servers omit it). */
    usage?: SeasonUsage | null;
  } | null;
  /** The current NFL week's projection and matchup; null in the offseason (or on an older server). */
  nextWeek?: {
    season: number;
    week: number;
    points: number | null;
    totals: Record<string, number>;
    bye: boolean;
    opponent: { team: string; home: boolean } | null;
    kickoff: string | null;
    /** How the opponent's defense has fared against his position (PPR); null on a bye or before week 2. */
    matchup?: {
      position: string;
      perGame: number;
      /** 1 allows the most points (easiest) through `of` (toughest). */
      rank: number;
      of: number;
      games: number;
      throughWeek: number;
    } | null;
  } | null;
  news: NewsHeadline[];
}

export interface TeamDepth {
  teamId: string;
  teamName: string;
  yours: boolean;
  picksBeforeYou: number;
  positions: { position: string; players: PlayerRef[] }[];
  slots: { slot: string; required: number; filled: number }[];
  gaps: string[];
}

export interface DraftDepth {
  yourTeamId: string | null;
  teams: TeamDepth[];
}

/** Short labels for the stat keys a player card totals. */
export const STAT_NAMES: Readonly<Record<string, string>> = {
  pass_att: 'Pass att',
  pass_cmp: 'Comp',
  pass_yd: 'Pass yds',
  pass_td: 'Pass TD',
  pass_int: 'INT thrown',
  rush_att: 'Carries',
  rush_yd: 'Rush yds',
  rush_td: 'Rush TD',
  rec_tgt: 'Targets',
  rec: 'Receptions',
  rec_yd: 'Rec yds',
  rec_td: 'Rec TD',
  fum_lost: 'Fumbles lost',
  fgm: 'FG made',
  fga: 'FG att',
  fgm_50p: 'FG 50+',
  xpm: 'XP made',
  xpa: 'XP att',
  sack: 'Sacks',
  int: 'INT',
  fum_rec: 'Fum rec',
  def_td: 'Def TD',
  safe: 'Safeties',
  pts_allow: 'Pts allowed',
  yds_allow: 'Yds allowed'
};

/** One decimal, dropping a trailing `.0`; an em dash for no value. */
export function fmt(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return String(Math.round(value * 10) / 10);
}
