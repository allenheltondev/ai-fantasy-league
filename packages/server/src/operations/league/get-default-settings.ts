import {
  LAST_NFL_WEEK,
  LEAGUE_PRESETS,
  LeagueSettingsSchema,
  MAX_TEAMS,
  MIN_TEAMS,
  PLAYER_STATUSES,
  ROSTER_SLOTS,
  SETTINGS_EDITABILITY,
  STAT_LABELS,
  yahooDefaultSettings
} from '@fantasy/core';
import { z } from 'zod';
import { defineOperation } from '../../registry/operation.js';

export const getDefaultSettings = defineOperation({
  name: 'get_default_settings',
  method: 'GET',
  path: '/settings/defaults',
  summary: 'Yahoo default league rules, and which rules can change after the draft',
  description: [
    'Returns the Yahoo default settings for a league of `teamCount` teams with a scoring `preset`, the settings create_league starts from. Compare them with `settings` from get_league to see what a commissioner changed.',
    '`editability` maps dotted setting paths to `pre_draft` (locked once the draft starts) or `any_time`; the longest matching prefix governs a path, and unknown paths are locked. Also lists the stat labels, roster slots, and player statuses the settings use. Reading defaults changes nothing.'
  ].join(' '),
  tags: ['leagues'],
  mutation: false,
  auth: 'user',
  input: z.object({
    teamCount: z
      .number()
      .int()
      .min(MIN_TEAMS)
      .max(MAX_TEAMS)
      .default(8)
      .describe('Number of teams (default 8).'),
    preset: z.enum(LEAGUE_PRESETS).default('yahoo_standard').describe('Scoring preset (default half-PPR).'),
    startWeek: z
      .number()
      .int()
      .min(1)
      .max(LAST_NFL_WEEK)
      .default(1)
      .describe('First NFL week the league plays (default 1).')
  }),
  output: z.object({
    settings: LeagueSettingsSchema,
    editability: z.record(z.string(), z.enum(['pre_draft', 'any_time'])),
    statLabels: z.record(z.string(), z.string()),
    rosterSlots: z.array(z.enum(ROSTER_SLOTS)),
    playerStatuses: z.array(z.enum(PLAYER_STATUSES))
  }),
  handler: async (_ctx, input) => ({
    settings: yahooDefaultSettings(input.teamCount, { scoring: input.preset, startWeek: input.startWeek }),
    editability: { ...SETTINGS_EDITABILITY },
    statLabels: { ...STAT_LABELS },
    rosterSlots: [...ROSTER_SLOTS],
    playerStatuses: [...PLAYER_STATUSES]
  })
});
