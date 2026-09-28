import {
  EVENT_DETAIL_SCHEMAS,
  InMemoryRealtime,
  JOBS,
  agentPrincipal,
  createContext,
  eventDetailSchema,
  executeOperation,
  handleDraftDeadline,
  handleLeagueEvent,
  handleTradeTimer,
  invokeTool,
  newsAlertDetail,
  postSystemMessage,
  registry,
  relayEvent,
  scheduleTradeDeadline,
  scheduleLockWarnings,
  silentLogger,
  statusChangedDetail,
  type ChatMessage,
  type EventDetail,
  type JobDeps,
  type Player,
  type Principal,
  type RecordedEvent,
  type Services,
  type SystemMessageOutcome
} from '@fantasy/server';
import { computeStandings, playoffBracket, systemMessageRoute, yahooDefaultSettings } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import type { BusEvent } from '../../src/events.js';
import { ScriptedModelClient } from '../../src/fake-model.js';
import { runAgentAction } from '../../src/runner.js';
import { leagueRosterIndex, routeEvent, TRIGGER_RULES, type RouteDecision } from '../../src/router.js';
import { createTaskKindRegistry, type TaskKind } from '../../src/tasks/kinds.js';
import { noopTask } from '../../src/tasks/noop.js';
import { draftSetup } from '../draft-support.js';
import { LEAGUE_ID, SF_KICKOFF, START, setup, type Setup } from '../support.js';

/**
 * The cross-stream event contract (issue #112). Each event is produced by its real emitter (an
 * operation, a job, or the emitter's exported detail builder), checked against its schema in
 * `EVENT_DETAIL_SCHEMAS`, and then fed, exactly as emitted, to every consumer: the chat system
 * messages (`postSystemMessage`), the realtime relay (`relayEvent`), and the agent router
 * (`routeEvent`). Consumer unit tests build details by hand; this suite is what catches an emitter
 * and a consumer drifting apart.
 *
 * It lives in `agents` because only this package can see all three consumers (`agents` depends on
 * `server`, not the other way around).
 */

const ROOKIE = { personalityId: 'stats-nerd', difficulty: 'rookie', archetype: 'balanced' } as const;
const ALLEN_IN_SEASON: Principal = {
  type: 'user',
  sub: 'user-123',
  email: 'allen@example.com',
  name: 'Allen'
};

/** Every trigger kind registered (as no-ops), so routing is decided by the rules alone. */
const allKinds = createTaskKindRegistry(
  [...new Set(Object.values(TRIGGER_RULES).map((r) => r.kind))].map((kind): TaskKind => ({
    ...noopTask,
    kind
  }))
);

let seq = 0;

/** The recorded event as EventBridge delivers it, after a JSON round trip like the real bus. */
function delivered(e: { detailType: string; detail: EventDetail }, time?: string): BusEvent {
  return {
    id: `evt-${++seq}`,
    'detail-type': e.detailType,
    source: 'fantasy',
    ...(time === undefined ? {} : { time }),
    detail: JSON.parse(JSON.stringify(e.detail)) as unknown
  };
}

interface Consumed {
  event: BusEvent;
  chat: SystemMessageOutcome;
  relay: { topics: string[]; published: InMemoryRealtime['published'] };
  routed: RouteDecision[];
}

/** Checks the detail against the contract, then runs every consumer on it. */
async function consume(services: Services, event: BusEvent): Promise<Consumed> {
  const schema = eventDetailSchema(event['detail-type']);
  expect(schema, `${event['detail-type']} has a detail schema`).toBeDefined();
  const parsed = schema?.safeParse(event.detail);
  expect(
    parsed?.success ? null : parsed?.error.issues,
    `${event['detail-type']} matches its schema`
  ).toBeNull();
  const realtime = new InMemoryRealtime();
  const chat = await postSystemMessage(services, event);
  const relay = await relayEvent(realtime, silentLogger, event);
  const routed = await routeEvent(
    { services, kinds: allKinds, rosterIndex: leagueRosterIndex(services) },
    event
  );
  return { event, chat, relay: { topics: relay.topics, published: realtime.published }, routed };
}

function last(events: readonly RecordedEvent[], detailType: string): RecordedEvent {
  const found = events.filter((e) => e.detailType === detailType).at(-1);
  if (found === undefined) throw new Error(`no ${detailType} event was emitted`);
  return found;
}

/** The system message an event posted, checked to be in the room the routing table names (#144). */
const posted = (c: Consumed): ChatMessage => {
  if (c.chat.status !== 'posted') throw new Error(`expected a chat message, got ${JSON.stringify(c.chat)}`);
  expect(c.chat.message.roomId, `${c.event['detail-type']} room`).toBe(
    systemMessageRoute(c.event['detail-type']).room
  );
  return c.chat.message;
};
const decisions = (c: Consumed) => c.routed.map((d) => [d.teamId, d.kind, d.decision]);

function jobDeps(s: Setup): JobDeps {
  return {
    repos: s.repos,
    reference: s.services.data.reference,
    events: s.events,
    log: silentLogger
  } as unknown as JobDeps;
}

async function inSeason(): Promise<Setup> {
  const s = await setup();
  for (const teamId of ['team-2', 'team-3', 'team-4']) await s.seat(teamId, ROOKIE);
  return s;
}

async function run(s: Setup, name: string, input: Record<string, unknown>, principal: Principal) {
  const operation = registry.get(name);
  if (operation === undefined) throw new Error(`no operation ${name}`);
  const result = await executeOperation({
    registry,
    operation,
    ctx: createContext(s.services, principal),
    input,
    idempotencyKey: operation.mutation ? `contract-${++seq}-key` : null
  });
  if ('error' in result.body) throw new Error(JSON.stringify(result.body.error));
  return result.body.data;
}

describe('event contract: waivers', () => {
  it('Waivers Processed names each award for chat, and each team hears its own awards', async () => {
    const s = await inSeason();
    // team-4 (an agent) picks up a free agent and drops him, which puts him on waivers.
    await s.repos.players.putMany([
      {
        id: 'wr9',
        name: 'WR9',
        firstName: 'WR9',
        lastName: 'WR9',
        team: 'SF',
        position: 'WR',
        status: 'active',
        injuryStatus: null,
        aliases: [],
        rank: null,
        updatedAt: s.clock.now().toISOString()
      }
    ]);
    const principal = agentPrincipal({
      agentId: `${LEAGUE_ID}.team-4`,
      teamId: 'team-4',
      leagueId: LEAGUE_ID
    });
    for (const [name, key] of [
      ['claim_waiver', 'contract-add-1'],
      ['drop_player', 'contract-drop-1']
    ] as const) {
      const result = await invokeTool({
        registry,
        services: s.services,
        principal,
        name,
        args: { leagueId: LEAGUE_ID, playerId: 'wr9', idempotencyKey: key }
      });
      expect(result.status).toBe(200);
    }
    await run(s, 'claim_waiver', { leagueId: LEAGUE_ID, playerId: 'wr9', bid: 7 }, ALLEN_IN_SEASON);
    s.clock.advance(3 * 86_400_000);
    await JOBS.processWaivers(jobDeps(s), s.clock);

    const processed = await consume(s.services, delivered(last(s.events.events, 'Waivers Processed')));
    const wr9 = { id: 'wr9', name: 'WR9', team: 'SF', position: 'WR' };
    expect(processed.event.detail).toMatchObject({
      awarded: [{ teamId: 'team-1', playerId: 'wr9', player: wr9, bid: 7, cost: 7, dropPlayer: null }]
    });
    const message = posted(processed);
    expect(message.text).toBe("Waivers processed for week 5: Allen's Team added WR9 ($7).");
    expect(message.roomId).toBe('waivers-news');
    expect(message.players).toEqual([wr9]);
    expect(processed.chat).toMatchObject({ moment: true });
    expect(processed.relay.topics).toEqual([
      `fantasy.league.${LEAGUE_ID}`,
      `fantasy.team.${LEAGUE_ID}.team-1`
    ]);
    expect(processed.relay.published[1]?.message).toMatchObject({
      detail: { teamId: 'team-1', awarded: [{ player: wr9 }] }
    });
    expect(processed.routed).toEqual([]);

    // Agents react to the moment the announcement raised.
    const moment = await consume(s.services, delivered(last(s.events.events, 'Chat Moment')));
    expect(moment.event.detail).toMatchObject({
      sourceEventType: 'Waivers Processed',
      messageId: message.id,
      roomId: 'waivers-news'
    });
    expect(moment.routed.map((d) => [d.kind, d.decision])).toEqual([
      ['chat_moment', 'requested'],
      ['chat_moment', 'requested']
    ]);
    const chatPosted = await consume(s.services, delivered(last(s.events.events, 'Chat Message Posted')));
    expect(chatPosted.relay.published).toEqual([
      { topic: `fantasy.league.${LEAGUE_ID}`, message: { type: 'chat', leagueId: LEAGUE_ID, message } }
    ]);
  });

  it('Waiver Window Opened triggers agents once per league week; an empty run says nothing', async () => {
    const s = await inSeason();
    await JOBS.processWaivers(jobDeps(s), s.clock);
    const opened = await consume(s.services, delivered(last(s.events.events, 'Waiver Window Opened')));
    expect(decisions(opened)).toEqual([
      ['team-2', 'waivers', 'requested'],
      ['team-3', 'waivers', 'requested'],
      ['team-4', 'waivers', 'requested']
    ]);
    expect(opened.chat).toEqual({ status: 'skipped', reason: 'no_template' });
    expect(opened.relay.topics).toEqual([]);

    const empty = await consume(s.services, delivered(last(s.events.events, 'Waivers Processed')));
    expect(empty.chat).toEqual({ status: 'skipped', reason: 'nothing_to_say' });
    expect(s.events.events.some((e) => e.detailType === 'Chat Moment')).toBe(false);

    s.clock.advance(86_400_000);
    await JOBS.processWaivers(jobDeps(s), s.clock);
    const nextDay = await consume(s.services, delivered(last(s.events.events, 'Waiver Window Opened')));
    expect(nextDay.routed.map((d) => d.decision)).toEqual(['repeat', 'repeat', 'repeat']);
  });
});

describe('event contract: the weekly cycle', () => {
  async function scoredWeek() {
    const s = await inSeason();
    await s.repos.schedule.putMatchups(
      [
        ['team-1', 'team-2'],
        ['team-3', 'team-4']
      ].map(([home, away], i) => ({
        id: `W05-M${i + 1}`,
        leagueId: LEAGUE_ID,
        week: 5,
        kind: 'regular' as const,
        homeTeamId: home as string,
        awayTeamId: away as string,
        homeScore: null,
        awayScore: null,
        status: 'scheduled' as const
      }))
    );
    // qb2 starts for team-2 and team-3.
    await s.services.data.reference.stats.putLines([
      { playerId: 'qb2', season: 2026, week: 5, stats: { pass_yd: 300, pass_td: 3 }, updatedAt: SF_KICKOFF }
    ]);
    return s;
  }

  it('Scores Updated goes to the league topic only', async () => {
    const s = await scoredWeek();
    s.clock.set('2026-10-04T21:00:00.000Z');
    await JOBS.scoreLiveWeek(jobDeps(s), s.clock);
    const scores = await consume(s.services, delivered(last(s.events.events, 'Scores Updated')));
    expect(scores.relay.topics).toEqual([`fantasy.league.${LEAGUE_ID}`]);
    expect(scores.chat).toEqual({ status: 'skipped', reason: 'no_template' });
    expect(scores.routed).toEqual([]);
  });

  it('NFL Games Updated (from live scoring) goes to the global topic only', async () => {
    const s = await scoredWeek();
    s.clock.set('2026-10-04T21:00:00.000Z');
    // ESPN's read of the week: SF driving at the LAR 7.
    const provider = {
      getLiveGames: async (_season: number, _week: number, asOf: Date, games: { gameId: string }[]) =>
        games.map((g) => ({
          gameKey: g.gameId,
          espnId: '401772904',
          homeTeam: 'SF',
          awayTeam: 'LAR',
          homeScore: 10,
          awayScore: 7,
          kickoff: SF_KICKOFF,
          state: 'in',
          status: '8:32 - 2nd',
          period: 2,
          clock: '8:32',
          possessionTeam: 'SF',
          isRedZone: true,
          downDistance: '2nd & 4 at LAR 7',
          fieldPosition: 'LAR 7',
          yardsToGoal: 7,
          updatedAt: asOf.toISOString()
        }))
    };
    await JOBS.scoreLiveWeek({ ...jobDeps(s), provider } as unknown as JobDeps, s.clock);
    const games = await consume(s.services, delivered(last(s.events.events, 'NFL Games Updated')));
    expect(games.event.detail).toMatchObject({
      season: 2026,
      week: 5,
      redZone: [{ team: 'SF', downDistance: '2nd & 4 at LAR 7', fieldPosition: 'LAR 7' }]
    });
    expect(games.relay.topics).toEqual(['fantasy.global']);
    expect(games.chat).toEqual({ status: 'skipped', reason: 'no_template' });
    expect(games.routed).toEqual([]);
  });

  it('Week Provisionally Final announces the top score and the biggest blowout', async () => {
    const s = await scoredWeek();
    s.clock.set('2026-10-06T12:00:00.000Z');
    await JOBS.advanceSeason(jobDeps(s), s.clock);
    const final = await consume(s.services, delivered(last(s.events.events, 'Week Provisionally Final')));
    const detail = final.event.detail as { topScore: number; blowout: { margin: number } };
    expect(final.event.detail).toMatchObject({ topTeamId: 'team-2', blowout: { winnerTeamId: 'team-2' } });
    expect(detail.topScore).toBeGreaterThan(0);
    expect(posted(final).text).toBe(
      `Week 5 is in the books (provisional). Top score: Team 2 with ${detail.topScore}. Biggest blowout: Team 2 beat Allen's Team by ${detail.blowout.margin}.`
    );
    expect(final.chat).toMatchObject({ moment: true });
    expect(final.relay.topics).toEqual([`fantasy.league.${LEAGUE_ID}`]);
    // One line in each matchup room, too.
    expect(final.chat.status === 'posted' && final.chat.matchupMessages.map((m) => m.roomId)).toEqual([
      'm-2026-W05-W05-M1',
      'm-2026-W05-W05-M2'
    ]);
    const roomLines = s.events.events.filter(
      (e) => e.detailType === 'Chat Message Posted' && String(e.detail.roomId).startsWith('m-2026-W05-')
    );
    expect(roomLines).toHaveLength(2);
    for (const line of roomLines) {
      const relayed = await consume(s.services, delivered(line));
      expect(relayed.relay.topics).toEqual([`fantasy.league.${LEAGUE_ID}`]);
    }
    const moments = s.events.events.filter((e) => e.detailType === 'Chat Moment');
    const leagueMoment = await consume(
      s.services,
      delivered(moments.find((e) => e.detail.roomId === 'league') as RecordedEvent)
    );
    expect(leagueMoment.event.detail).toMatchObject({ teamId: 'team-2', roomId: 'league' });

    // The league's rollover sends every agent shopping for trades (once per league week).
    const rolled = await consume(s.services, delivered(last(s.events.events, 'Week Rolled Over')));
    expect(decisions(rolled)).toEqual([
      ['team-2', 'trade_proposal', 'requested'],
      ['team-3', 'trade_proposal', 'requested'],
      ['team-4', 'trade_proposal', 'requested']
    ]);
    expect(rolled.chat).toEqual({ status: 'skipped', reason: 'no_template' });
    expect(rolled.relay.topics).toEqual([]);
  });

  it('Agent Budget Exceeded (from the task runner) is announced in chat once per week', async () => {
    const s = await inSeason();
    await s.repos.agents.addUsage({
      leagueId: LEAGUE_ID,
      week: 5,
      agentId: `${LEAGUE_ID}.team-2`,
      modelKey: 'nova-micro',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 5,
      tasks: 1
    });
    await runAgentAction(s.deps(new ScriptedModelClient()), {
      taskId: 'lineup.budget',
      leagueId: LEAGUE_ID,
      teamId: 'team-2',
      agentId: `${LEAGUE_ID}.team-2`,
      kind: 'lineup',
      trigger: { detailType: 'Lineup Lock Approaching', eventId: 'evt-budget', urgent: true },
      payload: { reason: 'lock', week: 5 },
      requestedAt: START
    });
    const notice = await consume(s.services, delivered(last(s.events.events, 'Agent Budget Exceeded')));
    expect(posted(notice).text).toBe(
      'The AI managers have used this week’s model budget ($5 of $0.25). Until next week they play on autopilot: optimizer lineups, autopicks, no waiver claims, and they turn down trade offers.'
    );
    expect(notice.routed).toEqual([]);
    expect(notice.relay.topics).toEqual([]);
  });

  it('Model Power Rankings posts the weekly standings by model at the rollover', async () => {
    const s = await scoredWeek();
    s.clock.set('2026-10-06T12:00:00.000Z');
    await JOBS.advanceSeason(jobDeps(s), s.clock);
    const rankings = await consume(s.services, delivered(last(s.events.events, 'Model Power Rankings')));
    const detail = rankings.event.detail as {
      week: number;
      lines: string[];
      rankings: { modelKey: string }[];
    };
    expect(detail.week).toBe(5);
    expect(detail.rankings.map((r) => r.modelKey)).toContain('human');
    expect(detail.lines).toHaveLength(detail.rankings.length);
    expect(posted(rankings).text).toBe(`Model power rankings after week 5: ${detail.lines.join(', ')}.`);
    expect(rankings.chat).toMatchObject({ moment: false });
    expect(rankings.relay.topics).toEqual([]);
    expect(rankings.routed).toEqual([]);
  });

  it('Lineup Lock Approaching (a deferred event) sends every agent to its lineup', async () => {
    const s = await inSeason();
    const league = await s.repos.leagues.get(LEAGUE_ID);
    const games = await s.services.data.reference.schedule.getWeek(2026, 5);
    expect(await scheduleLockWarnings(s.services, league!, games, s.clock.now())).toBe(1);
    const scheduled = last(s.events.events, 'Schedule Event').detail as {
      event: { detailType: string; detail: EventDetail };
    };
    const lock = await consume(s.services, delivered(scheduled.event));
    expect(decisions(lock)).toEqual([
      ['team-2', 'lineup', 'requested'],
      ['team-3', 'lineup', 'requested'],
      ['team-4', 'lineup', 'requested']
    ]);
    expect(lock.chat).toEqual({ status: 'skipped', reason: 'no_template' });
    expect(lock.relay.topics).toEqual([]);
  });
});

describe('event contract: the official final and the season finale', () => {
  /** officialFinal dependencies: a provider serving the corrected week, and the badge chest on. */
  type Line = { playerId: string; season: number; week: number; stats: Record<string, number> };
  function officialDeps(s: Setup, lines: readonly Line[]): JobDeps {
    const provider = { getWeekStats: async () => structuredClone(lines) } as unknown as JobDeps['provider'];
    return {
      ...(jobDeps(s) as object),
      provider,
      directory: { all: async () => [] },
      badgeChest: true
    } as unknown as JobDeps;
  }

  it('a correction that flips a result: Stat Correction Applied, Week Official Final, Achievement Earned', async () => {
    const s = await inSeason();
    await s.repos.schedule.putMatchups([
      {
        id: 'W05-M1',
        leagueId: LEAGUE_ID,
        week: 5,
        kind: 'regular',
        homeTeamId: 'team-1',
        awayTeamId: 'team-2',
        homeScore: null,
        awayScore: null,
        status: 'scheduled'
      }
    ]);
    // Allen's team-1 starts qb1 (no stats yet); team-2 starts qb2.
    await s.repos.lineups.put([
      {
        leagueId: LEAGUE_ID,
        teamId: 'team-1',
        week: 5,
        entries: [{ playerId: 'qb1', slot: 'QB' }],
        updatedAt: START,
        updatedBy: 'user#user-123'
      }
    ]);
    const qb2 = { playerId: 'qb2', season: 2026, week: 5, stats: { pass_yd: 300, pass_td: 3 } };
    await s.services.data.reference.stats.putLines([{ ...qb2, updatedAt: SF_KICKOFF }]);
    s.clock.set('2026-10-06T12:00:00.000Z');
    await JOBS.advanceSeason(jobDeps(s), s.clock);

    // Thursday: a stat correction credits qb1 with a big game, and team-1 now wins.
    const qb1 = { playerId: 'qb1', season: 2026, week: 5, stats: { pass_yd: 500, pass_td: 3 } };
    s.clock.set('2026-10-08T15:00:00.000Z');
    expect(await JOBS.officialFinal(officialDeps(s, [qb2, qb1]), s.clock)).toMatchObject({
      status: 'ok',
      corrections: 1
    });

    const correction = await consume(s.services, delivered(last(s.events.events, 'Stat Correction Applied')));
    expect(correction.event.detail).toMatchObject({
      week: 5,
      teamId: 'team-1',
      oldScore: 0,
      resultFlipped: true,
      winnerTeamId: 'team-1',
      loserTeamId: 'team-2'
    });
    const { winnerScore, loserScore } = correction.event.detail as {
      winnerScore: number;
      loserScore: number;
    };
    expect(posted(correction).text).toBe(
      `Stat correction flips week 5: Allen's Team now beats Team 2, ${winnerScore} to ${loserScore}.`
    );
    expect(correction.relay.topics).toEqual([`fantasy.league.${LEAGUE_ID}`]);
    expect(correction.routed).toEqual([]);

    const official = await consume(s.services, delivered(last(s.events.events, 'Week Official Final')));
    expect(posted(official).text).toBe(
      'Week 5 is official. Recap: Stat corrections changed 1 matchup(s), and 1 result(s) flipped.'
    );
    expect(official.relay.topics).toEqual([`fantasy.league.${LEAGUE_ID}`]);
    expect(official.routed).toEqual([]);

    const earned = await consume(s.services, delivered(last(s.events.events, 'Achievement Earned')));
    expect(earned.event.detail).toMatchObject({ teamId: 'team-1', achievementId: 'weekly-high-score' });
    expect(posted(earned).text).toBe(
      `Allen's Team earned Top Score of the Week: ${winnerScore} points, the most in week 5.`
    );
    expect(earned.relay.topics).toEqual([]);
    expect(earned.routed).toEqual([]);

    // Allen is a person, so the badge chest hears about it (rsc-core matches on the detail type).
    const activity = last(s.events.events, 'Track Activity');
    expect(EVENT_DETAIL_SCHEMAS['Track Activity'].parse(activity.detail)).toMatchObject({
      userId: 'user-123',
      action: 'fantasy.week.high_score',
      service: 'fantasy'
    });
  });

  it('the last playoff week completes the league: Season Completed crowns the champion', async () => {
    const s = await setup({ league: { phase: 'playoffs', week: 17 } });
    for (const teamId of ['team-2', 'team-3', 'team-4']) await s.seat(teamId, ROOKIE);
    const settings = yahooDefaultSettings(4);
    const teamIds = ['team-1', 'team-2', 'team-3', 'team-4'];
    const rows = computeStandings(settings, [], { teamIds, seed: 'seed-1' });
    await s.repos.schedule.putStandings({ leagueId: LEAGUE_ID, week: 15, rows, computedAt: START });
    const seeded = playoffBracket(settings, rows, []);
    if (!seeded.ok) throw new Error('bracket');
    const semis = seeded.value.games.filter((g) => g.week === 16);
    const results = semis.map((g) => ({
      homeTeamId: g.home.teamId as string,
      awayTeamId: g.away.teamId as string,
      homeScore: 100,
      awayScore: 90
    }));
    const advanced = playoffBracket(settings, rows, [{ week: 16, results }]);
    if (!advanced.ok) throw new Error('bracket');
    const final = advanced.value.games.find((g) => g.week === 17)!;
    await s.repos.schedule.putMatchups([
      ...semis.map((g, i) => ({
        id: `W16-P-${g.id}`,
        leagueId: LEAGUE_ID,
        week: 16,
        kind: 'playoff' as const,
        ...(results[i] as (typeof results)[number]),
        status: 'final' as const
      })),
      {
        id: `W17-P-${final.id}`,
        leagueId: LEAGUE_ID,
        week: 17,
        kind: 'playoff',
        homeTeamId: final.home.teamId as string,
        awayTeamId: final.away.teamId as string,
        homeScore: null,
        awayScore: null,
        status: 'scheduled'
      }
    ]);
    const reference = s.services.data.reference;
    const week5 = await reference.schedule.getWeek(2026, 5);
    const game = week5[0] as (typeof week5)[number];
    await reference.schedule.putSeason(
      2026,
      [...week5, { ...game, gameId: '2026_17_LAR_SF', week: 17, kickoff: '2026-12-27T21:25:00.000Z' }],
      {},
      new Date(START)
    );
    s.clock.set('2026-12-29T12:00:00.000Z');
    expect(await JOBS.advanceSeason(jobDeps(s), s.clock)).toMatchObject({ completed: 1 });

    const done = await consume(s.services, delivered(last(s.events.events, 'Season Completed')));
    // Nobody scored in the final: the tie goes to the better seed, who is home.
    const champion = final.home.teamId as string;
    const runnerUp = final.away.teamId as string;
    const name = (teamId: string) => (teamId === 'team-1' ? "Allen's Team" : `Team ${teamId.slice(5)}`);
    expect(done.event.detail).toMatchObject({ championTeamId: champion, runnerUpTeamId: runnerUp });
    expect(posted(done).text).toBe(
      `${name(champion)} won the 2026 championship, beating ${name(runnerUp)} in the final!`
    );
    expect(done.chat).toMatchObject({ moment: true });
    expect(done.relay.topics).toEqual([]);
    expect(done.routed).toEqual([]);
  });
});

describe('event contract: player news', () => {
  it('Player News Alert reaches the agents rostering any tagged player', async () => {
    const s = await inSeason();
    const alert = await consume(
      s.services,
      delivered({
        detailType: 'Player News Alert',
        detail: newsAlertDetail({
          id: 'n1',
          url: 'https://example.com/rb3',
          title: 'RB3 limited in practice',
          source: 'example',
          publishedAt: '2026-10-04T14:00:00.000Z',
          summary: null,
          playerIds: ['nobody', 'rb3'],
          teams: ['SF'],
          ingestedAt: '2026-10-04T14:05:00.000Z'
        })
      })
    );
    expect(decisions(alert)).toEqual([
      ['team-2', 'lineup', 'requested'],
      ['team-3', 'lineup', 'requested']
    ]);
    expect(alert.chat.status).toBe('skipped');
    expect(alert.relay.topics).toEqual([]);
  });

  it('Player Status Changed reaches the agents rostering the player, labelled as a status change', async () => {
    const s = await inSeason();
    const player = (await s.repos.players.get('rb3')) as Player;
    const changed = await consume(
      s.services,
      delivered({
        detailType: 'Player Status Changed',
        detail: statusChangedDetail(
          player,
          [{ playerId: 'rb3', field: 'injuryStatus', from: null, to: 'Out' }],
          '2026-10-04T14:00:00.000Z'
        )
      })
    );
    expect(decisions(changed)).toEqual([
      ['team-2', 'lineup', 'requested'],
      ['team-3', 'lineup', 'requested']
    ]);
    const request = last(s.events.events, 'Agent Action Requested');
    expect(request.detail).toMatchObject({ payload: { reason: 'status', playerId: 'rb3' } });
  });
});

describe('event contract: chat', () => {
  it('Chat Message Posted goes to the league topic and Chat Mention to the mentioned agent', async () => {
    const s = await inSeason();
    await run(
      s,
      'post_message',
      { leagueId: LEAGUE_ID, text: '@team-2 your bench is a crime scene' },
      ALLEN_IN_SEASON
    );
    const message = await consume(s.services, delivered(last(s.events.events, 'Chat Message Posted')));
    expect(message.relay.published[0]?.message).toMatchObject({
      type: 'chat',
      message: { text: '@team-2 your bench is a crime scene', roomId: 'trash-talk' }
    });
    expect(message.relay.topics).toEqual([`fantasy.league.${LEAGUE_ID}`]);
    expect(message.chat).toEqual({ status: 'skipped', reason: 'no_template' });
    const mention = await consume(s.services, delivered(last(s.events.events, 'Chat Mention')));
    expect(decisions(mention)).toEqual([['team-2', 'chat_reply', 'requested']]);
    expect(mention.relay.topics).toEqual([]);
  });

  it('a DM (Chat Message Posted with its two teams) reaches only their team topics; the other team is addressed', async () => {
    const s = await inSeason();
    await run(
      s,
      'post_message',
      { leagueId: LEAGUE_ID, roomId: 'dm-team-1-team-2', text: 'Want my backup QB?' },
      ALLEN_IN_SEASON
    );
    const dm = await consume(s.services, delivered(last(s.events.events, 'Chat Message Posted')));
    expect(dm.event.detail).toMatchObject({ roomId: 'dm-team-1-team-2', teamIds: ['team-1', 'team-2'] });
    expect(dm.relay.topics).toEqual([`fantasy.team.${LEAGUE_ID}.team-1`, `fantasy.team.${LEAGUE_ID}.team-2`]);
    expect(dm.relay.published[0]?.message).toMatchObject({
      type: 'chat',
      message: { text: 'Want my backup QB?' }
    });
    expect(dm.chat).toEqual({ status: 'skipped', reason: 'no_template' });
    // No @mention, but a DM always addresses the other team.
    const mention = await consume(s.services, delivered(last(s.events.events, 'Chat Mention')));
    expect(mention.event.detail).toMatchObject({ roomId: 'dm-team-1-team-2', mentionedTeamIds: ['team-2'] });
    expect(decisions(mention)).toEqual([['team-2', 'chat_reply', 'requested']]);
    expect(mention.relay.topics).toEqual([]);
  });
});

describe('event contract: league setup and the draft', () => {
  it('membership, settings, and every draft event render and route', async () => {
    const BOB: Principal = { type: 'user', sub: 'bob', email: 'bob@example.com', name: 'Bob' };
    const outcomes: Record<string, Consumed> = {};
    const d = await draftSetup({
      beforeStart: async (base) => {
        const invite = (await base.run('create_invite', { leagueId: base.leagueId })) as {
          data: { token: string };
        };
        await base.run('join_league', { token: invite.data.token }, BOB);
        outcomes.joined = await consume(base.services, delivered(last(base.events.events, 'Member Joined')));
        await base.run('update_league_settings', {
          leagueId: base.leagueId,
          changes: { trades: { reviewPeriodDays: 1 } }
        });
        outcomes.settings = await consume(
          base.services,
          delivered(last(base.events.events, 'Settings Changed'))
        );
        await base.run('leave_league', { leagueId: base.leagueId }, BOB);
        outcomes.left = await consume(base.services, delivered(last(base.events.events, 'Member Left')));
      }
    });
    expect(posted(outcomes.joined!).text).toMatch(/^Bob joined the league and took over /);
    expect(posted(outcomes.settings!).text).toBe(
      'The commissioner changed league settings: trades.reviewPeriodDays.'
    );
    expect(posted(outcomes.left!).text).toMatch(/ left the league\.$/);

    const created = last(d.events.events, 'League Created');
    expect(EVENT_DETAIL_SCHEMAS['League Created'].safeParse(created.detail).success).toBe(true);

    const turn = await consume(d.services, delivered(last(d.events.events, 'Draft Turn Started')));
    expect(turn.relay.topics).toEqual([`fantasy.league.${d.leagueId}`]);
    const onTheClock = (turn.event.detail as { teamId: string }).teamId;
    expect(turn.routed.map((r) => [r.teamId, r.kind])).toEqual(
      onTheClock === 'team-1' ? [] : [[onTheClock, 'draft_pick']]
    );

    // Run the draft on the clock: every pick is an autopick at its deadline.
    for (let pick = 1; !d.events.events.some((e) => e.detailType === 'Draft Completed'); pick++) {
      const deadline = Date.parse(last(d.events.events, 'Draft Turn Started').detail.deadline as string);
      d.clock.set(new Date(deadline + 1000).toISOString());
      await handleDraftDeadline(d.services, { leagueId: d.leagueId, pick });
      if (pick === 1) {
        const made = await consume(d.services, delivered(last(d.events.events, 'Draft Pick Made')));
        const player = (made.event.detail as { player: { name: string } }).player;
        expect(posted(made).text).toMatch(new RegExp(` drafted ${player.name} \\(round 1, pick 1\\)\\.$`));
        expect(posted(made).players).toEqual([(made.event.detail as { player: unknown }).player]);
        expect(made.relay.topics).toEqual([`fantasy.league.${d.leagueId}`]);

        // The commissioner pauses and resumes the clock: both are pushed to boards and announced.
        await d.run('pause_draft', { leagueId: d.leagueId });
        const paused = await consume(d.services, delivered(last(d.events.events, 'Draft Paused')));
        expect(EVENT_DETAIL_SCHEMAS['Draft Paused'].safeParse(paused.event.detail).success).toBe(true);
        expect(paused.relay.topics).toEqual([`fantasy.league.${d.leagueId}`]);
        expect(posted(paused).text).toBe('The commissioner paused the draft at pick 2.');
        expect(paused.routed).toEqual([]);
        await d.run('resume_draft', { leagueId: d.leagueId });
        const resumed = await consume(d.services, delivered(last(d.events.events, 'Draft Resumed')));
        expect(EVENT_DETAIL_SCHEMAS['Draft Resumed'].safeParse(resumed.event.detail).success).toBe(true);
        expect(resumed.relay.topics).toEqual([`fantasy.league.${d.leagueId}`]);
        expect(posted(resumed).text).toBe('The draft is back on: pick 2 is on the clock.');
      }
      if (pick > 100) throw new Error('the draft did not finish');
    }
    const completed = await consume(d.services, delivered(last(d.events.events, 'Draft Completed')));
    expect(EVENT_DETAIL_SCHEMAS['Draft Completed'].safeParse(completed.event.detail).success).toBe(true);
    expect(posted(completed).text).toMatch(
      /^The draft is complete\. Good luck this season! Draft recap: \d+ picks\./
    );
    expect(completed.chat).toMatchObject({ moment: true });
    expect(completed.relay.topics).toEqual([`fantasy.league.${d.leagueId}`]);

    // After the draft, a commissioner's change to an AI seat is announced to the league.
    const seat = { leagueId: d.leagueId, teamId: 'team-3', personalityId: 'hype-man', archetype: 'win_now' };
    const announced = () => d.events.events.filter((e) => e.detailType === 'Agent Seat Changed').length;
    await d.run('configure_agent_seat', { ...seat, difficulty: 'all_pro' });
    const before = announced();
    await d.run('configure_agent_seat', { ...seat, difficulty: 'all_pro' });
    expect(announced()).toBe(before); // nothing changed, nothing announced
    await d.run('configure_agent_seat', { ...seat, difficulty: 'rookie' });
    expect(announced()).toBe(before + 1);
    const changed = await consume(d.services, delivered(last(d.events.events, 'Agent Seat Changed')));
    expect(EVENT_DETAIL_SCHEMAS['Agent Seat Changed'].safeParse(changed.event.detail).success).toBe(true);
    expect(posted(changed).text).toMatch(
      /^The commissioner changed .+'s AI difficulty from All-Pro to Rookie, AI decision model from Claude Sonnet 5 to Amazon Nova Micro\.$/
    );
    expect(changed.routed).toEqual([]);
    expect(changed.relay.topics).toEqual([]);
  });
});

describe('event contract: the scheduled draft', () => {
  it('the start and reminder timers, Draft Starting Soon, and Draft Start Blocked render and relay', async () => {
    const outcomes: Record<string, Consumed> = {};
    await draftSetup({
      beforeStart: async (base) => {
        const scheduledAt = new Date(base.clock.now().getTime() + 3_600_000).toISOString();
        await base.run('update_league_settings', {
          leagueId: base.leagueId,
          changes: { draft: { scheduledAt } }
        });
        const timers = base.events.events
          .filter((e) => e.detailType === 'Schedule Event')
          .map((e) => (e.detail as { event: { detailType: string; detail: EventDetail } }).event);
        const timer = (type: string) => {
          const found = timers.find((t) => t.detailType === type);
          if (found === undefined) throw new Error(`no ${type} timer`);
          return found;
        };
        // The timers themselves are for the API function alone: no chat, no relay, no agents.
        for (const type of ['Draft Start Scheduled', 'Draft Reminder Due']) {
          const consumed = await consume(base.services, delivered(timer(type)));
          expect(consumed.chat).toEqual({ status: 'skipped', reason: 'no_template' });
          expect(consumed.relay.topics).toEqual([]);
          expect(consumed.routed).toEqual([]);
        }

        base.clock.set(new Date(Date.parse(scheduledAt) - 600_000).toISOString());
        await handleLeagueEvent(base.services, delivered(timer('Draft Reminder Due')));
        outcomes.soon = await consume(
          base.services,
          delivered(last(base.events.events, 'Draft Starting Soon'))
        );

        await base.run('set_seat_type', { leagueId: base.leagueId, teamId: 'team-2', seatType: 'human' });
        base.clock.set(scheduledAt);
        await handleLeagueEvent(base.services, delivered(timer('Draft Start Scheduled')));
        outcomes.blocked = await consume(
          base.services,
          delivered(last(base.events.events, 'Draft Start Blocked'))
        );
        await base.run('set_seat_type', { leagueId: base.leagueId, teamId: 'team-2', seatType: 'agent' });
      }
    });
    const soon = outcomes.soon!;
    expect(posted(soon).text).toBe('The draft starts in 10 minutes. Set your queue in the draft room!');
    expect(soon.relay.topics).toEqual([expect.stringMatching(/^fantasy\.league\./)]);
    expect(soon.routed).toEqual([]);
    const blocked = outcomes.blocked!;
    expect(posted(blocked).text).toMatch(
      /^The draft could not start at its scheduled time\. 1 human seat\(s\) are still open: .+ Commissioner: Invite people/
    );
    expect(blocked.relay.topics).toEqual([expect.stringMatching(/^fantasy\.league\./)]);
    expect(blocked.routed).toEqual([]);
  });
});

describe('event contract: trades', () => {
  /** team-1 (Allen) holds rb3; team-2 (an agent) the rest of the support roster. */
  async function tradeLeague(): Promise<Setup> {
    const s = await inSeason();
    const rosters: Record<string, string[]> = {
      'team-1': ['rb3'],
      'team-2': (await s.repos.teams.get(LEAGUE_ID, 'team-2'))?.roster.filter((id) => id !== 'rb3') ?? [],
      'team-3': [],
      'team-4': []
    };
    for (const [teamId, roster] of Object.entries(rosters)) {
      const team = await s.repos.teams.get(LEAGUE_ID, teamId);
      if (team === null) throw new Error(teamId);
      await s.repos.teams.update({ ...team, roster });
    }
    return s;
  }
  const agent2 = agentPrincipal({ agentId: `${LEAGUE_ID}.team-2`, teamId: 'team-2', leagueId: LEAGUE_ID });
  const teamTopics = (...teams: string[]) => teams.map((t) => `fantasy.team.${LEAGUE_ID}.${t}`);
  const offerOf = (data: unknown) => (data as { trade: { id: string; reviewEndsAt: string | null } }).trade;

  it('pending offers reach only the two teams; the team that must answer is triggered', async () => {
    const s = await tradeLeague();
    const offer = offerOf(
      await run(
        s,
        'propose_trade',
        { leagueId: LEAGUE_ID, withTeamId: 'team-2', send: ['rb3'], receive: ['rb4'] },
        ALLEN_IN_SEASON
      )
    );
    const proposed = await consume(s.services, delivered(last(s.events.events, 'Trade Proposed')));
    expect(proposed.chat).toEqual({ status: 'skipped', reason: 'no_template' });
    expect(proposed.relay.topics).toEqual(teamTopics('team-1', 'team-2'));
    expect(decisions(proposed)).toEqual([['team-2', 'trade_response', 'requested']]);

    // The agent counters through its own tool; the person it goes back to is not an agent.
    const countered = await invokeTool({
      registry,
      services: s.services,
      principal: agent2,
      name: 'counter_trade',
      args: {
        leagueId: LEAGUE_ID,
        tradeId: offer.id,
        send: ['rb4'],
        receive: ['rb3'],
        idempotencyKey: 'contract-counter-1'
      }
    });
    const counter = offerOf((countered.body as { data: unknown }).data);
    const counterEvent = await consume(s.services, delivered(last(s.events.events, 'Trade Countered')));
    expect(counterEvent.relay.topics).toEqual(teamTopics('team-2', 'team-1'));
    expect(counterEvent.routed).toEqual([]);

    await run(
      s,
      'respond_to_trade',
      { leagueId: LEAGUE_ID, tradeId: counter.id, response: 'reject' },
      ALLEN_IN_SEASON
    );
    const rejected = await consume(s.services, delivered(last(s.events.events, 'Trade Rejected')));
    expect(rejected.relay.topics).toEqual(teamTopics('team-2', 'team-1'));
    expect(rejected.chat).toMatchObject({ status: 'skipped' });

    const lapsing = offerOf(
      await run(
        s,
        'propose_trade',
        { leagueId: LEAGUE_ID, withTeamId: 'team-2', send: ['rb3'] },
        ALLEN_IN_SEASON
      )
    );
    const timer = last(s.events.events, 'Schedule Event').detail.event as {
      detailType: string;
      detail: EventDetail;
    };
    const deadline = await consume(s.services, delivered(timer));
    expect(deadline.relay.topics).toEqual([]);
    s.clock.set((timer.detail as { expiresAt: string }).expiresAt);
    expect(await handleTradeTimer(s.services, timer.detailType, deadline.event.detail)).toBe('expired');
    const expired = await consume(s.services, delivered(last(s.events.events, 'Trade Expired')));
    expect((expired.event.detail as { tradeId: string }).tradeId).toBe(lapsing.id);
    expect(expired.relay.topics).toEqual(teamTopics('team-1', 'team-2'));
  });

  it('withdrawn offers, and offers voided when a player moves, reach only the two teams', async () => {
    const s = await tradeLeague();
    const offer = { leagueId: LEAGUE_ID, withTeamId: 'team-2', send: ['rb3'], receive: ['rb4'] };
    const taken = offerOf(await run(s, 'propose_trade', offer, ALLEN_IN_SEASON));
    await run(s, 'withdraw_trade', { leagueId: LEAGUE_ID, tradeId: taken.id }, ALLEN_IN_SEASON);
    const withdrawn = await consume(s.services, delivered(last(s.events.events, 'Trade Withdrawn')));
    expect(withdrawn.event.detail).toMatchObject({ tradeId: taken.id, status: 'withdrawn' });
    expect(withdrawn.relay.topics).toEqual(teamTopics('team-1', 'team-2'));
    expect(withdrawn.chat).toEqual({ status: 'skipped', reason: 'no_template' });
    expect(withdrawn.routed).toEqual([]);

    const stale = offerOf(await run(s, 'propose_trade', offer, ALLEN_IN_SEASON));
    await run(s, 'drop_player', { leagueId: LEAGUE_ID, playerId: 'rb3' }, ALLEN_IN_SEASON);
    const voided = await consume(s.services, delivered(last(s.events.events, 'Trade Expired')));
    expect(voided.event.detail).toMatchObject({
      tradeId: stale.id,
      status: 'expired',
      voided: true,
      reasonCode: 'PLAYER_MOVED'
    });
    expect(voided.relay.topics).toEqual(teamTopics('team-1', 'team-2'));
    expect(voided.routed).toEqual([]);
  });

  it('accepted, vetoed, and processed trades are league news with chat lines', async () => {
    const s = await tradeLeague();
    const vetoed = offerOf(
      await run(
        s,
        'propose_trade',
        { leagueId: LEAGUE_ID, withTeamId: 'team-2', send: ['rb3'], receive: ['rb4'] },
        ALLEN_IN_SEASON
      )
    );
    const respond = (tradeId: string, key: string) =>
      invokeTool({
        registry,
        services: s.services,
        principal: agent2,
        name: 'respond_to_trade',
        args: { leagueId: LEAGUE_ID, tradeId, response: 'accept', idempotencyKey: key }
      });
    await respond(vetoed.id, 'contract-accept-1');
    const accepted = await consume(s.services, delivered(last(s.events.events, 'Trade Accepted')));
    expect(posted(accepted).text).toMatch(
      /accepted a trade with Allen's Team: RB3 for RB4\. It is under review\.$/
    );
    expect(accepted.relay.topics).toEqual([`fantasy.league.${LEAGUE_ID}`]);
    // League-vote review: every agent team outside the trade reviews it.
    expect(decisions(accepted)).toEqual([
      ['team-3', 'trade_vote', 'requested'],
      ['team-4', 'trade_vote', 'requested']
    ]);
    const review = last(s.events.events, 'Schedule Event').detail.event as {
      detailType: string;
      detail: EventDetail;
    };
    expect((await consume(s.services, delivered(review))).relay.topics).toEqual([]);

    for (const teamId of ['team-3', 'team-4']) {
      await invokeTool({
        registry,
        services: s.services,
        principal: agentPrincipal({ agentId: `${LEAGUE_ID}.${teamId}`, teamId, leagueId: LEAGUE_ID }),
        name: 'vote_trade',
        args: { leagueId: LEAGUE_ID, tradeId: vetoed.id, idempotencyKey: `contract-veto-${teamId}` }
      });
    }
    const veto = await consume(s.services, delivered(last(s.events.events, 'Trade Vetoed')));
    expect(posted(veto).text).toMatch(/^The league vetoed the trade between Allen's Team and /);
    expect(veto.chat).toMatchObject({ moment: true });
    expect(veto.relay.topics).toEqual([`fantasy.league.${LEAGUE_ID}`]);

    const done = offerOf(
      await run(
        s,
        'propose_trade',
        { leagueId: LEAGUE_ID, withTeamId: 'team-2', send: ['rb3'], receive: ['rb4'] },
        ALLEN_IN_SEASON
      )
    );
    await respond(done.id, 'contract-accept-2');
    const reviewEndsAt = (await s.repos.trades.get(LEAGUE_ID, done.id))?.trade.reviewEndsAt;
    if (reviewEndsAt == null) throw new Error('not in review');
    s.clock.set(reviewEndsAt);
    // The week has rolled over, so the SF players' week-5 locks have released.
    const league = await s.repos.leagues.get(LEAGUE_ID);
    if (league === null) throw new Error('league');
    await s.repos.leagues.update({ ...league, week: 6 });
    expect(
      await handleTradeTimer(s.services, 'Trade Review Ended', { leagueId: LEAGUE_ID, tradeId: done.id })
    ).toBe('processed');
    const processed = await consume(s.services, delivered(last(s.events.events, 'Trade Processed')));
    expect(posted(processed).text).toMatch(/^Trade complete: Allen's Team sends RB3 to .* for RB4\.$/);
    expect(processed.chat).toMatchObject({ moment: true });
    expect(processed.relay.topics).toEqual([`fantasy.league.${LEAGUE_ID}`]);
  });

  it('Trade Deadline Passed (a deferred event) posts a chat moment', async () => {
    const s = await tradeLeague();
    const league = await s.repos.leagues.get(LEAGUE_ID);
    if (league === null) throw new Error('league');
    const deadlineAt = '2026-11-20T00:20:00.000Z';
    const withDeadline = await s.repos.leagues.update({
      ...league,
      deadlines: { ...league.deadlines, tradeDeadlineAt: deadlineAt }
    });
    await scheduleTradeDeadline({ events: s.events }, withDeadline);
    const timer = last(s.events.events, 'Schedule Event').detail.event as {
      detailType: string;
      detail: EventDetail;
    };
    // Delivered before the deadline (it moved later since): nothing to announce yet.
    expect((await consume(s.services, delivered(timer))).chat).toEqual({
      status: 'skipped',
      reason: 'stale'
    });
    s.clock.set(deadlineAt);
    const passed = await consume(s.services, delivered(timer));
    expect(posted(passed).text).toBe(
      'The trade deadline has passed. Rosters change only through waivers from here on.'
    );
    expect(passed.chat).toMatchObject({ moment: true });
    expect(passed.relay.topics).toEqual([]);
  });
});

describe('event contract coverage', () => {
  it('every consumed event type has a schema', () => {
    const consumed = new Set([
      ...Object.keys(TRIGGER_RULES),
      'Waivers Processed',
      'Draft Pick Made',
      'Draft Completed',
      'Draft Paused',
      'Draft Resumed',
      'Draft Start Scheduled',
      'Draft Reminder Due',
      'Draft Starting Soon',
      'Draft Start Blocked',
      'Week Provisionally Final',
      'Member Joined',
      'Member Left',
      'Settings Changed',
      'Agent Seat Changed',
      'Agent Budget Exceeded',
      'Chat Message Posted',
      'Scores Updated',
      'NFL Games Updated',
      'Week Official Final',
      'Stat Correction Applied',
      'Season Completed',
      'Achievement Earned',
      'Model Power Rankings'
    ]);
    for (const type of consumed) expect(eventDetailSchema(type), type).toBeDefined();
    for (const type of [
      'Accepted',
      'Rejected',
      'Expired',
      'Withdrawn',
      'Processed',
      'Vetoed',
      'Offer Deadline',
      'Review Ended',
      'Deadline Passed'
    ])
      expect(eventDetailSchema(`Trade ${type}`), type).toBeDefined();
    expect(eventDetailSchema('Agent Action Requested')).toBeUndefined();
  });
});
