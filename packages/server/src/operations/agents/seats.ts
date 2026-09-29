import {
  AgentSeatConfigSchema,
  MAX_TEAMS,
  getModel,
  randomizeAgentSeats,
  resolveAgentConfig,
  type AgentSeatConfig
} from '@fantasy/core';
import { z } from 'zod';
import { principalKey } from '../../auth/principal.js';
import type { Ctx } from '../../context.js';
import { ApiError } from '../../errors.js';
import { agentIdFor, type AgentSeatRecord } from '../../repos/agents.js';
import type { LeagueAccess } from '../../league/access.js';
import { isAgentPlayed, leagueManagers } from '../../league/managers.js';
import type { League } from '../../repos/types.js';
import { defineOperation } from '../../registry/operation.js';
import {
  CommissionerSeatSchema,
  PublicSeatSchema,
  SeatRevisionSchema,
  TeamIdSchema,
  commissionerSeat,
  isCommissioner,
  requireAgentSeat,
  requireMemberAccess,
  publicSeat,
  requireCommissioner
} from './shared.js';

type SeatChange = { field: 'difficulty' | 'archetype' | 'model' | 'personality'; from: string; to: string };

/** What a player of the league would notice changing about an agent, by display name. */
export function seatChanges(before: AgentSeatConfig, after: AgentSeatConfig): SeatChange[] {
  const a = resolveAgentConfig(before);
  const b = resolveAgentConfig(after);
  const pairs: [SeatChange['field'], string, string][] = [
    ['difficulty', a.difficulty.displayName, b.difficulty.displayName],
    ['archetype', a.archetype.displayName, b.archetype.displayName],
    [
      'model',
      getModel(a.models.decision[0] as Parameters<typeof getModel>[0]).displayName,
      getModel(b.models.decision[0] as Parameters<typeof getModel>[0]).displayName
    ],
    ['personality', a.personality.displayName, b.personality.displayName]
  ];
  return pairs.filter(([, from, to]) => from !== to).map(([field, from, to]) => ({ field, from, to }));
}

async function writeSeat(
  ctx: Ctx,
  league: Pick<League, 'id' | 'phase'>,
  teamId: string,
  config: AgentSeatConfig,
  expectedVersion: number | undefined
): Promise<AgentSeatRecord> {
  const leagueId = league.id;
  const current = await ctx.repos.agents.getSeat(leagueId, teamId);
  const currentVersion = current?.version ?? 0;
  if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
    throw new ApiError('CONFLICT', `The agent seat for team ${teamId} is at version ${currentVersion}.`, {
      fix: `Read it with get_agent_seat, then retry with expectedVersion ${currentVersion}.`,
      details: { currentVersion }
    });
  }
  const record: AgentSeatRecord = {
    leagueId,
    teamId,
    agentId: agentIdFor(leagueId, teamId),
    config,
    version: currentVersion + 1,
    updatedAt: ctx.clock.now().toISOString(),
    updatedBy: principalKey(ctx.principal)
  };
  await ctx.repos.agents.putSeat(record);
  // After the draft, changes are announced (event + chat line): the commissioner usually plays too,
  // and must not be able to quietly weaken the AI teams they face.
  if (league.phase !== 'setup' && current !== null) {
    const changes = seatChanges(current.config, config);
    if (changes.length > 0) {
      await ctx.events.publish('Agent Seat Changed', {
        leagueId,
        teamId,
        changedBy: record.updatedBy,
        phase: league.phase,
        version: record.version,
        changes
      });
    }
  }
  return record;
}

const nameKey = (name: string) => name.trim().toLowerCase();

/**
 * Names already used in the league by anyone but `except`: the other AI managers (stored or
 * default) and the people holding seats. Manager names are unique so chat and @mentions stay clear.
 */
async function namesInUse(ctx: Ctx, access: LeagueAccess, except: ReadonlySet<string>): Promise<string[]> {
  const managers = await leagueManagers(ctx, access.league.id, access.teams);
  return access.teams
    .filter((t) => !except.has(t.id))
    .map((t) => (isAgentPlayed(t) ? managers.get(t.id)?.name : t.ownerName) ?? null)
    .filter((n): n is string => n !== null && n !== '');
}

export const configureAgentSeat = defineOperation({
  name: 'configure_agent_seat',
  method: 'PUT',
  path: '/leagues/{leagueId}/agents/{teamId}',
  summary: "Set an agent seat's manager name, avatar, personality, difficulty, and strategy",
  description: [
    "Commissioner only, any time until the season is complete. A change takes effect on the agent's next trigger; nothing is redeployed. After the draft, every change the league would notice (difficulty, strategy, model, personality) is announced in the league chat.",
    'Sets which agent plays a team: a personality preset, a difficulty tier, and a strategy archetype, plus optional Advanced settings (a model override from the catalog, individual difficulty levers, and up to 280 characters of extra flavor).',
    "`name` (1-40 characters on one line, unique in the league) is what the manager calls itself in chat; `avatarSeed` picks its avatar picture. Leave either out to keep the seat's current one.",
    '`namesTeam` (on by default) lets the manager name its team: it replaces a placeholder like "Team 3" in character and may rebrand now and then. Turned off, it never renames, and a name you give the team (rename_team) is locked. Leave it out to keep the current setting.',
    'Every change is stored as a new version; pass `expectedVersion` (from get_agent_seat) to avoid overwriting a change someone else made, or leave it out to overwrite.',
    'Errors: FORBIDDEN if you are not the commissioner; PHASE_NOT_ALLOWED once the season is complete; CONFLICT when expectedVersion is stale (details.currentVersion has the right one); INVALID_INPUT for unknown ids, out-of-range levers, a malformed name or avatar seed, or a name another manager in the league already uses.'
  ].join(' '),
  tags: ['agents'],
  mutation: true,
  auth: 'user',
  phases: ['setup', 'drafting', 'regular_season', 'playoffs'],
  input: z.object({
    leagueId: z.string(),
    teamId: TeamIdSchema,
    ...AgentSeatConfigSchema.shape,
    expectedVersion: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('The version you read; 0 when the seat has no config yet. Omit to overwrite.')
  }),
  output: z.object({ seat: CommissionerSeatSchema }),
  handler: async (ctx, input) => {
    const access = await requireCommissioner(ctx, input.leagueId);
    requireAgentSeat(access, input.teamId);
    const { leagueId: _leagueId, teamId, expectedVersion, ...fields } = input;
    const config = AgentSeatConfigSchema.parse(fields);
    // Name and avatar carry over when left out, so a settings change never renames the manager.
    const current = await ctx.repos.agents.getSeat(access.league.id, teamId);
    const name = config.name ?? current?.config.name;
    const avatarSeed = config.avatarSeed ?? current?.config.avatarSeed;
    const namesTeam = config.namesTeam ?? current?.config.namesTeam;
    if (config.name !== undefined) {
      const taken = await namesInUse(ctx, access, new Set([teamId]));
      if (taken.some((n) => nameKey(n) === nameKey(config.name as string))) {
        throw new ApiError(
          'INVALID_INPUT',
          `Another manager in this league is already named "${config.name}".`,
          {
            fix: `Pick a name no one else in the league uses (taken: ${taken.join(', ')}), or leave \`name\` out to keep this seat's current name.`
          }
        );
      }
    }
    const record = await writeSeat(
      ctx,
      access.league,
      teamId,
      {
        ...config,
        ...(name === undefined ? {} : { name }),
        ...(avatarSeed === undefined ? {} : { avatarSeed }),
        ...(namesTeam === undefined ? {} : { namesTeam })
      },
      expectedVersion
    );
    return { seat: commissionerSeat(record) };
  }
});

export const randomizeAgentSeatsOperation = defineOperation({
  name: 'randomize_agent_seats',
  method: 'POST',
  path: '/leagues/{leagueId}/agents/randomize',
  summary: 'Fill agent seats with a random, varied mix of agents',
  description: [
    'Commissioner only, before the draft (league phase "setup").',
    'Gives each listed team a different personality, a new manager name (unique in the league) and avatar, and spreads difficulties and strategies evenly across them.',
    'The same `seed` always produces the same seats; leave it out for a fresh mix. Existing configs for those teams are replaced (as new versions).',
    'Errors: FORBIDDEN if you are not the commissioner; PHASE_NOT_ALLOWED after the draft starts; INVALID_INPUT for duplicate team ids, human seats, or more teams than the league allows; TEAM_NOT_FOUND for a team that is not in the league.'
  ].join(' '),
  tags: ['agents'],
  mutation: true,
  auth: 'user',
  phases: ['setup'],
  input: z.object({
    leagueId: z.string(),
    teamIds: z
      .array(TeamIdSchema)
      .min(1)
      .max(MAX_TEAMS)
      .refine((ids) => new Set(ids).size === ids.length, 'teamIds must be unique')
      .describe('The agent seats to fill.'),
    seed: z.string().min(1).max(100).optional().describe('Seed for a repeatable mix.')
  }),
  output: z.object({ seed: z.string(), seats: z.array(CommissionerSeatSchema) }),
  handler: async (ctx, input) => {
    const access = await requireCommissioner(ctx, input.leagueId);
    const { league } = access;
    const teamCount = league.settings.teamCount;
    if (input.teamIds.length > teamCount) {
      throw new ApiError('INVALID_INPUT', `This league has ${teamCount} teams.`, {
        fix: `List at most ${teamCount} team ids.`
      });
    }
    for (const teamId of input.teamIds) requireAgentSeat(access, teamId);
    const seed = input.seed ?? `${league.id}:${ctx.clock.now().toISOString()}`;
    const taken = await namesInUse(ctx, access, new Set(input.teamIds));
    const configs = randomizeAgentSeats(input.teamIds.length, seed, taken);
    const seats = [];
    for (const [i, teamId] of input.teamIds.entries()) {
      const record = await writeSeat(ctx, league, teamId, configs[i] as AgentSeatConfig, undefined);
      seats.push(commissionerSeat(record));
    }
    return { seed, seats };
  }
});

export const getAgentSeat = defineOperation({
  name: 'get_agent_seat',
  method: 'GET',
  path: '/leagues/{leagueId}/agents/{teamId}',
  summary: 'See which agent plays a team',
  description: [
    "Returns an agent seat's public persona (personality and difficulty), which every league member can see.",
    'The commissioner also gets the full config, its version, the effective model and lever settings, and the change history.',
    'Errors: FORBIDDEN if you are not in the league; NOT_FOUND when the team has no agent config; LEAGUE_NOT_FOUND for an unknown league.'
  ].join(' '),
  tags: ['agents'],
  mutation: false,
  input: z.object({ leagueId: z.string(), teamId: TeamIdSchema }),
  output: z.object({
    seat: PublicSeatSchema,
    commissioner: z
      .object({ current: CommissionerSeatSchema, history: z.array(SeatRevisionSchema) })
      .nullable()
      .describe('Only for the commissioner; null for everyone else.')
  }),
  handler: async (ctx, input) => {
    const access = await requireMemberAccess(ctx, input.leagueId);
    const { league } = access;
    const record = await ctx.repos.agents.getSeat(league.id, input.teamId);
    if (record === null) {
      throw new ApiError('NOT_FOUND', `Team ${input.teamId} has no agent config.`, {
        fix: 'The commissioner sets one with configure_agent_seat or randomize_agent_seats.'
      });
    }
    if (!isCommissioner(access)) return { seat: publicSeat(record), commissioner: null };
    const history = await ctx.repos.agents.seatHistory(league.id, input.teamId);
    return {
      seat: publicSeat(record),
      commissioner: {
        current: commissionerSeat(record),
        history: history.map((h) => ({
          version: h.version,
          updatedAt: h.updatedAt,
          updatedBy: h.updatedBy,
          config: h.config
        }))
      }
    };
  }
});
