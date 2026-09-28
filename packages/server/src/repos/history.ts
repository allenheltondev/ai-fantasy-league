import type { AchievementId, Bracket, HeadToHeadRecord, SeasonRecords } from '@fantasy/core';

/**
 * Playoffs, official finals, league history, and achievements (#78, #80, #81, #82). Everything
 * lives in the league partition (`pk = LEAGUE#<leagueId>`):
 * - Playoff bracket:   sk PLAYOFFS             (rebuilt from standings and results, stored for reads)
 * - Official final:    sk OFFICIAL#W05         (one per week; makes the Thursday job idempotent)
 * - Season archive:    sk HISTORY#<season>     (written when the league completes)
 * - Achievement:       sk ACHIEVEMENT#<id>     (one per award; the id makes awarding idempotent)
 */

export interface PlayoffRecord {
  leagueId: string;
  season: number;
  /** The regular-season week whose standings seeded the bracket. */
  seedingWeek: number;
  bracket: Bracket;
  championTeamId: string | null;
  consolationChampionTeamId: string | null;
  updatedAt: string;
}

/** A matchup's scores before the official final rescored it. */
export interface MatchupScoreSnapshot {
  matchupId: string;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number | null;
  awayScore: number | null;
}

export interface OfficialWeekRecord {
  leagueId: string;
  week: number;
  status: 'running' | 'complete';
  startedAt: string;
  completedAt: string | null;
  /** The provisional scores, captured when the run starts, so a retried run reports the same corrections. */
  provisional: MatchupScoreSnapshot[];
  /** Matchups whose score changed, once complete. */
  corrections: number;
  /** Matchups whose winner changed, once complete. */
  flipped: number;
}

export interface SeasonStandingRow {
  rank: number;
  teamId: string;
  teamName: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
}

export interface PlayoffGameResult {
  gameId: string;
  bracket: 'championship' | 'consolation';
  round: number;
  week: number;
  homeTeamId: string | null;
  awayTeamId: string | null;
  homeSeed: number | null;
  awaySeed: number | null;
  homeScore: number | null;
  awayScore: number | null;
  winnerTeamId: string | null;
}

/** One completed season, as the league finished it. */
export interface SeasonHistoryRecord {
  leagueId: string;
  season: number;
  leagueName: string;
  championTeamId: string | null;
  runnerUpTeamId: string | null;
  consolationChampionTeamId: string | null;
  finalStandings: SeasonStandingRow[];
  playoffResults: PlayoffGameResult[];
  records: SeasonRecords;
  headToHead: HeadToHeadRecord[];
  completedAt: string;
  updatedAt: string;
}

export interface AchievementRecord {
  /** `<achievementId>#<season>#<W05|season>#<teamId>`: one award per team per achievement per week. */
  id: string;
  leagueId: string;
  season: number;
  achievementId: AchievementId;
  teamId: string;
  week: number | null;
  reason: string;
  awardedAt: string;
}

export interface HistoryRepository {
  getPlayoffs(leagueId: string): Promise<PlayoffRecord | null>;
  putPlayoffs(record: PlayoffRecord): Promise<void>;

  /**
   * Claims a week's official final. Returns the stored record to continue with: a new claim, or a
   * `running` one started before `staleBefore` (a crashed run, taken over with its snapshot).
   * Returns null when the week is already official or another run holds it.
   */
  beginOfficialWeek(record: OfficialWeekRecord, staleBefore: string): Promise<OfficialWeekRecord | null>;
  completeOfficialWeek(record: OfficialWeekRecord): Promise<void>;
  getOfficialWeek(leagueId: string, week: number): Promise<OfficialWeekRecord | null>;

  putSeason(record: SeasonHistoryRecord): Promise<void>;
  /** Newest season first. */
  listSeasons(leagueId: string): Promise<SeasonHistoryRecord[]>;

  /** Stores awards not stored yet and returns those (so each is announced once). */
  addAchievements(records: readonly AchievementRecord[]): Promise<AchievementRecord[]>;
  /** Oldest first. */
  listAchievements(leagueId: string): Promise<AchievementRecord[]>;
}
