import { getPersonality, leagueManagerIdentities, type ManagerIdentity } from '@fantasy/core';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { agentIdFor, type AgentSeatRecord } from '../repos/agents.js';
import type { Team } from '../repos/types.js';

/**
 * The AI manager behind each agent team (#159): its name, avatar seed, and personality title, as
 * the league sees them. A seat with no stored name or avatar gets a stable default from its agent
 * id, so leagues made before names existed show names too; no default repeats another manager's
 * name in the league (`leagueManagerIdentities`, #151).
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

/**
 * Team id → name and avatar for every stored seat of a league, then for `unconfigured` teams (agent
 * seats with no config yet). The stored seats come first and never depend on the unconfigured ones,
 * so the runner, which sees only the stored seats, gives a seat the same name the API shows.
 */
export function seatIdentities(
  leagueId: string,
  seats: readonly Pick<AgentSeatRecord, 'teamId' | 'config'>[],
  unconfigured: readonly string[] = []
): Map<string, ManagerIdentity> {
  const stored = leagueManagerIdentities(
    seats.map((s) => ({ key: agentIdFor(leagueId, s.teamId), config: s.config }))
  );
  const rest = leagueManagerIdentities(
    unconfigured.map((teamId) => ({ key: agentIdFor(leagueId, teamId), config: null })),
    [...stored.values()].map((m) => m.name)
  );
  const byTeam = new Map<string, ManagerIdentity>();
  for (const s of seats) byTeam.set(s.teamId, stored.get(agentIdFor(leagueId, s.teamId)) as ManagerIdentity);
  for (const teamId of unconfigured)
    byTeam.set(teamId, rest.get(agentIdFor(leagueId, teamId)) as ManagerIdentity);
  return byTeam;
}

/** One stored seat's name and avatar, as the league shows them (one read of the league's seats). */
export async function seatManager(
  ctx: Pick<Ctx, 'repos'>,
  leagueId: string,
  teamId: string
): Promise<ManagerIdentity | undefined> {
  return seatIdentities(leagueId, await ctx.repos.agents.listSeats(leagueId)).get(teamId);
}

/** Every agent-played team's manager, from one read of the league's seat configs. */
export async function leagueManagers(
  ctx: Pick<Ctx, 'repos'>,
  leagueId: string,
  teams: readonly Team[]
): Promise<ManagerLookup> {
  const agentTeams = teams.filter(isAgentPlayed);
  if (agentTeams.length === 0) return new Map();
  const records = await ctx.repos.agents.listSeats(leagueId);
  const configs = new Map(records.map((s) => [s.teamId, s.config]));
  const identities = seatIdentities(
    leagueId,
    records,
    agentTeams.filter((t) => !configs.has(t.id)).map((t) => t.id)
  );
  return new Map(
    agentTeams.map((t) => {
      const config = configs.get(t.id);
      const personality = config === undefined ? null : getPersonality(config.personalityId).displayName;
      return [t.id, { ...(identities.get(t.id) as ManagerIdentity), personality }];
    })
  );
}

/** The `manager` field for a team: its AI manager, or null when a person plays it. */
export function teamManager(managers: ManagerLookup, teamId: string): Manager | null {
  return managers.get(teamId) ?? null;
}
