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
