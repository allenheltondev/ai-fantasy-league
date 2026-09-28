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

export interface OutlookSide {
  teamId: string;
  teamName: string;
  currentPoints: number;
  projectedPoints: number;
  remainingPoints: number;
  playersYetToPlay: number;
  playersInProgress: number;
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
