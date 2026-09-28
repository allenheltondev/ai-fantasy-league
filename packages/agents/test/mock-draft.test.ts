import { activeRosterSize, unfilledStarterSlots, type Position } from '@fantasy/core';
import { fixtureDraftPool, handleLeagueEvent, type RecordedEvent } from '@fantasy/server';
import { describe, expect, it } from 'vitest';
import type { AgentActionRequested } from '../src/events.js';
import { ScriptedModelClient } from '../src/fake-model.js';
import { routeEvent } from '../src/router.js';
import { runAgentAction } from '../src/runner.js';
import { defaultTaskKinds } from '../src/tasks/index.js';
import { draftSetup } from './draft-support.js';

/**
 * Milestone #50: a full 8-team mock draft. Allen (a human stand-in on seat 1) drafts through the
 * API against seven agents on the fake model, which the real trigger router and task runner drive
 * from the draft's own events. Allen lets his round-2 clock run out, so the pick-clock handler
 * autopicks for him. The league starts mid-season: it is Wednesday of 2026 week 4.
 */

interface Board {
  onTheClock: { overall: number; teamId: string } | null;
  yourNeeds: string[];
  bestAvailable: { player: { id: string } }[];
}

const position = (id: string) => fixtureDraftPool.find((p) => p.id === id)?.position as Position;

describe('mock draft: Allen vs. seven agents', () => {
  it('drafts every round to valid rosters, nobody twice, and starts the season', async () => {
    const s = await draftSetup({ teamCount: 8, start: '2026-09-30T12:00:00.000Z' });
    const model = new ScriptedModelClient();
    const deps = s.deps(model);
    const records: { status: string; teamId: string }[] = [];
    let seen = 0;
    let expired = 0;

    const allenPicks = async (turn: RecordedEvent) => {
      if (turn.detail.round === 2) {
        // Allen walks away: the clock runs out and the deadline handler autopicks for him.
        s.clock.set(new Date(new Date(turn.detail.deadline as string).getTime() + 1000));
        const handled = await handleLeagueEvent(s.services, {
          id: `deadline-${String(turn.detail.pick)}`,
          source: 'fantasy',
          'detail-type': 'Draft Pick Deadline',
          detail: { leagueId: s.leagueId, pick: turn.detail.pick }
        });
        expect(handled).toEqual({ handled: true, outcome: 'autopicked' });
        expired++;
        return;
      }
      const board = await s.run('get_draft_board', { leagueId: s.leagueId });
      if ('error' in board) throw new Error(board.error.message);
      const b = board.data as Board;
      let pick = await s.run('make_draft_pick', {
        leagueId: s.leagueId,
        playerId: b.bestAvailable[0]?.player.id,
        pick: turn.detail.pick
      });
      if ('error' in pick && pick.error.code === 'ROSTER_WOULD_BE_INVALID') {
        // Allen reads the fix and drafts for an empty starting slot instead.
        const need = await s.run('get_draft_board', {
          leagueId: s.leagueId,
          position: b.yourNeeds[0] === 'W/R/T' ? 'WR' : b.yourNeeds[0]
        });
        if ('error' in need) throw new Error(need.error.message);
        pick = await s.run('make_draft_pick', {
          leagueId: s.leagueId,
          playerId: (need.data as Board).bestAvailable[0]?.player.id,
          pick: turn.detail.pick
        });
      }
      if ('error' in pick) throw new Error(`${pick.error.code}: ${pick.error.message}`);
    };

    for (let guard = 0; guard < 2000; guard++) {
      const next = s.events.events[seen];
      if (next === undefined) break;
      seen++;
      if (next.detailType !== 'Draft Turn Started') continue;
      s.clock.advance(5000);
      if (next.detail.teamId === 'team-1') {
        await allenPicks(next);
        continue;
      }
      const decisions = await routeEvent(
        { services: s.services, kinds: defaultTaskKinds },
        {
          id: `turn-${String(next.detail.pick)}`,
          source: 'fantasy',
          'detail-type': next.detailType,
          detail: next.detail
        }
      );
      expect(decisions).toEqual([expect.objectContaining({ decision: 'requested', kind: 'draft_pick' })]);
      const request = s.events.events.filter((e) => e.detailType === 'Agent Action Requested').at(-1);
      const record = await runAgentAction(deps, request?.detail as unknown as AgentActionRequested);
      records.push({ status: record.status, teamId: record.teamId });
    }

    const draft = await s.repos.drafts.get(s.leagueId);
    const league = await s.repos.leagues.get(s.leagueId);
    expect(draft?.status).toBe('complete');
    expect(league).toMatchObject({ phase: 'regular_season', week: 4 });
    expect(league?.settings.schedule.startWeek).toBe(4);

    const ids = draft!.state.picks.map((p) => p.playerId);
    expect(ids).toHaveLength(8 * activeRosterSize(league!.settings));
    expect(new Set(ids).size).toBe(ids.length);
    const teams = await s.repos.teams.list(s.leagueId);
    expect(teams).toHaveLength(8);
    for (const team of teams) {
      expect(team.roster, team.id).toHaveLength(activeRosterSize(league!.settings));
      expect(
        unfilledStarterSlots(
          league!.settings,
          team.roster.map((id) => [position(id)])
        ),
        team.id
      ).toEqual([]);
    }

    expect(expired).toBe(1);
    expect(draft!.state.picks.filter((p) => p.auto).map((p) => [p.teamId, p.round])).toEqual([['team-1', 2]]);
    expect(records).toHaveLength(7 * 16);
    expect(records.every((r) => r.status === 'completed' || r.status === 'fallback')).toBe(true);
    expect(new Set(records.map((r) => r.teamId)).size).toBe(7);
    expect(model.transcript.length).toBeGreaterThan(0);
    expect(s.events.events.filter((e) => e.detailType === 'Draft Completed')).toHaveLength(1);
    expect(await s.repos.agents.listTasks(s.leagueId, { teamId: 'team-5', limit: 50 })).toHaveLength(16);
  });
});
