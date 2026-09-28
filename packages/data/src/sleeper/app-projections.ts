import { z } from 'zod';
import { SchemaDriftError, type DriftIssue } from '../errors.js';
import type { SleeperWeekStats } from './schemas.js';

/**
 * `api.sleeper.com/projections/nfl/{season}/{week}?season_type=regular&position[]=...`: the
 * projections endpoint Sleeper's own app reads (#184). Like `/v1/projections`, it is not documented
 * at docs.sleeper.com, so the shape is read defensively. Community clients and one captured payload
 * (see docs/data-sources.md) show an array of rows like
 *
 *   { player_id: '6904', week: 1, season: '2026', season_type: 'regular', team: 'PHI',
 *     opponent: 'WAS', company: 'rotowire', category: 'proj', game_id: '202610126',
 *     stats: { pass_yd: 258.4, pts_ppr: 22.75, adp_dd_ppr: 15, ... }, player: { ... } }
 *
 * A bye week or a player without a team comes back with `stats: { adp_dd_ppr: 1000 }` and a null
 * `game_id`. One community client has also seen the stats flat on the row, so both are accepted.
 */
export const sleeperAppProjectionEntrySchema = z
  .object({
    player_id: z.union([z.string().min(1), z.number().int()]).transform(String),
    week: z.union([z.number(), z.string()]).nullable().optional(),
    stats: z.record(z.string(), z.unknown()).nullable().optional()
  })
  .passthrough();
export type SleeperAppProjectionEntry = z.infer<typeof sleeperAppProjectionEntrySchema>;

/** Row fields that are not stats, skipped when a row carries its stats flat. */
const ROW_FIELDS = new Set([
  'player_id',
  'week',
  'season',
  'season_type',
  'sport',
  'category',
  'company',
  'team',
  'opponent',
  'game_id',
  'date',
  'status',
  'last_modified',
  'updated_at',
  'week_shard',
  'player',
  'stats'
]);

/** ADP and rank keys: they come on every row, even a bye week's, so they are not a projection. */
const NOT_A_PROJECTION = /^(pos_)?(adp|rank)_/;

/** Whether a stat map projects anything (a finite value other than ADP or rank). */
export function hasProjectedStats(stats: Readonly<Record<string, number | null>>): boolean {
  return Object.entries(stats).some(
    ([key, value]) => value !== null && Number.isFinite(value) && !NOT_A_PROJECTION.test(key)
  );
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function statMap(source: Record<string, unknown>, skip: ReadonlySet<string>): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const [key, value] of Object.entries(source)) {
    if (skip.has(key)) continue;
    const n = numeric(value);
    if (n !== null) stats[key] = n;
  }
  return stats;
}

const NO_FIELDS: ReadonlySet<string> = new Set();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The fallback's body → the same player id → stat map `/v1/projections` returns, so every consumer
 * is unchanged. Malformed rows (no player id, not an object) and rows for another week are skipped;
 * a row seen twice keeps the version that projects something. `null` or `[]` is an empty week.
 * Raises `SchemaDriftError` only when the body is not a list (or a v1-style map), or when it has
 * rows and none of them parse.
 */
export function parseSleeperAppProjections(body: unknown, week: number, source: string): SleeperWeekStats {
  if (body === null) return {};
  if (isRecord(body)) {
    // The v1 shape (a map by player id), in case the app endpoint ever serves it.
    const out: SleeperWeekStats = {};
    for (const [playerId, stats] of Object.entries(body)) {
      if (isRecord(stats)) out[playerId] = statMap(stats, NO_FIELDS);
    }
    if (Object.keys(body).length > 0 && Object.keys(out).length === 0) {
      throw new SchemaDriftError(source, [{ path: '', message: 'Expected a list of projection rows' }]);
    }
    return out;
  }
  if (!Array.isArray(body)) {
    throw new SchemaDriftError(source, [
      { path: '', message: `Expected a list of projection rows, received ${typeof body}` }
    ]);
  }
  const out: SleeperWeekStats = {};
  const issues: DriftIssue[] = [];
  let parsed = 0;
  body.forEach((row: unknown, index) => {
    const result = sleeperAppProjectionEntrySchema.safeParse(row);
    if (!result.success) {
      if (issues.length < 10) {
        for (const issue of result.error.issues) {
          issues.push({ path: [index, ...issue.path].map(String).join('.'), message: issue.message });
        }
      }
      return;
    }
    parsed += 1;
    const entry = result.data;
    const rowWeek = numeric(entry.week);
    if (rowWeek !== null && rowWeek !== week) return;
    const stats = isRecord(entry.stats) ? statMap(entry.stats, NO_FIELDS) : statMap(entry, ROW_FIELDS);
    const seen = out[entry.player_id];
    if (seen !== undefined && hasProjectedStats(seen) && !hasProjectedStats(stats)) return;
    out[entry.player_id] = stats;
  });
  if (body.length > 0 && parsed === 0) throw new SchemaDriftError(source, issues);
  return out;
}
