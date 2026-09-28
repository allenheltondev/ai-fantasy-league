import { parseCsv } from '@fantasy/data';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { csv, nflverseFixture } from '../../test/helpers.js';
import { weekMoments } from '../clock/moments.js';
import { buildSimArchive, type ArchiveSources } from './build.js';
import { TEAM_STATS_REQUIRED_COLUMNS } from './defense.js';
import { projectLine } from './projections.js';

const statsCsv = nflverseFixture('stats_player_week_2025.csv');
/** The same rows relabelled as last season, so every fixture player has a baseline equal to his 2025 average. */
const priorCsv = statsCsv.replace(/,2025,(\d+),REG,/g, ',2024,$1,REG,');

const rosters = csv(
  [
    'season',
    'team',
    'position',
    'status',
    'full_name',
    'first_name',
    'last_name',
    'gsis_id',
    'week',
    'game_type',
    'sleeper_id'
  ],
  [
    [2025, 'BUF', 'QB', 'ACT', 'Josh Allen', 'Josh', 'Allen', '00-0034857', 1, 'REG', '4984'],
    [2025, 'BUF', 'QB', 'RES', 'Josh Allen', 'Josh', 'Allen', '00-0034857', 3, 'REG', '4984'],
    [2025, 'KC', 'TE', 'CUT', 'Travis Kelce', 'Travis', 'Kelce', '00-0030506', 3, 'REG', '1466'],
    [2025, 'BUF', 'QB', 'ACT', 'Josh Allen', 'Josh', 'Allen', '00-0034857', 19, 'WC', '4984'],
    [2024, 'BUF', 'QB', 'ACT', 'Josh Allen', 'Josh', 'Allen', '00-0034857', 1, 'REG', '4984']
  ]
);
const injuries = csv(
  ['season', 'season_type', 'week', 'gsis_id', 'report_status'],
  [
    [2025, 'REG', 1, '00-0036900', 'Out'],
    [2025, 'REG', 2, '00-0036900', 'Questionable'],
    [2025, 'REG', 2, '00-0034857', 'Probable'],
    [2025, 'POST', 19, '00-0036900', 'Out']
  ]
);
const teamStats = csv(
  [...TEAM_STATS_REQUIRED_COLUMNS],
  [[2025, 1, 'BUF', 'REG', 'BAL', 3, 1, 1, 0, 0, 0, 200, 100]]
);

function sources(overrides: Partial<ArchiveSources> = {}): ArchiveSources {
  return {
    season: 2025,
    gamesCsv: nflverseFixture('games_2025.csv'),
    playerStatsCsv: statsCsv,
    priorPlayerStatsCsv: priorCsv,
    teamStatsCsv: teamStats,
    idMapCsv: nflverseFixture('db_playerids.csv'),
    rostersCsv: rosters,
    injuriesCsv: injuries,
    sourceUrls: ['https://example.test/games.csv'],
    ...overrides
  };
}

/** Serializes parsed CSV rows back to text (quoting fields that need it). */
function toCsv(rows: string[][]): string {
  const quote = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(quote).join(',')).join('\n') + '\n';
}

describe('buildSimArchive', () => {
  const archive = buildSimArchive(sources());
  const byId = new Map(archive.players.map((p) => [p.id, p]));

  it('keeps fantasy players (by Sleeper id) and the 32 defenses, sorted by id', () => {
    expect(archive.manifest).toMatchObject({ version: 1, season: 2025, fixture: false });
    expect(archive.manifest.weeks.slice(0, 2)).toEqual([1, 2]);
    expect(byId.get('4984')).toMatchObject({ name: 'Josh Allen', position: 'QB', gsisId: '00-0034857' });
    expect(byId.get('4881')).toMatchObject({ name: 'Lamar Jackson', position: 'QB' });
    expect(byId.get('11533')).toMatchObject({ position: 'K' });
    expect(byId.has('7640')).toBe(false); // Micah Parsons (IDP) is not archived
    expect(archive.players.filter((p) => p.position === 'DEF')).toHaveLength(32);
    expect(byId.get('KC')).toMatchObject({
      name: 'Kansas City Chiefs',
      firstName: 'Kansas City',
      lastName: 'Chiefs'
    });
    const ids = archive.players.map((p) => p.id);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });

  it('records teams by week from stats, then rosters, then the last known team', () => {
    const allen = byId.get('4984')!;
    expect(allen.teams['1']).toBe('BUF');
    expect(allen.teams['3']).toBe('BUF');
    expect(byId.get('1466')?.teams['3']).toBeNull(); // released that week
    expect(byId.get('1466')?.teams['4']).toBe('KC'); // no roster file for week 4: last known team
    expect(byId.get('9493')?.teams['1']).toBe('LAR'); // nflverse LA → Sleeper LAR
  });

  it('records injury designations and reserve lists by week', () => {
    expect(byId.get('7564')?.injuries).toEqual({ 1: 'Out', 2: 'Questionable' });
    expect(byId.get('4984')?.injuries).toEqual({ 3: 'IR' });
    expect(byId.get('96')?.injuries).toBeUndefined();
  });

  it('stores actual stats under Sleeper keys, plus DEF lines from scores and team stats', () => {
    const w1 = archive.weeks[1]!;
    expect(w1.stats['4984']).toMatchObject({ gp: 1 });
    expect(w1.stats.BUF).toMatchObject({ sack: 3, int: 1, fum_rec: 1 });
    expect(typeof w1.stats.BUF?.pts_allow).toBe('number');
    expect(w1.stats.KC).toEqual({ gp: 1, pts_allow: expect.any(Number) });
    expect(archive.weeks[3]?.stats['4984']).toBeUndefined();
  });

  it('projects from the baseline and earlier weeks only, captured before the first kickoff', () => {
    const moments = weekMoments(archive.schedule);
    const allen1 = archive.weeks[1]!.stats['4984']!;
    const allen2 = archive.weeks[2]!.stats['4984']!;
    // The prior-season rows are the same two games, so the baseline is their plain average.
    const base = projectLine(20, [allen1, allen2], undefined, { window: 6, decay: 1, baselineWeeks: 0 })!;
    expect(archive.weeks[1]!.projections.lines['4984']).toEqual(base);
    expect(archive.weeks[2]!.projections.lines['4984']).toEqual(projectLine(2, [allen1], base));
    expect(archive.weeks[3]!.projections.lines['4984']).toEqual(projectLine(3, [allen2, allen1], base));
    for (const week of archive.manifest.weeks) {
      const w = archive.weeks[week]!;
      const m = moments.get(week)!;
      expect(Date.parse(w.projections.capturedAt)).toBe(m.projectionsAt);
      expect(Date.parse(w.projections.capturedAt)).toBeLessThan(m.firstKickoff);
      expect(w.playersCapturedAt).toBe(w.projections.capturedAt);
      expect(Date.parse(w.injuriesCapturedAt)).toBe(m.firstKickoff - 2 * 3_600_000);
      expect(w.trending.capturedAt).toBe(w.projections.capturedAt);
    }
  });

  it('gives no projection to players on bye or without a team', () => {
    const byes = archive.byeWeeks;
    const week = byes.BUF as number;
    expect(archive.weeks[week]?.projections.lines['4984']).toBeUndefined();
    expect(archive.weeks[week]?.projections.lines.BUF).toBeUndefined();
    expect(archive.weeks[3]?.projections.lines['1466']).toBeUndefined();
  });

  it('keeps crosswalk entries for archived players only, and records provenance', () => {
    expect(archive.crosswalk.find((e) => e.sleeperId === '4984')).toEqual({
      sleeperId: '4984',
      gsisId: '00-0034857',
      method: 'idmap'
    });
    expect(archive.crosswalk.some((e) => e.sleeperId === '7640')).toBe(false);
    expect(archive.manifest.provenance.sources).toEqual(['https://example.test/games.csv']);
    expect(archive.manifest.provenance.projectionMethod).toContain('pre-kickoff');
    expect(archive.manifest.provenance.defenseMethod).toContain('pts_allow');
  });

  it('notes missing optional sources and still builds', () => {
    const bare = buildSimArchive(
      sources({
        priorPlayerStatsCsv: undefined,
        teamStatsCsv: undefined,
        rostersCsv: undefined,
        injuriesCsv: undefined,
        sourceUrls: undefined
      })
    );
    expect(bare.manifest.provenance.notes.join(' ')).toMatch(/points allowed only/);
    expect(bare.manifest.provenance.notes.join(' ')).toMatch(/no baseline/);
    expect(bare.manifest.provenance.sources).toEqual([]);
    expect(bare.weeks[1]?.projections.lines['4984']).toBeUndefined();
    expect(bare.weeks[2]?.projections.lines['4984']).toBeDefined();
    expect(bare.players.find((p) => p.id === '4984')?.teams['3']).toBe('BUF');
  });

  it('only archives weeks whose games are all final', () => {
    const games = nflverseFixture('games_2025.csv').replace(
      /^(2025_18_[^,]+,2025,REG,18,[^,]+,[^,]+,[^,]+,[^,]+),\d+,/m,
      '$1,,'
    );
    const partial = buildSimArchive(sources({ gamesCsv: games }));
    expect(partial.manifest.weeks).not.toContain(18);
    expect(partial.manifest.weeks).toContain(17);
  });

  it("never lets a later week change an earlier week's projections (no leakage)", () => {
    const rows = parseCsv(statsCsv);
    const header = rows[0]!;
    const weekCol = header.indexOf('week');
    const cols = ['passing_yards', 'rushing_yards', 'receiving_yards', 'receptions'].map((c) =>
      header.indexOf(c)
    );
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 500 }), { minLength: 4, maxLength: 4 }), (values) => {
        const changed = rows.map((r, i) =>
          i > 0 && r[weekCol] === '2'
            ? r.map((v, c) => (cols.includes(c) ? String(values[cols.indexOf(c)]) : v))
            : r
        );
        const other = buildSimArchive(sources({ playerStatsCsv: toCsv(changed) }));
        expect(other.weeks[1]).toEqual(archive.weeks[1]);
        expect(other.weeks[2]?.projections).toEqual(archive.weeks[2]?.projections);
        expect(other.weeks[2]?.trending).toEqual(archive.weeks[2]?.trending);
      }),
      { numRuns: 15 }
    );
  });
});
