import { z } from 'zod';

/** Detail of `Agent Action Requested` (source `fantasy`): one task for one agent team. */
export const AgentActionRequestedSchema = z.object({
  /** Deterministic from the trigger event and team: a redelivered trigger yields the same id. */
  taskId: z.string().min(1).max(200),
  leagueId: z.string(),
  teamId: z.string(),
  agentId: z.string(),
  kind: z.string(),
  trigger: z.object({ detailType: z.string(), eventId: z.string(), urgent: z.boolean() }),
  payload: z.record(z.string(), z.unknown()),
  requestedAt: z.string()
});
export type AgentActionRequested = z.infer<typeof AgentActionRequestedSchema>;

/** The EventBridge envelope fields the handlers read. */
export interface BusEvent {
  id: string;
  'detail-type': string;
  source: string;
  time?: string;
  detail: unknown;
}
