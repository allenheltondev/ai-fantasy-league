import {
  AgentSeatConfigSchema,
  DIFFICULTIES,
  PERSONALITY_IDS,
  getDifficulty,
  getPersonality,
  resolveAgentConfig
} from '@fantasy/core';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { ApiError } from '../../errors.js';
import type { AgentSeatRecord } from '../../repos/agents.js';
import type { League } from '../../repos/types.js';

/**
 * Shared pieces of the agent seat operations: guards and response views.
 *
 * TODO(#23): replace `requireCommissioner` and `TeamIdSchema` with the league-membership guards
 * (requireCommissioner and friends) once they land on main, and check that `teamId` is a seat in
 * the league that no human has claimed.
 */

export const TeamIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .describe('The team (seat) id in this league.');

export async function loadLeague(ctx: Ctx, leagueId: string): Promise<League> {
  const league = await ctx.repos.leagues.get(leagueId);
  if (league === null) {
    throw new ApiError('LEAGUE_NOT_FOUND', `League "${leagueId}" does not exist.`, {
      fix: 'Check the leagueId. Your leagues are listed by the league operations.'
    });
  }
  return league;
}

export function isCommissioner(ctx: Ctx, league: League): boolean {
  return ctx.principal.type === 'user' && ctx.principal.sub === league.commissionerSub;
}

/** Minimal local guard until #23 lands: only the league's commissioner (a signed-in person). */
export async function requireCommissioner(ctx: Ctx, leagueId: string): Promise<League> {
  const league = await loadLeague(ctx, leagueId);
  if (!isCommissioner(ctx, league)) {
    throw new ApiError('FORBIDDEN', 'Only the league commissioner can do this.', {
      fix: 'Ask the commissioner of this league to make the change.'
    });
  }
  return league;
}

export const PublicSeatSchema = z
  .object({
    teamId: z.string(),
    personality: z.object({
      id: z.enum(PERSONALITY_IDS),
      displayName: z.string(),
      teamNameSuggestion: z.string(),
      bio: z.string(),
      avatarSeed: z.string()
    }),
    difficulty: z.object({ id: z.enum(DIFFICULTIES), displayName: z.string() })
  })
  .describe('What everyone in the league can see about an agent seat: its persona and difficulty.');
export type PublicSeat = z.infer<typeof PublicSeatSchema>;

export const SeatRevisionSchema = z.object({
  version: z.number().int(),
  updatedAt: z.string(),
  updatedBy: z.string(),
  config: AgentSeatConfigSchema
});

export const CommissionerSeatSchema = z
  .object({
    teamId: z.string(),
    agentId: z.string(),
    version: z.number().int().describe('Pass as expectedVersion to configure_agent_seat to change it.'),
    updatedAt: z.string(),
    updatedBy: z.string(),
    config: AgentSeatConfigSchema,
    effective: z.object({
      decisionModels: z.array(z.string()).describe('Catalog model keys, primary first then fallbacks.'),
      chatModels: z.array(z.string()),
      maxToolSteps: z.number().int(),
      actionsPerTrigger: z.number().int(),
      cooldownMinutes: z.number().int(),
      negotiationRounds: z.number().int(),
      research: z.object({
        projections: z.boolean(),
        news: z.boolean(),
        trending: z.boolean(),
        matchupOutlook: z.boolean()
      })
    })
  })
  .describe("The commissioner's full view of an agent seat, including its effective settings.");
export type CommissionerSeat = z.infer<typeof CommissionerSeatSchema>;

export function publicSeat(record: AgentSeatRecord): PublicSeat {
  const p = getPersonality(record.config.personalityId);
  const d = getDifficulty(record.config.difficulty);
  return {
    teamId: record.teamId,
    personality: {
      id: record.config.personalityId,
      displayName: p.displayName,
      teamNameSuggestion: p.teamNameSuggestion,
      bio: p.bio,
      avatarSeed: p.avatarSeed
    },
    difficulty: { id: d.id, displayName: d.displayName }
  };
}

export function commissionerSeat(record: AgentSeatRecord): CommissionerSeat {
  const resolved = resolveAgentConfig(record.config);
  return {
    teamId: record.teamId,
    agentId: record.agentId,
    version: record.version,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
    config: record.config,
    effective: {
      decisionModels: resolved.models.decision,
      chatModels: resolved.models.chat,
      maxToolSteps: resolved.levers.maxToolSteps,
      actionsPerTrigger: resolved.levers.actionsPerTrigger,
      cooldownMinutes: resolved.levers.cooldownMinutes,
      negotiationRounds: resolved.levers.negotiationRounds,
      research: resolved.levers.research
    }
  };
}
