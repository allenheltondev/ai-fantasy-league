/**
 * The epic #219 baseline (docs/evaluations/epic-219-baseline.md): every configuration (the full
 * runtime and one ablation each) on every seed, scripted model, offline and deterministic.
 *
 *   npm run sim:baseline -w @fantasy/sim -- --seeds base-1,base-2,base-3 --report baseline.json --markdown baseline.md
 */
import { writeFile } from 'node:fs/promises';
import { readSimArchive } from '../archive/io.js';
import { REPORT_SEEDS, renderBaselineReport, runBaseline } from '../eval/baseline.js';
import { archiveDir } from './archive-dir.js';
import { intArg, parseArgs, stringArg } from './args.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const seeds = (stringArg(args, 'seeds') ?? REPORT_SEEDS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const report = await runBaseline({
    archive: await readSimArchive(archiveDir(stringArg(args, 'archive', 'fixtures') as string)),
    seeds,
    weeks: intArg(args, 'weeks', 3) as number,
    log: (line) => console.error(line)
  });
  const json = stringArg(args, 'report');
  if (json) await writeFile(json, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = renderBaselineReport(report);
  const md = stringArg(args, 'markdown');
  if (md) await writeFile(md, markdown);
  console.log(markdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
