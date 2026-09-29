import { vi } from 'vitest';
import type { LeagueApi } from '../api/league';
import type {
  AgentCatalog,
  AgentSeatConfig,
  DefaultSettings,
  LeagueDashboardData,
  LeagueDetail,
  LeagueSettings,
  LeagueState,
  TeamDetail
} from '../api/types';

export const DIFFICULTIES = ['rookie', 'amateur', 'pro', 'all_pro', 'hall_of_famer'] as const;

export function seatConfigs(count: number, offset = 0): AgentSeatConfig[] {
  return Array.from({ length: count }, (_, i) => ({
    personalityId: `p${i + offset}`,
    difficulty: DIFFICULTIES[(i + offset) % DIFFICULTIES.length] as string,
    archetype: i % 2 === 0 ? 'balanced' : 'zero_rb'
  }));
}

export function catalog(suggest: number | null = 7): AgentCatalog {
  return {
    personalities: Array.from({ length: 12 }, (_, i) => ({
      id: `p${i}`,
      displayName: `Persona ${i}`,
      teamNameSuggestion: `Team P${i}`,
      bio: `Bio of persona ${i}.`,
      avatarSeed: `seed-${i}`,
      nicknames: [`Nick${i}`]
    })),
    managerNames: { first: ['Ana', 'Ravi', 'Mei'], last: ['Soto', 'Park', 'Hale'] },
    difficulties: DIFFICULTIES.map((id, i) => ({
      id,
      displayName: ['Rookie', 'Amateur', 'Pro', 'All-Pro', 'Hall of Famer'][i] as string,
      description: `${id} description`,
      decisionModelTier: ['micro', 'lite', 'standard', 'advanced', 'frontier'][i] as string
    })),
    archetypes: [
      { id: 'balanced', displayName: 'Balanced', description: 'Best player available.' },
      { id: 'zero_rb', displayName: 'Zero RB', description: 'Receivers early.' }
    ],
    modelTiers: ['micro', 'lite', 'standard', 'advanced', 'frontier'],
    models: [
      { key: 'nova-micro', displayName: 'Amazon Nova Micro', tier: 'micro' },
      { key: 'claude-opus-5', displayName: 'Claude Opus 5', tier: 'frontier' }
    ],
    suggestion: suggest === null ? null : { seed: 's', seats: seatConfigs(suggest) }
  };
}

export function settings(overrides: Partial<LeagueSettings> = {}): LeagueSettings {
  return {
    teamCount: 4,
    schedule: { startWeek: 1, regularSeasonEndWeek: 15 },
    roster: { slots: { QB: 1, WR: 3, RB: 2, BN: 6 }, irEligibleStatuses: ['ir', 'out'] },
    scoring: { perStat: { pass_td: 4, rec: 0.5 }, tiers: [] },
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
    playoffs: {
      teams: 4,
      byes: 0,
      startWeek: 16,
      endWeek: 17,
      tiebreaker: 'points_for',
      reseed: false,
      consolation: false
    },
    ...overrides
  };
}

export function defaults(): DefaultSettings {
  return {
    settings: settings(),
    editability: {
      teamCount: 'pre_draft',
      schedule: 'pre_draft',
      'roster.slots': 'pre_draft',
      'roster.irEligibleStatuses': 'any_time',
      scoring: 'pre_draft',
      waivers: 'pre_draft',
      'waivers.waiverPeriodDays': 'any_time',
      trades: 'any_time',
      playoffs: 'pre_draft'
    },
    statLabels: { pass_td: 'Passing touchdowns', rec: 'Receptions', rec_yd: 'Receiving yards' },
    rosterSlots: ['QB', 'WR', 'RB', 'TE', 'BN'],
    playerStatuses: ['ir', 'out', 'pup']
  };
}

export function team(slot: number, overrides: Partial<TeamDetail> = {}): TeamDetail {
  return {
    id: `team-${slot}`,
    name: `Team ${slot}`,
    seatType: 'agent',
    open: true,
    ownerName: null,
    ownerUserId: null,
    draftSlot: slot,
    ...overrides
  };
}

/** A 4-team league in setup: Alice (commissioner) on team-1, Bob on team-2, team-3 open human, team-4 AI. */
export function league(overrides: Partial<LeagueDetail> = {}): LeagueDetail {
  return {
    id: 'L1',
    name: 'Sunday Funday',
    season: 2026,
    phase: 'setup',
    week: null,
    version: 3,
    commissioner: { userId: 'alice', name: 'Alice' },
    settings: settings(),
    teams: [
      team(1, {
        name: "Alice's Team",
        seatType: 'human',
        open: false,
        ownerName: 'Alice',
        ownerUserId: 'alice'
      }),
      team(2, { name: "Bob's Team", seatType: 'human', open: false, ownerName: 'Bob', ownerUserId: 'bob' }),
      team(3, { seatType: 'human' }),
      team(4)
    ],
    ...overrides
  };
}

export const COMMISSIONER_ACTIONS = [
  'update_league_settings',
  'create_invite',
  'revoke_invite',
  'remove_member',
  'set_seat_type',
  'transfer_commissioner',
  'configure_agent_seat',
  'randomize_agent_seats',
  'rename_team'
];

export function state(overrides: Partial<LeagueState> = {}): LeagueState {
  const detail = league();
  return {
    leagueId: 'L1',
    name: detail.name,
    phase: 'setup',
    week: null,
    youAreCommissioner: true,
    yourTeam: detail.teams[0] as TeamDetail,
    allowedActions: COMMISSIONER_ACTIONS,
    teams: detail.teams,
    ...overrides
  };
}

/** get_league_dashboard (#166) for a league in setup: the draft not yet scheduled, no moves. */
export function dashboard(overrides: Partial<LeagueDashboardData> = {}): LeagueDashboardData {
  return {
    leagueId: 'L1',
    name: 'Sunday Funday',
    season: 2026,
    phase: 'setup',
    week: null,
    yourTeamId: 'team-1',
    draft: {
      status: 'not_started',
      scheduledAt: null,
      seatsFilled: 3,
      seats: 4,
      picksMade: 0,
      totalPicks: null,
      onTheClock: null,
      deadline: null,
      yourPickIn: null
    },
    matchups: [],
    standings: { throughWeek: null, rows: [] },
    moves: [],
    hasMoreMoves: false,
    champion: null,
    ...overrides
  };
}

/** A fake league API: every call resolves with a sensible default unless overridden. */
export function fakeApi(overrides: Partial<LeagueApi> = {}): LeagueApi {
  const api: LeagueApi = {
    listMyLeagues: vi.fn(async () => []),
    getNotificationSummary: vi.fn(async () => ({ unreadCount: 0, leagues: [] })),
    listNotifications: vi.fn(async () => ({
      teamId: null,
      unreadCount: 0,
      notifications: [],
      nextCursor: null
    })),
    markNotificationsRead: vi.fn(async (leagueId: string) => ({ leagueId, unreadCount: 0 })),
    markNotificationsDelivered: vi.fn(async (leagueId: string) => ({ leagueId })),
    createLeague: vi.fn(async () => league()),
    getLeague: vi.fn(async () => league()),
    getLeagueState: vi.fn(async () => state()),
    updateSettings: vi.fn(async () => ({ version: 4, changedPaths: [] })),
    getDefaultSettings: vi.fn(async () => defaults()),
    createInvite: vi.fn(async () => ({
      invite: {
        id: 'i-new',
        status: 'active' as const,
        email: null,
        maxUses: 1,
        uses: 0,
        expiresAt: '2026-10-01'
      },
      token: 'tok',
      joinPath: '/join/tok'
    })),
    listInvites: vi.fn(async () => []),
    revokeInvite: vi.fn(async () => ({
      invite: {
        id: 'i1',
        status: 'revoked' as const,
        email: null,
        maxUses: 1,
        uses: 0,
        expiresAt: '2026-10-01'
      }
    })),
    getInvite: vi.fn(async () => ({
      leagueName: 'Sunday Funday',
      season: 2026,
      commissionerName: 'Alice',
      phase: 'setup' as const,
      teamCount: 4,
      openSeats: 2,
      status: 'active' as const,
      joinable: true
    })),
    joinLeague: vi.fn(async () => ({
      league: {
        id: 'L1',
        name: 'Sunday Funday',
        season: 2026,
        phase: 'setup' as const,
        week: null,
        teamCount: 4,
        startWeek: 1,
        commissionerName: 'Alice',
        youAreCommissioner: false,
        yourTeamId: 'team-3',
        record: null
      },
      team: team(3)
    })),
    setSeatType: vi.fn(async () => ({ team: team(3) })),
    renameTeam: vi.fn(async () => ({ team: team(1) })),
    setTeamProfile: vi.fn(async () => ({ team: team(1) })),
    listChatRooms: vi.fn(async () => ({ defaultRoomId: 'trash-talk', rooms: [] })),
    removeMember: vi.fn(async () => ({})),
    transferCommissioner: vi.fn(async () => ({})),
    getAgentCatalog: vi.fn(async (query: { suggest?: number } = {}) => catalog(query.suggest ?? null)),
    getAgentSeat: vi.fn(async (_id: string, teamId: string) => ({
      seat: {
        teamId,
        personality: catalog().personalities[4]!,
        difficulty: { id: 'pro', displayName: 'Pro' }
      },
      commissioner: {
        current: { version: 1, config: { personalityId: 'p4', difficulty: 'pro', archetype: 'balanced' } },
        history: [
          {
            version: 1,
            updatedAt: '2026-09-01T12:00:00.000Z',
            updatedBy: 'user#alice',
            config: { personalityId: 'p4', difficulty: 'pro', archetype: 'balanced' }
          }
        ]
      }
    })),
    configureAgentSeat: vi.fn(async () => ({})),
    randomizeAgentSeats: vi.fn(async () => ({ seats: [] })),
    getRoster: vi.fn(async () => ({
      teamId: 'team-1',
      teamName: "Alice's Team",
      week: 1,
      lineupSaved: false,
      carriedFromWeek: null,
      slots: [],
      players: []
    })),
    setLineup: vi.fn(async () => {
      throw new Error('setLineup is not faked in this test');
    }),
    getMatchup: vi.fn(async () => ({ week: 1, teamId: 'team-1', matchup: null, lineups: null })),
    getNflGames: vi.fn(async () => ({ season: 2026, week: 1, games: [], redZone: [], updatedAt: null })),
    getStandings: vi.fn(async () => ({ throughWeek: null, standings: [] })),
    getModelLeaderboard: vi.fn(async () => ({ throughWeek: null, teams: [], models: [] })),
    getAgentActivity: vi.fn(async () => ({
      tasks: [],
      budget: {
        week: 0,
        ceilingUsd: 0.25,
        spentUsd: 0,
        remainingUsd: 0.25,
        exceeded: false,
        byAgent: [],
        byModel: []
      },
      killSwitch: { configured: false, engaged: false }
    })),
    getDataStatus: vi.fn(async () => ({
      checkedAt: '2026-09-28T20:00:00.000Z',
      nflState: null,
      league: { season: 2026, week: null },
      players: { total: 0, byPosition: { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 } },
      weeks: [],
      research: { stats: null, projections: null },
      jobs: []
    })),
    getRealtime: vi.fn(async () => ({
      enabled: false,
      token: null,
      endpoint: null,
      cacheName: null,
      topics: null,
      expiresAt: null,
      pollIntervalSeconds: 5
    })),
    getPlayoffBracket: vi.fn(async () => ({
      status: 'not_started' as const,
      teams: 4,
      byes: 0,
      weeks: [16, 17],
      reseed: false,
      consolation: false,
      seeds: [],
      games: [],
      championTeamId: null,
      consolationChampionTeamId: null
    })),
    getLeagueHistory: vi.fn(async () => ({
      seasons: [],
      current: {
        season: 2026,
        records: { highestScore: null, lowestScore: null, biggestBlowout: null, closestGame: null },
        headToHead: []
      },
      achievements: [],
      trades: [],
      tradeRecords: { best: [], worst: [] }
    })),
    getScoringLog: vi.fn(async () => ({
      week: 1,
      teamId: 'team-1',
      matchupId: null,
      entries: [],
      nextCursor: null
    })),
    getMatchupOutlook: vi.fn(async () => {
      throw new Error('getMatchupOutlook is not faked in this test');
    }),
    getLeagueDashboard: vi.fn(async () => dashboard())
  };
  return { ...api, ...overrides };
}
