/**
 * Replays a season through the real league (server operations, jobs, and event handlers, and the
 * agents on the fake model) and writes the season report. Exits 1 when an invariant fails or a
 * handler throws.
 *
 *   npm run sim:replay -w @fantasy/sim -- --archive fixtures --weeks 3
 *   npm run sim:replay -w @fantasy/sim -- --archive 2025 --report season.json --markdown season.md
 *   npm run sim:replay -w @fantasy/sim -- --archive 2025 --start-week 4
 *
 * Options: --archive fixtures|<season>|<dir>, --weeks N, --start-week N, --teams N (default 8),
 * --seed S, --anonymize, --report <file.json>, --markdown <file.md>, --stats-every <minutes>.
 */
import { writeFile } from 'node:fs/promises';
import { readSimArchive } from '../archive/io.js';
import { replayLeague } from '../replay/league-replay.js';
import { renderLeagueReport } from '../replay/report.js';
import { archiveDir } from './archive-dir.js';
import { intArg, parseArgs, stringArg } from './args.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const archive = await readSimArchive(archiveDir(stringArg(args, 'archive', 'fixtures') as string));
  const weeks = intArg(args, 'weeks');
  const startWeek = intArg(args, 'start-week');
  const statsEvery = intArg(args, 'stats-every');
  const report = await replayLeague({
    archive,
    seed: stringArg(args, 'seed', 'replay') as string,
    teamCount: intArg(args, 'teams', 8) as number,
    anonymizePlayers: args.has('anonymize'),
    ...(weeks !== undefined ? { weeks } : {}),
    ...(startWeek !== undefined ? { startWeek } : {}),
    ...(statsEvery !== undefined
      ? {
          jobCadences: {
            ingestStats: `rate(${statsEvery} minutes)`,
            scoreLiveWeek: `rate(${statsEvery} minutes)`
          }
        }
      : {}),
    log: (line) => console.error(line)
  });
  const json = stringArg(args, 'report');
  if (json) await writeFile(json, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = renderLeagueReport(report);
  const md = stringArg(args, 'markdown');
  if (md) await writeFile(md, markdown);
  console.log(markdown);
  if (report.violations.length > 0 || report.events.failures.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
