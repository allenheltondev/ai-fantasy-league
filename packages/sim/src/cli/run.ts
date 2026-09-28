/**
 * Replays a season with scripted bots and prints a summary. Exits 1 when any invariant fails.
 *
 *   npm run sim:run -w @fantasy/sim -- --archive fixtures --weeks 4
 *   npm run sim:run -w @fantasy/sim -- --archive 2025            # full season (build it first)
 *
 * Options: --archive fixtures|<season>|<dir>, --weeks N, --start-week N, --teams N (default 8),
 * --seed S, --anonymize, --report <file.json>.
 */
import { writeFile } from 'node:fs/promises';
import { readSimArchive } from '../archive/io.js';
import { scriptedPolicy } from '../policy/scripted.js';
import { runSeason } from '../runner/run-season.js';
import { formatSummary } from '../runner/summary.js';
import { archiveDir } from './archive-dir.js';
import { intArg, parseArgs, stringArg } from './args.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const archive = await readSimArchive(archiveDir(stringArg(args, 'archive', 'fixtures') as string));
  const teamCount = intArg(args, 'teams', 8) as number;
  const teams = Array.from({ length: teamCount }, (_, i) => ({
    id: `team-${String(i + 1).padStart(2, '0')}`,
    policy: scriptedPolicy()
  }));
  const weeks = intArg(args, 'weeks');
  const startWeek = intArg(args, 'start-week');
  const report = await runSeason({
    archive,
    teams,
    seed: stringArg(args, 'seed', 'replay') as string,
    anonymizePlayers: args.has('anonymize'),
    ...(weeks !== undefined ? { weeks } : {}),
    ...(startWeek !== undefined ? { startWeek } : {}),
    log: (line) => console.error(line)
  });
  const out = stringArg(args, 'report');
  if (out) await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(formatSummary(report));
  if (report.violations.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
