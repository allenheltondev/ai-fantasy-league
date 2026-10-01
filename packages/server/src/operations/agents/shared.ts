import {
  AgentSeatConfigSchema,
  DIFFICULTIES,
  PERSONALITY_IDS,
  getDifficulty,
  getPersonality,
  resolveAgentConfig,
  type AiSettings
} from '@fantasy/core';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { ApiError } from '../../errors.js';
import type { AgentSeatRecord } from '../../repos/agents.js';
import { managerOf } from '../../league/managers.js';
import {
  requireCommissioner as requireLeagueCommissioner,
  requireMember,
  requireTeam,
  type LeagueAccess
} from '../../league/access.js';
import type { Team } from '../../repos/types.js';

/** Shared pieces of the agent seat operations: guards and response views. */

export const TeamIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .describe('The team (seat) id in this league.');

/** Only the league's commissioner, via the league-membership guards (#23). */
export async function requireCommissioner(ctx: Ctx, leagueId: string): Promise<LeagueAccess> {
  return requireLeagueCommissioner(ctx, leagueId);
}

/** Members of the league (people and the league's own agents). */
export async function requireMemberAccess(ctx: Ctx, leagueId: string): Promise<LeagueAccess> {
  return requireMember(ctx, leagueId);
}

export function isCommissioner(access: LeagueAccess): boolean {
  return access.actor.kind === 'user' && access.actor.isCommissioner;
}

/** The team must exist in the league and be played by an agent (no human has claimed it). */
export function requireAgentSeat(access: LeagueAccess, teamId: string): Team {
  const team = requireTeam(access, teamId);
  if (team.seatType !== 'agent') {
    throw new ApiError('INVALID_INPUT', `Team "${teamId}" is a human seat, not an agent seat.`, {
      fix: 'Pick a team whose seat type is agent, or turn this seat into an agent seat with set_seat_type first.'
    });
  }
  return team;
}

const SeatManagerSchema = z
  .object({
    name: z.string().describe("The AI manager's name (a generated default until one is set)."),
    avatarSeed: z.string().describe('Seed the app hashes into the avatar picture.')
  })
  .describe("The AI manager's name and avatar: the stored ones, or stable defaults for this seat.");

export const PublicSeatSchema = z
  .object({
    teamId: z.string(),
    manager: SeatManagerSchema,
    personality: z.object({
      id: z.enum(PERSONALITY_IDS),
      displayName: z.string(),
      teamNameSuggestion: z.string(),
      bio: z.string(),
      avatarSeed: z.string()
    }),
    difficulty: z.object({ id: z.enum(DIFFICULTIES), displayName: z.string() })
  })
  .describe('What everyone in the league can see about an agent seat: its manager, persona, and difficulty.');
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
    manager: SeatManagerSchema,
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
      }),
      responseDelay: z
        .object({ multiplier: z.number(), immediateChance: z.number() })
        .describe(
          'How long the agent waits before acting on a trigger: the multiplier on the typical delay, and the chance of answering at once.'
        )
    })
  })
  .describe("The commissioner's full view of an agent seat, including its effective settings.");
export type CommissionerSeat = z.infer<typeof CommissionerSeatSchema>;

export function publicSeat(record: AgentSeatRecord): PublicSeat {
  const p = getPersonality(record.config.personalityId);
  const d = getDifficulty(record.config.difficulty);
  const { name, avatarSeed } = managerOf(record.leagueId, record.teamId, record.config);
  return {
    teamId: record.teamId,
    manager: { name, avatarSeed },
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

/** The seat as its commissioner sees it; `ai` (the league's AI settings) sets its effective models. */
export function commissionerSeat(record: AgentSeatRecord, ai?: AiSettings): CommissionerSeat {
  const resolved = resolveAgentConfig(record.config, {
    managerKey: record.agentId,
    ...(ai === undefined ? {} : { ai })
  });
  return {
    teamId: record.teamId,
    agentId: record.agentId,
    version: record.version,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
    config: record.config,
    manager: { name: resolved.name, avatarSeed: resolved.avatarSeed },
    effective: {
      decisionModels: resolved.models.decision,
      chatModels: resolved.models.chat,
      maxToolSteps: resolved.levers.maxToolSteps,
      actionsPerTrigger: resolved.levers.actionsPerTrigger,
      cooldownMinutes: resolved.levers.cooldownMinutes,
      negotiationRounds: resolved.levers.negotiationRounds,
      research: resolved.levers.research,
      responseDelay: resolved.levers.responseDelay
    }
  };
}
