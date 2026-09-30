/**
 * Longer-season calibration (#248, docs/evaluations/season-calibration.md): the full 2025 season
 * for `full`, `no_situation`, and `no_attachments` on matched seeds, scripted model, offline.
 * Build the archive first (`npm run sim:archive -w @fantasy/sim -- --season 2025`).
 *
 *   npm run sim:calibrate -w @fantasy/sim -- --seeds cal-1,cal-2,cal-3,cal-4,cal-5 --weeks 17 \
 *     --report calibration.json --markdown calibration.md
 */
import { writeFile } from 'node:fs/promises';
import { readSimArchive } from '../archive/io.js';
import {
  CALIBRATION_SEEDS,
  CALIBRATION_WEEKS,
  renderCalibrationReport,
  runCalibration
} from '../eval/calibration.js';
import { archiveDir } from './archive-dir.js';
import { intArg, parseArgs, stringArg } from './args.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const seeds = (stringArg(args, 'seeds') ?? CALIBRATION_SEEDS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const report = await runCalibration({
    archive: await readSimArchive(archiveDir(stringArg(args, 'archive', '2025') as string)),
    seeds,
    weeks: intArg(args, 'weeks', CALIBRATION_WEEKS) as number,
    log: (line) => console.error(line)
  });
  const json = stringArg(args, 'report');
  if (json) await writeFile(json, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = renderCalibrationReport(report);
  const md = stringArg(args, 'markdown');
  if (md) await writeFile(md, markdown);
  console.log(markdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
