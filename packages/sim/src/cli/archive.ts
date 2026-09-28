/**
 * Builds a season archive from nflverse release files.
 *
 *   npm run sim:archive -w @fantasy/sim -- --season 2025             # → packages/sim/archives/2025/
 *   npm run sim:archive -w @fantasy/sim -- --season 2025 --fixture   # → packages/sim/fixtures/ (4 weeks, trimmed)
 *
 * Options: --out <dir>, --cache <dir> (default archives/.cache; downloads are reused).
 */
import { join } from 'node:path';
import { HttpClient } from '@fantasy/data';
import { buildSimArchive } from '../archive/build.js';
import { ARCHIVES_DIR, FIXTURE_ARCHIVE_DIR, writeSimArchive, type TextFormatter } from '../archive/io.js';
import { loadArchiveSources } from '../archive/sources.js';
import { trimArchive } from '../archive/trim.js';
import { intArg, parseArgs, stringArg } from './args.js';

async function prettierFormatter(): Promise<TextFormatter> {
  const prettier = await import('prettier');
  const config = (await prettier.resolveConfig(FIXTURE_ARCHIVE_DIR)) ?? {};
  return (text, file) => prettier.format(text, { ...config, filepath: file });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const season = intArg(args, 'season', 2025) as number;
  const fixture = args.has('fixture');
  const out = stringArg(
    args,
    'out',
    fixture ? FIXTURE_ARCHIVE_DIR : join(ARCHIVES_DIR, String(season))
  ) as string;
  const cache = stringArg(args, 'cache', join(ARCHIVES_DIR, '.cache')) as string;
  const http = new HttpClient({ timeoutMs: 300_000 });
  const sources = await loadArchiveSources(
    season,
    (url) => http.getText(url),
    cache,
    (line) => console.log(line)
  );
  console.log('building archive...');
  const full = buildSimArchive(sources);
  const archive = fixture ? trimArchive(full) : full;
  await writeSimArchive(out, archive, fixture ? await prettierFormatter() : undefined);
  const stats = Object.values(archive.weeks).reduce((n, w) => n + Object.keys(w.stats).length, 0);
  const projected = Object.values(archive.weeks).reduce(
    (n, w) => n + Object.keys(w.projections.lines).length,
    0
  );
  console.log(
    `wrote ${out}: season ${season}, weeks ${archive.manifest.weeks.join(',')}, ${archive.players.length} players, ` +
      `${archive.crosswalk.length} crosswalk entries, ${stats} stat lines, ${projected} projections`
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
