import { emptyMemory, type AgentLeagueMemory } from '@fantasy/core';
import {
  staleSeat,
  type AgentRepository,
  type AgentSeatRecord,
  type AgentTaskClaim,
  type AgentTaskRecord,
  type AgentTriggerState,
  type AgentUsageRow
} from './agents.js';

const clone = <T>(value: T): T => structuredClone(value);

interface TaskSlot {
  lockUntil: number;
  record: AgentTaskRecord | null;
}

export class InMemoryAgentRepository implements AgentRepository {
  readonly #seats = new Map<string, AgentSeatRecord>();
  readonly #history = new Map<string, AgentSeatRecord[]>();
  readonly #memory = new Map<string, AgentLeagueMemory>();
  readonly #tasks = new Map<string, TaskSlot>();
  readonly #usage = new Map<string, AgentUsageRow>();
  readonly #state = new Map<string, AgentTriggerState>();

  async getSeat(leagueId: string, teamId: string): Promise<AgentSeatRecord | null> {
    const seat = this.#seats.get(`${leagueId}\u0000${teamId}`);
    return seat === undefined ? null : clone(seat);
  }

  async listSeats(leagueId: string): Promise<AgentSeatRecord[]> {
    return [...this.#seats.values()]
      .filter((s) => s.leagueId === leagueId)
      .sort((a, b) => a.teamId.localeCompare(b.teamId))
      .map(clone);
  }

  async putSeat(record: AgentSeatRecord): Promise<void> {
    const id = `${record.leagueId}\u0000${record.teamId}`;
    const current = this.#seats.get(id);
    const expected = current === undefined ? 0 : current.version;
    if (record.version !== expected + 1) throw staleSeat(record.teamId);
    this.#seats.set(id, clone(record));
    this.#history.set(id, [clone(record), ...(this.#history.get(id) ?? [])]);
  }

  async seatHistory(leagueId: string, teamId: string, limit = 20): Promise<AgentSeatRecord[]> {
    return (this.#history.get(`${leagueId}\u0000${teamId}`) ?? []).slice(0, limit).map(clone);
  }

  async getMemory(leagueId: string, agentId: string): Promise<AgentLeagueMemory> {
    return clone(this.#memory.get(`${leagueId}\u0000${agentId}`) ?? emptyMemory());
  }

  async updateMemory(
    leagueId: string,
    agentId: string,
    update: (memory: AgentLeagueMemory) => AgentLeagueMemory
  ): Promise<AgentLeagueMemory> {
    const id = `${leagueId}\u0000${agentId}`;
    const next = update(clone(this.#memory.get(id) ?? emptyMemory()));
    this.#memory.set(id, clone(next));
    return clone(next);
  }

  async claimTask(input: { taskId: string; now: Date; lockUntil: Date }): Promise<AgentTaskClaim> {
    const slot = this.#tasks.get(input.taskId);
    if (slot?.record) return { status: 'done', record: clone(slot.record) };
    if (slot !== undefined && slot.lockUntil > input.now.getTime()) return { status: 'in_progress' };
    this.#tasks.set(input.taskId, { lockUntil: input.lockUntil.getTime(), record: null });
    return { status: 'started' };
  }

  async completeTask(record: AgentTaskRecord): Promise<void> {
    this.#tasks.set(record.taskId, { lockUntil: 0, record: clone(record) });
  }

  async listTasks(
    leagueId: string,
    query: { teamId?: string; limit?: number } = {}
  ): Promise<AgentTaskRecord[]> {
    return [...this.#tasks.values()]
      .flatMap((slot) => (slot.record === null ? [] : [slot.record]))
      .filter((r) => r.leagueId === leagueId && (query.teamId === undefined || r.teamId === query.teamId))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.taskId.localeCompare(a.taskId))
      .slice(0, query.limit ?? 25)
      .map(clone);
  }

  async addUsage(row: AgentUsageRow): Promise<void> {
    const id = [row.leagueId, row.week, row.agentId, row.modelKey].join('\u0000');
    const current = this.#usage.get(id);
    this.#usage.set(
      id,
      current === undefined
        ? clone(row)
        : {
            ...current,
            inputTokens: current.inputTokens + row.inputTokens,
            outputTokens: current.outputTokens + row.outputTokens,
            costUsd: current.costUsd + row.costUsd,
            tasks: current.tasks + row.tasks
          }
    );
  }

  async weekUsage(leagueId: string, week: number): Promise<AgentUsageRow[]> {
    return [...this.#usage.values()]
      .filter((r) => r.leagueId === leagueId && r.week === week)
      .sort((a, b) => a.agentId.localeCompare(b.agentId) || a.modelKey.localeCompare(b.modelKey))
      .map(clone);
  }

  async getTriggerState(leagueId: string, agentId: string): Promise<AgentTriggerState | null> {
    const state = this.#state.get(`${leagueId}\u0000${agentId}`);
    return state === undefined ? null : clone(state);
  }

  async putTriggerState(state: AgentTriggerState): Promise<void> {
    this.#state.set(`${state.leagueId}\u0000${state.agentId}`, clone(state));
  }
}
