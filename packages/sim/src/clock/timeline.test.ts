import { describe, expect, it } from 'vitest';
import { fixtureArchive, game } from '../../test/helpers.js';
import {
  GAME_DURATION_MS,
  HOUR_MS,
  MOMENT_OFFSETS,
  draftMoment,
  regularSeasonWeeks,
  weekMoments
} from './moments.js';
import { SIM_EVENT_KINDS, TimelineError, buildTimeline, type SimEvent } from './timeline.js';

const ms = (iso: string): number => Date.parse(iso);

describe('weekMoments', () => {
  it('places every moment of a week between the previous week being final and its own first kickoff', async () => {
    const { schedule, manifest } = await fixtureArchive();
    const moments = weekMoments(schedule);
    expect([...moments.keys()]).toEqual(manifest.weeks);
    for (const week of manifest.weeks) {
      const m = moments.get(week)!;
      const prev = moments.get(week - 1);
      expect(m.waiversAt).toBeLessThan(m.firstKickoff);
      expect(m.projectionsAt).toBeLessThan(m.waiversAt);
      expect(m.injuriesAt).toBeLessThan(m.firstKickoff);
      expect(m.injuriesAt).toBeGreaterThan(m.waiversAt);
      expect(m.lastFinalAt).toBe(m.lastKickoff + GAME_DURATION_MS);
      if (prev) {
        expect(m.projectionsAt).toBeGreaterThanOrEqual(prev.lastFinalAt);
        expect(m.projectionsAt).toBe(prev.lastKickoff + MOMENT_OFFSETS.projectionsAfterPreviousLastKickoffMs);
        expect(m.waiversAt).toBe(prev.lastKickoff + MOMENT_OFFSETS.waiversAfterPreviousLastKickoffMs);
      } else {
        expect(m.projectionsAt).toBe(m.firstKickoff - MOMENT_OFFSETS.projectionsBeforeFirstKickoffMs);
        expect(m.waiversAt).toBe(m.firstKickoff - MOMENT_OFFSETS.waiversBeforeFirstKickoffMs);
      }
      expect(draftMoment(m)).toBe(m.projectionsAt + 2 * HOUR_MS);
    }
  });

  it('ignores postseason games and groups kickoffs into distinct windows', () => {
    const schedule = [
      game(1, '2025-09-07T17:00:00.000Z', 'A', 'B'),
      game(1, '2025-09-07T17:00:00.000Z', 'C', 'D'),
      game(1, '2025-09-07T20:25:00.000Z', 'E', 'F'),
      { ...game(19, '2026-01-10T21:30:00.000Z', 'A', 'C'), seasonType: 'post' as const }
    ];
    const weeks = regularSeasonWeeks(schedule);
    expect(weeks).toHaveLength(1);
    expect(weeks[0]?.windows).toEqual([ms('2025-09-07T17:00:00.000Z'), ms('2025-09-07T20:25:00.000Z')]);
  });
});

describe('buildTimeline', () => {
  it('builds a sorted, deterministic timeline with every event kind for every week', async () => {
    const { schedule, manifest } = await fixtureArchive();
    const timeline = buildTimeline(schedule, { weeks: manifest.weeks });
    expect(buildTimeline(schedule, { weeks: [...manifest.weeks].reverse() })).toEqual(timeline);
    expect(timeline.map((e) => e.seq)).toEqual(timeline.map((_, i) => i));
    for (let i = 1; i < timeline.length; i++) {
      expect(ms((timeline[i] as SimEvent).at)).toBeGreaterThanOrEqual(ms((timeline[i - 1] as SimEvent).at));
    }
    expect(timeline[0]?.kind).toBe('draft');
    expect(timeline.filter((e) => e.kind === 'draft')).toHaveLength(1);
    const moments = weekMoments(schedule);
    for (const week of manifest.weeks) {
      const events = timeline.filter((e) => e.week === week);
      const kinds = new Set(events.map((e) => e.kind));
      for (const kind of SIM_EVENT_KINDS)
        if (kind !== 'draft' || week === 1) expect(kinds.has(kind)).toBe(true);
      const locks = events.filter((e) => e.kind === 'lineup_lock');
      expect(locks.map((e) => ms(e.at))).toEqual(moments.get(week)?.windows);
      const waiver = events.find((e) => e.kind === 'waiver_run')!;
      expect(ms(waiver.at)).toBeLessThan(ms(locks[0]!.at));
      const teams = locks.flatMap((e) => e.window?.teams ?? []);
      const playing = schedule.filter((g) => g.week === week).flatMap((g) => [g.homeTeam, g.awayTeam]);
      expect([...teams].sort()).toEqual([...playing].sort());
      for (const final of events.filter((e) => e.kind === 'games_final')) {
        expect(ms(final.at)).toBe(ms(final.window!.kickoff) + GAME_DURATION_MS);
      }
      const mnf = events.find((e) => e.kind === 'monday_night_final')!;
      const correction = events.find((e) => e.kind === 'stat_correction')!;
      expect(ms(mnf.at)).toBe(
        Math.max(...events.filter((e) => e.kind === 'games_final').map((e) => ms(e.at)))
      );
      expect(ms(correction.at)).toBeGreaterThan(ms(mnf.at));
      const next = timeline.find((e) => e.week === week + 1 && e.kind === 'lineup_lock');
      if (next) expect(ms(correction.at)).toBeLessThan(ms(next.at));
    }
  });

  it('starts a mid-season league with a draft before its first week', async () => {
    const { schedule } = await fixtureArchive();
    const timeline = buildTimeline(schedule, { weeks: [3, 4] });
    expect(timeline[0]).toMatchObject({ kind: 'draft', week: 3 });
    expect(timeline.some((e) => e.week < 3)).toBe(false);
    expect(ms(timeline[0]!.at)).toBeLessThan(ms(timeline[1]!.at));
  });

  it('rejects empty week lists, weeks without games, and overlapping weeks', () => {
    const schedule = [
      game(1, '2025-09-07T17:00:00.000Z', 'A', 'B'),
      game(2, '2025-09-08T17:00:00.000Z', 'A', 'B')
    ];
    expect(() => buildTimeline(schedule, { weeks: [] })).toThrow(TimelineError);
    expect(() => buildTimeline(schedule, { weeks: [1, 5] })).toThrow(/no regular-season games in week 5/);
    expect(() => buildTimeline(schedule, { weeks: [1, 2] })).toThrow(/before its waivers/);
    const tight = [
      game(1, '2025-09-07T17:00:00.000Z', 'A', 'B'),
      game(2, '2025-09-09T17:00:00.000Z', 'A', 'B')
    ];
    expect(() => buildTimeline(tight, { weeks: [1, 2] })).toThrow(/overlap/);
  });
});
