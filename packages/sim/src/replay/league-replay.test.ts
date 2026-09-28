import { describe, expect, it } from 'vitest';
import { fixtureArchive } from '../../test/helpers.js';
import { replayLeague } from './league-replay.js';
import { renderLeagueReport } from './report.js';

describe('replayLeague: the real league on the simulated clock', () => {
  it('drafts, plays, and finishes a 3-week season with 7 agents and the human stand-in', async () => {
    const lines: string[] = [];
    const report = await replayLeague({
      archive: await fixtureArchive(),
      seed: 'ci',
      weeks: 3,
      log: (l) => lines.push(l)
    });
    (await import('node:fs')).writeFileSync('/tmp/claude-0/-home-user-ai-fantasy-league/4cb70630-7c51-5a61-8a44-e8115b19243d/scratchpad/ws60/r.md', renderLeagueReport(report) + JSON.stringify({ events: report.events, lines, decisions: report.decisions, human: report.human, tx: report.transactions, agents: report.agents.totals }, null, 1));
    expect(report.events.failures).toEqual([]);
    expect(report.violations).toEqual([]);
  });
});
