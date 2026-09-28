/**
 * Response shapes of the operations the league setup screens call, as documented in
 * packages/server/openapi.json. Only the fields the app reads are listed.
 */

export type Phase = 'setup' | 'drafting' | 'regular_season' | 'playoffs' | 'complete';
export type SeatType = 'human' | 'agent';
export type ScoringPreset = 'yahoo_standard' | 'full_ppr' | 'standard';

export interface MyLeague {
  id: string;
  name: string;
  season: number;
  phase: Phase;
  week: number | null;
  teamCount: number;
  startWeek: number;
  commissionerName: string;
  youAreCommissioner: boolean;
  yourTeamId: string | null;
  record: string | null;
}

export interface TeamDetail {
  id: string;
  name: string;
  seatType: SeatType;
  open: boolean;
  ownerName: string | null;
  ownerUserId: string | null;
  draftSlot: number;
}

/** League rules. Nested groups are kept loose: the rules editor walks them by dotted path. */
export interface LeagueSettings {
  teamCount: number;
  schedule: Record<string, unknown>;
  roster: { slots: Record<string, number>; irEligibleStatuses: string[] };
  scoring: { perStat: Record<string, number>; tiers: unknown[] };
  waivers: Record<string, unknown>;
  trades: Record<string, unknown>;
  playoffs: Record<string, unknown>;
}

export interface LeagueDetail {
  id: string;
  name: string;
  season: number;
  phase: Phase;
  week: number | null;
  version: number;
  commissioner: { userId: string; name: string };
  settings: LeagueSettings;
  teams: TeamDetail[];
}

export interface LeagueState {
  leagueId: string;
  name: string;
  phase: Phase;
  week: number | null;
  youAreCommissioner: boolean;
  yourTeam: TeamDetail | null;
  allowedActions: string[];
}

export type InviteStatus = 'active' | 'expired' | 'used_up' | 'revoked';

export interface Invite {
  id: string;
  status: InviteStatus;
  email: string | null;
  maxUses: number;
  uses: number;
  expiresAt: string;
}

export interface CreatedInvite {
  invite: Invite;
  token: string;
  joinPath: string;
}

export interface InvitePreview {
  leagueName: string;
  season: number;
  commissionerName: string;
  phase: Phase;
  teamCount: number;
  openSeats: number;
  status: InviteStatus;
  joinable: boolean;
}

export interface AgentLevers {
  decisionModelTier?: string;
  chatModelTier?: string;
  reasoningEffort?: string;
  maxToolSteps?: number;
  actionsPerTrigger?: number;
  cooldownMinutes?: number;
  negotiationRounds?: number;
  valuationNoise?: number;
  research?: Partial<Record<'projections' | 'news' | 'trending' | 'matchupOutlook', boolean>>;
}

export interface AgentSeatConfig {
  personalityId: string;
  difficulty: string;
  archetype: string;
  advanced?: { modelOverride?: string; levers?: AgentLevers; customFlavor?: string };
}

export interface Personality {
  id: string;
  displayName: string;
  teamNameSuggestion: string;
  bio: string;
  avatarSeed: string;
}

export interface AgentCatalog {
  personalities: Personality[];
  difficulties: { id: string; displayName: string; description: string; decisionModelTier: string }[];
  archetypes: { id: string; displayName: string; description: string }[];
  modelTiers: string[];
  models: { key: string; displayName: string; tier: string }[];
  suggestion: { seed: string; seats: AgentSeatConfig[] } | null;
}

export interface AgentSeatView {
  seat: {
    teamId: string;
    personality: Personality;
    difficulty: { id: string; displayName: string };
  };
  commissioner: { current: { version: number; config: AgentSeatConfig } } | null;
}

export interface DefaultSettings {
  settings: LeagueSettings;
  editability: Record<string, 'pre_draft' | 'any_time'>;
  statLabels: Record<string, string>;
  rosterSlots: string[];
  playerStatuses: string[];
}

export interface SettingsIssue {
  code: string;
  path: string;
  message: string;
  fix: string;
}

// ---------------------------------------------------------------------------
// Season loop: get_roster, set_lineup, get_matchup, get_standings
// ---------------------------------------------------------------------------

export interface PlayerRef {
  id: string;
  name: string;
  team: string | null;
  position: string;
}

export interface RosterEntry {
  player: PlayerRef;
  slot: string;
  status: string;
  injuryStatus: string | null;
  byeWeek: number | null;
  onBye: boolean;
  kickoff: string | null;
  locked: boolean;
  projectedPoints: number | null;
  points: number | null;
}

export interface SlotCount {
  slot: string;
  count: number;
}

export interface Roster {
  teamId: string;
  teamName: string;
  week: number;
  lineupSaved: boolean;
  carriedFromWeek: number | null;
  slots: SlotCount[];
  players: RosterEntry[];
}

export interface LineupMove {
  playerId: string;
  slot: string;
}

export interface MatchupSide {
  teamId: string;
  teamName: string;
  score: number | null;
}

export interface MatchupLineup {
  teamId: string;
  points: number;
  players: RosterEntry[];
}

export interface MatchupData {
  week: number;
  teamId: string;
  matchup: {
    id: string;
    status: 'scheduled' | 'in_progress' | 'final';
    home: MatchupSide;
    away: MatchupSide;
  } | null;
  lineups: { home: MatchupLineup; away: MatchupLineup } | null;
}

export interface StandingsRow {
  rank: number;
  teamId: string;
  teamName: string;
  record: string;
  pointsFor: number;
  pointsAgainst: number;
  streak: string | null;
}

export interface StandingsData {
  throughWeek: number | null;
  standings: StandingsRow[];
}

export interface BracketSideView {
  teamId: string | null;
  teamName: string | null;
  seed: number | null;
  score: number | null;
  from: string;
}

export interface BracketGameView {
  id: string;
  bracket: 'championship' | 'consolation';
  round: number;
  week: number;
  home: BracketSideView;
  away: BracketSideView;
  winnerTeamId: string | null;
  decidedBySeed: boolean;
}

export interface PlayoffBracketData {
  status: 'not_started' | 'projected' | 'in_progress' | 'complete';
  teams: number;
  byes: number;
  weeks: number[];
  reseed: boolean;
  consolation: boolean;
  seeds: { seed: number; teamId: string; teamName: string }[];
  games: BracketGameView[];
  championTeamId: string | null;
  consolationChampionTeamId: string | null;
}

export interface TeamScoreRecord {
  teamId: string;
  teamName: string;
  week: number;
  points: number;
}

export interface MarginRecord {
  week: number;
  winnerTeamId: string;
  winnerName: string;
  loserTeamId: string;
  loserName: string;
  winnerScore: number;
  loserScore: number;
  margin: number;
}

export interface SeasonRecordsView {
  highestScore: TeamScoreRecord | null;
  lowestScore: TeamScoreRecord | null;
  biggestBlowout: MarginRecord | null;
  closestGame: MarginRecord | null;
}

export interface LeagueHistoryData {
  seasons: {
    season: number;
    championTeamId: string | null;
    championName: string | null;
    runnerUpTeamId: string | null;
    finalStandings: {
      rank: number;
      teamId: string;
      teamName: string;
      wins: number;
      losses: number;
      ties: number;
    }[];
    records: SeasonRecordsView;
    completedAt: string;
  }[];
  current: {
    season: number;
    records: SeasonRecordsView;
    headToHead: {
      teamId: string;
      teamName: string;
      opponentId: string;
      opponentName: string;
      wins: number;
      losses: number;
      ties: number;
    }[];
  };
  achievements: {
    id: string;
    achievementId: string;
    name: string;
    teamId: string;
    teamName: string;
    week: number | null;
    reason: string;
  }[];
  trades: {
    id: string;
    at: string;
    week: number;
    teamName: string;
    added: PlayerRef | null;
    dropped: PlayerRef | null;
  }[];
}
