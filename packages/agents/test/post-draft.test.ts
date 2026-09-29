import { DEFAULT_ROOM_ID } from '@fantasy/core';
import {
  EventLoop,
  createRegistry,
  fixtureDraftPool,
  operations,
  silentLogger,
  type EventSubscriber
} from '@fantasy/server';
import type { AgentActionRequested } from '../src/events.js';
import { describe, expect, it } from 'vitest';
import { ScriptedModelClient } from '../src/fake-model.js';
import type { KillSwitch } from '../src/kill-switch.js';
import { agentSubscribers, inProcessAgentDeps } from '../src/loop.js';
import { POST_DRAFT_KICKOFF, routeEvent } from '../src/router.js';
import { runAgentAction } from '../src/runner.js';
import { CHAT_TOOLS } from '../src/tasks/chat.js';
import { draftFacts, draftReactionLine, managerName, renderDraftFacts } from '../src/tasks/post-draft.js';
import { draftSetup, type DraftSetup } from './draft-support.js';

const START = '2026-09-30T12:00:00.000Z';
const AGENTS = ['team-2', 'team-3', 'team-4'];
const SEATS = {
  'team-2': { personalityId: 'hype-man', difficulty: 'pro', archetype: 'trade_happy' },
  'team-3': { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'balanced' },
  'team-4': { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'waiver_hawk' }
} as const;

/** Allen (team-1) fills his first empty starting slot with the best player there. */
function allen(s: DraftSetup): EventSubscriber {
  return {
    name: 'allen',
    detailTypes: ['Draft Turn Started'],
    handle: async (e) => {
      const d = e.detail as { teamId: string; pick: number };
      if (d.teamId !== 'team-1') return;
      const board = await s.run('get_draft_board', { leagueId: s.leagueId, limit: 40 });
      if ('error' in board) throw new Error(board.error.message);
      const draft = board.data as {
        yourNeeds: string[];
        bestAvailable: { player: { id: string; position: string } }[];
      };
      const need = new Set(draft.yourNeeds.flatMap((n) => (n === 'W/R/T' ? ['RB', 'WR', 'TE'] : [n])));
      const pick = draft.bestAvailable.find((c) => need.has(c.player.position)) ?? draft.bestAvailable[0];
      await s.run('make_draft_pick', { leagueId: s.leagueId, playerId: pick?.player.id, pick: d.pick });
    }
  };
}

/** A four-team league (Allen and three agents) drafted to the end in the event loop. */
async function drafted(options: { killSwitch?: KillSwitch } = {}) {
  const s = await draftSetup({
    teamCount: 4,
    start: START,
    beforeStart: async (d) => {
      for (const [teamId, seat] of Object.entries(SEATS)) {
        const res = await d.run('configure_agent_seat', { leagueId: d.leagueId, teamId, ...seat });
        if ('error' in res) throw new Error(JSON.stringify(res.error));
      }
    }
  });
  const model = new ScriptedModelClient();
  const deps = inProcessAgentDeps(s.services, model, {
    modelTimeoutMs: 5000,
    ...(options.killSwitch === undefined ? {} : { killSwitch: options.killSwitch })
  });
  const loop = new EventLoop({
    publisher: s.events,
    clock: { now: () => s.clock.now(), advanceTo: (at: Date) => s.clock.set(at) },
    subscribers: [...agentSubscribers(deps), allen(s)],
    log: silentLogger
  });
  await loop.drain();
  expect((await s.repos.drafts.get(s.leagueId))?.status).toBe('complete');
  const draftModelCalls = model.transcript.length;
  const tasks = async (kind: string) =>
    (await s.repos.agents.listTasks(s.leagueId, { limit: 500 })).filter((t) => t.kind === kind);
  const reactions = async () =>
    (await s.repos.chat.list(s.leagueId, DEFAULT_ROOM_ID, { limit: 100 })).messages.filter(
      (m) => m.kind === 'agent'
    );
  return { s, model, deps, loop, draftModelCalls, tasks, reactions };
}

/** Puts one of the team's drafted kickers on IR, so its kicker slot is a hole. */
async function injureKicker(s: DraftSetup, teamId: string): Promise<string> {
  const team = await s.repos.teams.get(s.leagueId, teamId);
  const kicker = fixtureDraftPool.find((p) => p.position === 'K' && team?.roster.includes(p.id));
  if (kicker === undefined) throw new Error(`${teamId} drafted no kicker`);
  await s.repos.players.putMany([{ ...kicker, injuryStatus: 'IR' }]);
  return kicker.id;
}

describe('post-draft kickoff', () => {
  it('staggers one kickoff per agent after the draft, and never twice for one draft', async () => {
    const { s, loop } = await drafted();
    const kickoffs = loop.scheduled.filter((e) => e.detailType === 'Agent Action Requested');
    expect(kickoffs).toHaveLength(AGENTS.length);
    const at = kickoffs.map((k) => Date.parse(k.at) - s.clock.now().getTime());
    expect(at).toEqual(AGENTS.map((_, i) => POST_DRAFT_KICKOFF.firstMs + i * POST_DRAFT_KICKOFF.spacingMs));
    // Nothing runs on top of the last pick: no kickoff task was delivered yet.
    expect(await s.repos.agents.listTasks(s.leagueId, { limit: 500 })).not.toContainEqual(
      expect.objectContaining({ kind: 'post_draft' })
    );

    // A replayed Draft Completed (a redelivery, the stalled-draft watchdog) is a repeat.
    const completed = s.events.events.find((e) => e.detailType === 'Draft Completed');
    const replay = await routeEvent(
      { services: s.services, kinds: inProcessAgentDeps(s.services, new ScriptedModelClient()).router.kinds },
      { id: 'evt-replay', 'detail-type': 'Draft Completed', source: 'fantasy', detail: completed?.detail }
    );
    expect(replay.map((d) => d.decision)).toEqual(['repeat', 'repeat', 'repeat']);
  });

  it('sets lineups, posts one grounded reaction per agent, fills a hole, and sends the trader shopping', async () => {
    const { s, loop, model, draftModelCalls, tasks, reactions } = await drafted();
    const injured = await injureKicker(s, 'team-4');
    await loop.runUntil(new Date(s.clock.now().getTime() + 10 * 60_000));
    expect(loop.stats.failures).toEqual([]);

    const kickoffs = await tasks('post_draft');
    expect(kickoffs.map((t) => t.teamId).sort()).toEqual(AGENTS);
    expect(kickoffs.every((t) => t.status === 'completed')).toBe(true);

    // 1. Every agent saved a lineup for the first week.
    const league = await s.repos.leagues.get(s.leagueId);
    for (const teamId of AGENTS) {
      const lineup = await s.repos.lineups.get(s.leagueId, teamId, league?.week ?? 0);
      expect(lineup?.updatedBy, teamId).toMatch(/^agent#/);
    }

    // 2. One reaction per agent, about its own real picks, by the one chat model call per agent.
    const posted = await reactions();
    expect(posted.map((m) => m.author.teamId).sort()).toEqual(AGENTS);
    const board = await s.run('get_draft_board', { leagueId: s.leagueId, limit: 1 });
    if ('error' in board) throw new Error(board.error.message);
    const picks = (board.data as { picks: { teamId: string; player: { name: string } }[] }).picks;
    for (const m of posted) {
      expect(m.text).toMatch(/^Grading my own draft: [A-F]\.|^Draft done/);
      const own = picks.filter((p) => p.teamId === m.author.teamId).map((p) => p.player.name);
      expect(
        own.some((name) => m.text.includes(name)),
        m.text
      ).toBe(true);
    }

    // The reaction gets what its instructions promise: the read-only lookups and who's who.
    const reactionRuns = model.transcript.filter((t) => t.systemPrompt.includes('The draft just ended.'));
    expect(reactionRuns).toHaveLength(AGENTS.length);
    for (const run of reactionRuns) {
      expect(run.toolNames.length).toBeGreaterThan(0);
      expect(run.toolNames.every((n) => (CHAT_TOOLS as readonly string[]).includes(n))).toBe(true);
      expect(run.systemPrompt).toContain("Who's who (tag a team with @ and its name):");
    }

    // 3. The agent whose kicker went on IR claimed a healthy kicker; the others needed nothing.
    const claims = await s.repos.waivers.listClaims(s.leagueId, 'pending');
    const team4 = await s.repos.teams.get(s.leagueId, 'team-4');
    const kickers = fixtureDraftPool.filter((p) => p.position === 'K').map((p) => p.id);
    const added =
      claims.find((c) => c.teamId === 'team-4')?.addPlayerId ??
      team4?.roster.find((id) => kickers.includes(id) && id !== injured);
    expect(added).toBeDefined();
    expect(kickers).toContain(added);
    expect(claims.filter((c) => c.teamId !== 'team-4')).toEqual([]);

    // 4. Only the trade-happy agent took an early trade look, with at most one offer.
    const looks = await tasks('trade_proposal');
    expect(looks.map((t) => [t.teamId, t.trigger.detailType])).toEqual([['team-2', 'Draft Completed']]);
    expect((await s.repos.trades.list(s.leagueId)).length).toBeLessThanOrEqual(1);

    // Model calls: one chat reaction each, plus the trade look (if it found a candidate).
    const kickoffCalls = model.transcript.length - draftModelCalls;
    expect(kickoffCalls).toBeGreaterThanOrEqual(AGENTS.length);
    expect(kickoffCalls).toBeLessThanOrEqual(AGENTS.length + 1);
  });

  it('keeps the deterministic steps and stays quiet with the kill switch on', async () => {
    const engaged = { engaged: async () => true };
    const { s, loop, tasks, reactions } = await drafted({ killSwitch: engaged });
    await loop.runUntil(new Date(s.clock.now().getTime() + 10 * 60_000));
    expect(loop.stats.failures).toEqual([]);
    const kickoffs = await tasks('post_draft');
    expect(kickoffs.map((t) => [t.status, t.fallbackReason])).toEqual(
      AGENTS.map(() => ['fallback', 'kill_switch'])
    );
    expect(kickoffs.every((t) => t.reasoningSummary.includes('Lineup:'))).toBe(true);
    expect(await reactions()).toEqual([]);
    expect(await tasks('trade_proposal')).toEqual([]);
  });
});

describe('post_draft task', () => {
  const kickoff = (s: DraftSetup, teamId = 'team-2'): AgentActionRequested => ({
    taskId: `post_draft.${teamId}`,
    leagueId: s.leagueId,
    teamId,
    agentId: `${s.leagueId}.${teamId}`,
    kind: 'post_draft',
    trigger: { detailType: 'Draft Completed', eventId: 'evt-done', urgent: true },
    payload: {},
    requestedAt: s.clock.now().toISOString()
  });
  const without = (...names: string[]) => createRegistry(operations.filter((op) => !names.includes(op.name)));

  it('does nothing before the draft is complete, or when the board cannot be read', async () => {
    const s = await draftSetup({ teamCount: 4, start: START });
    const deps = s.deps(new ScriptedModelClient());
    expect(await runAgentAction(deps, kickoff(s))).toMatchObject({
      status: 'skipped',
      fallbackReason: 'draft_not_complete'
    });
    expect(
      await runAgentAction({ ...deps, registry: without('get_draft_board') }, { ...kickoff(s), taskId: 'x2' })
    ).toMatchObject({ status: 'skipped', fallbackReason: 'get_draft_board failed: FORBIDDEN' });
  });

  it('goes on without a roster or a chat room: no lineup, no claims, and nothing said', async () => {
    const { s } = await drafted();
    const model = new ScriptedModelClient();
    const record = await runAgentAction(
      { ...s.deps(model), registry: without('get_roster', 'list_chat_rooms') },
      kickoff(s, 'team-3')
    );
    expect(record).toMatchObject({ status: 'completed', finalAction: 'post_draft' });
    expect(record.reasoningSummary).toBe(
      'Lineup: Not set: get_roster failed: FORBIDDEN The tool "get_roster" is not available to you. Chat: Stayed quiet (list_chat_rooms failed: FORBIDDEN). Waivers: No roster holes.'
    );
    expect(model.transcript[0]?.systemPrompt).toContain('You cannot post in the chat right now');
    expect(await s.repos.waivers.listClaims(s.leagueId, 'pending')).toEqual([]);
  });
});

describe('draft reaction facts', () => {
  const teams = [
    { id: 't1', name: 'Big Tuna', ownerName: 'Allen', manager: null },
    { id: 't2', name: 'Robo Ballers', ownerName: null, manager: { name: 'Marcus Hale' } },
    { id: 't3', name: 'Open Seat', ownerName: null }
  ];
  const pick = (
    overall: number,
    round: number,
    teamId: string,
    name: string,
    position: string,
    adp: number | null
  ) => ({
    overall,
    round,
    teamId,
    player: { id: name.toLowerCase(), name, position },
    adp
  });
  const board = {
    status: 'complete',
    order: [{ teamId: 't1' }, { teamId: 't2' }, { teamId: 't3' }],
    picks: [
      pick(1, 1, 't1', 'Alpha', 'RB', 1),
      pick(2, 1, 't2', 'Bravo', 'WR', 20),
      pick(3, 1, 't3', 'Charlie', 'QB', 3),
      pick(4, 2, 't3', 'Delta', 'RB', 30),
      pick(5, 2, 't2', 'Echo', 'TE', 1),
      pick(6, 2, 't1', 'Foxtrot', 'K', null)
    ],
    recap: { steals: [{ overall: 5 }], reaches: [{ overall: 2 }, { overall: 4 }] }
  };

  it('names managers by their manager names and uses only real picks', () => {
    expect(managerName(teams[1], 't2')).toBe('Marcus Hale');
    expect(managerName(teams[0], 't1')).toBe('Allen');
    expect(managerName(teams[2], 't3')).toBe('Open Seat');
    expect(managerName(undefined, 't9')).toBe('t9');

    const facts = draftFacts(board, teams, 't3');
    expect(facts.grade).toBe('F');
    expect(facts.yourEarly.map((p) => p.player)).toEqual(['Charlie', 'Delta']);
    expect(facts.yourSteal).toBeNull();
    expect(facts.steals.map((p) => [p.manager, p.player, p.value])).toEqual([['Marcus Hale', 'Echo', 4]]);
    // Your own reach is not someone else's to needle.
    expect(facts.reaches.map((p) => [p.manager, p.player, p.round])).toEqual([['Marcus Hale', 'Bravo', 1]]);

    const lines = renderDraftFacts(facts);
    expect(lines[0]).toBe('Your draft grade by ADP value: F.');
    expect(lines.join('\n')).toContain(
      "Other managers' reaches: Marcus Hale (Robo Ballers) took Bravo (WR) in round 1, pick 2 (ADP 20, 18 picks before his ADP)."
    );
    expect(draftReactionLine(facts)).toBe(
      'Grading my own draft: F. Charlie in round 1 anchors this team. Marcus Hale, Bravo at pick 2? Bold. I respect it. A little.'
    );
  });

  it('brags about the best steal, and grades nothing without ranked picks', () => {
    const mine = draftFacts(
      {
        ...board,
        picks: [...board.picks, pick(8, 3, 't2', 'Golf', 'RB', 1), pick(9, 3, 't9', 'Hotel', 'WR', 1)]
      },
      teams,
      't2'
    );
    // Two steals: the bigger one is the brag; a pick by a team the league no longer lists keeps its id.
    expect(mine.yourSteal).toMatchObject({ player: 'Golf', round: 3, value: 7 });
    expect(renderDraftFacts(mine)).toContain(
      'Your best value: Golf (RB) in round 3, pick 8 (ADP 1, 7 picks after his ADP).'
    );
    expect(
      draftFacts(
        {
          ...board,
          picks: [...board.picks, pick(9, 3, 't9', 'Hotel', 'WR', 1)],
          recap: { steals: [{ overall: 9 }], reaches: [] }
        },
        teams,
        't2'
      ).steals
    ).toEqual([expect.objectContaining({ manager: 't9', team: 't9' })]);
    expect(mine.reaches.map((p) => p.manager)).toEqual(['Open Seat']);
    expect(draftReactionLine(mine)).toContain('Golf in round 3 (ADP 1)? Robbery.');
    const unranked = draftFacts(
      { ...board, picks: [pick(6, 2, 't1', 'Foxtrot', 'K', null)], recap: null },
      teams,
      't1'
    );
    expect(unranked.grade).toBeNull();
    expect(renderDraftFacts(unranked)[0]).toContain('not enough ranked picks');
    expect(renderDraftFacts(unranked)[1]).toContain('Foxtrot (K) in round 2, pick 6 (unranked)');
    expect(draftReactionLine(unranked)).toBe(
      'Draft done and I like my squad. Foxtrot in round 2 anchors this team.'
    );
    expect(draftReactionLine({ ...unranked, yourEarly: [] })).toBe('Draft done and I like my squad.');
  });
});
