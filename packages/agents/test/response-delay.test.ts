import {
  DIFFICULTY_TIERS,
  RESPONSE_DELAY_PROFILES,
  responseDelay,
  type ResponseDelayClass,
  type ResponseDelayLever
} from '@fantasy/core';
import { scheduleName } from '@fantasy/server';
import { describe, expect, it } from 'vitest';
import { AgentActionRequestedSchema, type BusEvent } from '../src/events.js';
import { inProcessAgentDeps } from '../src/loop.js';
import { ScriptedModelClient } from '../src/fake-model.js';
import { POST_DRAFT_KICKOFF, routeEvent, TRIGGER_RULES, type RouteDecision } from '../src/router.js';
import { createTaskKindRegistry, type TaskKind } from '../src/tasks/kinds.js';
import { noopTask } from '../src/tasks/noop.js';
import { LEAGUE_ID, SF_KICKOFF, START, setup } from './support.js';

/**
 * Human-like response delays in the router (#189): each class's delay, its deadline clamp, the
 * urgent triggers that never wait, and the in-process default that keeps dev, e2e, and the sim
 * immediate.
 */

const ROOKIE = { personalityId: 'stats-nerd', difficulty: 'rookie', archetype: 'balanced' } as const;
const HOF = { personalityId: 'hype-man', difficulty: 'hall_of_famer', archetype: 'win_now' } as const;
const ROOKIE_LEVER = DIFFICULTY_TIERS.rookie.levers.responseDelay;
const HOF_LEVER = DIFFICULTY_TIERS.hall_of_famer.levers.responseDelay;
const NOW = new Date(START);
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

const allKinds = createTaskKindRegistry(
  [...new Set(Object.values(TRIGGER_RULES).map((r) => r.kind))].map((kind): TaskKind => ({
    ...noopTask,
    kind
  }))
);

function event(detailType: string, detail: Record<string, unknown>, id: string): BusEvent {
  return { id, 'detail-type': detailType, source: 'fantasy', detail };
}

/** An event id whose roll for `teamId` is a real wait (not the immediate roll). */
function delayedId(
  cls: ResponseDelayClass,
  teamId: string,
  lever: ResponseDelayLever,
  options: { quick?: boolean; deadline?: string } = {}
): string {
  for (let i = 0; i < 1000; i++) {
    const id = `evt-${cls}-${i}`;
    const roll = responseDelay({ eventClass: cls, seed: `${id}:${teamId}`, lever, now: NOW, ...options });
    if (roll.reason !== 'immediate') return id;
  }
  throw new Error('every roll was immediate');
}

async function withSeats() {
  const s = await setup();
  await s.seat('team-2', ROOKIE);
  await s.seat('team-3', HOF);
  const route = (e: BusEvent, responseDelays = true) =>
    routeEvent({ services: s.services, kinds: allKinds, responseDelays }, e);
  const published = () =>
    s.events.events
      .filter((e) => e.detailType === 'Agent Action Requested')
      .map((e) => AgentActionRequestedSchema.parse(e.detail));
  const scheduled = () =>
    s.events.events
      .filter((e) => e.detailType === 'Schedule Event')
      .map((e) => e.detail as { at: string; name: string; event: { detailType: string; detail: unknown } });
  return { ...s, route, published, scheduled };
}

const delayOf = (d: RouteDecision[], teamId: string) => {
  const found = d.find((x) => x.teamId === teamId);
  if (found?.decision !== 'requested') throw new Error(`no task for ${teamId}`);
  return found.delayMs;
};

describe('router response delays', () => {
  it('delays a trade answer, schedules it by task id, and clamps it to half the time before expiry', async () => {
    const s = await withSeats();
    const expiresAt = at(2 * 60 * 60_000);
    const id = delayedId('trade', 'team-3', HOF_LEVER);
    const detail = {
      leagueId: LEAGUE_ID,
      tradeId: 't1',
      toTeamId: 'team-3',
      fromTeamId: 'team-1',
      expiresAt
    };
    const decisions = await s.route(event('Trade Proposed', detail, id));
    const expected = responseDelay({
      eventClass: 'trade',
      seed: `${id}:team-3`,
      lever: HOF_LEVER,
      now: NOW,
      deadline: expiresAt
    }).delayMs;
    expect(expected).toBeGreaterThan(0);
    expect(delayOf(decisions, 'team-3')).toBe(expected);
    expect(expected).toBeLessThanOrEqual(60 * 60_000);
    expect(s.published()).toEqual([]);
    const [first] = s.scheduled();
    expect(Date.parse(first?.at ?? '') - NOW.getTime()).toBe(expected);
    expect(AgentActionRequestedSchema.parse(first?.event.detail)).toMatchObject({
      kind: 'trade_response',
      teamId: 'team-3'
    });
    // The routing decision logs the delay.
    expect(s.logs.some((l) => l.includes(`"delayMs":${expected}`))).toBe(true);
    // A redelivered trigger gets the same delay and moves the same schedule instead of adding one.
    const again = await s.route(event('Trade Proposed', detail, id));
    expect(delayOf(again, 'team-3')).toBe(expected);
    expect(new Set(s.scheduled().map((x) => x.name)).size).toBe(1);
    expect(first?.name).toMatch(/^agent-task/);
    // An offer about to expire is answered at once.
    const soon = await s.route(event('Trade Countered', { ...detail, expiresAt: at(-1000) }, `${id}-late`));
    expect(delayOf(soon, 'team-3')).toBe(0);
  });

  it('never delays a lineup lock or a league-vote review', async () => {
    const s = await withSeats();
    const lock = await s.route(
      event('Lineup Lock Approaching', { leagueId: LEAGUE_ID, week: 5, lockAt: SF_KICKOFF }, 'evt-lock')
    );
    expect(lock.map((d) => (d.decision === 'requested' ? d.delayMs : null))).toEqual([0, 0]);
    const vote = await s.route(
      event(
        'Trade Accepted',
        {
          leagueId: LEAGUE_ID,
          tradeId: 't9',
          teamIds: ['team-1', 'team-4'],
          review: 'league_vote',
          status: 'in_review'
        },
        'evt-vote'
      )
    );
    expect(vote.map((d) => (d.decision === 'requested' ? d.delayMs : null))).toEqual([0, 0]);
    expect(s.scheduled()).toEqual([]);
    expect(s.published()).toHaveLength(4);
  });

  it('gives a draft pick a short think time inside the pick clock, none without a clock', async () => {
    const s = await withSeats();
    const id = delayedId('deadline', 'team-2', ROOKIE_LEVER, { deadline: at(90_000) });
    // A rookie's pick waits no more than 40% of the 90 seconds left.
    const turn = {
      leagueId: LEAGUE_ID,
      teamId: 'team-2',
      pick: 3,
      round: 1,
      deadline: at(90_000),
      pickSeconds: 90
    };
    const delay = delayOf(await s.route(event('Draft Turn Started', turn, id)), 'team-2');
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(36_000);
    const { deadline: _drop, ...noClock } = turn;
    expect(delayOf(await s.route(event('Draft Turn Started', noClock, `${id}-b`)), 'team-2')).toBe(0);
  });

  it('clamps roster work to the waiver run and to the next lineup lock', async () => {
    const s = await withSeats();
    const closesAt = at(30 * 60_000);
    const waivers = await s.route(
      event('Waiver Window Opened', { leagueId: LEAGUE_ID, week: 5, opensAt: START, closesAt }, 'evt-w')
    );
    for (const d of waivers) expect(d.decision === 'requested' && d.delayMs <= 15 * 60_000).toBe(true);
    // A status change for a rostered player: the next kickoff (SF, 5h25m away) bounds the lineup look.
    const id = delayedId('roster', 'team-2', ROOKIE_LEVER);
    const status = await s.route(
      event(
        'Player Status Changed',
        { playerId: 'p1', rosteredBy: [{ leagueId: LEAGUE_ID, teamId: 'team-2' }] },
        id
      )
    );
    const lockLimit = (Date.parse(SF_KICKOFF) - NOW.getTime()) / 2;
    const delay = delayOf(status, 'team-2');
    expect(delay).toBe(
      responseDelay({
        eventClass: 'roster',
        seed: `${id}:team-2`,
        lever: ROOKIE_LEVER,
        now: NOW,
        deadline: SF_KICKOFF
      }).delayMs
    );
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(lockLimit);
    // News about a player on a team in a league the router cannot find: no lock known, the cap holds.
    const news = await s.route(
      event(
        'Player News Alert',
        { playerIds: ['p1'], rosteredBy: [{ leagueId: 'lg-gone', teamId: 'team-2' }] },
        'evt-news'
      )
    );
    expect(news).toEqual([]);
    // The weekly trade shop has no deadline: capped at the class cap times the multiplier.
    const week = await s.route(event('Week Rolled Over', { leagueId: LEAGUE_ID, week: 6 }, 'evt-roll'));
    for (const d of week)
      expect(d.decision === 'requested' && d.delayMs <= RESPONSE_DELAY_PROFILES.roster.capMs * 2).toBe(true);
  });

  it('answers chat like someone typing, and a person’s DM at the quicker end', async () => {
    const s = await withSeats();
    const id = delayedId('chat', 'team-2', ROOKIE_LEVER, { quick: true });
    const dm = {
      leagueId: LEAGUE_ID,
      roomId: 'dm-team-1-team-2',
      messageId: 'm1',
      authorTeamId: 'team-1',
      authorType: 'user',
      mentionedTeamIds: ['team-2'],
      replyToAgentDepth: 0
    };
    const quick = delayOf(await s.route(event('Chat Mention', dm, id)), 'team-2');
    const seed = `${id}:team-2`;
    expect(quick).toBe(
      responseDelay({ eventClass: 'chat', seed, lever: ROOKIE_LEVER, now: NOW, quick: true }).delayMs
    );
    expect(quick).toBeLessThan(
      responseDelay({ eventClass: 'chat', seed, lever: ROOKIE_LEVER, now: NOW }).delayMs
    );
    expect(quick).toBeLessThanOrEqual(RESPONSE_DELAY_PROFILES.chat.capMs * ROOKIE_LEVER.multiplier);
    // A chat moment (team-2's chat slot is cooling down after the DM; the Hall of Famer reacts).
    const moment = await s.route(
      event(
        'Chat Moment',
        { leagueId: LEAGUE_ID, moment: 'blowout', messageId: 'm2', roomId: 'league' },
        'evt-m'
      )
    );
    expect(delayOf(moment, 'team-3')).toBeLessThanOrEqual(
      RESPONSE_DELAY_PROFILES.chat.capMs * HOF_LEVER.multiplier
    );
  });

  it('jitters the post-draft kickoff on top of the stagger', async () => {
    const s = await withSeats();
    const detail = {
      leagueId: LEAGUE_ID,
      week: 1,
      completedAt: '2026-09-30T13:00:00.000Z',
      picks: 32,
      rounds: 16
    };
    const decisions = await s.route(event('Draft Completed', detail, 'evt-dc'));
    decisions.forEach((d, i) => {
      const stagger = POST_DRAFT_KICKOFF.firstMs + i * POST_DRAFT_KICKOFF.spacingMs;
      const delay = d.decision === 'requested' ? d.delayMs : -1;
      expect(delay).toBeGreaterThanOrEqual(stagger);
      expect(delay).toBeLessThanOrEqual(stagger + RESPONSE_DELAY_PROFILES.post_draft.capMs * 2);
    });
  });

  it('stays immediate with delays off: the in-process loop of the dev server, e2e, and the sim', async () => {
    const s = await withSeats();
    const deps = inProcessAgentDeps(s.services, new ScriptedModelClient());
    expect(deps.router.responseDelays).toBe(false);
    expect(
      inProcessAgentDeps(s.services, new ScriptedModelClient(), { responseDelays: true }).router
        .responseDelays
    ).toBe(true);
    const id = delayedId('trade', 'team-3', HOF_LEVER);
    const decisions = await s.route(
      event(
        'Trade Proposed',
        { leagueId: LEAGUE_ID, tradeId: 't1', toTeamId: 'team-3', expiresAt: at(86_400_000) },
        id
      ),
      false
    );
    expect(delayOf(decisions, 'team-3')).toBe(0);
    expect(s.scheduled()).toEqual([]);
    expect(s.published()).toHaveLength(1);
    expect(scheduleName('agent-task', 'x')).toMatch(/^agent-task/);
  });
});
