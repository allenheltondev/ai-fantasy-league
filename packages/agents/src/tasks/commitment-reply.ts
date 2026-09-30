import { CommitmentReplyRefSchema, deliverReply } from '../commitments.js';
import { BaseDecisionSchema, defineTaskKind } from './kinds.js';
import { TaskUnavailableError } from './lineup.js';

/**
 * Delivery-only recovery for #246. `prepare` performs the persisted, idempotent post and stops;
 * this task never calls a model and never re-enters the trade decision.
 */
export const commitmentReplyTask = defineTaskKind({
  kind: 'commitment_reply',
  title: 'Deliver a promised follow-up',
  modelRole: 'chat',
  payload: CommitmentReplyRefSchema,
  decision: BaseDecisionSchema,
  tools: ['post_message'],
  prepare: async (ctx, payload) => {
    const outcome = await deliverReply(ctx, payload);
    throw new TaskUnavailableError(`commitment_reply_${outcome}`);
  },
  /* v8 ignore next -- prepare always throws after delivery; the runner cannot reach generation */
  instructions: () => '',
  /* v8 ignore next -- prepare always throws after delivery */
  apply: async () => ({ action: 'none', summary: 'Closing reply delivery is handled before generation.' }),
  /* v8 ignore next -- prepare always throws after delivery */
  fallback: async () => ({ action: 'none', summary: 'Closing reply delivery is handled before generation.' }),
  /* v8 ignore next -- prepare always throws before the fake model */
  fakeScript: () => ({ steps: [], decision: { summary: 'No generation needed.' } })
});
