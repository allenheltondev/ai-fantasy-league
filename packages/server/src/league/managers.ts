import { effectiveManager, getPersonality, type AgentSeatConfig } from '@fantasy/core';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { agentIdFor } from '../repos/agents.js';
import type { Team } from '../repos/types.js';

/**
 * The AI manager behind each agent team (#159): its name, avatar seed, and personality title, as
 * the league sees them. A seat with no stored name or avatar gets a stable default from its agent
 * id, so leagues made before names existed show names too.
 */

export const ManagerSchema = z
  .object({
    name: z.string().describe('The AI manager\'s name, e.g. "Marcus Hale".'),
    avatarSeed: z.string().describe('Seed the app hashes into the avatar picture.'),
    personality: z
      .string()
      .nullable()
      .describe('The personality it plays, e.g. "The Spreadsheet"; null until the seat is configured.')
  })
  .describe('The AI manager playing an agent team.');
export type Manager = z.infer<typeof ManagerSchema>;

/** A team's manager field: the AI manager for an agent team nobody holds, null for people. */
export const TeamManagerSchema = ManagerSchema.nullable().describe(
  'The AI manager playing this team (its name and avatar); null when a person plays it.'
);

/** Team id → manager, for the league's agent teams only. */
export type ManagerLookup = ReadonlyMap<string, Manager>;

export function isAgentPlayed(team: Pick<Team, 'seatType' | 'ownerUserId'>): boolean {
  return team.seatType === 'agent' && team.ownerUserId === null;
}

export function managerOf(leagueId: string, teamId: string, config: AgentSeatConfig | null): Manager {
  const identity = effectiveManager(config, agentIdFor(leagueId, teamId));
  return {
    ...identity,
    personality: config === null ? null : getPersonality(config.personalityId).displayName
  };
}

/** Every agent-played team's manager, from one read of the league's seat configs. */
export async function leagueManagers(
  ctx: Pick<Ctx, 'repos'>,
  leagueId: string,
  teams: readonly Team[]
): Promise<ManagerLookup> {
  const agentTeams = teams.filter(isAgentPlayed);
  if (agentTeams.length === 0) return new Map();
  const seats = new Map((await ctx.repos.agents.listSeats(leagueId)).map((s) => [s.teamId, s.config]));
  return new Map(agentTeams.map((t) => [t.id, managerOf(leagueId, t.id, seats.get(t.id) ?? null)]));
}

/** The `manager` field for a team: its AI manager, or null when a person plays it. */
export function teamManager(managers: ManagerLookup, teamId: string): Manager | null {
  return managers.get(teamId) ?? null;
}
