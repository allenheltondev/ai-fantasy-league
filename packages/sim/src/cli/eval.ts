/**
 * The opt-in live-model agent evaluation (#211, docs/agent-eval.md). It calls Bedrock and costs
 * money, so it refuses to start without FANTASY_LIVE_EVAL=1 and a hard --budget-usd cap, and never
 * runs in CI.
 *
 *   FANTASY_LIVE_EVAL=1 npm run sim:eval -w @fantasy/sim -- --budget-usd 5 --model nova-lite \
 *     --seeds eval-1,eval-2 --conditions full,no_memory,persona_only,deterministic \
 *     --report eval.json --markdown eval.md --transcripts transcripts.md
 */
import { writeFile } from 'node:fs/promises';
import { bedrockModel } from '@fantasy/agents';
import { readSimArchive } from '../archive/io.js';
import { liveEvalRefusal } from '../eval/budget.js';
import { parseEvalArgs, renderEvalReport, renderTranscripts, runLiveEval } from '../eval/live-eval.js';
import { archiveDir } from './archive-dir.js';
import { parseArgs, stringArg } from './args.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const options = parseEvalArgs(args);
  const refusal = liveEvalRefusal(process.env, options.budgetUsd);
  if (refusal !== null) {
    console.error(refusal);
    process.exitCode = 2;
    return;
  }
  const report = await runLiveEval({
    archive: await readSimArchive(archiveDir(stringArg(args, 'archive', 'fixtures') as string)),
    seeds: options.seeds,
    conditions: options.conditions,
    model: await bedrockModel(),
    budgetUsd: options.budgetUsd as number,
    weeks: options.weeks,
    ...(options.modelKey === undefined ? {} : { modelKey: options.modelKey }),
    log: (line) => console.error(line)
  });
  const json = stringArg(args, 'report');
  if (json) await writeFile(json, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = renderEvalReport(report);
  const md = stringArg(args, 'markdown');
  if (md) await writeFile(md, markdown);
  const transcripts = stringArg(args, 'transcripts');
  if (transcripts) await writeFile(transcripts, renderTranscripts(report));
  console.log(markdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
