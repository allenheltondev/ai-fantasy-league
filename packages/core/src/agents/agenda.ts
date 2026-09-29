import { z } from 'zod';
import { RosterSlotSchema, SLOT_ELIGIBILITY } from '../rules/positions.js';

/** Operational goals are kept separately from lossy, natural-language memory. */
export const AGENDA_LIMITS = { active: 3, history: 12 } as const;
export const AgendaGoalSchema = z.object({
  id: z.string(),
  kind: z.literal('repair_position'),
  slot: RosterSlotSchema,
  week: z.number().int().positive(),
  missing: z.number().int().positive(),
  status: z.enum(['active', 'completed', 'expired', 'cancelled']),
  createdAt: z.string(),
  updatedAt: z.string(),
  sourceTaskId: z.string(),
  /** Explicit even though the first slice never exposes an agenda to chat. */
  audience: z.literal('owner_decisions'),
  reason: z.literal('insufficient_available_starters')
});
export type AgendaGoal = z.infer<typeof AgendaGoalSchema>;

export const AgentAgendaSchema = z.object({
  schemaVersion: z.literal(1),
  closed: z.boolean(),
  observedAt: z.string().nullable(),
  week: z.number().int().positive().nullable(),
  goals: z.array(AgendaGoalSchema).max(AGENDA_LIMITS.active + AGENDA_LIMITS.history)
});
export type AgentAgenda = z.infer<typeof AgentAgendaSchema>;

export const emptyAgenda = (): AgentAgenda => ({
  schemaVersion: 1,
  closed: false,
  observedAt: null,
  week: null,
  goals: []
});

export interface AgendaObservation {
  at: string;
  taskId: string;
  week: number | null;
  complete: boolean;
  /** Verified unfillable starting slots, in strategy priority order (duplicates count). */
  holes: readonly z.infer<typeof RosterSlotSchema>[];
}

/** Pure reconciliation: repeated observations don't create goals, and stale reads cannot revive them. */
export function reconcileAgenda(current: AgentAgenda, observation: AgendaObservation): AgentAgenda {
  const { at, taskId, week, complete } = observation;
  if (current.closed) return current;
  if (current.observedAt !== null && Date.parse(at) < Date.parse(current.observedAt)) return current;
  if (current.week !== null && week !== null && week < current.week) return current;
  const counts = new Map<AgendaGoal['slot'], number>();
  if (!complete && week !== null)
    for (const slot of observation.holes) counts.set(slot, (counts.get(slot) ?? 0) + 1);
  // A still-relevant priority stays ahead of newly discovered needs: no check-in thrashing.
  const retained = current.goals.filter(
    (g) => g.status === 'active' && g.week === week && counts.has(g.slot)
  );
  const selected = [...new Set([...retained.map((g) => g.slot), ...counts.keys()])].slice(
    0,
    AGENDA_LIMITS.active
  );
  const active: AgendaGoal[] = selected.map((slot) => {
    const id = `repair_position:W${week}:${slot}`;
    const previous = current.goals.find((g) => g.id === id);
    const missing = counts.get(slot) as number;
    if (previous?.status === 'active' && previous.missing === missing) return previous;
    return {
      id,
      kind: 'repair_position',
      slot,
      week: week as number,
      missing,
      status: 'active',
      createdAt: previous?.createdAt ?? at,
      updatedAt: at,
      sourceTaskId: taskId,
      audience: 'owner_decisions',
      reason: 'insufficient_available_starters'
    };
  });
  const activeIds = new Set(active.map((g) => g.id));
  const history = current.goals
    .filter((g) => !activeIds.has(g.id))
    .map((g) => {
      if (g.status !== 'active') return g;
      return {
        ...g,
        status: complete
          ? ('cancelled' as const)
          : g.week !== week
            ? ('expired' as const)
            : ('completed' as const),
        updatedAt: at,
        sourceTaskId: taskId
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return {
    schemaVersion: 1,
    closed: complete,
    observedAt: at,
    week,
    goals: [...active, ...history.slice(0, AGENDA_LIMITS.history)]
  };
}

/** Preference among already-legal candidates; it never changes prices, floors, or permissions. */
export function agendaPriority(agenda: AgentAgenda | undefined, position: string): number {
  const goals = agenda?.goals.filter((g) => g.status === 'active') ?? [];
  const index = goals.findIndex((g) => (SLOT_ELIGIBILITY[g.slot] as readonly string[]).includes(position));
  return index < 0 ? 0 : AGENDA_LIMITS.active - index;
}

export function agendaPrompt(agenda: AgentAgenda): string[] {
  return agenda.goals
    .filter((g) => g.status === 'active')
    .map(
      (g) =>
        `[${g.id}] Need ${g.missing} available starter(s) for ${g.slot} in week ${g.week}; pursuing since ${g.createdAt}. Prefer a legal pickup or fair trade that repairs this need. A pending claim or offer does not complete it.`
    );
}
