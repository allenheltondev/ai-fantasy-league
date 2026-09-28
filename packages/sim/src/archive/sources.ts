import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NFLVERSE_URLS } from '@fantasy/data';
import type { ArchiveSources } from './build.js';

const RELEASES = 'https://github.com/nflverse/nflverse-data/releases/download';

/** Every file the archive builder reads, by role. All are free nflverse / dynastyprocess release assets. */
export function archiveSourceUrls(
  season: number
): Record<Exclude<keyof ArchiveSources, 'season' | 'sourceUrls'>, string> {
  return {
    gamesCsv: NFLVERSE_URLS.schedules,
    playerStatsCsv: NFLVERSE_URLS.weeklyStats(season),
    priorPlayerStatsCsv: NFLVERSE_URLS.weeklyStats(season - 1),
    teamStatsCsv: `${RELEASES}/stats_team/stats_team_week_${season}.csv`,
    priorTeamStatsCsv: `${RELEASES}/stats_team/stats_team_week_${season - 1}.csv`,
    idMapCsv: NFLVERSE_URLS.idMap,
    rostersCsv: `${RELEASES}/weekly_rosters/roster_weekly_${season}.csv`,
    injuriesCsv: `${RELEASES}/injuries/injuries_${season}.csv`
  };
}

/** Fetches a URL's text. Injected so tests never touch the network. */
export type FetchText = (url: string) => Promise<string>;

/** Optional sources that may be absent (for example an injuries file not yet published). */
const OPTIONAL = new Set([
  'priorPlayerStatsCsv',
  'teamStatsCsv',
  'priorTeamStatsCsv',
  'rostersCsv',
  'injuriesCsv'
]);

/**
 * Downloads every source for `season`, caching each file under `cacheDir` by its file name so rebuilds
 * are offline. A missing optional source is skipped (the manifest notes the gap); a missing required one
 * throws.
 */
export async function loadArchiveSources(
  season: number,
  fetchText: FetchText,
  cacheDir?: string,
  log: (line: string) => void = () => {}
): Promise<ArchiveSources> {
  const urls = archiveSourceUrls(season);
  const sources: ArchiveSources = { season, gamesCsv: '', playerStatsCsv: '', idMapCsv: '', sourceUrls: [] };
  if (cacheDir) await mkdir(cacheDir, { recursive: true });
  for (const [key, url] of Object.entries(urls) as [keyof typeof urls, string][]) {
    const cached = cacheDir ? join(cacheDir, url.slice(url.lastIndexOf('/') + 1)) : undefined;
    let text: string | undefined;
    if (cached) text = await readFile(cached, 'utf8').catch(() => undefined);
    if (text === undefined) {
      try {
        log(`fetching ${url}`);
        text = await fetchText(url);
        if (cached) await writeFile(cached, text);
      } catch (error) {
        if (!OPTIONAL.has(key)) throw error;
        log(`skipping optional source ${url}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    } else {
      log(`using cached ${cached}`);
    }
    sources[key] = text;
    sources.sourceUrls?.push(url);
  }
  return sources;
}
