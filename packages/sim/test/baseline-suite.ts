import { beforeAll, describe, expect, it } from 'vitest';
import {
  CI_SEEDS,
  baselineInvariantBreaches,
  runBaseline,
  type BaselineConfig,
  type BaselineReport
} from '../src/eval/baseline.js';
import { fixtureArchive } from './helpers.js';

/**
 * One configuration of the epic #219 baseline (src/eval/baseline.ts) on the CI seeds: a season
 * replay per seed plus the acceptance scenario, scripted model. Each configuration has its own test
 * file so the replays run in parallel. Only invariants are asserted; the numbers themselves are
 * recorded in docs/evaluations/epic-219-baseline.md, never pinned here.
 */
export function baselineSuite(config: BaselineConfig): void {
  let report: BaselineReport;
  beforeAll(async () => {
    report = await runBaseline({ archive: await fixtureArchive(), seeds: CI_SEEDS, configs: [config] });
  }, 300_000);

  describe(`the ${config} baseline configuration`, () => {
    it('replays every CI seed clean: chat inside its budgets, no refused action, nothing duplicated', () => {
      expect(report.season.map((m) => m.seed)).toEqual([...CI_SEEDS]);
      for (const m of report.season) {
        expect(baselineInvariantBreaches(m), m.seed).toEqual([]);
        // The run really played: the agents called the model.
        expect(m.modelCalls, m.seed).toBeGreaterThan(0);
      }
    });

    it('runs the acceptance scenario for three managers', () => {
      expect(report.acceptance.map((a) => a.archetype)).toEqual([
        'balanced',
        'analytics_only',
        'trade_happy'
      ]);
      // With the full runtime every check holds; an ablation may fail the checks for what it removed.
      if (config === 'full') for (const a of report.acceptance) expect(a.failed, a.archetype).toEqual([]);
    });
  });
}
