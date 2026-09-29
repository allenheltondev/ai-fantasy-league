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

/** The AI manager playing an agent team (#159): absent on older responses, null for people. */
export interface Manager {
  name: string;
  avatarSeed: string;
  /** The personality it plays, e.g. "The Spreadsheet"; null until the seat is configured. */
  personality: string | null;
}

export interface TeamDetail {
  id: string;
  name: string;
  seatType: SeatType;
  open: boolean;
  ownerName: string | null;
  ownerUserId: string | null;
  draftSlot: number;
  manager?: Manager | null;
  /** The seed its owner picked for the team's avatar (#178); null until set, absent on older responses. */
  avatarSeed?: string | null;
  /** Who set the name (#194); absent on older responses. */
  nameSetBy?: 'owner' | 'commissioner' | 'agent' | 'default';
  /** The name before its last rename, e.g. "Team 3"; null if never renamed. */
  renamedFrom?: string | null;
}

/** A team in get_league_state's `teams`. */
export type LeagueTeam = Omit<TeamDetail, 'ownerUserId'>;

/** A scoring bucket: `min` to `max` inclusive (`max` null means no upper bound) scores `points`. */
export interface TierBand {
  min: number;
  max: number | null;
  points: number;
}

/** Bucketed scoring for one stat, such as points allowed by a team defense. */
export interface TierRule {
  stat: string;
  bands: TierBand[];
}

/** League rules. Nested groups are kept loose: the rules editor walks them by dotted path. */
export interface LeagueSettings {
  teamCount: number;
  schedule: Record<string, unknown>;
  roster: { slots: Record<string, number>; irEligibleStatuses: string[] };
  scoring: { perStat: Record<string, number>; tiers: TierRule[] };
  waivers: Record<string, unknown>;
  trades: Record<string, unknown>;
  playoffs: Record<string, unknown>;
  /** The draft: its pick clock, and when (and in which order) it starts by itself. */
  draft?: DraftSettings;
}

export type DraftOrderMode = 'slots' | 'random';

export interface DraftSettings {
  pickSeconds?: number;
  /** ISO instant (UTC); null when the commissioner starts the draft by hand. */
  scheduledAt?: string | null;
  orderMode?: DraftOrderMode;
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
  /** Every team: names, seats, AI managers, and team avatars. */
  teams?: LeagueTeam[];
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
  /** How long the agent waits before acting on a trigger (#189). */
  responseDelay?: { multiplier?: number; immediateChance?: number };
}

export interface AgentSeatConfig {
  personalityId: string;
  difficulty: string;
  archetype: string;
  /** The manager's name (#159); a default is shown when absent. */
  name?: string;
  avatarSeed?: string;
  /** Let this manager name its team (#194); on unless false. Commissioner only. */
  namesTeam?: boolean;
  advanced?: { modelOverride?: string; levers?: AgentLevers; customFlavor?: string };
}

export interface Personality {
  id: string;
  displayName: string;
  teamNameSuggestion: string;
  bio: string;
  avatarSeed: string;
  /** Nicknames a manager with this personality may carry. */
  nicknames?: string[];
}

export interface AgentCatalog {
  personalities: Personality[];
  difficulties: { id: string; displayName: string; description: string; decisionModelTier: string }[];
  archetypes: { id: string; displayName: string; description: string }[];
  modelTiers: string[];
  models: { key: string; displayName: string; tier: string }[];
  suggestion: { seed: string; seats: AgentSeatConfig[] } | null;
  /** The pool manager names are drawn from. */
  managerNames?: { first: string[]; last: string[] };
}

export interface AgentSeatView {
  seat: {
    teamId: string;
    manager?: { name: string; avatarSeed: string };
    personality: Personality;
    difficulty: { id: string; displayName: string };
  };
  commissioner: {
    current: { version: number; config: AgentSeatConfig };
    /** Every saved version, newest first (#77). */
    history: AgentSeatRevision[];
  } | null;
}

export interface AgentSeatRevision {
  version: number;
  updatedAt: string;
  updatedBy: string;
  config: AgentSeatConfig;
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

/**
 * A player's NFL game this week as the server sees it (#193, core `playerGame`): the matchup, the
 * outlook, the lineup locks, and the agents all use this one state.
 */
export interface PlayerGame {
  state: 'upcoming' | 'live' | 'final' | 'bye';
  opponent: string | null;
  home: boolean | null;
  kickoff: string | null;
  period: number | null;
  clock: string | null;
  teamScore: number | null;
  opponentScore: number | null;
  possession: boolean;
  redZone: boolean;
  /** Share of the game played, 0-1; null when unknown. */
  progress: number | null;
}

export interface RosterEntry {
  player: PlayerRef;
  slot: string;
  status: string;
  injuryStatus: string | null;
  byeWeek: number | null;
  onBye: boolean;
  kickoff: string | null;
  /** His NFL team's opponent this week (#176): absent on older responses, null on a bye. */
  opponent?: { team: string; home: boolean } | null;
  locked: boolean;
  projectedPoints: number | null;
  points: number | null;
  /** Points per game over the last 3 NFL weeks (get_roster, #176), or null with no games yet. */
  recentPoints?: { average: number; games: number } | null;
  /** His game (#193); absent on older responses. */
  game?: PlayerGame;
  /** Expected final points, live-adjusted (#193), or null with no projection and no points. */
  expectedPoints?: number | null;
  /** "18/27 · 212 yds · 2 TD" once his game is under way (#193). */
  statLine?: string | null;
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
  /** The starters' projection; starters on bye or ruled out count 0 (#176). */
  projectedPoints?: number;
  /** The best legal lineup as set_lineup moves from this one, by projection or, with none, by rank (#176). */
  optimal?: { basis?: 'projections' | 'rank'; projectedPoints: number; moves: LineupMove[] } | null;
}

export interface LineupMove {
  playerId: string;
  slot: string;
}

export interface MatchupSide {
  teamId: string;
  teamName: string;
  score: number | null;
  manager?: Manager | null;
}

export interface MatchupLineup {
  teamId: string;
  points: number;
  /** The starters' expected final score, live-adjusted (#193); absent on older responses. */
  projectedPoints?: number;
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

/** One change in a matchup's scoring log (get_scoring_log, #162). */
export interface ScoringLogEntry {
  /** `<at>#<playerId>`: unique per matchup, and sorts in time order. */
  id: string;
  at: string;
  kind: 'live' | 'correction';
  teamId: string;
  teamName: string;
  slot: string;
  starter: boolean;
  player: PlayerRef;
  changes: { stat: string; delta: number }[];
  summary: string;
  points: number;
  touchdown: boolean;
  /**
   * ESPN's description of the touchdown or field goal (#164), when exactly one play fits; null
   * otherwise. Left out by pushes from before it existed.
   */
  play?: { text: string } | null;
}

/** get_scoring_log (#162): one page of a matchup's scoring log, newest first. */
export interface ScoringLogData {
  week: number;
  teamId: string;
  matchupId: string | null;
  entries: ScoringLogEntry[];
  nextCursor: string | null;
}

/** One NFL game as it stands (get_nfl_games, #132). Team codes are Sleeper's (`WAS`, `LAR`). */
export interface NflGame {
  gameId: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  homeScore: number | null;
  awayScore: number | null;
  kickoff: string | null;
  state: 'pre' | 'in' | 'post';
  status: string | null;
  period: number | null;
  clock: string | null;
  possessionTeam: string | null;
  isRedZone: boolean;
  downDistance: string | null;
  fieldPosition: string | null;
  yardsToGoal: number | null;
}

/** A team with the ball inside the opponent's 20. */
export interface RedZoneTeam {
  team: string;
  downDistance: string | null;
  fieldPosition: string | null;
}

/** get_nfl_games (#132): the week's NFL games and the teams in the red zone. */
export interface NflGamesData {
  season: number;
  week: number;
  games: NflGame[];
  redZone: RedZoneTeam[];
  updatedAt: string | null;
}

export interface OutlookSide {
  teamId: string;
  teamName: string;
  currentPoints: number;
  projectedPoints: number;
  remainingPoints: number;
  playersYetToPlay: number;
  playersInProgress: number;
  /** Starters whose game is final (#193). */
  playersDone?: number;
  /** Starters on bye or ruled out (#193). */
  playersNotPlaying?: number;
  winProbability: number | null;
}

/** get_matchup_outlook (#36). */
export interface MatchupOutlook {
  week: number;
  teamId: string;
  status: 'scheduled' | 'in_progress' | 'final' | null;
  you: OutlookSide;
  opponent: OutlookSide | null;
  insights: {
    startersOut: { player: PlayerRef; slot: string; reason: 'bye' | 'out' }[];
    emptySlots: { slot: string; missing: number }[];
    benchUpgrades: { player: PlayerRef; replaces: PlayerRef | null; slot: string; gain: number }[];
    lockedPlayers: PlayerRef[];
    currentProjectedPoints: number;
    optimalProjectedPoints: number;
  };
}

export interface StandingsRow {
  rank: number;
  teamId: string;
  teamName: string;
  manager?: Manager | null;
  record: string;
  pointsFor: number;
  pointsAgainst: number;
  streak: string | null;
}

export interface StandingsData {
  throughWeek: number | null;
  standings: StandingsRow[];
}

/** get_model_leaderboard (#76): which model wins the league. */
export interface ModelLeaderboardRecord {
  wins: number;
  losses: number;
  ties: number;
  winRate: number | null;
  pointsFor: number;
  costUsd: number;
  trades: number;
  tradesWon: number;
  tradesLost: number;
  /** Player value won (+) or lost (-) in processed trades. */
  tradeValue: number;
  waiverClaims: number;
  waiverHits: number;
  waiverHitRate: number | null;
  waiverNetPoints: number;
}

export interface ModelLeaderboardTeam extends ModelLeaderboardRecord {
  teamId: string;
  teamName: string;
  seatType: SeatType;
  rank: number;
  modelKey: string;
  modelName: string;
  provider: string | null;
  personality: string | null;
  difficulty: string | null;
}

export interface ModelLeaderboardModel extends ModelLeaderboardRecord {
  modelKey: string;
  modelName: string;
  provider: string | null;
  teams: number;
  bestRank: number;
  pointsForPerTeam: number;
  costPerWinUsd: number | null;
}

export interface ModelLeaderboard {
  throughWeek: number | null;
  teams: ModelLeaderboardTeam[];
  models: ModelLeaderboardModel[];
}

/** get_agent_activity (#45, #77): the commissioner's view of the league's agents. */
export interface AgentTaskRecord {
  taskId: string;
  teamId: string;
  agentId: string;
  kind: string;
  week: number;
  trigger: { detailType: string; eventId: string };
  status: 'completed' | 'fallback' | 'failed' | 'skipped';
  fallbackReason: string | null;
  toolsCalled: { name: string; mutation: boolean; ok: boolean; errorCode: string | null }[];
  finalAction: string;
  reasoningSummary: string;
  latencyMs: number;
  usage: { modelKey: string; inputTokens: number; outputTokens: number; estimatedCostUsd: number }[];
  costUsd: number;
  startedAt: string;
  finishedAt: string;
  /** True while the task holds sealed information (a pending bid, a private offer, an open vote). */
  redacted?: boolean;
}

export interface AgentSpend {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  tasks: number;
}

export interface AgentActivity {
  tasks: AgentTaskRecord[];
  budget: {
    week: number;
    ceilingUsd: number;
    spentUsd: number;
    remainingUsd: number;
    exceeded: boolean;
    byAgent: (AgentSpend & { agentId: string; teamId: string | null; allowanceUsd: number | null })[];
    byModel: (AgentSpend & { modelKey: string })[];
  };
  killSwitch: { configured: boolean; engaged: boolean };
}

/** One data job run (get_data_status, #181). */
export interface DataJobRun {
  finishedAt: string;
  status: 'ok' | 'skipped' | 'failed';
  reason: string | null;
  summary: string | null;
  durationMs: number;
}

export interface DataSeasonSet {
  season: number;
  updatedAt: string;
  checkedAt: string | null;
  players: number;
  weeks: number[];
}

/** get_data_status (#181): the commissioner's view of the NFL data behind projections and research. */
export interface DataStatus {
  checkedAt: string;
  nflState: {
    season: number;
    seasonType: 'pre' | 'regular' | 'post' | 'off';
    week: number;
    leagueSeason: number;
    updatedAt: string;
  } | null;
  league: { season: number; week: number | null };
  players: { total: number; byPosition: Record<'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DEF', number> };
  weeks: {
    season: number;
    week: number;
    /** `source`: the Sleeper endpoint that served the snapshot (#184); null before it was recorded. */
    projections: { capturedAt: string; count: number; hash: string; source?: 'v1' | 'app' | null } | null;
    statLines: number;
  }[];
  research: {
    stats: DataSeasonSet | null;
    projections: DataSeasonSet | null;
    /** This season's stats so far (newer servers). */
    currentStats?: DataSeasonSet | null;
  };
  jobs: { job: string; latest: DataJobRun | null; lastOk: DataJobRun | null }[];
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
  /** The best and worst trades by value delta (one entry per team side). */
  tradeRecords: { best: TradeValueRecord[]; worst: TradeValueRecord[] };
}

export interface TradeValueRecord {
  tradeId: string;
  at: string;
  week: number;
  teamId: string;
  teamName: string;
  partnerTeamId: string;
  partnerName: string;
  received: PlayerRef[];
  sent: PlayerRef[];
  valueDelta: number;
}

/** A team as the dashboard shows it (#166): its name, and who plays it (a person or an AI manager). */
export interface DashboardTeam {
  teamId: string;
  teamName: string;
  /** The person playing it; null for an AI or open seat. */
  ownerName: string | null;
  manager: Manager | null;
}

export interface DashboardMatchupSide extends DashboardTeam {
  score: number | null;
  record: string | null;
}

export interface DashboardMatchup {
  id: string;
  kind: 'regular' | 'playoff';
  status: 'scheduled' | 'in_progress' | 'final';
  home: DashboardMatchupSide;
  away: DashboardMatchupSide;
}

export interface DashboardStanding extends DashboardTeam {
  rank: number;
  record: string;
  pointsFor: number;
  streak: string | null;
}

export type MoveType = 'trade' | 'add' | 'drop' | 'waiver' | 'team_renamed';

export interface MoveSide extends DashboardTeam {
  added: PlayerRef[];
  dropped: PlayerRef[];
  cost: number | null;
}

export interface Move {
  id: string;
  type: MoveType;
  at: string;
  week: number;
  teams: MoveSide[];
  /** `team_renamed` (#194): the old and new names, and who renamed it. */
  rename?: { from: string; to: string; by: 'owner' | 'commissioner' | 'agent' } | null;
}

export interface DashboardDraft {
  status: 'not_started' | 'in_progress' | 'paused' | 'complete';
  scheduledAt: string | null;
  seatsFilled: number;
  seats: number;
  picksMade: number;
  totalPicks: number | null;
  onTheClock: (DashboardTeam & { overall: number; round: number }) | null;
  deadline: string | null;
  yourPickIn: number | null;
}

/** get_league_dashboard (#166): the league at a glance. */
export interface LeagueDashboardData {
  leagueId: string;
  name: string;
  season: number;
  phase: Phase;
  week: number | null;
  yourTeamId: string | null;
  draft: DashboardDraft | null;
  matchups: DashboardMatchup[];
  standings: { throughWeek: number | null; rows: DashboardStanding[] };
  moves: Move[];
  hasMoreMoves: boolean;
  champion: DashboardTeam | null;
}
