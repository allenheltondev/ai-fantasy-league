import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { makePlayer } from '../../test/helpers.js';
import { DataNotAvailableError } from '../errors.js';
import type { ScheduledGame, StatLine } from '../types.js';
import {
  HistoricalDataProvider,
  InMemoryArchiveStore,
  buildArchiveFromNflverse,
  type SeasonArchive
} from './historical.js';

const H = 3_600_000;
const at = (iso: string): Date => new Date(iso);
const plus = (iso: string, ms: number): Date => new Date(Date.parse(iso) + ms);

// Week 1: DAL @ PHI Thursday night, then LAC @ KC Sunday. Week 2: PHI @ KC. BUF on bye in week 2.
const THU = '2025-09-05T00:20:00.000Z';
const SUN = '2025-09-07T17:00:00.000Z';
const W2 = '2025-09-14T20:25:00.000Z';
const game = (
  gameId: string,
  week: number,
  kickoff: string,
  homeTeam: string,
  awayTeam: string
): ScheduledGame => ({
  gameId,
  season: 2025,
  seasonType: 'regular',
  week,
  kickoff,
  homeTeam,
  awayTeam,
  status: 'final',
  homeScore: 24,
  awayScore: 20
});
const schedule: ScheduledGame[] = [
  game('2025_01_DAL_PHI', 1, THU, 'PHI', 'DAL'),
  game('2025_01_LAC_KC', 1, SUN, 'KC', 'LAC'),
  game('2025_01_NYJ_BUF', 1, SUN, 'BUF', 'NYJ'),
  game('2025_02_PHI_KC', 2, W2, 'KC', 'PHI')
];

const line = (playerId: string, week: number, stats: Record<string, number>, team?: string): StatLine =>
  team ? { playerId, season: 2025, week, team, stats } : { playerId, season: 2025, week, stats };

const players = [
  makePlayer({ id: 'phi1', team: 'PHI' }),
  makePlayer({ id: 'kc1', team: 'KC' }),
  makePlayer({ id: 'lac1', team: 'LAC' }),
  makePlayer({ id: 'buf1', team: 'BUF' })
];

function archive(overrides: Partial<SeasonArchive> = {}): SeasonArchive {
  return {
    season: 2025,
    schedule,
    players: [
      { capturedAt: '2025-09-01T12:00:00Z', data: players },
      { capturedAt: '2025-09-06T12:00:00Z', data: [...players, makePlayer({ id: 'late', team: 'KC' })] }
    ],
    stats: {
      1: [
        {
          data: [
            line('phi1', 1, { rec: 5 }, 'PHI'),
            line('kc1', 1, { rec: 7 }, 'KC'),
            line('lac1', 1, { rec: 3 }), // team from the player snapshot
            line('ghost', 1, { rec: 1 }) // unknown team: waits for the week's last game
          ]
        },
        // Stat correction discovered the following Thursday
        {
          capturedAt: '2025-09-11T20:00:00Z',
          data: [line('phi1', 1, { rec: 6 }, 'PHI'), line('kc1', 1, { rec: 7 }, 'KC')]
        }
      ]
    },
    projections: {
      1: [
        {
          capturedAt: '2025-09-03T12:00:00Z',
          data: [line('phi1', 1, { rec: 4 }), line('kc1', 1, { rec: 6 })]
        },
        // Captured Friday: after the Thursday game, before Sunday's.
        {
          capturedAt: '2025-09-05T18:00:00Z',
          data: [line('phi1', 1, { rec: 99 }), line('kc1', 1, { rec: 6.5 })]
        },
        // Captured after every kickoff: never valid for week 1.
        {
          capturedAt: '2025-09-08T12:00:00Z',
          data: [line('phi1', 1, { rec: 98 }), line('kc1', 1, { rec: 97 })]
        }
      ],
      2: [
        {
          capturedAt: '2025-09-10T12:00:00Z',
          data: [line('buf1', 2, { rec: 1 }), line('ghost', 2, { rec: 1 })]
        }
      ]
    },
    trending: {
      add: [
        { capturedAt: '2025-09-02T12:00:00Z', data: [{ playerId: 'phi1', count: 10 }] },
        {
          capturedAt: '2025-09-04T12:00:00Z',
          data: [
            { playerId: 'kc1', count: 20 },
            { playerId: 'lac1', count: 5 }
          ]
        }
      ]
    },
    ...overrides
  };
}

const provider = (a: SeasonArchive = archive()): HistoricalDataProvider =>
  new HistoricalDataProvider(new InMemoryArchiveStore([a]));

const ids = (lines: StatLine[]): string[] => lines.map((l) => l.playerId);

describe('HistoricalDataProvider: stats gating', () => {
  const p = provider();

  it('hides every line before any game is final', async () => {
    expect(await p.getWeekStats(2025, 1, at(THU))).toEqual([]);
    expect(await p.getWeekStats(2025, 1, plus(THU, 4 * H - 1))).toEqual([]);
  });

  it('reveals a player exactly when his game is final (kickoff + 4h)', async () => {
    expect(ids(await p.getWeekStats(2025, 1, plus(THU, 4 * H)))).toEqual(['phi1']);
    expect(ids(await p.getWeekStats(2025, 1, plus(SUN, 4 * H - 1)))).toEqual(['phi1']);
    // KC and LAC (via the player snapshot) finish Sunday; the unknown-team line waits for the last kickoff (also SUN).
    expect(ids(await p.getWeekStats(2025, 1, plus(SUN, 4 * H)))).toEqual(['phi1', 'kc1', 'lac1', 'ghost']);
  });

  it('applies stat corrections only once they are known', async () => {
    const before = await p.getWeekStats(2025, 1, at('2025-09-11T19:59:59Z'));
    expect(before.find((l) => l.playerId === 'phi1')?.stats.rec).toBe(5);
    const after = await p.getWeekStats(2025, 1, at('2025-09-11T20:00:00Z'));
    expect(after.find((l) => l.playerId === 'phi1')?.stats.rec).toBe(6);
    expect(ids(after)).toEqual(['phi1', 'kc1']);
  });

  it('returns nothing for weeks without stats and never before final even for later versions', async () => {
    expect(await p.getWeekStats(2025, 2, at('2026-01-01T00:00:00Z'))).toEqual([]);
    const onlyCorrection = provider(
      archive({
        stats: { 1: [{ capturedAt: '2025-09-20T00:00:00Z', data: [line('kc1', 1, { rec: 1 }, 'KC')] }] }
      })
    );
    expect(await onlyCorrection.getWeekStats(2025, 1, at('2025-09-10T00:00:00Z'))).toEqual([]);
    expect(await onlyCorrection.getWeekStats(2025, 1, at('2025-09-20T00:00:00Z'))).toHaveLength(1);
  });

  it('hides stats for a week with no scheduled games', async () => {
    const odd = provider(archive({ stats: { 9: [{ data: [line('kc1', 9, { rec: 1 })] }] } }));
    expect(await odd.getWeekStats(2025, 9, at('2026-06-01T00:00:00Z'))).toEqual([]);
  });

  it('honors a custom game duration', async () => {
    const quick = new HistoricalDataProvider(new InMemoryArchiveStore([archive()]), { gameDurationMs: H });
    expect(ids(await quick.getWeekStats(2025, 1, plus(THU, H)))).toEqual(['phi1']);
  });

  it('property: no line is ever visible before its game is final', async () => {
    const kickoffs: Record<string, string> = { phi1: THU, kc1: SUN, lac1: SUN, ghost: SUN };
    const start = Date.parse('2025-09-04T00:00:00Z');
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 10 * 24 * H }), async (offset) => {
        const asOf = new Date(start + offset);
        for (const l of await p.getWeekStats(2025, 1, asOf)) {
          expect(Date.parse(kickoffs[l.playerId] ?? '') + 4 * H).toBeLessThanOrEqual(asOf.getTime());
        }
      })
    );
  });
});

describe('HistoricalDataProvider: projection gating', () => {
  const stored = archive();
  const p = provider(stored);
  const proj = async (iso: string): Promise<Record<string, number | undefined>> =>
    Object.fromEntries((await p.getWeekProjections(2025, 1, at(iso))).map((l) => [l.playerId, l.stats.rec]));

  it('hides projections captured after asOf', async () => {
    expect(await proj('2025-09-03T11:59:59Z')).toEqual({});
    expect(await proj('2025-09-03T12:00:00Z')).toEqual({ phi1: 4, kc1: 6 });
  });

  it('uses the latest snapshot captured before each player’s own kickoff', async () => {
    // Friday: PHI already played, so the Friday snapshot is only valid for KC.
    expect(await proj('2025-09-05T18:00:00Z')).toEqual({ phi1: 4, kc1: 6.5 });
  });

  it('never serves a snapshot captured after kickoff, even looking back later', async () => {
    expect(await proj('2025-09-20T00:00:00Z')).toEqual({ phi1: 4, kc1: 6.5 });
  });

  it('treats unknown-team lines as locking at the week’s first kickoff; byes use the fallback too', async () => {
    const lines = await p.getWeekProjections(2025, 2, at('2025-09-12T00:00:00Z'));
    // Captured 2025-09-10, before the week 2 kickoff, so both are fine.
    expect(ids(lines)).toEqual(['buf1', 'ghost']);
    const late = provider(
      archive({
        projections: { 1: [{ capturedAt: '2025-09-06T00:00:00Z', data: [line('ghost', 1, { rec: 1 })] }] }
      })
    );
    expect(await late.getWeekProjections(2025, 1, at('2025-09-07T00:00:00Z'))).toEqual([]);
  });

  it('returns nothing for weeks without projections or games', async () => {
    expect(await p.getWeekProjections(2025, 5, at('2025-12-01T00:00:00Z'))).toEqual([]);
    const odd = provider(
      archive({ projections: { 9: [{ capturedAt: '2025-01-01T00:00:00Z', data: [line('kc1', 9, {})] }] } })
    );
    expect(await odd.getWeekProjections(2025, 9, at('2025-12-01T00:00:00Z'))).toEqual([]);
  });

  it('property: every served projection was captured before asOf and before its kickoff', async () => {
    const snapshots = stored.projections[1] ?? [];
    const start = Date.parse('2025-09-01T00:00:00Z');
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 20 * 24 * H }), async (offset) => {
        const asOf = start + offset;
        for (const l of await p.getWeekProjections(2025, 1, new Date(asOf))) {
          const source = snapshots.find((s) => s.data.includes(l));
          expect(source).toBeDefined();
          const captured = Date.parse(source?.capturedAt ?? '');
          expect(captured).toBeLessThanOrEqual(asOf);
          expect(captured).toBeLessThan(Date.parse(l.playerId === 'phi1' ? THU : SUN));
        }
      })
    );
  });
});

describe('HistoricalDataProvider: schedule, players, trending, state', () => {
  const p = provider();

  it('always returns the schedule but hides scores until final', async () => {
    const games = await p.getSchedule(2025, plus(THU, 4 * H));
    expect(games[0]).toMatchObject({ gameId: '2025_01_DAL_PHI', status: 'final', homeScore: 24 });
    expect(games[1]).toEqual({
      gameId: '2025_01_LAC_KC',
      season: 2025,
      seasonType: 'regular',
      week: 1,
      kickoff: SUN,
      homeTeam: 'KC',
      awayTeam: 'LAC',
      status: 'scheduled'
    });
    const unplayed = provider(
      archive({ schedule: [{ ...game('x', 1, THU, 'A', 'B'), status: 'scheduled' }] })
    );
    expect((await unplayed.getSchedule(2025, at('2030-01-01T00:00:00Z')))[0]?.status).toBe('scheduled');
  });

  it('computes bye weeks from the schedule', async () => {
    expect(await p.getByeWeeks(2025, at(THU))).toEqual({ BUF: 2, NYJ: 2, DAL: 2, LAC: 2 });
  });

  it('serves the latest player snapshot captured by asOf, with bye weeks', async () => {
    await expect(p.getPlayers(at('2025-08-01T00:00:00Z'))).rejects.toBeInstanceOf(DataNotAvailableError);
    const early = await p.getPlayers(at('2025-09-02T00:00:00Z'));
    expect(early.map((x) => x.id)).not.toContain('late');
    expect(early.find((x) => x.id === 'buf1')?.byeWeek).toBe(2);
    expect(early.find((x) => x.id === 'phi1')?.byeWeek).toBeUndefined();
    const later = await p.getPlayers(at('2025-09-06T12:00:00Z'));
    expect(later.map((x) => x.id)).toContain('late');
  });

  it('keeps an existing byeWeek', async () => {
    const withBye = provider(
      archive({
        players: [
          { capturedAt: '2025-01-01T00:00:00Z', data: [makePlayer({ id: 'x', team: 'BUF', byeWeek: 7 })] }
        ]
      })
    );
    expect((await withBye.getPlayers(at('2025-02-01T00:00:00Z')))[0]?.byeWeek).toBe(7);
  });

  it('serves the latest fresh trending snapshot', async () => {
    expect(await p.getTrending('add', at('2025-09-01T00:00:00Z'))).toEqual([]);
    expect(await p.getTrending('add', at('2025-09-03T00:00:00Z'))).toEqual([{ playerId: 'phi1', count: 10 }]);
    expect(await p.getTrending('add', at('2025-09-05T00:00:00Z'), { limit: 1 })).toEqual([
      { playerId: 'kc1', count: 20 }
    ]);
    // Older than 48h is stale
    expect(await p.getTrending('add', at('2025-09-06T12:00:01Z'))).toEqual([]);
    expect(await p.getTrending('drop', at('2025-09-05T00:00:00Z'))).toEqual([]);
  });

  it('derives the NFL state across archived seasons', async () => {
    const prev = archive({
      season: 2024,
      schedule: schedule.map((g) => ({ ...g, season: 2024, kickoff: g.kickoff.replace('2025', '2024') }))
    });
    const multi = new HistoricalDataProvider(new InMemoryArchiveStore([prev, archive()]));
    expect(await multi.getNflState(at('2025-09-06T00:00:00Z'))).toMatchObject({ season: 2025, week: 1 });
    expect(await multi.getNflState(at('2025-09-12T00:00:00Z'))).toMatchObject({ season: 2025, week: 2 });
    expect(await multi.getNflState(at('2025-03-01T00:00:00Z'))).toMatchObject({
      season: 2024,
      seasonType: 'off'
    });
    expect(await multi.getNflState(at('2024-06-01T00:00:00Z'))).toMatchObject({
      season: 2024,
      seasonType: 'pre'
    });
    await expect(new HistoricalDataProvider(new InMemoryArchiveStore()).getNflState(at(THU))).rejects.toThrow(
      DataNotAvailableError
    );
  });

  it('raises DataNotAvailableError for seasons it does not have', async () => {
    await expect(p.getSchedule(2019, at(THU))).rejects.toThrow(/No archived data for season 2019/);
  });
});

describe('buildArchiveFromNflverse', () => {
  it('keeps regular-season lines for the season, grouped by week, as base versions', async () => {
    const a = buildArchiveFromNflverse({
      season: 2025,
      schedule: [...schedule, { ...game('old', 1, '2024-09-08T17:00:00Z', 'KC', 'LAC'), season: 2024 }],
      weeklyStats: [
        { ...line('kc1', 1, { rec: 1 }, 'KC'), seasonType: 'regular' },
        line('phi1', 1, { rec: 2 }),
        { ...line('kc1', 19, { rec: 3 }, 'KC'), seasonType: 'post' },
        { ...line('kc1', 1, { rec: 4 }, 'KC'), season: 2024 }
      ]
    });
    expect(a.schedule).toHaveLength(4);
    expect(a.stats).toEqual({
      1: [{ data: [line('kc1', 1, { rec: 1 }, 'KC'), line('phi1', 1, { rec: 2 })] }]
    });
    expect(a.players).toEqual([]);
    const hp = provider(a);
    expect(ids(await hp.getWeekStats(2025, 1, plus(SUN, 4 * H)))).toEqual(['kc1', 'phi1']);
  });
});
