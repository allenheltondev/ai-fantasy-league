import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { parseNflverseSchedule } from '../nflverse/schedule.js';
import { sleeperPlayersSchema, sleeperTrendingSchema, sleeperWeekStatsSchema } from '../sleeper/schemas.js';
import { normalizePlayers, normalizeTrending, normalizeWeekStats } from '../sleeper/normalize.js';
import type { TrendingType } from '../types.js';
import { parseOrDrift } from '../validation.js';
import {
  HistoricalDataProvider,
  InMemoryArchiveStore,
  type ArchiveStore,
  type HistoricalProviderOptions,
  type SeasonArchive
} from './historical.js';

/** `packages/data/fixtures/` (the same relative path from `src/providers` and `dist/providers`). */
export const DEFAULT_FIXTURES_DIR = new URL('../../fixtures/', import.meta.url);

const manifestSchema = z.object({
  season: z.number().int(),
  files: z.record(
    z.string(),
    z.object({
      endpoint: z.string(),
      capturedAt: z.string().optional(),
      recordedAt: z.string().optional(),
      week: z.number().int().optional()
    })
  )
});
export type FixtureManifest = z.infer<typeof manifestSchema>;

async function readText(dir: URL, path: string): Promise<string> {
  return readFile(new URL(path, dir), 'utf8');
}

async function readJson(dir: URL, path: string): Promise<unknown> {
  return JSON.parse(await readText(dir, path)) as unknown;
}

/**
 * Builds a season archive from the recorded fixtures:
 * `sleeper/manifest.json` (+ the files it lists) and `nflverse/games_{season}.csv`.
 * Stats are treated as known when each game is final; projections, players, and trending use the
 * manifest's `capturedAt`.
 */
export async function loadFixtureArchive(dir: URL = DEFAULT_FIXTURES_DIR): Promise<SeasonArchive> {
  const manifest = parseOrDrift(
    manifestSchema,
    await readJson(dir, 'sleeper/manifest.json'),
    'fixture manifest'
  );
  const { season } = manifest;
  const archive: SeasonArchive = {
    season,
    schedule: parseNflverseSchedule(await readText(dir, `nflverse/games_${season}.csv`), season),
    players: [],
    stats: {},
    projections: {}
  };
  for (const [file, meta] of Object.entries(manifest.files)) {
    const path = `sleeper/${file}`;
    const captured = meta.capturedAt;
    const trending = /\/trending\/(add|drop)$/.exec(meta.endpoint);
    if (meta.endpoint === '/v1/players/nfl' && captured) {
      const raw = parseOrDrift(sleeperPlayersSchema, await readJson(dir, path), path);
      archive.players.push({ capturedAt: captured, data: normalizePlayers(raw) });
    } else if (meta.endpoint.startsWith('/v1/stats/') && meta.week !== undefined) {
      const raw = parseOrDrift(sleeperWeekStatsSchema, await readJson(dir, path), path);
      (archive.stats[meta.week] ??= []).push({ data: normalizeWeekStats(raw, season, meta.week) });
    } else if (meta.endpoint.startsWith('/v1/projections/') && meta.week !== undefined && captured) {
      const raw = parseOrDrift(sleeperWeekStatsSchema, await readJson(dir, path), path);
      (archive.projections[meta.week] ??= []).push({
        capturedAt: captured,
        data: normalizeWeekStats(raw, season, meta.week)
      });
    } else if (trending && captured) {
      const raw = parseOrDrift(sleeperTrendingSchema, await readJson(dir, path), path);
      archive.trending ??= {};
      (archive.trending[trending[1] as TrendingType] ??= []).push({
        capturedAt: captured,
        data: normalizeTrending(raw)
      });
    }
  }
  return archive;
}

/** An archive store backed by the recorded fixture directory (loaded once, lazily). */
export class FixtureArchiveStore implements ArchiveStore {
  readonly #dir: URL;
  #inner: Promise<InMemoryArchiveStore> | undefined;

  constructor(dir: URL = DEFAULT_FIXTURES_DIR) {
    this.#dir = dir;
  }

  async seasons(): Promise<number[]> {
    return (await this.#store()).seasons();
  }

  async load(season: number): Promise<SeasonArchive | undefined> {
    return (await this.#store()).load(season);
  }

  #store(): Promise<InMemoryArchiveStore> {
    this.#inner ??= loadFixtureArchive(this.#dir).then((a) => new InMemoryArchiveStore([a]));
    return this.#inner;
  }
}

/**
 * The provider tests and local dev use: recorded fixtures with the same `asOf` gating as the
 * historical provider, so fixture-based tests exercise the simulator's rules too.
 */
export class FixtureDataProvider extends HistoricalDataProvider {
  constructor(options: HistoricalProviderOptions & { dir?: URL } = {}) {
    const { dir, ...rest } = options;
    super(new FixtureArchiveStore(dir), rest);
  }
}
