import { seasonWindow, yahooDefaultSettings, type Difficulty } from '@fantasy/core';
import { fixtureDraftPool, type Player } from '@fantasy/server';
import { describe, expect, it } from 'vitest';
import { ScriptedModelClient } from '../src/fake-model.js';
import { runAgentAction } from '../src/runner.js';
import { draftIntel, nextTurnLine, rosterSummary, runLine, seasonLine } from '../src/tasks/draft.js';
import { draftSetup, type DraftSetup } from './draft-support.js';

/**
 * Draft context (issue #135): what the draft prompt shows beyond the ranked list, per difficulty,
 * and how bye weeks and injuries bend agent autopick.
 */

/** team-2 is the agent under test and picks 1, 8, 9, 16; Allen (team-1) picks 2, 7, 10, 15. */
const ORDER = ['team-2', 'team-1', 'team-3', 'team-4'];
const FULL = seasonWindow({ startWeek: 1, regularSeasonEndWeek: 15 }, null);
const settings = yahooDefaultSettings(4);

async function league(
  difficulty: Difficulty,
  options: { start?: string; players?: readonly Player[]; archetype?: string } = {}
): Promise<DraftSetup> {
  return draftSetup({
    order: ORDER,
    ...(options.start === undefined ? {} : { start: options.start }),
    ...(options.players === undefined ? {} : { players: options.players }),
    beforeStart: async (s) => {
      const res = await s.run('configure_agent_seat', {
        leagueId: s.leagueId,
        teamId: 'team-2',
        personalityId: 'stats-nerd',
        difficulty,
        archetype: options.archetype ?? 'balanced'
      });
      if ('error' in res) throw new Error(JSON.stringify(res.error));
    }
  });
}

/**
 * Drafts until team-2 is on the clock at `pick` (every other team takes the best available player
 * through the API), then runs team-2's task on `model` and returns the prompt it saw.
 */
async function promptAt(
  s: DraftSetup,
  pick: number,
  model = new ScriptedModelClient(),
  before?: () => Promise<void>
): Promise<string> {
  for (let guard = 0; guard < 40; guard++) {
    const req = s.turnRequest();
    if (req.payload.pick === pick) {
      await before?.();
      const record = await runAgentAction(s.deps(model), req);
      expect(record.status).not.toBe('failed');
      return model.transcript.at(-1)?.systemPrompt ?? '';
    }
    const board = await s.run('get_draft_board', { leagueId: s.leagueId });
    if ('error' in board) throw new Error(board.error.message);
    const best = (board.data as { bestAvailable: { player: { id: string } }[] }).bestAvailable[0];
    if (req.teamId === 'team-1') {
      await s.run('make_draft_pick', {
        leagueId: s.leagueId,
        playerId: best?.player.id,
        pick: req.payload.pick
      });
    } else {
      await runAgentAction(s.deps(new ScriptedModelClient()), req);
    }
  }
  throw new Error(`never reached pick ${pick}`);
}

function taskPart(prompt: string): string {
  return prompt.slice(prompt.indexOf('You are on the clock'));
}

/** A bye week (5-14) for every NFL team in the fixture pool. */
const EVERY_TEAM_BYE: Record<string, number> = Object.fromEntries(
  [...new Set(fixtureDraftPool.flatMap((p) => (p.team === null ? [] : [p.team])))].map((team, i) => [
    team,
    5 + (i % 10)
  ])
);

async function putByes(s: DraftSetup, byes: Record<string, number>) {
  await s.services.data.reference.schedule.putSeason(2026, [], byes, s.clock.now());
}

async function picked(s: DraftSetup, overall: number): Promise<string | undefined> {
  return (await s.repos.drafts.get(s.leagueId))?.state.picks.find((p) => p.overall === overall)?.playerId;
}

describe('draft prompt context by difficulty', () => {
  it('rookies see roster, byes and injuries; amateurs add runs; pros add the next-turn outlook', async () => {
    const prompts: Record<string, string> = {};
    for (const difficulty of ['rookie', 'amateur', 'pro', 'hall_of_famer'] as const) {
      const s = await league(difficulty);
      prompts[difficulty] = taskPart(await promptAt(s, 9, undefined, () => putByes(s, EVERY_TEAM_BYE)));
    }
    for (const prompt of Object.values(prompts)) {
      expect(prompt).toMatch(/Your roster \(drafted\/starting slots\): QB \d\/1/);
      expect(prompt).toContain('K 0/1 · DEF 0/1.');
      // Every drafted and listed player shows his bye week.
      const listed = prompt.split('\n').filter((l) => /^\d+\. /.test(l));
      expect(listed).toHaveLength(15);
      for (const line of listed) expect(line).toMatch(/, bye \d+\)/);
      expect(prompt).toMatch(/Your roster .*\([A-Z]+, bye \d+\)/);
      // A week-1 league has no season line.
      expect(prompt).not.toContain('Season:');
      // The list stays at 15 candidates.
      expect(prompt).toMatch(/\n15\. /);
      expect(prompt).not.toMatch(/\n16\. /);
    }
    expect(prompts.rookie).not.toContain('Last ');
    expect(prompts.rookie).not.toContain('Your next pick');
    expect(prompts.amateur).toMatch(/Last 8 picks: (\d [A-Z]+(, )?)+\./);
    expect(prompts.amateur).not.toContain('Your next pick');
    for (const d of ['pro', 'hall_of_famer']) {
      expect(prompts[d]).toContain('Last 8 picks:');
      expect(prompts[d]).toMatch(
        /Your next pick is 6 picks after this one\. (Likely gone by then: .+|Your top candidates should still be there)\./
      );
    }
    expect(prompts.rookie!.length).toBeLessThan(prompts.pro!.length);
  });

  it('follows the levers, so an Advanced override changes it', () => {
    const levers = (trending: boolean, reasoningEffort: 'low' | 'medium' | 'high') => ({
      research: { projections: true, news: false, trending, matchupOutlook: false },
      reasoningEffort
    });
    expect(draftIntel(levers(false, 'low'))).toEqual({ runs: false, nextTurn: false });
    expect(draftIntel(levers(true, 'low'))).toEqual({ runs: true, nextTurn: false });
    expect(draftIntel(levers(false, 'high'))).toEqual({ runs: false, nextTurn: true });
  });
});

describe('draft prompt lines', () => {
  const p = (id: string, position: 'QB' | 'RB' | 'WR', team: string, bye: number | null) => ({
    id,
    name: id.toUpperCase(),
    team,
    position,
    bye
  });

  it('summarizes the roster by position with depth, flex, and byes', () => {
    expect(rosterSummary([], settings, FULL)).toBe('Your roster: empty.');
    const roster = [
      p('qb', 'QB', 'KC', 10),
      p('rb1', 'RB', 'ATL', 5),
      p('rb2', 'RB', 'NYJ', null),
      p('rb3', 'RB', 'DAL', 7)
    ];
    expect(rosterSummary(roster, settings, FULL)).toBe(
      'Your roster (drafted/starting slots): QB 1/1: QB (KC, bye 10) · RB 3/2+flex: RB1 (ATL, bye 5), RB2 (NYJ), RB3 (DAL, bye 7) · WR 0/3+flex · TE 0/1+flex · K 0/1 · DEF 0/1.'
    );
    // Mid-season, a bye already played says so.
    const mid = seasonWindow({ startWeek: 8, regularSeasonEndWeek: 15 }, 8);
    expect(rosterSummary(roster.slice(0, 2), settings, mid)).toContain('RB1 (ATL, bye 5 played)');
  });

  it('reads runs and the next turn', () => {
    expect(runLine([])).toBeNull();
    expect(
      runLine([
        { position: 'TE', count: 3 },
        { position: 'WR', count: 2 }
      ])
    ).toBe('Last 5 picks: 3 TE, 2 WR.');
    const candidates = [{ player: { id: 'a', name: 'Alpha', team: 'KC', position: 'WR' as const }, rank: 1 }];
    expect(nextTurnLine({ picksBetween: null, likelyGone: [], candidates })).toBe('This is your last pick.');
    expect(nextTurnLine({ picksBetween: 0, likelyGone: [], candidates })).toBe(
      'You pick again right after this. Your top candidates should still be there.'
    );
    expect(nextTurnLine({ picksBetween: 6, likelyGone: ['a', 'zz'], candidates })).toBe(
      'Your next pick is 6 picks after this one. Likely gone by then: Alpha, zz.'
    );
  });

  it('adds season context only for a mid-season league, and urgency only when few weeks remain', () => {
    expect(seasonLine(FULL, null)).toBeNull();
    const early = seasonLine(seasonWindow({ startWeek: 4, regularSeasonEndWeek: 15 }, null), null);
    expect(early).toBe(
      'Season: you play weeks 4-15, 12 regular-season week(s) left, so an injured player costs weeks that count.'
    );
    const late = seasonLine(seasonWindow({ startWeek: 10, regularSeasonEndWeek: 15 }, 11), 11);
    expect(late).toContain('you play weeks 11-15 (NFL week 11 now), 5 regular-season week(s) left');
    expect(late).toContain('favour healthy players producing now over long-term upside');
  });
});

describe('mid-season drafts', () => {
  /** The top-ranked player, ruled out. */
  const hurt = fixtureDraftPool.map((p) => (p.id === 'fx-chase' ? { ...p, injuryStatus: 'Out' } : p));

  it('shows the season and passes on a player who is out', async () => {
    const s = await league('pro', { start: '2026-11-11T12:00:00.000Z', players: hurt });
    const prompt = taskPart(await promptAt(s, 1));
    expect(prompt).toMatch(/Season: you play weeks 10-15, 6 regular-season week\(s\) left/);
    expect(prompt).toContain('favour healthy players producing now');
    expect(prompt).toContain("Ja'Marr Chase (fx-chase, WR, CIN, rank 1, Out)");
    expect(prompt).not.toMatch(/\n1\. Ja'Marr Chase/);
    // The fake model takes the recommendation: not the injured top-ranked player.
    expect(await picked(s, 1)).not.toBe('fx-chase');
  });

  it('a week-1 draft still takes the injured star', async () => {
    const s = await league('pro', { players: hurt });
    const prompt = taskPart(await promptAt(s, 1));
    expect(prompt).toMatch(/\n1\. Ja'Marr Chase \(fx-chase, WR, CIN, rank 1, Out\)/);
    expect(await picked(s, 1)).toBe('fx-chase');
  });
});

describe('bye weeks in agent autopick', () => {
  it('flags a candidate whose bye matches his position mates on the roster', async () => {
    const s = await league('pro');
    let clash = '';
    const prompt = taskPart(
      await promptAt(s, 8, undefined, async () => {
        const board = await s.run('get_draft_board', { leagueId: s.leagueId, limit: 50 });
        if ('error' in board) throw new Error(board.error.message);
        type Row = { teamId?: string; player: { id: string; name: string; team: string; position: string } };
        const b = board.data as { picks: Row[]; bestAvailable: Row[] };
        const mine = b.picks.find((p) => p.teamId === 'team-2')!.player;
        const rival = b.bestAvailable.find(
          (r) => r.player.position === mine.position && r.player.team !== mine.team
        )!;
        clash = rival.player.name;
        await putByes(s, { [mine.team]: 7, [rival.player.team]: 7 });
      })
    );
    expect(prompt).toMatch(/Your roster \(drafted\/starting slots\): .*\(\w+, bye 7\)/);
    const line = prompt.split('\n').find((l) => /^\d+\. /.test(l) && l.includes(clash)) ?? '';
    expect(line).toContain('bye 7) (bye clash)');
  });
});
