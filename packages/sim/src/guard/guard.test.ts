import { FixedClock } from '@fantasy/core';
import {
  HistoricalDataProvider,
  InMemoryArchiveStore,
  type DataProvider,
  type Player,
  type ScheduledGame,
  type StatLine
} from '@fantasy/data';
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { fixtureArchive } from '../../test/helpers.js';
import type { SimArchive } from '../archive/format.js';
import { toSeasonArchive } from '../archive/season-archive.js';
import { GAME_DURATION_MS, HOUR_MS } from '../clock/moments.js';
import { SimClock } from '../clock/sim-clock.js';
import { buildTimeline, type SimEvent } from '../clock/timeline.js';
import { archiveKickoffs, type KickoffLookup } from '../runner/invariants.js';
import { AsOfGuardedProvider, DATA_METHODS, FutureDataAccessError, type DataRead } from './guard.js';

const SEASON = 2025;

interface Call {
  label: string;
  method: (typeof DATA_METHODS)[number];
  run: (p: DataProvider, asOf: Date) => Promise<unknown>;
  /** The same call without an asOf (the guard fills in now). */
  bare: (p: AsOfGuardedProvider) => Promise<unknown>;
}

function calls(weeks: readonly number[]): Call[] {
  return [
    {
      label: 'getPlayers',
      method: 'getPlayers',
      run: (p, t) => p.getPlayers(t),
      bare: (p) => p.getPlayers()
    },
    {
      label: 'getNflState',
      method: 'getNflState',
      run: (p, t) => p.getNflState(t),
      bare: (p) => p.getNflState()
    },
    ...weeks.flatMap((w): Call[] => [
      {
        label: `getWeekStats(${w})`,
        method: 'getWeekStats',
        run: (p, t) => p.getWeekStats(SEASON, w, t),
        bare: (p) => p.getWeekStats(SEASON, w)
      },
      {
        label: `getWeekProjections(${w})`,
        method: 'getWeekProjections',
        run: (p, t) => p.getWeekProjections(SEASON, w, t),
        bare: (p) => p.getWeekProjections(SEASON, w)
      }
    ]),
    {
      label: 'getTrending(add)',
      method: 'getTrending',
      run: (p, t) => p.getTrending('add', t),
      bare: (p) => p.getTrending('add')
    },
    {
      label: 'getTrending(add, limit 3)',
      method: 'getTrending',
      run: (p, t) => p.getTrending('add', t, { limit: 3 }),
      bare: (p) => p.getTrending('add', undefined, { limit: 3 })
    },
    {
      label: 'getTrending(drop)',
      method: 'getTrending',
      run: (p, t) => p.getTrending('drop', t),
      bare: (p) => p.getTrending('drop')
    },
    {
      label: 'getSchedule',
      method: 'getSchedule',
      run: (p, t) => p.getSchedule(SEASON, t),
      bare: (p) => p.getSchedule(SEASON)
    },
    {
      label: 'getByeWeeks',
      method: 'getByeWeeks',
      run: (p, t) => p.getByeWeeks(SEASON, t),
      bare: (p) => p.getByeWeeks(SEASON)
    }
  ];
}

/** A call's outcome as data, so a rejection can be compared like a value. */
async function settle(p: Promise<unknown>): Promise<{ value: unknown } | { error: string }> {
  try {
    return { value: await p };
  } catch (e) {
    return { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

/** Everything that can be checked against the archive (the omniscient view) for one served result. */
function assertNoLeak(
  call: Call,
  result: unknown,
  now: number,
  archive: SimArchive,
  kickoffOf: KickoffLookup
): void {
  const week = Number(/\((\d+)\)/.exec(call.label)?.[1]);
  if (call.method === 'getWeekStats') {
    for (const line of result as StatLine[]) {
      const kickoff = kickoffOf(line.playerId, week);
      expect(kickoff, `${line.playerId} has a game in week ${week}`).not.toBeNull();
      expect(
        (kickoff as number) + GAME_DURATION_MS,
        `${line.playerId} week ${week} final`
      ).toBeLessThanOrEqual(now);
      expect(line.stats).toEqual(archive.weeks[week]?.stats[line.playerId]);
    }
  }
  if (call.method === 'getWeekProjections') {
    const lines = result as StatLine[];
    const captured = Date.parse(archive.weeks[week]?.projections.capturedAt ?? '');
    if (lines.length > 0) expect(captured).toBeLessThanOrEqual(now);
    else
      expect(captured > now || Object.keys(archive.weeks[week]?.projections.lines ?? {}).length === 0).toBe(
        true
      );
    for (const line of lines) {
      const kickoff = kickoffOf(line.playerId, week);
      if (kickoff !== null) expect(captured).toBeLessThan(kickoff);
    }
  }
  if (call.method === 'getSchedule') {
    for (const g of result as ScheduledGame[]) {
      const over = Date.parse(g.kickoff) + GAME_DURATION_MS <= now;
      expect(g.status === 'final', `${g.gameId} final at ${new Date(now).toISOString()}`).toBe(over);
      if (!over) expect(g.homeScore ?? g.awayScore).toBeUndefined();
    }
  }
  if (call.method === 'getPlayers') {
    const players = result as Player[];
    const visible = archive.manifest.weeks.filter(
      (w) => Date.parse(archive.weeks[w]!.playersCapturedAt) <= now
    );
    const week = visible[visible.length - 1] as number;
    const hurt = Date.parse(archive.weeks[week]!.injuriesCapturedAt) <= now;
    for (const p of players) {
      const source = archive.players.find((a) => a.id === p.id)!;
      expect(p.team).toBe(source.teams[week] ?? null);
      expect(p.injuryStatus).toBe(hurt ? (source.injuries?.[week] ?? null) : null);
    }
  }
  if (call.method === 'getTrending') {
    const entries = result as { playerId: string }[];
    if (entries.length > 0) {
      const visible = archive.manifest.weeks.filter(
        (w) => Date.parse(archive.weeks[w]!.trending.capturedAt) <= now
      );
      expect(visible.length).toBeGreaterThan(0);
    }
  }
}

describe('AsOfGuardedProvider', () => {
  let archive: SimArchive;
  let timeline: SimEvent[];
  let inner: HistoricalDataProvider;
  let kickoffOf: KickoffLookup;

  beforeAll(async () => {
    archive = await fixtureArchive();
    timeline = buildTimeline(archive.schedule, { weeks: archive.manifest.weeks });
    inner = new HistoricalDataProvider(new InMemoryArchiveStore([toSeasonArchive(archive)]));
    kickoffOf = archiveKickoffs(archive);
  });

  it('serves every method exactly as of now at every timeline event, and refuses any later asOf', async () => {
    const clock = new SimClock(timeline);
    const reads: DataRead[] = [];
    const guard = new AsOfGuardedProvider(inner, clock, { onRead: (r) => reads.push(r) });
    const all = calls(archive.manifest.weeks);
    let blocked = 0;
    let checked = 0;
    for (let event = clock.nextEvent(); event; event = clock.nextEvent()) {
      const now = clock.now();
      for (const call of all) {
        const expected = await call.run(inner, now);
        expect(await call.bare(guard), `${call.label} at ${event.kind} ${event.at}`).toEqual(expected);
        expect(await call.run(guard, now)).toEqual(expected);
        // An earlier asOf is served as of now: the guard never serves a stale or a future view.
        expect(await call.run(guard, new Date(now.getTime() - 6 * HOUR_MS))).toEqual(expected);
        assertNoLeak(call, expected, now.getTime(), archive, kickoffOf);
        for (const ahead of [1, GAME_DURATION_MS, 7 * 24 * HOUR_MS]) {
          await expect(call.run(guard, new Date(now.getTime() + ahead))).rejects.toThrow(
            FutureDataAccessError
          );
          blocked++;
        }
        checked++;
      }
    }
    expect(checked).toBe(timeline.length * all.length);
    expect(guard.blockedAttempts).toBe(blocked);
    expect(new Set(reads.map((r) => r.method))).toEqual(new Set(DATA_METHODS));
    expect(reads.every((r) => Date.parse(r.asOf) <= Date.parse(timeline[timeline.length - 1]!.at))).toBe(
      true
    );
  });

  it('reports what it served, so an auditor can re-check it', async () => {
    const clock = new SimClock(timeline);
    const reads: DataRead[] = [];
    const guard = new AsOfGuardedProvider(inner, clock, { onRead: (r) => reads.push(r) });
    const mnf = timeline.find((e) => e.kind === 'monday_night_final' && e.week === 1)!;
    clock.advanceTo(mnf.at);
    const stats = await guard.getWeekStats(SEASON, 1);
    const games = await guard.getSchedule(SEASON);
    expect(reads[0]).toMatchObject({ method: 'getWeekStats', asOf: mnf.at, season: SEASON, week: 1 });
    expect(reads[0]?.playerIds).toEqual(stats.map((l) => l.playerId));
    expect(reads[1]?.finalGameIds).toEqual(games.filter((g) => g.status === 'final').map((g) => g.gameId));
    expect(reads[1]?.finalGameIds?.length).toBe(archive.schedule.filter((g) => g.week === 1).length);
  });

  it('names the method, the requested time, and now in the error', async () => {
    const clock = new FixedClock('2025-09-10T00:00:00.000Z');
    const guard = new AsOfGuardedProvider(inner, clock);
    const error = await guard
      .getWeekStats(SEASON, 1, new Date('2025-09-11T00:00:00.000Z'))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FutureDataAccessError);
    expect(error).toMatchObject({
      method: 'getWeekStats',
      requestedAsOf: '2025-09-11T00:00:00.000Z',
      now: '2025-09-10T00:00:00.000Z',
      name: 'FutureDataAccessError'
    });
    expect((error as Error).message).toMatch(/cannot read the future/);
  });

  describe('properties', () => {
    const first = (): number => Date.parse(timeline[0]!.at) - 24 * HOUR_MS;
    const last = (): number => Date.parse(timeline[timeline.length - 1]!.at) + 24 * HOUR_MS;

    it('any asOf after now throws, for every method, at any moment of the season', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.double({ min: 0, max: 1, noNaN: true }),
          fc.integer({ min: 1, max: 60 * 24 * HOUR_MS }),
          fc.integer({ min: 0, max: 100 }),
          async (where, ahead, pick) => {
            const now = Math.round(first() + where * (last() - first()));
            const guard = new AsOfGuardedProvider(inner, new FixedClock(new Date(now)));
            const all = calls(archive.manifest.weeks);
            const call = all[pick % all.length]!;
            await expect(call.run(guard, new Date(now + ahead))).rejects.toThrow(FutureDataAccessError);
            expect(guard.blockedAttempts).toBe(1);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('any asOf at or before now is served as of now, and the inner provider only ever sees now', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.double({ min: 0, max: 1, noNaN: true }),
          fc.integer({ min: 0, max: 400 * 24 * HOUR_MS }),
          fc.integer({ min: 0, max: 100 }),
          async (where, behind, pick) => {
            const now = Math.round(first() + where * (last() - first()));
            const seen: number[] = [];
            const spy = new Proxy(inner, {
              get(target, prop, receiver) {
                const value = Reflect.get(target, prop, receiver) as unknown;
                if (typeof value !== 'function') return value;
                return (...args: unknown[]) => {
                  for (const a of args) if (a instanceof Date) seen.push(a.getTime());
                  return (value as (...xs: unknown[]) => unknown).apply(target, args);
                };
              }
            });
            const guard = new AsOfGuardedProvider(spy, new FixedClock(new Date(now)));
            const all = calls(archive.manifest.weeks);
            const call = all[pick % all.length]!;
            const served = await settle(call.run(guard, new Date(now - behind)));
            expect(served).toEqual(await settle(call.run(inner, new Date(now))));
            expect(seen).toEqual([now]);
            // Before the first player snapshot, getPlayers has nothing to serve (DataNotAvailableError).
            if ('value' in served) assertNoLeak(call, served.value, now, archive, kickoffOf);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('knowledge only grows: whatever is known at t1 is still known, unchanged, at any t2 > t1', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.double({ min: 0, max: 1, noNaN: true }),
          fc.double({ min: 0, max: 1, noNaN: true }),
          async (a, b) => {
            const [t1, t2] = [a, b]
              .map((x) => Math.round(first() + x * (last() - first())))
              .sort((x, y) => x - y) as [number, number];
            for (const week of archive.manifest.weeks) {
              const early = await inner.getWeekStats(SEASON, week, new Date(t1));
              const late = new Map(
                (await inner.getWeekStats(SEASON, week, new Date(t2))).map((l) => [l.playerId, l])
              );
              for (const line of early) expect(late.get(line.playerId)).toEqual(line);
              const p1 = await inner.getWeekProjections(SEASON, week, new Date(t1));
              const p2 = new Map(
                (await inner.getWeekProjections(SEASON, week, new Date(t2))).map((l) => [l.playerId, l])
              );
              for (const line of p1) expect(p2.get(line.playerId)).toEqual(line);
            }
            const s1 = (await inner.getSchedule(SEASON, new Date(t1))).filter((g) => g.status === 'final');
            const s2 = new Map((await inner.getSchedule(SEASON, new Date(t2))).map((g) => [g.gameId, g]));
            for (const g of s1) expect(s2.get(g.gameId)).toEqual(g);
          }
        ),
        { numRuns: 60 }
      );
    });
  });
});
