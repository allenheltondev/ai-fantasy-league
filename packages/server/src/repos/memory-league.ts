import {
  draftExists,
  leagueExists,
  staleDraft,
  staleInvite,
  staleLeague,
  staleTeam,
  teamExists
} from './errors.js';
import type {
  DraftQueueRecord,
  DraftRecord,
  DraftRepository,
  Invite,
  InviteRepository,
  League,
  LeagueRepository,
  Lineup,
  LineupRepository,
  Matchup,
  Member,
  MemberRepository,
  ScheduleRepository,
  StandingsSnapshot,
  Team,
  TeamRepository
} from './types.js';

const clone = <T>(value: T): T => structuredClone(value);

/** Everything in one league partition, so deleting a league removes all of it, as in DynamoDB. */
interface Partition {
  league: League | null;
  teams: Map<string, Team>;
  members: Map<string, Member>;
  invites: Map<string, Invite>;
  matchups: Map<string, Matchup>;
  standings: Map<number, StandingsSnapshot>;
  lineups: Map<string, Lineup>;
  draft: DraftRecord | null;
  draftQueues: Map<string, DraftQueueRecord>;
}

export class InMemoryLeagueStore {
  readonly #partitions = new Map<string, Partition>();

  partition(leagueId: string): Partition {
    let partition = this.#partitions.get(leagueId);
    if (partition === undefined) {
      partition = {
        league: null,
        teams: new Map(),
        members: new Map(),
        invites: new Map(),
        matchups: new Map(),
        standings: new Map(),
        lineups: new Map(),
        draft: null,
        draftQueues: new Map()
      };
      this.#partitions.set(leagueId, partition);
    }
    return partition;
  }

  partitions(): Partition[] {
    return [...this.#partitions.values()];
  }

  drop(leagueId: string): void {
    this.#partitions.delete(leagueId);
  }
}

export class InMemoryLeagueRepository implements LeagueRepository {
  constructor(
    private readonly store: InMemoryLeagueStore,
    /** Clears league data kept outside this store (memory.ts: the waiver repository). */
    private readonly onDelete: (leagueId: string) => void = () => undefined
  ) {}

  async get(leagueId: string): Promise<League | null> {
    const league = this.store.partition(leagueId).league;
    return league === null ? null : clone(league);
  }

  async getMany(leagueIds: readonly string[]): Promise<League[]> {
    const leagues = await Promise.all(leagueIds.map((id) => this.get(id)));
    return leagues.filter((league): league is League => league !== null);
  }

  async create(league: League): Promise<void> {
    const partition = this.store.partition(league.id);
    if (partition.league !== null) throw leagueExists(league.id);
    partition.league = clone(league);
  }

  async update(league: League): Promise<League> {
    const partition = this.store.partition(league.id);
    if (partition.league?.version !== league.version) throw staleLeague(league.id);
    partition.league = { ...clone(league), version: league.version + 1 };
    return clone(partition.league);
  }

  async listByCreator(userId: string): Promise<League[]> {
    return this.store
      .partitions()
      .flatMap((p) => (p.league !== null && p.league.createdBy === userId ? [clone(p.league)] : []))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async listByPhase(phase: League['phase']): Promise<League[]> {
    return this.store
      .partitions()
      .flatMap((p) => (p.league !== null && p.league.phase === phase ? [clone(p.league)] : []))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async delete(leagueId: string): Promise<void> {
    this.onDelete(leagueId);
    this.store.drop(leagueId);
  }
}

export class InMemoryTeamRepository implements TeamRepository {
  constructor(private readonly store: InMemoryLeagueStore) {}

  async list(leagueId: string): Promise<Team[]> {
    return [...this.store.partition(leagueId).teams.values()]
      .sort((a, b) => a.draftSlot - b.draftSlot || a.id.localeCompare(b.id))
      .map(clone);
  }

  async get(leagueId: string, teamId: string): Promise<Team | null> {
    const team = this.store.partition(leagueId).teams.get(teamId);
    return team === undefined ? null : clone(team);
  }

  async create(teams: readonly Team[]): Promise<void> {
    for (const team of teams) {
      if (this.store.partition(team.leagueId).teams.has(team.id)) throw teamExists(team.id);
    }
    for (const team of teams) this.store.partition(team.leagueId).teams.set(team.id, clone(team));
  }

  async update(team: Team): Promise<Team> {
    const teams = this.store.partition(team.leagueId).teams;
    if (teams.get(team.id)?.version !== team.version) throw staleTeam(team.id);
    const next = { ...clone(team), version: team.version + 1 };
    teams.set(team.id, next);
    return clone(next);
  }

  async deleteUnowned(leagueId: string, teamId: string): Promise<boolean> {
    const teams = this.store.partition(leagueId).teams;
    const team = teams.get(teamId);
    if (team !== undefined && team.ownerUserId !== null) return false;
    teams.delete(teamId);
    return true;
  }
}

export class InMemoryMemberRepository implements MemberRepository {
  constructor(private readonly store: InMemoryLeagueStore) {}

  async get(leagueId: string, userId: string): Promise<Member | null> {
    const member = this.store.partition(leagueId).members.get(userId);
    return member === undefined ? null : clone(member);
  }

  async add(member: Member): Promise<boolean> {
    const members = this.store.partition(member.leagueId).members;
    if (members.has(member.userId)) return false;
    members.set(member.userId, clone(member));
    return true;
  }

  async remove(leagueId: string, userId: string): Promise<void> {
    this.store.partition(leagueId).members.delete(userId);
  }

  async listByUser(userId: string): Promise<Member[]> {
    return this.store
      .partitions()
      .flatMap((p) => {
        const member = p.members.get(userId);
        return member === undefined ? [] : [clone(member)];
      })
      .sort((a, b) => a.leagueId.localeCompare(b.leagueId));
  }
}

export class InMemoryInviteRepository implements InviteRepository {
  constructor(private readonly store: InMemoryLeagueStore) {}

  async create(invite: Invite): Promise<void> {
    this.store.partition(invite.leagueId).invites.set(invite.id, clone(invite));
  }

  async get(leagueId: string, inviteId: string): Promise<Invite | null> {
    const invite = this.store.partition(leagueId).invites.get(inviteId);
    return invite === undefined ? null : clone(invite);
  }

  async getByTokenHash(tokenHash: string): Promise<Invite | null> {
    for (const partition of this.store.partitions()) {
      for (const invite of partition.invites.values()) {
        if (invite.tokenHash === tokenHash) return clone(invite);
      }
    }
    return null;
  }

  async list(leagueId: string): Promise<Invite[]> {
    return [...this.store.partition(leagueId).invites.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map(clone);
  }

  async update(invite: Invite): Promise<Invite> {
    const invites = this.store.partition(invite.leagueId).invites;
    if (invites.get(invite.id)?.version !== invite.version) throw staleInvite(invite.id);
    const next = { ...clone(invite), version: invite.version + 1 };
    invites.set(invite.id, next);
    return clone(next);
  }
}

export class InMemoryScheduleRepository implements ScheduleRepository {
  constructor(private readonly store: InMemoryLeagueStore) {}

  async putMatchups(matchups: readonly Matchup[]): Promise<void> {
    for (const m of matchups) {
      this.store.partition(m.leagueId).matchups.set(`${m.week}#${m.id}`, clone(m));
    }
  }

  async listMatchups(leagueId: string, week?: number): Promise<Matchup[]> {
    return [...this.store.partition(leagueId).matchups.values()]
      .filter((m) => week === undefined || m.week === week)
      .sort((a, b) => a.week - b.week || a.id.localeCompare(b.id))
      .map(clone);
  }

  async putStandings(snapshot: StandingsSnapshot): Promise<void> {
    this.store.partition(snapshot.leagueId).standings.set(snapshot.week, clone(snapshot));
  }

  async latestStandings(leagueId: string): Promise<StandingsSnapshot | null> {
    const snapshots = [...this.store.partition(leagueId).standings.values()].sort((a, b) => b.week - a.week);
    return snapshots[0] === undefined ? null : clone(snapshots[0]);
  }
}

export class InMemoryLineupRepository implements LineupRepository {
  constructor(private readonly store: InMemoryLeagueStore) {}

  async get(leagueId: string, teamId: string, week: number): Promise<Lineup | null> {
    const lineup = this.store.partition(leagueId).lineups.get(`${week}#${teamId}`);
    return lineup === undefined ? null : clone(lineup);
  }

  async latest(leagueId: string, teamId: string, week: number): Promise<Lineup | null> {
    const found = [...this.store.partition(leagueId).lineups.values()]
      .filter((l) => l.teamId === teamId && l.week <= week)
      .sort((a, b) => b.week - a.week)[0];
    return found === undefined ? null : clone(found);
  }

  async put(lineups: readonly Lineup[]): Promise<void> {
    for (const l of lineups) this.store.partition(l.leagueId).lineups.set(`${l.week}#${l.teamId}`, clone(l));
  }

  async listWeek(leagueId: string, week: number): Promise<Lineup[]> {
    return [...this.store.partition(leagueId).lineups.values()]
      .filter((l) => l.week === week)
      .sort((a, b) => a.teamId.localeCompare(b.teamId))
      .map(clone);
  }
}

/** The league repositories over one shared store. */
export class InMemoryDraftRepository implements DraftRepository {
  constructor(private readonly store: InMemoryLeagueStore) {}

  async get(leagueId: string): Promise<DraftRecord | null> {
    const draft = this.store.partition(leagueId).draft;
    return draft === null ? null : clone(draft);
  }

  async create(draft: DraftRecord): Promise<void> {
    const partition = this.store.partition(draft.leagueId);
    if (partition.draft !== null) throw draftExists(draft.leagueId);
    partition.draft = clone(draft);
  }

  async update(draft: DraftRecord): Promise<DraftRecord> {
    const partition = this.store.partition(draft.leagueId);
    if (partition.draft?.version !== draft.version) throw staleDraft(draft.leagueId);
    partition.draft = { ...clone(draft), version: draft.version + 1 };
    return clone(partition.draft);
  }

  async getQueue(leagueId: string, teamId: string): Promise<DraftQueueRecord | null> {
    const queue = this.store.partition(leagueId).draftQueues.get(teamId);
    return queue === undefined ? null : clone(queue);
  }

  async putQueue(queue: DraftQueueRecord): Promise<void> {
    this.store.partition(queue.leagueId).draftQueues.set(queue.teamId, clone(queue));
  }
}

export function createInMemoryLeagueRepos(options: { onDelete?: (leagueId: string) => void } = {}) {
  const store = new InMemoryLeagueStore();
  return {
    leagues: new InMemoryLeagueRepository(store, options.onDelete),
    teams: new InMemoryTeamRepository(store),
    members: new InMemoryMemberRepository(store),
    invites: new InMemoryInviteRepository(store),
    schedule: new InMemoryScheduleRepository(store),
    lineups: new InMemoryLineupRepository(store),
    drafts: new InMemoryDraftRepository(store)
  };
}
