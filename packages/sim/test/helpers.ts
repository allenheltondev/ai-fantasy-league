import { readFileSync } from 'node:fs';
import type { ScheduledGame } from '@fantasy/data';
import { FIXTURE_ARCHIVE_DIR, readSimArchive } from '../src/archive/io.js';
import type { SimArchive } from '../src/archive/format.js';

let fixture: Promise<SimArchive> | undefined;

/** The committed 4-week fixture archive (read once per test file; callers must not mutate it). */
export function fixtureArchive(): Promise<SimArchive> {
  fixture ??= readSimArchive(FIXTURE_ARCHIVE_DIR);
  return fixture;
}

/** A deep copy of the fixture archive, safe to mutate. */
export async function freshArchive(): Promise<SimArchive> {
  return structuredClone(await fixtureArchive());
}

const DATA_FIXTURES = new URL('../../data/fixtures/nflverse/', import.meta.url);

/** Real (trimmed) nflverse files recorded by `@fantasy/data`. */
export function nflverseFixture(
  file: 'games_2025.csv' | 'stats_player_week_2025.csv' | 'db_playerids.csv'
): string {
  return readFileSync(new URL(file, DATA_FIXTURES), 'utf8');
}

export function game(
  week: number,
  kickoff: string,
  homeTeam: string,
  awayTeam: string,
  scores: [number, number] | null = [21, 17]
): ScheduledGame {
  const g: ScheduledGame = {
    gameId: `2025_${String(week).padStart(2, '0')}_${awayTeam}_${homeTeam}`,
    season: 2025,
    seasonType: 'regular',
    week,
    kickoff,
    homeTeam,
    awayTeam,
    status: scores ? 'final' : 'scheduled'
  };
  if (scores) {
    g.homeScore = scores[0];
    g.awayScore = scores[1];
  }
  return g;
}

/** Builds a CSV from a header and rows (values are written as-is; none contain commas). */
export function csv(header: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  return [header.join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n';
}
