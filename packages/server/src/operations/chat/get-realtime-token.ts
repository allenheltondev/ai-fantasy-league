import { z } from 'zod';
import { principalKey } from '../../auth/principal.js';
import { requireMember } from '../../league/access.js';
import { LeagueIdSchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';

/** How long a browser's subscribe token lasts; the app asks again before it expires. */
export const REALTIME_TOKEN_TTL_SECONDS = 30 * 60;
/** How often the app polls when realtime is off. */
export const POLL_INTERVAL_SECONDS = 5;

export const getRealtimeToken = defineOperation({
  name: 'get_realtime_token',
  method: 'GET',
  path: '/leagues/{leagueId}/realtime',
  summary: "Get a short-lived token to subscribe to the league's live updates",
  description: [
    "Returns a Momento Topics token that can only subscribe (never publish) to this league's topic and the global live-scores topic, with the cache and topic names to subscribe to. It expires after about 30 minutes; ask again before `expiresAt`.",
    'When realtime is not configured (local development) `enabled` is false and the other fields are null: poll the read operations every `pollIntervalSeconds` instead.',
    'People only. Errors: FORBIDDEN if you are not in the league.'
  ].join(' '),
  tags: ['realtime'],
  mutation: false,
  auth: 'user',
  input: z.object({ leagueId: LeagueIdSchema }),
  output: z.object({
    enabled: z.boolean(),
    token: z.string().nullable().describe('Subscribe-only Momento token.'),
    endpoint: z.string().nullable().describe('Momento endpoint for the token, when known.'),
    cacheName: z.string().nullable(),
    topics: z
      .object({
        league: z.string().describe('Chat and league events for this league.'),
        global: z.string().describe('Events not tied to one league, such as live stat updates.')
      })
      .nullable(),
    expiresAt: z.string().nullable(),
    pollIntervalSeconds: z.number().int()
  }),
  handler: async (ctx, input) => {
    const { league } = await requireMember(ctx, input.leagueId);
    const token = await ctx.realtime.issueSubscribeToken({
      leagueId: league.id,
      subscriber: principalKey(ctx.principal),
      ttlSeconds: REALTIME_TOKEN_TTL_SECONDS
    });
    if (token === null) {
      return {
        enabled: false,
        token: null,
        endpoint: null,
        cacheName: null,
        topics: null,
        expiresAt: null,
        pollIntervalSeconds: POLL_INTERVAL_SECONDS
      };
    }
    return { enabled: true, ...token, pollIntervalSeconds: POLL_INTERVAL_SECONDS };
  }
});
