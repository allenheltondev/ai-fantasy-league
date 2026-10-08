import { z } from 'zod';
import { requireMember } from '../../league/access.js';
import { actorTeam } from '../../league/phase.js';
import { GLOBAL_CHANNEL, leagueChannel, seatTenureKey, teamChannel } from '../../realtime/realtime.js';
import { LeagueIdSchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';

/** How long the returned channels hold; the app asks again (and resubscribes) before `refreshAt`. */
export const REALTIME_REFRESH_SECONDS = 30 * 60;
/** How often the app polls when realtime is off. */
export const POLL_INTERVAL_SECONDS = 5;

export const getRealtimeConfig = defineOperation({
  name: 'get_realtime_config',
  method: 'GET',
  path: '/leagues/{leagueId}/realtime',
  summary: "Get the endpoint and channels for the league's live updates",
  description: [
    "Returns the AWS AppSync Events endpoint and the channels to subscribe to with your Cognito ID token: this league's channel, your own team's private channel (your waiver claim results, trade offers, direct messages, and inbox), and the global live-scores channel. Each subscribe is checked against your current membership; browsers can never publish.",
    "Your team's channel changes when your seat changes hands, so ask again before `refreshAt` and resubscribe.",
    'When realtime is not configured (local development) `enabled` is false and the other fields are null: poll the read operations every `pollIntervalSeconds` instead.',
    'People only. Errors: FORBIDDEN if you are not in the league.'
  ].join(' '),
  tags: ['realtime'],
  mutation: false,
  auth: 'user',
  input: z.object({ leagueId: LeagueIdSchema }),
  output: z.object({
    enabled: z.boolean(),
    httpHost: z
      .string()
      .nullable()
      .describe('The Event API HTTP domain: the `host` in the WebSocket and subscribe authorization.'),
    realtimeHost: z
      .string()
      .nullable()
      .describe('The Event API WebSocket domain (wss://<realtimeHost>/event/realtime).'),
    channels: z
      .object({
        league: z.string().describe('Chat and league events for this league.'),
        global: z.string().describe('Events not tied to one league, such as live stat updates.'),
        team: z
          .string()
          .nullable()
          .describe(
            'Your team only, for your current tenure of the seat: your waiver claim results, trade offers, direct messages, and inbox. Null without a seat.'
          )
      })
      .nullable(),
    refreshAt: z.string().nullable().describe('Ask again (and resubscribe) before this time.'),
    pollIntervalSeconds: z.number().int()
  }),
  handler: async (ctx, input) => {
    const { league, actor } = await requireMember(ctx, input.leagueId);
    const endpoint = ctx.realtime.endpoint();
    if (endpoint === null) {
      return {
        enabled: false,
        httpHost: null,
        realtimeHost: null,
        channels: null,
        refreshAt: null,
        pollIntervalSeconds: POLL_INTERVAL_SECONDS
      };
    }
    // The caller's seat, if they hold one.
    const team = actorTeam(actor);
    return {
      enabled: true,
      ...endpoint,
      channels: {
        league: leagueChannel(league.id),
        global: GLOBAL_CHANNEL,
        team: team === null ? null : teamChannel(league.id, team.id, seatTenureKey(team))
      },
      refreshAt: new Date(ctx.clock.now().getTime() + REALTIME_REFRESH_SECONDS * 1000).toISOString(),
      pollIntervalSeconds: POLL_INTERVAL_SECONDS
    };
  }
});
