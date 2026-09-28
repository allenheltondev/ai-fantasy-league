import {
  EVENT_DETAIL_SCHEMAS,
  InMemoryRealtime,
  JOBS,
  agentPrincipal,
  createContext,
  eventDetailSchema,
  executeOperation,
  handleDraftDeadline,
  invokeTool,
  newsAlertDetail,
  postSystemMessage,
  registry,
  relayEvent,
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
import { computeStandings, playoffBracket, yahooDefaultSettings } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import type { BusEvent } from '../../src/events.js';
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

const posted = (c: Consumed): ChatMessage => {
  if (c.chat.status !== 'posted') throw new Error(`expected a chat message, got ${JSON.stringify(c.chat)}`);
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
      messageId: message.id
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
    const moment = await consume(s.services, delivered(last(s.events.events, 'Chat Moment')));
    expect(moment.event.detail).toMatchObject({ teamId: 'team-2' });

    // The rollover itself has no consumer yet, but it still follows the contract.
    const rolled = last(s.events.events, 'Week Rolled Over');
    expect(EVENT_DETAIL_SCHEMAS['Week Rolled Over'].safeParse(rolled.detail).success).toBe(true);
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
      message: { text: '@team-2 your bench is a crime scene' }
    });
    expect(message.chat).toEqual({ status: 'skipped', reason: 'no_template' });
    const mention = await consume(s.services, delivered(last(s.events.events, 'Chat Mention')));
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
      }
      if (pick > 100) throw new Error('the draft did not finish');
    }
    const completed = await consume(d.services, delivered(last(d.events.events, 'Draft Completed')));
    expect(posted(completed).text).toBe('The draft is complete. Good luck this season!');
    expect(completed.chat).toMatchObject({ moment: true });
    expect(completed.relay.topics).toEqual([`fantasy.league.${d.leagueId}`]);
  });
});

describe('event contract coverage', () => {
  it('every consumed event type has a schema', () => {
    const consumed = new Set([
      ...Object.keys(TRIGGER_RULES).filter((t) => !t.startsWith('Trade ')),
      'Waivers Processed',
      'Draft Pick Made',
      'Draft Completed',
      'Week Provisionally Final',
      'Member Joined',
      'Member Left',
      'Settings Changed',
      'Chat Message Posted',
      'Scores Updated',
      'Week Official Final',
      'Stat Correction Applied',
      'Season Completed',
      'Achievement Earned'
    ]);
    for (const type of consumed) expect(eventDetailSchema(type), type).toBeDefined();
    expect(eventDetailSchema('Trade Proposed')).toBeUndefined();
  });
});
