import { z } from 'zod';
import { defineOperation } from '../registry/operation.js';

export const API_VERSION = '1.0.0';

export const getHealth = defineOperation({
  name: 'get_health',
  method: 'GET',
  path: '/health',
  summary: 'Check that the API is up',
  description:
    'Returns ok when the API is reachable. Needs no sign-in and has no side effects. Use it to confirm connectivity before other calls; it says nothing about any league.',
  tags: ['system'],
  auth: 'public',
  mutation: false,
  input: z.object({}),
  output: z.object({
    status: z.literal('ok'),
    version: z.string().describe('API version.'),
    time: z.string().describe('Server time (ISO 8601). In simulations this is the simulated time.')
  }),
  handler: async (ctx) => ({
    status: 'ok' as const,
    version: API_VERSION,
    time: ctx.clock.now().toISOString()
  })
});

const UserIdentity = z
  .object({
    type: z.literal('user'),
    sub: z.string().describe('Stable user id from the identity provider.'),
    email: z.string().nullable(),
    name: z.string()
  })
  .describe('A signed-in person.');

const AgentIdentity = z
  .object({
    type: z.literal('agent'),
    agentId: z.string(),
    teamId: z.string().describe('The team this agent manages.'),
    leagueId: z.string().describe('The league this agent plays in.')
  })
  .describe('One of the league AI agents.');

export const getMe = defineOperation({
  name: 'get_me',
  method: 'GET',
  path: '/me',
  summary: 'Who am I?',
  description:
    'Returns the identity the API sees for the caller: a signed-in person (sub, email, name) or an agent (agentId, teamId, leagueId). Use it to learn your own ids before calling league operations. Fails with UNAUTHENTICATED when no valid token is sent.',
  tags: ['system'],
  mutation: false,
  input: z.object({}),
  output: z.discriminatedUnion('type', [UserIdentity, AgentIdentity]),
  handler: async (ctx) => {
    const principal = ctx.principal;
    // `authorize` has already rejected anonymous callers.
    if (principal.type === 'agent') {
      return {
        type: 'agent' as const,
        agentId: principal.agentId,
        teamId: principal.teamId,
        leagueId: principal.leagueId
      };
    }
    if (principal.type === 'user') {
      return { type: 'user' as const, sub: principal.sub, email: principal.email, name: principal.name };
    }
    throw new Error('get_me reached the handler without a principal');
  }
});
