import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveSourceUrls, loadArchiveSources } from './sources.js';

describe('archive sources', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sim-sources-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists nflverse release assets for the season and the season before', () => {
    const urls = archiveSourceUrls(2025);
    expect(urls.playerStatsCsv).toMatch(/stats_player_week_2025\.csv$/);
    expect(urls.priorPlayerStatsCsv).toMatch(/stats_player_week_2024\.csv$/);
    expect(urls.teamStatsCsv).toMatch(/stats_team\/stats_team_week_2025\.csv$/);
    expect(urls.rostersCsv).toMatch(/roster_weekly_2025\.csv$/);
    expect(urls.injuriesCsv).toMatch(/injuries_2025\.csv$/);
  });

  it('downloads each file once, then reads the cache', async () => {
    const fetched: string[] = [];
    const logs: string[] = [];
    const fetchText = async (url: string): Promise<string> => {
      fetched.push(url);
      return `body of ${url}`;
    };
    const first = await loadArchiveSources(2025, fetchText, dir, (l) => logs.push(l));
    expect(fetched).toHaveLength(8);
    expect(first.playerStatsCsv).toBe(`body of ${archiveSourceUrls(2025).playerStatsCsv}`);
    expect(first.sourceUrls).toHaveLength(8);
    expect(await readFile(join(dir, 'games.csv'), 'utf8')).toContain('games.csv');
    const second = await loadArchiveSources(2025, fetchText, dir, (l) => logs.push(l));
    expect(fetched).toHaveLength(8);
    expect(second).toEqual(first);
    expect(logs.some((l) => l.startsWith('using cached'))).toBe(true);
  });

  it('skips a missing optional source but fails on a missing required one', async () => {
    const failing = (bad: RegExp) => async (url: string) => {
      if (bad.test(url)) throw new Error('HTTP 404');
      return 'x';
    };
    const partial = await loadArchiveSources(2025, failing(/injuries/));
    expect(partial.injuriesCsv).toBeUndefined();
    expect(partial.sourceUrls).toHaveLength(7);
    await expect(loadArchiveSources(2025, failing(/games\.csv/))).rejects.toThrow('HTTP 404');
  });
});
