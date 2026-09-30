import {
  ambientTurn,
  checkInChatChance,
  computeStandings,
  matchupRoomId,
  matchupTalkChance,
  resolveAgentConfig,
  socialRoll,
  type AgentSeatConfig
} from '@fantasy/core';
import type { ChatMessage, Matchup } from '@fantasy/server';
import { describe, expect, it, vi } from 'vitest';
import { AgentActionRequestedSchema, type AgentActionRequested } from '../src/events.js';
import { ScriptedModelClient, type FakeScript } from '../src/fake-model.js';
import type { ModelClient } from '../src/model.js';
import { recordLeagueMemory } from '../src/memory.js';
import { taskIdFor } from '../src/router.js';
import { runAgentAction } from '../src/runner.js';
import { AGENT_TEAM, LEAGUE_ID, START, setup, type Setup } from './support.js';

/**
 * Grounded social acts at a check-in (#218): a person's question first, then at most one act the
 * selector chose from what the agent can prove and the room may hear, worded by the check-in's one
 * model call, checked, and posted once per event and room.
 */

const TENURE = '2026-09-01T00:00:00.000Z';
const LOUD: AgentSeatConfig = { personalityId: 'hype-man', difficulty: 'pro', archetype: 'analytics_only' };
const QUIET: AgentSeatConfig = {
  personalityId: 'zen-master',
  difficulty: 'pro',
  archetype: 'analytics_only'
};
const DM = 'dm-team-1-team-2';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (hours: number) => new Date(Date.parse(START) - hours * HOUR).toISOString();
const agentId = (teamId: string) => `${LEAGUE_ID}.${teamId}`;
let seq = 0;

/** An event id whose check-in rolls for these teams come out as asked (board; never matchup or DM). */
function rolled(config: AgentSeatConfig, board: boolean, teams: readonly string[] = [AGENT_TEAM]): string {
  const c = resolveAgentConfig(config).personality.chattiness;
  for (let i = 0; i < 50_000; i++) {
    const id = `evt-acts-${i}`;
    const ok = teams.every(
      (t) =>
        ambientTurn(c, `${id}:${t}:board`) === board &&
        !socialRoll(matchupTalkChance(c), `${id}:${t}:matchup`)
    );
    if (ok) return id;
  }
  throw new Error('no such roll');
}

function checkIn(eventId: string, teamId = AGENT_TEAM): AgentActionRequested {
  return {
    taskId: taskIdFor(eventId, teamId, 'check_in'),
    leagueId: LEAGUE_ID,
    teamId,
    agentId: agentId(teamId),
    kind: 'check_in',
    trigger: { detailType: 'Manager Check-In', eventId, urgent: false },
    payload: { slot: 'afternoon' },
    requestedAt: START
  };
}

type Game = { week: number; home: string; away: string; hs: number | null; as: number | null };
const game = (g: Game, i: number): Matchup => ({
  id: `W0${g.week}-M${i + 1}`,
  leagueId: LEAGUE_ID,
  week: g.week,
  kind: 'regular',
  homeTeamId: g.home,
  awayTeamId: g.away,
  homeScore: g.hs,
  awayScore: g.as,
  status: g.hs === null ? 'scheduled' : 'final'
});

/** A league results event, recorded into the agents' memory as the router would (#210). */
async function final(s: Setup, week: number, games: Game[], hoursAgo: number) {
  await recordLeagueMemory(s.services, {
    id: `final-w${week}`,
    source: 'fantasy',
    'detail-type': 'Week Provisionally Final',
    time: ago(hoursAgo),
    detail: {
      leagueId: LEAGUE_ID,
      week,
      matchups: games.map((g) => ({
        homeTeamId: g.home,
        awayTeamId: g.away,
        homeScore: g.hs,
        awayScore: g.as
      }))
    }
  });
}

/**
 * Week 5 of a league where the agent (team-2) beat team-3 110-95 in week 2 and team-1 120-105 in
 * week 4 (final 12 hours ago), and plays team-3 again this week.
 */
async function league(
  config: AgentSeatConfig = LOUD,
  games: { week2?: Game[]; week4?: Game[]; week5?: Game[]; others?: AgentSeatConfig } = {}
): Promise<Setup> {
  const s = await setup();
  await s.seat(AGENT_TEAM, config);
  await s.seat('team-3', games.others ?? QUIET);
  for (const team of await s.repos.teams.list(LEAGUE_ID))
    await s.repos.teams.update({ ...team, occupiedSince: TENURE });
  const week2 = games.week2 ?? [{ week: 2, home: AGENT_TEAM, away: 'team-3', hs: 110, as: 95 }];
  const week4 = games.week4 ?? [{ week: 4, home: AGENT_TEAM, away: 'team-1', hs: 120, as: 105 }];
  const week5 = games.week5 ?? [{ week: 5, home: AGENT_TEAM, away: 'team-3', hs: null, as: null }];
  await s.repos.schedule.putMatchups([...week2, ...week4, ...week5].map(game));
  const l = (await s.repos.leagues.get(LEAGUE_ID))!;
  const done = [...week2, ...week4].map((g) => ({
    week: g.week,
    homeTeamId: g.home,
    awayTeamId: g.away,
    homeScore: g.hs as number,
    awayScore: g.as as number
  }));
  await s.repos.schedule.putStandings({
    leagueId: LEAGUE_ID,
    week: 4,
    rows: computeStandings(l.settings, done, {
      teamIds: ['team-1', AGENT_TEAM, 'team-3', 'team-4'],
      seed: l.scheduleSeed
    }),
    computedAt: START
  });
  if (week2.length > 0) await final(s, 2, week2, 24 * 14);
  await final(s, 4, week4, 12);
  return s;
}

const run = (s: Setup, request: AgentActionRequested, model = new ScriptedModelClient()) =>
  runAgentAction(s.deps(model), request);

const agentPosts = async (s: Setup, roomId: string) =>
  (await s.repos.chat.list(LEAGUE_ID, roomId, { limit: 100 })).messages.filter((m) => m.kind === 'agent');

const acts = async (s: Setup, teamId = AGENT_TEAM) =>
  (await s.repos.agents.getSocialActs(LEAGUE_ID, agentId(teamId), TENURE)).acts;

function scripted(actions: Record<string, unknown>[]) {
  return new ScriptedModelClient({
    script: () => ({ steps: [], decision: { summary: 'Checked in.', actions } }) as FakeScript
  });
}

const requested = (s: Setup) =>
  s.events.events
    .filter((e) => e.detailType === 'Agent Action Requested')
    .map((e) => AgentActionRequestedSchema.parse(e.detail));

async function say(s: Setup, text: string, over: Partial<ChatMessage> = {}): Promise<ChatMessage> {
  const roomId = over.roomId ?? DM;
  const message: ChatMessage = {
    id: `m-${++seq}`,
    leagueId: LEAGUE_ID,
    roomId,
    kind: 'user',
    author: { teamId: 'team-1', teamName: "Allen's Team", name: 'Allen' },
    text,
    mentionedTeamIds: roomId === DM ? [] : [AGENT_TEAM],
    event: null,
    createdAt: ago(1),
    ...over
  };
  await s.repos.chat.put(message, roomId === DM ? { dmTeamIds: ['team-1', AGENT_TEAM] } : {});
  return message;
}

/** Agent messages from `teamId` in the last day, to spend its chat budget. */
async function spend(s: Setup, count: number, hoursAgo: number) {
  for (let i = 0; i < count; i++)
    await s.repos.chat.put({
      id: `spent-${++seq}`,
      leagueId: LEAGUE_ID,
      roomId: 'trades',
      kind: 'agent',
      author: { teamId: AGENT_TEAM, teamName: 'Team 2', name: 'Hype' },
      text: 'LOUD',
      mentionedTeamIds: [],
      event: null,
      createdAt: ago(hoursAgo)
    } as ChatMessage);
}

describe('a callback grounded in shared history', () => {
  it('recalls a real game with this week opponent, in place of a board post, from verified facts', async () => {
    const s = await league();
    const model = new ScriptedModelClient();
    const record = await run(s, checkIn(rolled(LOUD, true)), model);
    const prompt = model.transcript[0]?.systemPrompt ?? '';
    expect(prompt).toContain('A social moment worth a word in #trash-talk');
    expect(prompt).toContain('[result:w2] Week 2: you beat Team 3 110-95.');
    expect(prompt).toContain('[matchup:w5] This week (week 5) you play Team 3.');
    // It takes the board post's place: no news post alongside it.
    expect(prompt).not.toContain('add one `post_chat` action');
    expect(record.reasoningSummary).toContain('Posted a callback in #trash-talk.');
    expect(record.finalAction).toContain('social_act');
    const posts = await agentPosts(s, 'trash-talk');
    expect(posts.map((m) => m.text)).toEqual(['Not forgetting this one. Week 2: you beat Team 3 110-95.']);
    expect(await acts(s)).toMatchObject([
      {
        act: 'callback',
        reason: 'rematch',
        topic: 'callback:team-3:result:w2',
        roomId: 'trash-talk',
        counterpartTeamId: 'team-3',
        evidence: ['result:w2'],
        outcome: 'posted'
      }
    ]);
    // The same callback is not made twice: after someone speaks, the next board turn says something else.
    await say(s, 'Enjoy it while it lasts.', { roomId: 'trash-talk', mentionedTeamIds: [] });
    s.clock.advance(HOUR);
    await run(s, checkIn(rolled(LOUD, true).replace('evt', 'again')));
    const next = await agentPosts(s, 'trash-talk');
    expect(next.filter((m) => m.text.includes('110-95'))).toHaveLength(1);
  });

  it('cannot call back a private offer or an event it never observed', async () => {
    const s = await league(LOUD, { week2: [] });
    // Its offer to team-3 was turned down (private to the two teams); team-1 and team-3 traded (not its business).
    for (const [id, type, from, to] of [
      ['t-private', 'Trade Rejected', AGENT_TEAM, 'team-3'],
      ['t-others', 'Trade Processed', 'team-1', 'team-3']
    ] as const)
      await recordLeagueMemory(s.services, {
        id: `evt-${id}`,
        source: 'fantasy',
        'detail-type': type,
        time: ago(48),
        detail: {
          leagueId: LEAGUE_ID,
          tradeId: id,
          fromTeamId: from,
          toTeamId: to,
          fromPlayers: [{ name: 'Secret Guy' }],
          toPlayers: [{ name: 'Other Guy' }]
        }
      });
    const model = new ScriptedModelClient();
    await run(s, checkIn(rolled(LOUD, true)), model);
    const prompt = model.transcript[0]?.systemPrompt ?? '';
    // It still has something true to say (its week 4 win), but no callback to team-3.
    expect(prompt).toContain('[result:w4] Week 4 final: you beat Allen');
    expect(prompt).not.toContain('[trade:');
    expect(prompt).not.toContain('Secret Guy');
    expect(prompt).not.toContain('Other Guy');
    const posts = await agentPosts(s, 'trash-talk');
    expect(posts.map((m) => m.text)).toEqual([
      "Noted for the record. Week 4 final: you beat Allen's Team 120-105."
    ]);
    expect((await acts(s)).map((a) => a.act)).toEqual(['react_to_result']);
  });
});

describe('checking the worded act', () => {
  it('rejects a draft citing facts it was not given, or numbers the facts do not state', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ message: 'Remember our trade? Still laughing.', evidence: ['trade:invented'] }, 'unknown_evidence'],
      [{ message: 'Week 2 I hung 140 on you.', evidence: ['result:w2'] }, 'unsupported_number'],
      [{ message: 'Week 2, remember?', evidence: [] }, 'no_evidence']
    ];
    for (const [draft, detail] of cases) {
      const s = await league();
      const record = await run(s, checkIn(rolled(LOUD, true)), scripted([{ type: 'social_act', ...draft }]));
      expect(record.reasoningSummary).toContain('Dropped a callback: it did not check out.');
      expect(await agentPosts(s, 'trash-talk')).toEqual([]);
      expect(await acts(s)).toMatchObject([{ act: 'callback', outcome: 'rejected', detail }]);
    }
  });

  it('abstains when the model leaves it out, and then does not offer it again', async () => {
    const s = await league();
    const record = await run(s, checkIn(rolled(LOUD, true)), scripted([{ type: 'none' }]));
    expect(record.finalAction).toBe('none');
    expect(await acts(s)).toMatchObject([{ act: 'callback', outcome: 'passed', detail: 'model_passed' }]);
    const model = new ScriptedModelClient();
    await run(s, checkIn(rolled(LOUD, true).replace('evt', 'later')), model);
    expect(model.transcript[0]?.systemPrompt ?? '').not.toContain('[result:w2]');
  });

  it('offers no act in a room where it had the last word', async () => {
    const s = await league();
    await s.repos.chat.put({
      id: 'mine',
      leagueId: LEAGUE_ID,
      roomId: 'trash-talk',
      kind: 'agent',
      author: { teamId: AGENT_TEAM, teamName: 'Team 2', name: 'Hype' },
      text: 'Earlier.',
      mentionedTeamIds: [],
      event: null,
      createdAt: ago(30)
    } as ChatMessage);
    // Chosen at the look (the room's last word was not checked then: nothing new was said in a day).
    const quiet = await run(s, checkIn(rolled(LOUD, true)));
    expect(quiet.reasoningSummary ?? '').not.toContain('Posted');
    expect(await agentPosts(s, 'trash-talk')).toHaveLength(1);
  });
});

describe('several agents seeing one event', () => {
  it('give one reaction per room, not a flood', async () => {
    // Team 2 beat team 3 150-100 in week 4; both are loud, and both react at the same check-in.
    const week4 = [{ week: 4, home: AGENT_TEAM, away: 'team-3', hs: 150, as: 100 }];
    const s = await league(LOUD, { week2: [], week4, week5: [], others: LOUD });
    const id = rolled(LOUD, true, [AGENT_TEAM, 'team-3']);
    const first = await run(s, checkIn(id));
    const second = await run(s, checkIn(id, 'team-3'));
    expect(first.reasoningSummary).toContain('Posted a reaction to my result in #trash-talk.');
    expect(second.reasoningSummary).toContain(
      'Held back a reaction to my result: someone already spoke to that.'
    );
    expect(await agentPosts(s, 'trash-talk')).toHaveLength(1);
    expect(await acts(s, 'team-3')).toMatchObject([
      {
        act: 'react_to_result',
        eventKey: 'game:w4:team-2|team-3',
        outcome: 'withheld',
        detail: 'room_flooded'
      }
    ]);
  });
});

describe('limits and stores', () => {
  it('treats a contended event claim as taken, and keeps no history for a seat no longer an agent', async () => {
    const s = await league();
    const claim = s.repos.agents.claimLimit.bind(s.repos.agents);
    vi.spyOn(s.repos.agents, 'claimLimit').mockImplementation(async (input) =>
      input.key.startsWith('league#') ? 'contended' : claim(input)
    );
    const record = await run(s, checkIn(rolled(LOUD, true)));
    expect(record.reasoningSummary).toContain('Held back a callback: someone already spoke to that.');
    expect(s.logs.some((l) => l.includes('agent limit contended'))).toBe(true);

    const human = await league();
    const team = (await human.repos.teams.get(LEAGUE_ID, AGENT_TEAM))!;
    await human.repos.teams.update({ ...team, seatType: 'human' });
    const kept = await run(human, checkIn(rolled(LOUD, true)));
    expect(kept.status).not.toBe('failed');
    expect(await agentPosts(human, 'trash-talk')).toEqual([]);
    expect(await acts(human)).toEqual([]);
  });
});

describe("a person's question first", () => {
  it('hands a question the router never answered to the ordinary reply, even for a quiet manager', async () => {
    const s = await league(QUIET);
    const question = await say(s, 'Are you selling your RBs this week?');
    const record = await run(s, checkIn(rolled(QUIET, false)));
    // Nothing else worth a model call: the check-in hands the reply on without one.
    expect(record.status).toBe('skipped');
    expect(record.reasoningSummary).toContain('A question waiting on me gets its own reply.');
    const reply = requested(s).find((r) => r.kind === 'chat_reply');
    expect(reply?.payload).toEqual({ messageId: question.id, roomId: DM, coalesce: true });
    expect(await acts(s)).toMatchObject([{ act: 'answer_question', outcome: 'handed_on', roomId: DM }]);
    // The reply answers it in the conversation it came from, as a reply to it.
    await run(s, reply!);
    const answered = await agentPosts(s, DM);
    expect(answered).toHaveLength(1);
    expect(answered[0]?.replyToId).toBe(question.id);
    // Answered: the next check-in has nothing to hand on.
    s.clock.advance(5 * HOUR);
    const later = await run(s, checkIn(rolled(QUIET, false).replace('evt', 'later')));
    expect(later.reasoningSummary ?? '').not.toContain('A question waiting on me');
  });

  it('posts one reply when two tasks answer the same question at once', async () => {
    const s = await league(QUIET);
    const question = await say(s, 'Are you selling your RBs this week?');
    // Both runs are past their `already_answered` check before either posts: a model call that
    // waits for the other one to arrive holds them there.
    const scripted = new ScriptedModelClient();
    let arrived = 0;
    let release: () => void = () => undefined;
    const both = new Promise<void>((resolve) => (release = resolve));
    const barrier: ModelClient = {
      name: 'barrier',
      async run(request) {
        if (++arrived === 2) release();
        await both;
        return scripted.run(request);
      }
    };
    const reply = (eventId: string, detailType: string): AgentActionRequested => ({
      ...checkIn(eventId),
      taskId: taskIdFor(eventId, AGENT_TEAM, 'chat_reply'),
      kind: 'chat_reply',
      trigger: { detailType, eventId, urgent: false },
      payload: { messageId: question.id, roomId: DM }
    });
    // The router's own reply to the mention, and a check-in's hand-off (#218).
    const records = await Promise.all([
      runAgentAction(s.deps(barrier), reply('mention-1', 'Chat Mention')),
      runAgentAction(s.deps(barrier), reply('checkin-1', 'Manager Check-In'))
    ]);
    expect(arrived).toBe(2);
    expect(await agentPosts(s, DM)).toHaveLength(1);
    expect(records.map((r) => r.status).sort()).toEqual(['completed', 'skipped']);
    expect(records.find((r) => r.status === 'skipped')?.fallbackReason).toBe('already_answered');
  });

  it('lets a retry of the task that claimed the reply still post it', async () => {
    const s = await league(QUIET);
    const question = await say(s, 'Are you selling your RBs this week?');
    const request: AgentActionRequested = {
      ...checkIn('mention-9'),
      taskId: taskIdFor('mention-9', AGENT_TEAM, 'chat_reply'),
      kind: 'chat_reply',
      trigger: { detailType: 'Chat Mention', eventId: 'mention-9', urgent: false },
      payload: { messageId: question.id, roomId: DM }
    };
    // An earlier attempt of this task claimed the reply and crashed before posting.
    const slot = {
      slot: `${agentId(AGENT_TEAM)}#once#reply#${question.id}`,
      now: s.clock.now(),
      windowMs: 1
    };
    expect(await s.repos.agents.admitTrigger(LEAGUE_ID, { ...slot, owner: request.taskId })).toBe(true);
    expect(
      await s.repos.agents.admitTrigger(LEAGUE_ID, { ...slot, owner: 'someone-else', windowMs: DAY })
    ).toBe(false);
    const record = await run(s, request);
    expect(record.status).toBe('completed');
    expect(await agentPosts(s, DM)).toHaveLength(1);
  });

  it('answers a mention in a league room before any talk of its own', async () => {
    const s = await league();
    await say(s, '@Team 2 who do you start at flex?', { roomId: 'league' });
    const model = new ScriptedModelClient();
    await run(s, checkIn(rolled(LOUD, true)), model);
    // No act and no board post beside it; the question goes to chat_reply.
    expect(model.transcript[0]?.systemPrompt ?? '').not.toContain('A social moment worth a word');
    expect(await agentPosts(s, 'trash-talk')).toEqual([]);
    expect(requested(s).filter((r) => r.kind === 'chat_reply')).toHaveLength(1);
  });

  it('keeps the reply for a person when the budget runs out, and lets ambient talk go', async () => {
    const s = await league();
    await spend(s, 25, 23);
    const question = await say(s, 'You around for a trade?');
    const spent = await run(s, checkIn(rolled(LOUD, true)));
    expect(requested(s).filter((r) => r.kind === 'chat_reply')).toEqual([]);
    expect(spent.reasoningSummary ?? '').not.toContain('Posted');
    expect(await acts(s)).toEqual([]);
    // Two hours on, the day's posts have rolled over: the question still waits, and goes first.
    s.clock.advance(2 * HOUR);
    await run(s, checkIn(rolled(LOUD, true).replace('evt', 'later')));
    const replies = requested(s).filter((r) => r.kind === 'chat_reply');
    expect(replies.map((r) => r.payload.messageId)).toEqual([question.id]);
    expect(await agentPosts(s, 'trash-talk')).toEqual([]);
  });

  it('never takes the last post of the day for ambient talk', async () => {
    const s = await league();
    await spend(s, 24, 3);
    const model = new ScriptedModelClient();
    await run(s, checkIn(rolled(LOUD, true)), model);
    expect(model.transcript[0]?.systemPrompt ?? '').not.toContain('A social moment worth a word');
    expect(await acts(s)).toEqual([]);
  });
});

describe('a multi-day transcript', () => {
  it('carries one identifiable shared-history callback within the usual message budget', async () => {
    const s = await league();
    await recordLeagueMemory(s.services, {
      id: 'evt-private',
      source: 'fantasy',
      'detail-type': 'Trade Rejected',
      time: ago(30),
      detail: { leagueId: LEAGUE_ID, tradeId: 't-private', fromTeamId: AGENT_TEAM, toTeamId: 'team-3' }
    });
    const chattiness = resolveAgentConfig(LOUD).personality.chattiness;
    // Three days of check-ins; the first one's board roll passes.
    const ids = [
      rolled(LOUD, true),
      ...Array.from({ length: 8 }, (_, i) => `day-${Math.floor((i + 1) / 3)}-${i}`)
    ];
    let turns = 0;
    for (const id of ids) {
      if (socialRoll(checkInChatChance(chattiness), `${id}:${AGENT_TEAM}:board`)) turns++;
      if (socialRoll(matchupTalkChance(chattiness), `${id}:${AGENT_TEAM}:matchup`)) turns++;
      await run(s, checkIn(id));
      // Allen keeps the conversation going (no question, no mention).
      await say(s, 'Talk is cheap.', {
        roomId: 'trash-talk',
        mentionedTeamIds: [],
        createdAt: s.clock.now().toISOString()
      });
      s.clock.advance(8 * HOUR);
    }
    const rooms = ['trash-talk', 'league', 'trades', 'waivers-news', matchupRoomId(2026, 5, 'W05-M1'), DM];
    const mine = (await Promise.all(rooms.map((r) => agentPosts(s, r)))).flat();
    // No more posts than the personality's own rolls allowed: the act took a board post's place.
    expect(mine.length).toBeLessThanOrEqual(turns);
    const callbacks = mine.filter((m) => m.text.includes('Week 2: you beat Team 3 110-95.'));
    expect(callbacks).toHaveLength(1);
    expect(mine.some((m) => /t-private|rejected/i.test(m.text))).toBe(false);
    expect((await acts(s)).filter((a) => a.act === 'callback')).toMatchObject([{ outcome: 'posted' }]);
  });
});
