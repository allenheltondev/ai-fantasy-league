import { z } from 'zod';
import { ERROR_CODES, type ApiErrorBody } from '../errors.js';
import { LEAGUE_PHASES } from '../repos/types.js';

export const LeagueStatusSchema = z
  .object({
    id: z.string().describe('League id.'),
    phase: z
      .enum(LEAGUE_PHASES)
      .describe('Where the league is in its season. Decides which actions are allowed right now.'),
    week: z.number().int().nullable().describe('Current NFL week, or null before the season.'),
    allowedActions: z
      .array(z.string())
      .describe('Operation names you may call in this league right now. Check it before acting.')
  })
  .describe('League phase awareness, included whenever the request is about a league.');
export type LeagueStatus = z.infer<typeof LeagueStatusSchema>;

export const WarningSchema = z
  .object({
    code: z.string(),
    message: z.string()
  })
  .describe('A non-fatal note about the result, such as a player on bye in your lineup.');

export const ErrorBodySchema = z.object({
  code: z.enum(ERROR_CODES).describe('Stable machine-readable error code.'),
  message: z.string().describe('What went wrong.'),
  fix: z.string().describe('What to change to make the request succeed.'),
  details: z.record(z.string(), z.unknown()).optional().describe('Structured context, e.g. candidates.')
});

export const ErrorEnvelopeSchema = z.object({ error: ErrorBodySchema }).describe('Every error response.');

export function successEnvelopeSchema<T extends z.ZodType>(data: T) {
  return z.object({
    data,
    league: LeagueStatusSchema.nullable(),
    warnings: z.array(WarningSchema)
  });
}

export interface SuccessEnvelope {
  data: unknown;
  league: LeagueStatus | null;
  warnings: { code: string; message: string }[];
}

export interface ErrorEnvelope {
  error: ApiErrorBody;
}

export type Envelope = SuccessEnvelope | ErrorEnvelope;
