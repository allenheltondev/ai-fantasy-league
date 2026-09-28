import { scorePlayer, scoringPreset } from '@fantasy/core';
import type { ArchivePosition, SimArchive } from './format.js';

export interface TrimOptions {
  /** Regular-season weeks to keep (the first N archived weeks). */
  weeks: number;
  /** Players kept per position, best projected (half-PPR, summed over the kept weeks) first. */
  perPosition: Readonly<Record<ArchivePosition, number>>;
}

/** Enough players for 8 full rosters (128) plus a free-agent pool at every position. */
export const FIXTURE_TRIM: TrimOptions = {
  weeks: 4,
  perPosition: { QB: 20, RB: 44, WR: 56, TE: 20, K: 14, DEF: 18 }
};

/**
 * Cuts an archive down to its first `weeks` weeks and the most-projected players at each position, for a
 * small committed test fixture. The schedule keeps every game of the kept weeks (so byes and kickoff
 * windows stay real), and bye weeks stay those of the full season.
 */
export function trimArchive(archive: SimArchive, options: TrimOptions = FIXTURE_TRIM): SimArchive {
  const weeks = archive.manifest.weeks.slice(0, options.weeks);
  const scoring = scoringPreset('yahoo_standard');
  const total = new Map<string, number>();
  for (const w of weeks) {
    for (const [id, line] of Object.entries(archive.weeks[w]?.projections.lines ?? {})) {
      total.set(id, (total.get(id) ?? 0) + scorePlayer(scoring, line).points);
    }
  }
  const keep = new Set<string>();
  for (const [position, count] of Object.entries(options.perPosition)) {
    archive.players
      .filter((p) => p.position === position)
      .sort((a, b) => (total.get(b.id) ?? 0) - (total.get(a.id) ?? 0) || a.id.localeCompare(b.id))
      .slice(0, count)
      .forEach((p) => keep.add(p.id));
  }
  const pick = <T>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([id]) => keep.has(id)));
  const weekSet = new Set(weeks);
  const players = archive.players
    .filter((p) => keep.has(p.id))
    .map((p) => {
      const out = {
        ...p,
        teams: Object.fromEntries(Object.entries(p.teams).filter(([w]) => weekSet.has(Number(w))))
      };
      if (p.injuries) {
        const injuries = Object.fromEntries(
          Object.entries(p.injuries).filter(([w]) => weekSet.has(Number(w)))
        );
        if (Object.keys(injuries).length > 0) out.injuries = injuries;
        else delete out.injuries;
      }
      return out;
    });
  const gsisKept = new Set(players.map((p) => p.gsisId));
  return {
    manifest: { ...archive.manifest, weeks, fixture: true },
    schedule: archive.schedule.filter((g) => g.seasonType === 'regular' && weekSet.has(g.week)),
    byeWeeks: archive.byeWeeks,
    crosswalk: archive.crosswalk.filter((e) => gsisKept.has(e.gsisId)),
    players,
    weeks: Object.fromEntries(
      weeks.map((w) => {
        const week = archive.weeks[w];
        if (!week) throw new Error(`Archive is missing week ${w}.`);
        return [
          w,
          {
            ...week,
            stats: pick(week.stats),
            projections: { ...week.projections, lines: pick(week.projections.lines) },
            trending: { ...week.trending, add: week.trending.add.filter((t) => keep.has(t.playerId)) }
          }
        ];
      })
    )
  };
}
