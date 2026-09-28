import { z } from 'zod';
import { BaseDecisionSchema, defineTaskKind } from './kinds.js';

/**
 * The smallest possible task kind, as an example for feature streams: it gathers nothing, lets the
 * model look around with read-only tools, and changes nothing. Its fallback is also a no-op.
 */
export const noopTask = defineTaskKind({
  kind: 'noop',
  title: 'Check in',
  modelRole: 'chat',
  payload: z.object({ note: z.string().max(200).optional() }),
  decision: BaseDecisionSchema,
  tools: ['get_player', 'search_players', 'get_agent_seat'],
  prepare: async () => null,
  instructions: (_ctx, payload) =>
    `Nothing needs doing right now${payload.note === undefined ? '' : ` (${payload.note})`}. Take no actions; reply with a one-line summary.`,
  apply: async (_ctx, _payload, _prep, decision) => ({ action: 'none', summary: decision.summary }),
  fallback: async () => ({ action: 'none', summary: 'No action needed.' }),
  fakeScript: () => ({ steps: [], decision: { summary: 'Checked in; nothing to do.' } })
});
