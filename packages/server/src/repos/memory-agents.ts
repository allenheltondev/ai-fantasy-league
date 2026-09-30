import {
  AgentAgendaSchema,
  PlayerAttachmentsSchema,
  CommitmentBookSchema,
  SocialActBookSchema,
  emptyAgenda,
  emptyAttachments,
  emptyCommitments,
  emptyMemory,
  emptySocialActs,
  type AgentAgenda,
  type AgentLeagueMemory,
  type PlayerAttachments,
  type CommitmentBook,
  type SocialActBook
} from '@fantasy/core';
import {
  gateCutoff,
  roundUsd,
  staleSeat,
  type AgentDispatch,
  type AgentDispatchReservation,
  type AgentRepository,
  type AgentSeatRecord,
  type AgentTaskClaim,
  type AgentTaskClaimInput,
  type AgentTaskFence,
  type AgentTaskLease,
  type AgentTaskPending,
  type AgentTaskRecord,
  type AgentTriggerState,
  type AgentUsageEntry,
  type AgentUsageRow,
  type BudgetAdmission,
  type BudgetHold,
  type BudgetHoldRef,
  type LimitClaim,
  type LimitClaimResult,
  type TriggerGate
} from './agents.js';

const clone = <T>(value: T): T => structuredClone(value);
const holdId = (h: { taskId: string; key: string }) => `${h.taskId}\u0000${h.key}`;

interface TaskSlot {
  state: 'running' | 'retry' | 'complete';
  lockUntil: number;
  attempt: number;
  effects: number;
  pending: AgentTaskPending | null;
  request: Record<string, unknown> | null;
  record: AgentTaskRecord | null;
}

type StateSlot = AgentTriggerState & { owner?: string };

/**
 * The agent repository in memory, with the DynamoDB repository's semantics: every conditional
 * write there is a check and a write here that nothing can interleave with.
 */
export class InMemoryAgentRepository implements AgentRepository {
  readonly #agendas = new Map<string, AgentAgenda>();

  async getAgenda(leagueId: string, agentId: string, tenure: string): Promise<AgentAgenda> {
    return clone(this.#agendas.get(JSON.stringify([leagueId, agentId, tenure])) ?? emptyAgenda());
  }

  async updateAgenda(
    leagueId: string,
    agentId: string,
    tenure: string,
    update: (agenda: AgentAgenda) => AgentAgenda
  ): Promise<AgentAgenda> {
    const key = JSON.stringify([leagueId, agentId, tenure]);
    const next = AgentAgendaSchema.parse(update(clone(this.#agendas.get(key) ?? emptyAgenda())));
    this.#agendas.set(key, clone(next));
    return clone(next);
  }

  readonly #commitments = new Map<string, CommitmentBook>();

  async getCommitments(leagueId: string, agentId: string, tenure: string): Promise<CommitmentBook> {
    return clone(this.#commitments.get(JSON.stringify([leagueId, agentId, tenure])) ?? emptyCommitments());
  }

  async updateCommitments(
    leagueId: string,
    agentId: string,
    tenure: string,
    update: (book: CommitmentBook) => CommitmentBook
  ): Promise<CommitmentBook> {
    const key = JSON.stringify([leagueId, agentId, tenure]);
    const next = CommitmentBookSchema.parse(update(clone(this.#commitments.get(key) ?? emptyCommitments())));
    this.#commitments.set(key, clone(next));
    return clone(next);
  }

  readonly #socialActs = new Map<string, SocialActBook>();

  async getSocialActs(leagueId: string, agentId: string, tenure: string): Promise<SocialActBook> {
    return clone(this.#socialActs.get(JSON.stringify([leagueId, agentId, tenure])) ?? emptySocialActs());
  }

  async updateSocialActs(
    leagueId: string,
    agentId: string,
    tenure: string,
    update: (book: SocialActBook) => SocialActBook
  ): Promise<SocialActBook> {
    const key = JSON.stringify([leagueId, agentId, tenure]);
    const next = SocialActBookSchema.parse(update(clone(this.#socialActs.get(key) ?? emptySocialActs())));
    this.#socialActs.set(key, clone(next));
    return clone(next);
  }
  readonly #seats = new Map<string, AgentSeatRecord>();
  readonly #history = new Map<string, AgentSeatRecord[]>();
  readonly #memory = new Map<string, AgentLeagueMemory>();
  readonly #tasks = new Map<string, TaskSlot>();
  readonly #usage = new Map<string, AgentUsageRow>();
  readonly #state = new Map<string, StateSlot>();
  readonly #limits = new Map<string, number[]>();
  readonly #dispatches = new Map<string, AgentDispatch>();
  /** Budget holds by task and ledger key, and the ledger's keys (#209). */
  readonly #budgetHolds = new Map<string, BudgetHold>();
  readonly #ledger = new Set<string>();

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

  readonly #attachments = new Map<string, PlayerAttachments>();

  async getAttachments(leagueId: string, agentId: string, tenure: string): Promise<PlayerAttachments> {
    return clone(this.#attachments.get(JSON.stringify([leagueId, agentId, tenure])) ?? emptyAttachments());
  }

  async updateAttachments(
    leagueId: string,
    agentId: string,
    tenure: string,
    update: (attachments: PlayerAttachments) => PlayerAttachments
  ): Promise<PlayerAttachments> {
    const key = JSON.stringify([leagueId, agentId, tenure]);
    const current = clone(this.#attachments.get(key) ?? emptyAttachments());
    const next = PlayerAttachmentsSchema.parse(update(current));
    this.#attachments.set(key, clone(next));
    return clone(next);
  }

  async claimTask(input: AgentTaskClaimInput): Promise<AgentTaskClaim> {
    const slot = this.#tasks.get(input.taskId);
    if (slot?.record) return { status: 'done', record: clone(slot.record) };
    if (slot !== undefined && slot.state === 'running' && slot.lockUntil > input.now.getTime())
      return { status: 'in_progress' };
    const next: TaskSlot = {
      state: 'running',
      lockUntil: input.lockUntil.getTime(),
      attempt: (slot?.attempt ?? 0) + 1,
      effects: slot?.effects ?? 0,
      pending: slot?.pending ?? null,
      request: input.request === undefined ? (slot?.request ?? null) : clone(input.request),
      record: null
    };
    this.#tasks.set(input.taskId, next);
    return { status: 'started', attempt: next.attempt, effects: next.effects, pending: clone(next.pending) };
  }

  async completeTask(record: AgentTaskRecord, _expiresAt: Date, fence?: AgentTaskFence): Promise<boolean> {
    if (fence !== undefined && !this.#holds(fence)) return false;
    const slot = this.#tasks.get(record.taskId);
    this.#tasks.set(record.taskId, {
      state: 'complete',
      lockUntil: 0,
      attempt: slot?.attempt ?? 0,
      effects: slot?.effects ?? 0,
      pending: null,
      request: null,
      record: clone(record)
    });
    return true;
  }

  async recordTaskEffect(fence: AgentTaskFence): Promise<boolean> {
    return this.#update(fence, (slot) => ({ ...slot, effects: slot.effects + 1 }));
  }

  async saveTaskPending(fence: AgentTaskFence, pending: AgentTaskPending): Promise<boolean> {
    return this.#update(fence, (slot) => ({ ...slot, pending: clone(pending) }));
  }

  async releaseTask(fence: AgentTaskFence, retryAt: Date): Promise<boolean> {
    return this.#update(fence, (slot) => ({ ...slot, state: 'retry', lockUntil: retryAt.getTime() }));
  }

  async listExpiredTaskLeases(now: Date, limit: number): Promise<AgentTaskLease[]> {
    return [...this.#tasks.entries()]
      .filter(([, slot]) => slot.state !== 'complete' && slot.lockUntil <= now.getTime())
      .sort(([a, x], [b, y]) => x.lockUntil - y.lockUntil || a.localeCompare(b))
      .slice(0, limit)
      .map(([taskId, slot]) => ({
        taskId,
        attempt: slot.attempt,
        lockUntil: slot.lockUntil,
        request: clone(slot.request)
      }));
  }

  async requeueTaskLease(lease: Pick<AgentTaskLease, 'taskId' | 'lockUntil'>, until: Date): Promise<boolean> {
    const slot = this.#tasks.get(lease.taskId);
    if (slot === undefined || slot.state === 'complete' || slot.lockUntil !== lease.lockUntil) return false;
    this.#tasks.set(lease.taskId, { ...slot, state: 'retry', lockUntil: until.getTime() });
    return true;
  }

  #holds(fence: AgentTaskFence): boolean {
    const slot = this.#tasks.get(fence.taskId);
    return slot !== undefined && slot.state !== 'complete' && slot.attempt === fence.attempt;
  }

  #update(fence: AgentTaskFence, change: (slot: TaskSlot) => TaskSlot): boolean {
    const slot = this.#tasks.get(fence.taskId);
    if (slot === undefined || !this.#holds(fence)) return false;
    this.#tasks.set(fence.taskId, change(slot));
    return true;
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

  async reserveBudget(hold: BudgetHold, ceilingUsd: number): Promise<BudgetAdmission> {
    if (this.#budgetHolds.has(holdId(hold))) return { status: 'reserved' };
    // No await from the check to the write: nothing can interleave, as with the conditional write.
    let spent = 0;
    for (const r of this.#usage.values())
      if (r.leagueId === hold.leagueId && r.week === hold.week) spent += r.costUsd;
    const spentUsd = roundUsd(spent);
    const reservedUsd = this.#reserved(hold.leagueId, hold.week);
    if (roundUsd(spentUsd + reservedUsd + hold.costUsd) > ceilingUsd) {
      return { status: 'refused', spentUsd, reservedUsd };
    }
    this.#budgetHolds.set(holdId(hold), clone(hold));
    return { status: 'reserved' };
  }

  async recordUsage(entry: AgentUsageEntry, hold?: BudgetHoldRef): Promise<boolean> {
    if (hold !== undefined) this.#budgetHolds.delete(holdId(hold));
    const id = holdId(entry);
    if (this.#ledger.has(id)) return false;
    this.#ledger.add(id);
    await this.addUsage({
      leagueId: entry.leagueId,
      week: entry.week,
      agentId: entry.agentId,
      modelKey: entry.modelKey,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      costUsd: entry.costUsd,
      tasks: entry.tasks
    });
    return true;
  }

  async releaseBudget(hold: BudgetHoldRef): Promise<boolean> {
    return this.#budgetHolds.delete(holdId(hold));
  }

  async listStaleHolds(now: Date, limit: number): Promise<BudgetHold[]> {
    return [...this.#budgetHolds.values()]
      .filter((h) => Date.parse(h.expiresAt) <= now.getTime())
      .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt) || holdId(a).localeCompare(holdId(b)))
      .slice(0, limit)
      .map(clone);
  }

  #reserved(leagueId: string, week: number): number {
    let sum = 0;
    for (const h of this.#budgetHolds.values())
      if (h.leagueId === leagueId && h.week === week) sum += h.costUsd;
    return roundUsd(sum);
  }

  async getTriggerState(leagueId: string, agentId: string): Promise<AgentTriggerState | null> {
    const state = this.#state.get(`${leagueId}\u0000${agentId}`);
    if (state === undefined) return null;
    return { leagueId: state.leagueId, agentId: state.agentId, lastTriggeredAt: state.lastTriggeredAt };
  }

  async putTriggerState(state: AgentTriggerState): Promise<void> {
    this.#state.set(`${state.leagueId}\u0000${state.agentId}`, clone(state));
  }

  async admitTrigger(leagueId: string, gate: TriggerGate): Promise<boolean> {
    if (!this.#gateOpen(leagueId, gate)) return false;
    this.#takeGate(leagueId, gate);
    return true;
  }

  async releaseTrigger(leagueId: string, slot: string, owner: string): Promise<boolean> {
    const key = `${leagueId}\u0000${slot}`;
    if (this.#state.get(key)?.owner !== owner) return false;
    return this.#state.delete(key);
  }

  async reserveDispatch(dispatch: AgentDispatch, gate?: TriggerGate): Promise<AgentDispatchReservation> {
    const existing = this.#dispatches.get(dispatch.taskId);
    if (existing !== undefined) return { status: 'exists', dispatch: clone(existing) };
    if (gate !== undefined) {
      if (!this.#gateOpen(dispatch.leagueId, gate)) return { status: 'gated' };
      this.#takeGate(dispatch.leagueId, gate);
    }
    this.#dispatches.set(dispatch.taskId, clone(dispatch));
    return { status: 'reserved' };
  }

  async getDispatch(taskId: string): Promise<AgentDispatch | null> {
    const dispatch = this.#dispatches.get(taskId);
    return dispatch === undefined ? null : clone(dispatch);
  }

  async settleDispatch(taskId: string, state: 'dispatched' | 'abandoned'): Promise<void> {
    const dispatch = this.#dispatches.get(taskId);
    if (dispatch !== undefined) this.#dispatches.set(taskId, { ...dispatch, state });
  }

  async failDispatch(taskId: string, retryAt: Date): Promise<number> {
    const dispatch = this.#dispatches.get(taskId);
    if (dispatch === undefined) return 0;
    const attempts = dispatch.attempts + 1;
    this.#dispatches.set(taskId, { ...dispatch, attempts, retryAt: retryAt.toISOString() });
    return attempts;
  }

  async listDueDispatches(now: Date, limit: number): Promise<AgentDispatch[]> {
    return [...this.#dispatches.values()]
      .filter((d) => d.state === 'reserved' && Date.parse(d.retryAt) <= now.getTime())
      .sort((a, b) => a.retryAt.localeCompare(b.retryAt) || a.taskId.localeCompare(b.taskId))
      .slice(0, limit)
      .map(clone);
  }

  #gateOpen(leagueId: string, gate: TriggerGate): boolean {
    const current = this.#state.get(`${leagueId}\u0000${gate.slot}`);
    if (current === undefined || current.owner === gate.owner || gate.windowMs === 0) return true;
    return (
      gate.windowMs !== null && current.lastTriggeredAt <= gateCutoff({ ...gate, windowMs: gate.windowMs })
    );
  }

  #takeGate(leagueId: string, gate: TriggerGate): void {
    this.#state.set(`${leagueId}\u0000${gate.slot}`, {
      leagueId,
      agentId: gate.slot,
      lastTriggeredAt: gate.now.toISOString(),
      owner: gate.owner
    });
  }

  /** Same semantics as DynamoDB's conditional write: the read and the write cannot interleave here. */
  async claimLimit(input: LimitClaim): Promise<LimitClaimResult> {
    const key = `${input.leagueId}\u0000${input.key}`;
    const since = input.now.getTime() - input.windowMs;
    const uses = (this.#limits.get(key) ?? []).filter((at) => at > since);
    if (uses.length >= input.cap) return 'full';
    this.#limits.set(key, [...uses, input.now.getTime()]);
    return 'claimed';
  }
}
