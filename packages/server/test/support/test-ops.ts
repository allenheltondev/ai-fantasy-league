import { z } from 'zod';
import { ApiError } from '../../src/errors.js';
import { operations } from '../../src/operations/index.js';
import { playerSelectorShape, PlayerRefSchema, toPlayerRef } from '../../src/players/model.js';
import { defineOperation, withWarnings } from '../../src/registry/operation.js';
import { createRegistry } from '../../src/registry/registry.js';

/** A league mutation that exercises idempotency, phases, audit, and league status. */
export const renameLeague = defineOperation({
  name: 'rename_league',
  method: 'POST',
  path: '/leagues/{leagueId}/name',
  summary: 'Rename a league (test operation)',
  description: 'Test-only mutation. Renames the league. Only allowed before the season starts.',
  mutation: true,
  phases: ['setup', 'drafting'],
  input: z.object({ leagueId: z.string(), name: z.string().min(1).max(40), fail: z.boolean().optional() }),
  output: z.object({ id: z.string(), name: z.string() }),
  handler: async (ctx, input) => {
    const league = await ctx.repos.leagues.get(input.leagueId);
    if (league === null) {
      throw new ApiError('LEAGUE_NOT_FOUND', 'No such league.', { fix: 'Use an existing league id.' });
    }
    if (input.fail === true) {
      throw new ApiError('CONFLICT', 'Told to fail.', { fix: 'Do not set fail.' });
    }
    const updated = await ctx.repos.leagues.update({
      ...league,
      name: input.name,
      updatedAt: ctx.clock.now().toISOString()
    });
    await ctx.events.publish('Week Official Final', { leagueId: updated.id });
    return withWarnings({ id: updated.id, name: updated.name }, [
      { code: 'RENAMED', message: `League renamed to ${updated.name}.` }
    ]);
  }
});

/** A mutation whose handler crashes: the key must be released for a retry. */
export const explode = defineOperation({
  name: 'explode',
  method: 'POST',
  path: '/explode',
  summary: 'Crash (test operation)',
  description: 'Test-only mutation that always throws a non-API error.',
  mutation: true,
  input: z.object({ times: z.number().int().optional() }),
  output: z.object({ ok: z.boolean() }),
  handler: async () => {
    throw new Error('boom');
  }
});

/** Returns data that does not match its output schema. */
export const badOutput = defineOperation({
  name: 'bad_output',
  method: 'GET',
  path: '/bad-output',
  summary: 'Return invalid output (test operation)',
  description: 'Test-only read whose handler breaks its own output schema.',
  mutation: false,
  auth: 'public',
  input: z.object({}),
  output: z.object({ count: z.number() }),
  handler: async () => ({ count: 'three' }) as unknown as { count: number }
});

/** Humans only. */
export const userOnly = defineOperation({
  name: 'user_only',
  method: 'GET',
  path: '/user-only',
  summary: 'Humans only (test operation)',
  description: 'Test-only read that agents may not call.',
  mutation: false,
  auth: 'user',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  handler: async () => ({ ok: true })
});

/** Takes a player by id or name, as every player-taking operation must. */
export const pickPlayer = defineOperation({
  name: 'pick_player',
  method: 'PUT',
  path: '/leagues/{leagueId}/picks/{round}',
  summary: 'Pick a player (test operation)',
  description: 'Test-only mutation that resolves a player and echoes it.',
  mutation: true,
  input: z.object({
    leagueId: z.string(),
    round: z.number().int().min(1),
    tags: z.array(z.string()).optional(),
    ...playerSelectorShape
  }),
  output: z.object({ round: z.number(), player: PlayerRefSchema, tags: z.array(z.string()) }),
  handler: async (ctx, input) => ({
    round: input.round,
    player: toPlayerRef(await ctx.data.players.resolve(input)),
    tags: input.tags ?? []
  })
});

export const testOperations = [renameLeague, explode, badOutput, userOnly, pickPlayer];
export const testRegistry = createRegistry([...operations, ...testOperations]);
