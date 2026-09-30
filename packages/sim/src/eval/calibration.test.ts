import { emptyAttachments } from '@fantasy/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { fixtureArchive } from '../../test/helpers.js';
import {
  attachmentUseOf,
  exposureOf,
  matchedRow,
  observer,
  renderCalibrationReport,
  runCalibration,
  type CalibrationReport,
  type CalibrationRun,
  type SituationLine
} from './calibration.js';

/**
 * The longer-season calibration (#248) on the committed fixture: the replay's log hook reaches the
 * agents' situation and attachment lines, the measures add up, and the report states matched
 * changes and integrity. The full-season numbers are in docs/evaluations/season-calibration.md.
 */

let report: CalibrationReport;

beforeAll(async () => {
  report = await runCalibration({
    archive: await fixtureArchive(),
    seeds: ['c1'],
    weeks: 3,
    configs: ['full', 'no_situation', 'no_attachments']
  });
}, 300_000);

const line = (over: Partial<SituationLine>): SituationLine => ({
  teamId: 'team-2',
  week: 5,
  throughWeek: 4,
  urgency: 'baseline',
  basis: 'none',
  reasons: ['early_season'],
  pressure: [],
  ...over
});

describe('measures', () => {
  it('counts states per task and per agent-week, label changes, pressure, and hindsight', () => {
    const e = exposureOf([
      line({}),
      line({}),
      line({
        urgency: 'contender',
        basis: 'heuristic',
        reasons: ['comfortable_cushion'],
        pressure: ['RB:short']
      }),
      line({ teamId: 'team-3', pressure: ['TE:thin'] }),
      line({ week: 6, throughWeek: 7 })
    ]);
    expect(e.tasks).toBe(5);
    expect(e.byUrgency).toMatchObject({ baseline: 4, contender: 1 });
    // team-2 week 5 baseline, team-2 week 5 contender, team-3 week 5 baseline, team-2 week 6 baseline.
    expect(e.agentWeeks).toMatchObject({ baseline: 3, contender: 1 });
    expect(e.transitions).toBe(2);
    expect([e.short, e.thin, e.hindsight]).toEqual([1, 1, 1]);
    expect(e.reasons).toMatchObject({ early_season: 4, comfortable_cushion: 1 });
  });

  it('reads attachment lines and the end state, and finds a held player who left the roster', () => {
    const seen = observer();
    seen.observe(
      '{"level":"info","message":"agent attachment adjustment","use":"answer","adjustment":1.2,"override":false}'
    );
    seen.observe(
      '{"level":"info","message":"agent attachment adjustment","use":"scout","adjustment":0,"override":true}'
    );
    seen.observe('{"level":"info","message":"something else"}');
    const pref = {
      ...emptyAttachments(),
      preferences: [
        {
          playerId: 'p1',
          status: 'held',
          sources: [{ kind: 'drafted' }],
          revisions: [{ from: 0.8, to: 0.6 }]
        },
        {
          playerId: 'p2',
          status: 'held',
          sources: [{ kind: 'traded_for' }],
          revisions: [{ from: 0.5, to: 0.7 }]
        },
        { playerId: 'p3', status: 'departed', sources: [{ kind: 'drafted' }], revisions: [] }
      ]
    } as never;
    const use = attachmentUseOf(
      { attachments: { 'team-2': pref }, rosters: { 'team-2': ['p1'] } },
      seen.adjustments
    );
    expect(use).toMatchObject({
      adjustments: 2,
      byUse: { answer: 1, scout: 1 },
      raised: 1,
      overrides: 1,
      meanAdjustment: 1.2,
      held: 2,
      departed: 1,
      drafted: 2,
      tradedFor: 1,
      revisedDown: 1,
      revisedUp: 1,
      staleHeld: 1
    });
  });

  it('states an ablation as a matched change from full, seed by seed', () => {
    const run = (config: CalibrationRun['config'], seed: string, adds: number) =>
      ({ config, seed, season: { adds } }) as CalibrationRun;
    const r = {
      seeds: ['a', 'b'],
      weeks: 17,
      configs: ['full', 'no_situation'],
      runs: [
        run('full', 'a', 10),
        run('full', 'b', 20),
        run('no_situation', 'a', 13),
        run('no_situation', 'b', 19)
      ]
    } as CalibrationReport;
    expect(matchedRow(r, 'full', (x) => x.season.adds)).toBe('15 ± 5 (10 / 20)');
    expect(matchedRow(r, 'no_situation', (x) => x.season.adds)).toBe('16 (Δ +1 ± 2; up 1, down 1 of 2)');
  });
});

describe('a matched run on the fixture', () => {
  it('sees situations and attachments through the replay, only when they are on', () => {
    const of = (c: CalibrationRun['config']) => report.runs.find((r) => r.config === c) as CalibrationRun;
    expect(of('full').exposure.tasks).toBeGreaterThan(0);
    expect(of('full').exposure.hindsight).toBe(0);
    expect(of('no_situation').exposure.tasks).toBe(0);
    expect(of('full').attachments.held).toBeGreaterThan(0);
    expect(of('full').attachments.staleHeld).toBe(0);
    expect(of('no_attachments').attachments.adjustments).toBe(0);
    for (const r of report.runs) {
      expect(r.season.violations).toBe(0);
      expect(r.season.invalidActions).toBe(0);
      expect(Object.values(r.scouting).reduce((a, s) => a + s.agents, 0)).toBe(r.season.agents);
    }
  });

  it('renders the matched table, exposure, attachments, scouting, and integrity', () => {
    const md = renderCalibrationReport(report);
    expect(md).toContain('### Decisions and outcomes');
    expect(md).toContain('| Agent points for (mean per agent) |');
    expect(md).toContain('### Situational exposure');
    expect(md).toContain('### Attachments');
    expect(md).toContain('### Trade scouting by archetype');
    expect(md).toContain('Integrity: no invariant violation');
  });
});
