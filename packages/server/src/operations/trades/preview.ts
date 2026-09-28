import { activeRosterSize, validateTrade, type RosteredPlayer, type TradePhase } from '@fantasy/core';
import { z } from 'zod';
import { ApiError } from '../../errors.js';
import { requireMember, requireTeam } from '../../league/access.js';
import { actionError } from '../../league/phase.js';
import { LeagueIdSchema } from '../../league/views.js';
import { PlayerRefSchema } from '../../players/model.js';
import { defineOperation } from '../../registry/operation.js';
import { issueJson, refsFor } from '../../trades/lifecycle.js';
import { horizonPoints, loadProjections, loadTradeWorld, valueTrade } from '../../trades/world.js';
import { actingTeam, refOf, TeamIdField } from '../waivers/shared.js';
import { buildSides } from './proposal.js';
import { loadTrade, playersField, TradeIdField, tradeDepsOf } from './shared.js';

const IssueSchema = z.object({ code: z.string(), message: z.string(), fix: z.string() });

const SideImpactSchema = z.object({
  team: z.object({ id: z.string(), name: z.string() }),
  sends: z.array(PlayerRefSchema),
  receives: z.array(PlayerRefSchema),
  drops: z.array(PlayerRefSchema),
  activeBefore: z.number().int().describe('Active (non-IR) players now.'),
  activeAfter: z.number().int().describe('Active players after the trade.'),
  activeLimit: z.number().int(),
  dropsNeeded: z.number().int().describe('More drops this team needs for the roster to be legal.'),
  dropCandidates: z
    .array(PlayerRefSchema)
    .describe('When drops are needed: the team’s lowest-projected players not in the trade, weakest first.'),
  lineupBefore: z.number().describe('Best-lineup projected points over the valuation weeks, now.'),
  lineupAfter: z.number(),
  lineupDelta: z.number().describe('Positive means this team’s best lineup gets better.'),
  valueBefore: z.number().describe('Total player value (points over replacement), now.'),
  valueAfter: z.number(),
  valueDelta: z.number()
});

export const previewTrade = defineOperation({
  name: 'preview_trade',
  method: 'GET',
  path: '/leagues/{leagueId}/trades/preview',
  summary: 'Check a trade before proposing or answering it: legality, roster impact, and fairness',
  description: [
    'A dry run. Either describe a new offer (`withTeamId`, the players you `send`, the players you `receive`, and any `drops` of yours) or pass `tradeId` to evaluate an existing offer you can see.',
    'Returns whether it is legal right now (`valid`, with `issues` that each carry a fix: roster limits, players not on the roster, locked players, the trade deadline), both sides’ roster and lineup impact, the trade value math (best-lineup points and player value before and after over the next few weeks), and a fairness summary (`favors`, `lopsided`).',
    'Players can be ids or names. Use it before propose_trade, counter_trade, or accepting with respond_to_trade; agents and the trade screen read the same numbers. Nothing changes.'
  ].join(' '),
  tags: ['trades'],
  mutation: false,
  input: z.object({
    leagueId: LeagueIdSchema,
    teamId: TeamIdField,
    tradeId: TradeIdField.optional().describe('Evaluate this existing trade instead of describing one.'),
    withTeamId: z.string().min(1).max(64).optional().describe('The team you would trade with.'),
    send: playersField('Your players to send (ids or names).'),
    receive: playersField('Their players you would receive (ids or names).'),
    drops: playersField('Your players to release so your roster fits (ids or names).')
  }),
  output: z.object({
    valid: z.boolean(),
    issues: z.array(IssueSchema).describe('What makes the trade illegal right now, with fixes.'),
    warnings: z.array(IssueSchema).describe('Advisory, e.g. RESPONDER_MUST_DROP: they must drop when accepting.'),
    sides: z.tuple([SideImpactSchema, SideImpactSchema]).describe('[the offering team, the answering team]'),
    fairness: z.object({
      favors: z.string().nullable().describe('The team id that gains more, or null when even.'),
      lineupGap: z.number(),
      valueGap: z.number(),
      lopsided: z.boolean().describe('True when one side gains far more (agent-to-agent trades like this are refused).'),
      fromWeek: z.number().int(),
      toWeek: z.number().int()
    }),
    players: z
      .array(z.object({ player: PlayerRefSchema, fromTeamId: z.string(), projectedPoints: z.number() }))
      .describe('Every player in the trade with his projected points over the valuation weeks.')
  }),
  handler: async (ctx, input) => {
    const now = ctx.clock.now();
    const access = await requireMember(ctx, input.leagueId);
    const { league } = access;
    const world = await loadTradeWorld(tradeDepsOf(ctx), league, now, access.teams);
    let sides;
    let phase: TradePhase = 'proposal';
    const issues: z.infer<typeof IssueSchema>[] = [];
    if (input.tradeId !== undefined) {
      const { trade } = await loadTrade(ctx, access, input.tradeId);
      sides = trade.sides;
      if (trade.status !== 'proposed') phase = 'processing';
    } else {
      if (input.withTeamId === undefined) {
        throw new ApiError('INVALID_INPUT', 'Say which trade to preview.', {
          fix: 'Pass `tradeId` for an existing offer, or `withTeamId` with the players to `send` and `receive`.'
        });
      }
      const me = actingTeam(access, input.teamId);
      sides = await buildSides(ctx, world, me, requireTeam(access, input.withTeamId), input);
      const blocked = actionError('propose_trade', league, access.actor, now);
      if (blocked !== null) issues.push({ code: blocked.code, message: blocked.message, fix: blocked.fix });
    }
    const check = validateTrade(league.settings, { sides }, world.context, phase);
    issues.push(...check.errors.map(issueJson));
    const ids = Object.values(world.context.rosters).flatMap((r) => r.map((p) => p.playerId));
    const projections = await loadProjections(ctx.data.reference, league, ids, now);
    const value = valueTrade(world, { sides }, projections);
    const refs = await refsFor(ctx.repos, ids.concat(sides.flatMap((s) => s.sends)));
    const refList = (list: readonly string[]) => list.map((id) => refOf(refs, id));
    const limit = activeRosterSize(league.settings);
    const impact = (i: 0 | 1) => {
      const side = sides[i];
      const other = sides[1 - i] as (typeof sides)[0];
      const roster = world.context.rosters[side.teamId] ?? [];
      const active = (p: RosteredPlayer) => p.slot !== 'IR';
      const leaving = new Set([...side.sends, ...side.drops]);
      const activeBefore = roster.filter(active).length;
      const activeAfter = roster.filter((p) => active(p) && !leaving.has(p.playerId)).length + other.sends.length;
      const dropsNeeded = Math.max(0, activeAfter - limit);
      const candidates =
        dropsNeeded === 0
          ? []
          : roster
              .filter((p) => active(p) && !leaving.has(p.playerId))
              .sort((a, b) => horizonPoints(projections, a.playerId) - horizonPoints(projections, b.playerId))
              .slice(0, dropsNeeded + 2)
              .map((p) => p.playerId);
      const v = value.sides[i];
      return {
        team: { id: side.teamId, name: access.teams.find((t) => t.id === side.teamId)?.name ?? side.teamId },
        sends: refList(side.sends),
        receives: refList(other.sends),
        drops: refList(side.drops),
        activeBefore,
        activeAfter,
        activeLimit: limit,
        dropsNeeded,
        dropCandidates: refList(candidates),
        lineupBefore: v.lineupBefore,
        lineupAfter: v.lineupAfter,
        lineupDelta: v.lineupDelta,
        valueBefore: v.valueBefore,
        valueAfter: v.valueAfter,
        valueDelta: v.valueDelta
      };
    };
    return {
      valid: issues.length === 0,
      issues,
      warnings: check.warnings.map(issueJson),
      sides: [impact(0), impact(1)] as [ReturnType<typeof impact>, ReturnType<typeof impact>],
      fairness: {
        favors: value.favors,
        lineupGap: value.lineupGap,
        valueGap: value.valueGap,
        lopsided: value.lopsided,
        fromWeek: projections.fromWeek,
        toWeek: projections.toWeek
      },
      players: sides.flatMap((s) =>
        s.sends.map((id) => ({
          player: refOf(refs, id),
          fromTeamId: s.teamId,
          projectedPoints: horizonPoints(projections, id)
        }))
      )
    };
  }
});
