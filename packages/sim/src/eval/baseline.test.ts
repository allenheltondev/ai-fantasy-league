import { describe, expect, it } from 'vitest';
import type { TradeRecord } from '@fantasy/server';
import { fixtureArchive } from '../../test/helpers.js';
import type { AcceptanceRun } from '../acceptance/trade-interest.js';
import {
  ACCEPTANCE_MANAGERS,
  BASELINE_CONFIGS,
  ablationsOf,
  baselineInvariantBreaches,
  duplicateOffers,
  metricRow,
  renderBaselineReport,
  runBaseline,
  type AcceptanceMetrics,
  type BaselineReport,
  type SeasonMetrics
} from './baseline.js';

/**
 * The baseline's plumbing with stand-in runs (the real replays run in `baseline.<config>.test.ts`):
 * configurations, invariants, duplicate detection, and the report.
 */

const season = (over: Partial<SeasonMetrics> = {}): SeasonMetrics => ({
  config: 'full',
  seed: 's1',
  agents: 7,
  adds: 10,
  drops: 10,
  tradesProcessed: 1,
  invalidActions: 0,
  offersSent: 4,
  offersAccepted: 1,
  agentMessages: 70,
  maxAgentPerDay: 3,
  leagueMaxPerDay: 20,
  modelCalls: 500,
  inputTokens: 700_000,
  outputTokens: 15_000,
  costUsd: 1.05,
  questions: 3,
  unansweredQuestions: 0,
  repeatedLines: 20,
  duplicateReplies: 0,
  duplicateOffers: 0,
  violations: 0,
  loopFailures: 0,
  byArchetype: { balanced: { agents: 1, offers: 1, adds: 2, messages: 10 } },
  ...over
});

const acceptance = (over: Partial<AcceptanceMetrics> = {}): AcceptanceMetrics => ({
  config: 'full',
  archetype: 'balanced',
  checksPassed: 7,
  checksTotal: 7,
  failed: [],
  profile: { archetype: 'balanced', bar: 1, marginal: 'offer_sent', offersSent: 2, offersAccepted: 1 },
  modelCalls: 14,
  costUsd: 0.07,
  ...over
});

function trade(id: string, proposedAt: string, closed: string | null, sends = ['a']): TradeRecord {
  return {
    trade: {
      tradeId: id,
      status: closed === null ? 'proposed' : 'rejected',
      proposedAt,
      sides: [
        { teamId: 'team-2', sends, drops: [] },
        { teamId: 'team-1', sends: ['b'], drops: [] }
      ],
      history: [
        { status: 'proposed', at: proposedAt, byTeamId: 'team-2' },
        ...(closed === null ? [] : [{ status: 'rejected', at: closed, byTeamId: 'team-1' }])
      ]
    }
  } as unknown as TradeRecord;
}

describe('the epic #219 baseline plumbing', () => {
  it('matches every configuration to its ablations, production first', () => {
    expect(BASELINE_CONFIGS).toEqual([
      'full',
      'no_agenda_commitments',
      'no_situation',
      'no_attachments',
      'no_social_acts'
    ]);
    expect(ablationsOf('full')).toEqual([]);
    expect(ablationsOf('no_situation')).toEqual(['no_situation']);
  });

  it('counts an offer as a duplicate only while the same swap is still open', () => {
    const agents = new Set(['team-2']);
    const open = trade('t1', '2026-01-01T00:00:00Z', null);
    const again = trade('t2', '2026-01-02T00:00:00Z', null);
    expect(duplicateOffers([open, again], agents)).toBe(1);
    const closed = trade('t1', '2026-01-01T00:00:00Z', '2026-01-01T12:00:00Z');
    expect(duplicateOffers([closed, again], agents)).toBe(0);
    expect(duplicateOffers([open, trade('t3', '2026-01-02T00:00:00Z', null, ['c'])], agents)).toBe(0);
    expect(duplicateOffers([open, again], new Set())).toBe(0);
  });

  it('names every broken invariant', () => {
    expect(baselineInvariantBreaches(season())).toEqual([]);
    expect(
      baselineInvariantBreaches(
        season({
          maxAgentPerDay: 99,
          leagueMaxPerDay: 999,
          invalidActions: 1,
          duplicateOffers: 1,
          duplicateReplies: 1,
          violations: 1,
          loopFailures: 1
        })
      )
    ).toHaveLength(7);
  });

  it('runs configurations over seeds (seeds outer), then the acceptance scenario per configuration', async () => {
    const calls: string[] = [];
    const lines: string[] = [];
    const report = await runBaseline({
      archive: await fixtureArchive(),
      seeds: ['s1'],
      configs: ['full', 'no_situation'],
      seasons: false,
      log: (l) => lines.push(l),
      runAcceptance: (options) => {
        calls.push(`${options.config.archetype}:${(options.ablations ?? []).join()}`);
        return Promise.reject(new Error('stop'));
      }
    }).catch((e: Error) => e.message);
    expect(report).toBe('stop');
    expect(calls).toEqual(['balanced:']);
    expect(lines).toEqual([]);
    expect(ACCEPTANCE_MANAGERS.map((m) => m.archetype)).toEqual([
      'balanced',
      'analytics_only',
      'trade_happy'
    ]);
  });

  it('runs the season layer through the given runner with matched options', async () => {
    const seen: unknown[] = [];
    const lines: string[] = [];
    await runBaseline({
      archive: await fixtureArchive(),
      seeds: ['s1', 's2'],
      configs: ['no_attachments'],
      log: (l) => lines.push(l),
      runScenario: (options) => {
        seen.push([options.seed, options.ablations, options.weeks, options.jobCadences?.ingestStats]);
        return Promise.reject(new Error('stop'));
      },
      runAcceptance: () => Promise.resolve({} as AcceptanceRun)
    }).catch(() => undefined);
    expect(seen).toEqual([['s1', ['no_attachments'], 3, 'rate(30 minutes)']]);
    expect(lines).toEqual(['season no_attachments / s1']);
  });

  it('renders a table per metric with the change from full, and the acceptance layer', () => {
    const report: BaselineReport = {
      seeds: ['s1', 's2'],
      weeks: 3,
      configs: ['full', 'no_situation'],
      season: [
        season(),
        season({
          seed: 's2',
          adds: 12,
          costUsd: 1.1,
          byArchetype: {
            balanced: { agents: 2, offers: 0.5, adds: 3, messages: 12 },
            analytics_only: { agents: 1, offers: 0, adds: 1, messages: 5 }
          }
        }),
        season({ config: 'no_situation', adds: 9 }),
        season({ config: 'no_situation', seed: 's2', adds: 9 })
      ],
      acceptance: [
        acceptance(),
        acceptance({
          archetype: 'analytics_only',
          profile: {
            archetype: 'analytics_only',
            bar: 2,
            marginal: 'value_below_floor',
            offersSent: 1,
            offersAccepted: 1
          }
        }),
        acceptance({ archetype: 'trade_happy' }),
        acceptance({ config: 'no_situation', checksPassed: 6, failed: ['reconsidered'] })
      ]
    };
    expect(metricRow(report, 'full', 'adds')).toBe('11 (—; 10 / 12)');
    expect(metricRow(report, 'no_situation', 'adds')).toBe('9 (-2; 9 / 9)');
    expect(metricRow(report, 'no_situation', 'costUsd')).toBe('1.1 (-0.025; 1.1 / 1.1)');
    const markdown = renderBaselineReport(report);
    expect(markdown).toContain('#### Roster churn (agents)');
    expect(markdown).toContain('| full | 11 (—; 10 / 12) |');
    // Weighted by agents: (1×1 + 0.5×2) / 3 offers, (2 + 6) / 3 adds, (10 + 24) / 3 messages.
    expect(markdown).toContain('| full | analytics_only 0 / 1 / 5 (n 1); balanced 0.67 / 2.7 / 11.3 (n 3) |');
    expect(markdown).toContain(
      '| full | 7/7 (offer_sent, 2 offers) | 7/7 (value_below_floor, 1 offers) | 7/7 (offer_sent, 2 offers) | differ | none |'
    );
    expect(markdown).toContain('| no_situation | 6/7 (offer_sent, 2 offers) | – | – | same | reconsidered |');
    // Acceptance only: no season tables.
    expect(renderBaselineReport({ ...report, season: [] })).not.toContain('Roster churn');
    expect(metricRow({ ...report, season: [] }, 'full', 'adds')).toBe('0 (—; )');
  });
});
