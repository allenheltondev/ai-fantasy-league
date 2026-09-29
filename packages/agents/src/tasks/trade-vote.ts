import { tradeVetoVote } from '@fantasy/core';
import type { AgentTaskSeal } from '@fantasy/server';
import { z } from 'zod';
import { BaseDecisionSchema, defineTaskKind, type TaskContext, type TaskOutcome } from './kinds.js';
import { TaskUnavailableError } from './lineup.js';

/**
 * Trade vote task (issues #66, #122): in a league-vote league, when two other teams accept a
 * trade, every agent team not in it reviews the trade and votes. The vote is deterministic: veto
 * when the trade value math calls the trade lopsided, and, depending on the archetype, when it
 * comes close (core `tradeVetoVote`). A trade that passes needs no vote (letting it pass is doing
 * nothing), so the task is skipped without a model call. For a veto the model only writes the
 * explanation; it cannot flip the vote, and without a model the agent still vetoes.
 *
 * Veto votes are private until the review ends, so the activity log seals the summary until the
 * trade is processed or vetoed.
 */

const PayloadSchema = z.object({ tradeId: z.string() });
type Payload = z.infer<typeof PayloadSchema>;

export const TradeVoteDecisionSchema = BaseDecisionSchema;
type TradeVoteDecision = z.infer<typeof TradeVoteDecisionSchema>;

const Ref = z.object({ id: z.string(), name: z.string() });
const ListedSchema = z.object({
  trades: z.array(
    z.object({
      id: z.string(),
      fromTeam: Ref,
      toTeam: Ref,
      fromSends: z.array(Ref),
      toSends: z.array(Ref),
      yourActions: z.array(z.string())
    })
  )
});
const FairnessSchema = z.object({
  fairness: z.object({
    favors: z.string().nullable(),
    lineupGap: z.number(),
    valueGap: z.number(),
    lopsided: z.boolean()
  })
});

interface VotePrep {
  trade: z.infer<typeof ListedSchema>['trades'][number];
  fairness: z.infer<typeof FairnessSchema>['fairness'];
  severity: number;
  ratio: number;
}

function names(list: readonly { name: string }[]): string {
  return list.map((p) => p.name).join(', ') || 'nothing';
}

export const SEALED_VOTE =
  'Reviewed a trade under league vote; its vote stays private until the review ends.';

export const tradeVoteTask = defineTaskKind<Payload, TradeVoteDecision, VotePrep>({
  kind: 'trade_vote',
  title: 'Review a trade other teams made',
  modelRole: 'decision',
  modelNotes: false,
  payload: PayloadSchema,
  decision: TradeVoteDecisionSchema,
  // The vote is sealed and nobody reads the model's words: it may recall the agent's own secrets.
  memoryAudience: () => 'owner',
  // Reading only: the vote itself is cast by the runtime.
  tools: ['get_league_state', 'get_roster', 'get_player', 'get_projections', 'get_news', 'preview_trade'],
  async prepare(ctx, payload) {
    const listed = await ctx.tools.call('list_trades', { tradeId: payload.tradeId });
    const trade = 'error' in listed ? undefined : ListedSchema.parse(listed.data).trades[0];
    if (trade === undefined || !trade.yourActions.includes('vote')) throw new TaskUnavailableError('no_vote');
    const preview = await ctx.tools.call('preview_trade', { tradeId: trade.id });
    if ('error' in preview) throw new TaskUnavailableError(`preview_failed:${preview.error.code}`);
    const { fairness } = FairnessSchema.parse(preview.data);
    const vote = tradeVetoVote(fairness, ctx.config);
    // Sealed like a veto, so the activity log cannot tell a pass from a veto during the review.
    if (!vote.veto) throw new TaskUnavailableError('vote_pass', sealedVote(trade.id));
    return { trade, fairness, severity: vote.severity, ratio: vote.ratio };
  },
  instructions(_ctx, _payload, prep) {
    const t = prep.trade;
    const favored =
      prep.fairness.favors === t.fromTeam.id
        ? t.fromTeam.name
        : prep.fairness.favors === t.toTeam.id
          ? t.toTeam.name
          : 'neither side';
    return [
      `${t.toTeam.name} accepted a trade with ${t.fromTeam.name}: ${names(t.fromSends)} for ${names(t.toSends)}. It is under league review.`,
      `The trade value math: lineup gap ${prep.fairness.lineupGap} points, value gap ${prep.fairness.valueGap}; it favors ${favored}${prep.fairness.lopsided ? ' and is lopsided' : ''}.`,
      'You are voting to veto it; that is decided and will not change. Explain the veto in one or two sentences in your own voice (the league does not see it until the review ends).'
    ].join('\n');
  },
  async apply(ctx, _payload, prep, decision) {
    return veto(ctx, prep, decision.summary);
  },
  fallback: (ctx, _payload, prep) =>
    veto(ctx, prep, `Vetoed: the trade value math calls it too one-sided (severity ${prep.severity}).`),
  fakeScript: (_ctx, _payload, prep) => ({
    steps: [],
    decision: { summary: `Too one-sided for this league (severity ${prep.severity}, my line ${prep.ratio}).` }
  })
});

async function veto(ctx: TaskContext, prep: VotePrep, summary: string): Promise<TaskOutcome> {
  const result = await ctx.tools.call('vote_trade', { tradeId: prep.trade.id, decision: 'veto' });
  return {
    action: 'error' in result ? 'veto_trade_failed' : 'veto_trade',
    summary: 'error' in result ? `${summary} Refused: ${result.error.code}.` : summary,
    memorySummary: `Voted to veto the ${prep.trade.fromTeam.id}/${prep.trade.toTeam.id} trade (lineup gap ${prep.fairness.lineupGap}, value gap ${prep.fairness.valueGap}).`,
    sealed: sealedVote(prep.trade.id)
  };
}

function sealedVote(tradeId: string): AgentTaskSeal {
  return { summary: SEALED_VOTE, trades: [{ tradeId, until: 'final' }], waiverClaims: [] };
}
