import type {
  AchievementRecord,
  HistoryRepository,
  OfficialWeekRecord,
  PlayoffRecord,
  SeasonHistoryRecord
} from './history.js';

const clone = <T>(value: T): T => structuredClone(value);

export class InMemoryHistoryRepository implements HistoryRepository {
  readonly #playoffs = new Map<string, PlayoffRecord>();
  readonly #official = new Map<string, OfficialWeekRecord>();
  readonly #seasons = new Map<string, SeasonHistoryRecord>();
  readonly #achievements = new Map<string, AchievementRecord>();

  async getPlayoffs(leagueId: string): Promise<PlayoffRecord | null> {
    const record = this.#playoffs.get(leagueId);
    return record === undefined ? null : clone(record);
  }

  async putPlayoffs(record: PlayoffRecord): Promise<void> {
    this.#playoffs.set(record.leagueId, clone(record));
  }

  async beginOfficialWeek(
    record: OfficialWeekRecord,
    staleBefore: string
  ): Promise<OfficialWeekRecord | null> {
    const key = `${record.leagueId}#${record.week}`;
    const existing = this.#official.get(key);
    if (existing === undefined) {
      this.#official.set(key, clone(record));
      return clone(record);
    }
    if (existing.status === 'running' && existing.startedAt < staleBefore) {
      const takeover = { ...existing, startedAt: record.startedAt };
      this.#official.set(key, clone(takeover));
      return clone(takeover);
    }
    return null;
  }

  async completeOfficialWeek(record: OfficialWeekRecord): Promise<void> {
    this.#official.set(`${record.leagueId}#${record.week}`, clone(record));
  }

  async getOfficialWeek(leagueId: string, week: number): Promise<OfficialWeekRecord | null> {
    const record = this.#official.get(`${leagueId}#${week}`);
    return record === undefined ? null : clone(record);
  }

  async putSeason(record: SeasonHistoryRecord): Promise<void> {
    this.#seasons.set(`${record.leagueId}#${record.season}`, clone(record));
  }

  async listSeasons(leagueId: string): Promise<SeasonHistoryRecord[]> {
    return [...this.#seasons.values()]
      .filter((s) => s.leagueId === leagueId)
      .sort((a, b) => b.season - a.season)
      .map(clone);
  }

  async addAchievements(records: readonly AchievementRecord[]): Promise<AchievementRecord[]> {
    const added: AchievementRecord[] = [];
    for (const record of records) {
      const key = `${record.leagueId}#${record.id}`;
      if (this.#achievements.has(key)) continue;
      this.#achievements.set(key, clone(record));
      added.push(clone(record));
    }
    return added;
  }

  /** Forgets a deleted league (the DynamoDB delete removes the whole partition). */
  dropLeague(leagueId: string): void {
    this.#playoffs.delete(leagueId);
    for (const map of [this.#official, this.#seasons, this.#achievements] as Map<string, unknown>[]) {
      for (const key of map.keys()) if (key.startsWith(`${leagueId}#`)) map.delete(key);
    }
  }

  async listAchievements(leagueId: string): Promise<AchievementRecord[]> {
    return [...this.#achievements.values()]
      .filter((a) => a.leagueId === leagueId)
      .sort((a, b) => a.awardedAt.localeCompare(b.awardedAt) || a.id.localeCompare(b.id))
      .map(clone);
  }
}
