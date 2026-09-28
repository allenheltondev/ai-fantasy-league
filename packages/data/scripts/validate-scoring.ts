/**
 * Scores recorded stat lines with the engine and compares them with the source's own totals (#30).
 *
 *   npm run validate-scoring -w @fantasy/data -- <file>...
 *
 * Each file is either a Sleeper weekly stats JSON (`/v1/stats/nfl/regular/{season}/{week}`, keyed by
 * player id, with pts_ppr / pts_half_ppr / pts_std) or an nflverse `stats_player_week_{season}.csv`
 * (the whole season works: download it from the nflverse-data `stats_player` release). Prints each
 * mismatch and exits 1 when any is unexplained. The CI test runs the same checks on the fixtures.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { formatScoringReport, type ScoringReport } from '@fantasy/core';
import { validateNflverseStats, validateSleeperStats } from '../src/validation/scoring-harness.js';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: validate-scoring <sleeper-stats.json | nflverse-stats.csv>...');
  process.exit(2);
}
let failed = false;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const report: ScoringReport = file.endsWith('.csv')
    ? validateNflverseStats(text)
    : validateSleeperStats(JSON.parse(text) as Parameters<typeof validateSleeperStats>[0], basename(file));
  console.log(`${file}\n${formatScoringReport(report)}\n`);
  failed ||= report.unexplained.length > 0;
}
process.exit(failed ? 1 : 0);
