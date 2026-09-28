import { describe, expect, it } from 'vitest';
import { AgentActionRequestedSchema, type BusEvent } from '../src/events.js';
import {
  CHAT_MOMENT_AGENTS,
  detailRosterIndex,
  leagueRosterIndex,
  routeEvent,
  taskIdFor,
  TRIGGER_RULES
} from '../src/router.js';
import { DEFAULT_TASK_KINDS, defaultTaskKinds } from '../src/tasks/index.js';
import { createTaskKindRegistry, type TaskKind } from '../src/tasks/kinds.js';
import { noopTask } from '../src/tasks/noop.js';
import { LEAGUE_ID, setup } from './support.js';

const ROOKIE = { personalityId: 'stats-nerd', difficulty: 'rookie', archetype: 'balanced' } as const;
const HOF = { personalityId: 'hype-man', difficulty: 'hall_of_famer', archetype: 'win_now' } as const;

function event(detailType: string, detail: Record<string, unknown>, id = 'evt-1'): BusEvent {
  return { id, 'detail-type': detailType, source: 'fantasy', detail };
}

/** Every trigger kind registered (as no-ops), so the router's mapping can be tested end to end. */
const allKinds = createTaskKindRegistry(
  [...new Set(Object.values(TRIGGER_RULES).map((r) => r.kind))].map((kind): TaskKind => ({
    ...noopTask,
    kind
  }))
);

async function withSeats() {
  const s = await setup();
  await s.seat('team-2', ROOKIE);
  await s.seat('team-3', HOF);
  await s.seat('team-4', HOF);
  const route = (e: BusEvent, kinds = allKinds) => routeEvent({ services: s.services, kinds }, e);
  const requested = () =>
    s.events.events
      .filter((e) => e.detailType === 'Agent Action Requested')
      .map((e) => AgentActionRequestedSchema.parse(e.detail));
  return { ...s, route, requested };
}

describe('routeEvent', () => {
  it('sends a draft turn only to the agent on the clock, and never to humans', async () => {
    const s = await withSeats();
    const decisions = await s.route(
      event('Draft Turn Started', { leagueId: LEAGUE_ID, teamId: 'team-3', pick: 4, round: 1 })
    );
    expect(decisions).toEqual([
      {
        teamId: 'team-3',
        leagueId: LEAGUE_ID,
        decision: 'requested',
        kind: 'draft_pick',
        taskId: taskIdFor('evt-1', 'team-3', 'draft_pick')
      }
    ]);
    expect(s.requested()[0]).toMatchObject({
      agentId: `${LEAGUE_ID}.team-3`,
      kind: 'draft_pick',
      trigger: { detailType: 'Draft Turn Started', eventId: 'evt-1', urgent: true },
      payload: { pick: 4, round: 1 }
    });
    expect(
      await s.route(event('Draft Turn Started', { leagueId: LEAGUE_ID, teamId: 'team-1' }, 'evt-2'))
    ).toEqual([]);
    expect(s.logs.some((l) => l.includes('no_agent_teams'))).toBe(true);
  });

  it('sends waiver windows to every agent team, gated by cooldown', async () => {
    const s = await withSeats();
    const first = await s.route(event('Waiver Window Opened', { leagueId: LEAGUE_ID, week: 5 }));
    expect(first.map((d) => [d.teamId, d.decision])).toEqual([
      ['team-2', 'requested'],
      ['team-3', 'requested'],
      ['team-4', 'requested']
    ]);
    s.clock.advance(20 * 60_000);
    const second = await s.route(event('Waiver Window Opened', { leagueId: LEAGUE_ID, week: 5 }, 'evt-2'));
    // Rookie cooldown is 240 minutes, Hall of Famer 15.
    expect(second.map((d) => [d.teamId, d.decision])).toEqual([
      ['team-2', 'cooldown'],
      ['team-3', 'requested'],
      ['team-4', 'requested']
    ]);
  });

  it('lets urgent triggers through a cooldown', async () => {
    const s = await withSeats();
    await s.route(event('Waiver Window Opened', { leagueId: LEAGUE_ID }));
    const decisions = await s.route(
      event(
        'Trade Proposed',
        { leagueId: LEAGUE_ID, tradeId: 't1', toTeamId: 'team-2', fromTeamId: 'team-1' },
        'evt-2'
      )
    );
    expect(decisions).toMatchObject([{ teamId: 'team-2', decision: 'requested', kind: 'trade_response' }]);
    expect(s.requested().at(-1)?.payload).toEqual({ tradeId: 't1', fromTeamId: 'team-1' });
    const countered = await s.route(
      event('Trade Countered', { leagueId: LEAGUE_ID, tradeId: 't1', toTeamId: 'team-4' }, 'evt-3')
    );
    expect(countered).toMatchObject([{ teamId: 'team-4', decision: 'requested' }]);
  });

  it('checks lineups for a lock, for listed teams or all agents', async () => {
    const s = await withSeats();
    const all = await s.route(event('Lineup Lock Approaching', { leagueId: LEAGUE_ID, week: 5 }));
    expect(all.map((d) => d.teamId)).toEqual(['team-2', 'team-3', 'team-4']);
    const listed = await s.route(
      event('Lineup Lock Approaching', { leagueId: LEAGUE_ID, teamIds: ['team-4', 'team-1'] }, 'evt-2')
    );
    expect(listed.map((d) => d.teamId)).toEqual(['team-4']);
    expect(s.requested()[0]?.payload).toEqual({ reason: 'lock', week: 5 });
  });

  it('routes player news only to agents rostering the player', async () => {
    const s = await withSeats();
    const decisions = await s.route(
      event('Player Status Changed', {
        playerId: 'p1',
        status: 'out',
        rosteredBy: [
          { leagueId: LEAGUE_ID, teamId: 'team-3' },
          { leagueId: LEAGUE_ID, teamId: 'team-1' }
        ]
      })
    );
    expect(decisions).toMatchObject([{ teamId: 'team-3', kind: 'lineup', decision: 'requested' }]);
    expect(s.requested()[0]?.payload).toEqual({ reason: 'status', playerId: 'p1' });
    const news = await s.route(
      event(
        'Player News Alert',
        { playerId: 'p1', rosteredBy: [{ leagueId: LEAGUE_ID, teamId: 'team-4' }] },
        'evt-2'
      )
    );
    expect(s.requested()[1]?.payload).toEqual({ reason: 'news', playerId: 'p1' });
    expect(news).toHaveLength(1);
    expect(await s.route(event('Player News Alert', { playerId: 'p1' }, 'evt-3'))).toEqual([]);
    expect(await s.route(event('Player News Alert', {}, 'evt-4'))).toEqual([]);
    expect(await detailRosterIndex.teamsWithPlayer('p', { rosteredBy: 'bad' })).toEqual([]);
  });

  it('finds the teams rostering a player in every in-season league', async () => {
    const s = await withSeats();
    const index = leagueRosterIndex(s.services);
    // The support league is in week 5 of the regular season; team-2 and team-3 roster rb3.
    expect(await index.teamsWithPlayer('rb3', {})).toEqual([
      { leagueId: LEAGUE_ID, teamId: 'team-2' },
      { leagueId: LEAGUE_ID, teamId: 'team-3' }
    ]);
    expect(await index.teamsWithPlayer('nobody', {})).toEqual([]);
    const listed = [{ leagueId: 'lg-x', teamId: 'team-9' }];
    expect(await index.teamsWithPlayer('rb3', { rosteredBy: listed })).toEqual(listed);
    const decisions = await routeEvent(
      { services: s.services, kinds: allKinds, rosterIndex: index },
      event('Player Status Changed', { playerId: 'rb3', status: 'out' }, 'evt-9')
    );
    expect(decisions.map((d) => d.teamId)).toEqual(['team-2', 'team-3']);
  });

  it('answers chat mentions and lets a few agents react to chat moments', async () => {
    const s = await withSeats();
    const mention = await s.route(
      event('Chat Mention', {
        leagueId: LEAGUE_ID,
        mentionedTeamIds: ['team-2', 'team-3', 'team-9'],
        messageId: 'm1'
      })
    );
    expect(mention.map((d) => d.teamId)).toEqual(['team-2', 'team-3']);
    const moment = await s.route(event('Chat Moment', { leagueId: LEAGUE_ID, moment: 'blowout' }, 'evt-2'));
    expect(moment).toHaveLength(CHAT_MOMENT_AGENTS);
    const again = await (
      await withSeats()
    ).route(event('Chat Moment', { leagueId: LEAGUE_ID, moment: 'blowout' }, 'evt-2'));
    expect(again.map((d) => d.teamId)).toEqual(moment.map((d) => d.teamId));
  });

  it('skips triggers whose task kind is not built yet', async () => {
    const s = await withSeats();
    const decisions = await s.route(
      event('Trade Proposed', { leagueId: LEAGUE_ID, toTeamId: 'team-3', tradeId: 't1' }),
      createTaskKindRegistry(DEFAULT_TASK_KINDS.filter((k) => k.kind !== 'trade_response'))
    );
    expect(decisions).toEqual([
      { teamId: 'team-3', leagueId: LEAGUE_ID, decision: 'no_handler', kind: 'trade_response' }
    ]);
    expect(s.requested()).toEqual([]);
    expect(s.logs.some((l) => l.includes('"decision":"no_handler"'))).toBe(true);
  });

  it('ignores non-trigger events, other sources, and events without a league', async () => {
    const s = await withSeats();
    expect(await s.route(event('Scores Updated', { leagueId: LEAGUE_ID }))).toEqual([]);
    expect(
      await s.route({
        ...event('Draft Turn Started', { leagueId: LEAGUE_ID, teamId: 'team-3' }),
        source: 'other'
      })
    ).toEqual([]);
    expect(await s.route(event('Waiver Window Opened', {}))).toEqual([]);
    expect(
      await s.route({ id: 'x', 'detail-type': 'Waiver Window Opened', source: 'fantasy', detail: null })
    ).toEqual([]);
    expect(s.requested()).toEqual([]);
  });

  it('derives stable task ids from the event and team', () => {
    expect(taskIdFor('e', 't', 'lineup')).toBe(taskIdFor('e', 't', 'lineup'));
    expect(taskIdFor('e', 't', 'lineup')).not.toBe(taskIdFor('e', 't2', 'lineup'));
    expect(taskIdFor('e', 't', 'lineup')).toMatch(/^lineup\.[a-z0-9]+\.[a-z0-9]+$/);
  });
});
