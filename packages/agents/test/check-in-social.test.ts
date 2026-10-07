import {
  CHECK_INS_PER_WEEK,
  checkInChatChance,
  computeStandings,
  dmChance,
  matchupRoomId,
  matchupTalkChance,
  rebrandRoll,
  resolveAgentConfig,
  socialRoll,
  type AgentSeatConfig
} from '@fantasy/core';
import { createContext, executeOperation, type ChatMessage, type Matchup } from '@fantasy/server';
import { describe, expect, it } from 'vitest';
import type { AgentActionRequested } from '../src/events.js';
import { ScriptedModelClient, type FakeScript } from '../src/fake-model.js';
import { routeEvent } from '../src/router.js';
import { runAgentAction } from '../src/runner.js';
import { MOVES_NOT_MADE, PUBLIC_POSTS } from '../src/tasks/check-in-social.js';
import { defaultTaskKinds } from '../src/tasks/index.js';
import { AGENT_TEAM, LEAGUE_ID, START, setup, type Setup } from './support.js';

/**
 * The social side of a check-in (#196): a rename, a board post, matchup talk, and a DM with a goal,
 * each gated by the personality's chattiness and the chat limits, all in the check-in's one decision.
 */

const AGENT_ID = `${LEAGUE_ID}.${AGENT_TEAM}`;
const LOUD: AgentSeatConfig = { personalityId: 'hype-man', difficulty: 'pro', archetype: 'analytics_only' };
const QUIET: AgentSeatConfig = {
  personalityId: 'zen-master',
  difficulty: 'pro',
  archetype: 'analytics_only'
};
const ROOM = matchupRoomId(2026, 5, 'W05-M1');
const ALLEN = { type: 'user' as const, sub: 'user-123', email: null, name: 'Allen' };
let seq = 0;

type Roll = 'board' | 'matchup' | 'dm';
const CHANCE: Record<Roll, (c: number) => number> = {
  board: checkInChatChance,
  matchup: matchupTalkChance,
  dm: dmChance
};

/** An event id whose social rolls for the agent come out as asked (the others fail). */
function rolled(config: AgentSeatConfig, pass: readonly Roll[]): string {
  const chattiness = resolveAgentConfig(config).personality.chattiness;
  for (let i = 0; i < 20_000; i++) {
    const id = `evt-social-${i}`;
    const ok = (['board', 'matchup', 'dm'] as const).every(
      (r) => socialRoll(CHANCE[r](chattiness), `${id}:${AGENT_TEAM}:${r}`) === pass.includes(r)
    );
    if (ok) return id;
  }
  throw new Error('no such roll');
}

function checkIn(eventId: string, payload: Record<string, unknown> = {}): AgentActionRequested {
  return {
    taskId: `check_in.${eventId}.${++seq}`,
    leagueId: LEAGUE_ID,
    teamId: AGENT_TEAM,
    agentId: AGENT_ID,
    kind: 'check_in',
    trigger: { detailType: 'Manager Check-In', eventId, urgent: false },
    payload: { slot: 'afternoon', ...payload },
    requestedAt: START
  };
}

const matchup = (week: number, status: Matchup['status'], home: number | null, away: number | null) => ({
  id: `W0${week}-M1`,
  leagueId: LEAGUE_ID,
  week,
  kind: 'regular' as const,
  homeTeamId: AGENT_TEAM,
  awayTeamId: 'team-3',
  homeScore: home,
  awayScore: away,
  status
});

/** A league in week 5 whose week 4 is final (the agent blew out Team 3) and whose week 5 is on. */
async function league(config: AgentSeatConfig): Promise<Setup> {
  const s = await setup();
  await s.seat(AGENT_TEAM, config);
  await s.seat('team-3', QUIET);
  for (const team of await s.repos.teams.list(LEAGUE_ID))
    await s.repos.teams.update({ ...team, occupiedSince: '2026-09-01T00:00:00.000Z' });
  await s.repos.schedule.putMatchups([matchup(4, 'final', 150, 100), matchup(5, 'scheduled', null, null)]);
  const l = (await s.repos.leagues.get(LEAGUE_ID))!;
  await s.repos.schedule.putStandings({
    leagueId: LEAGUE_ID,
    week: 4,
    rows: computeStandings(
      l.settings,
      [{ week: 4, homeTeamId: AGENT_TEAM, awayTeamId: 'team-3', homeScore: 150, awayScore: 100 }],
      { teamIds: ['team-1', AGENT_TEAM, 'team-3', 'team-4'], seed: l.scheduleSeed }
    ),
    computedAt: START
  });
  return s;
}

const run = (s: Setup, request: AgentActionRequested, model = new ScriptedModelClient()) =>
  runAgentAction(s.deps(model), request);

const posted = async (s: Setup, roomId: string) =>
  (await s.repos.chat.list(LEAGUE_ID, roomId, { limit: 50 })).messages.filter((m) => m.kind === 'agent');

function scripted(actions: Record<string, unknown>[]) {
  return new ScriptedModelClient({
    script: () => ({ steps: [], decision: { summary: 'Checked in.', actions } }) as FakeScript
  });
}

describe('check-in: a rename in the same decision', () => {
  it('names a placeholder team in character when the router asks', async () => {
    const s = await league(LOUD);
    const model = new ScriptedModelClient();
    const record = await run(s, checkIn(rolled(LOUD, []), { naming: 'placeholder' }), model);
    expect(record.status).toBe('completed');
    expect(record.finalAction).toContain('rename_team');
    expect(record.reasoningSummary).toContain('My team still has a placeholder name.');
    expect(record.reasoningSummary).toContain(`Renamed "Team 2" to "Let's Gooo Brigade".`);
    expect((await s.repos.teams.get(LEAGUE_ID, AGENT_TEAM))?.name).toBe("Let's Gooo Brigade");
    expect(model.transcript[0]?.systemPrompt).toContain('To rename, add `{ "type": "rename_team"');
    expect(model.transcript[0]?.systemPrompt).toContain('keeping the placeholder is not an option');
    // One model call: the rename is one of the check-in's actions.
    expect(model.transcript).toHaveLength(1);
  });

  it('leaves a name the commissioner locked alone, and reports a refused name', async () => {
    const s = await league(LOUD);
    const team = await s.repos.teams.get(LEAGUE_ID, AGENT_TEAM);
    await s.repos.teams.update({ ...team!, name: 'The Commish Pick', nameSetBy: 'commissioner' });
    const locked = await run(s, checkIn(rolled(LOUD, []), { naming: 'rebrand' }));
    expect(locked.finalAction).not.toContain('rename_team');

    const other = await league(LOUD);
    const refused = await run(
      other,
      checkIn(rolled(LOUD, []), { naming: 'placeholder' }),
      scripted([{ type: 'rename_team', teamName: 'Team 3' }])
    );
    expect(refused.finalAction).toContain('rename_team_failed');
    expect(refused.reasoningSummary).toContain('Tried to rename to "Team 3"');
    // The refused pick does not leave the placeholder: a name in its style is taken instead.
    expect(refused.finalAction).toContain('+rename_team');
    expect((await other.repos.teams.get(LEAGUE_ID, AGENT_TEAM))?.nameSetBy).toBe('agent');
  });
});

describe('check-in routing: when to (re)name', () => {
  const route = (s: Setup, id: string, slot: string) =>
    routeEvent(
      { services: s.services, kinds: defaultTaskKinds },
      {
        id,
        source: 'fantasy',
        'detail-type': 'Manager Check-In',
        detail: { leagueId: LEAGUE_ID, slot, date: '2026-10-04', week: 5 }
      }
    );
  const requests = (s: Setup) =>
    s.events.events
      .filter((e) => e.detailType === 'Agent Action Requested')
      .map((e) => e.detail as AgentActionRequested);

  it('names a generic team at the next check-in, once a day, never a locked name', async () => {
    // A league drafted before agents named their teams: its AI teams are still "Team N".
    const s = await league(LOUD);
    await s.seat('team-4', { ...QUIET, namesTeam: false });
    const three = await s.repos.teams.get(LEAGUE_ID, 'team-3');
    await s.repos.teams.update({ ...three!, name: 'Team 3', nameSetBy: 'commissioner' });
    await route(s, 'checkin-morning', 'morning');
    expect(requests(s).map((r) => [r.teamId, r.payload.naming])).toEqual([
      [AGENT_TEAM, 'placeholder'],
      ['team-3', undefined],
      ['team-4', undefined]
    ]);
    // The check-in names it, in character, in its one decision.
    const named = requests(s).find((r) => r.teamId === AGENT_TEAM)!;
    const record = await run(s, { ...named, trigger: { ...named.trigger, eventId: rolled(LOUD, []) } });
    expect(record.reasoningSummary).toContain(`Renamed "Team 2" to "Let's Gooo Brigade".`);
    // Had it kept the name, the next check-in the same day would not ask again (naming cooldown).
    const other = await league(LOUD);
    await route(other, 'c-1', 'morning');
    other.clock.advance(5 * 3_600_000);
    await route(other, 'c-2', 'afternoon');
    const mine = requests(other).filter((r) => r.teamId === AGENT_TEAM);
    expect(mine.map((r) => r.payload.naming)).toEqual(['placeholder', undefined]);
  });

  it('asks for a rebrand only outside the cooldown, on a twenty-first of the weekly roll', async () => {
    const s = await league({ personalityId: 'startup-founder', difficulty: 'pro', archetype: 'balanced' });
    await s.seat('team-3', { personalityId: 'startup-founder', difficulty: 'pro', archetype: 'balanced' });
    const two = await s.repos.teams.get(LEAGUE_ID, AGENT_TEAM);
    const three = await s.repos.teams.get(LEAGUE_ID, 'team-3');
    // team-2 renamed itself last week (cooldown); team-3 has had its real name all along.
    await s.repos.teams.update({
      ...two!,
      name: 'Unicorn Backfield',
      nameSetBy: 'agent',
      renames: [{ from: 'Team 2', to: 'Unicorn Backfield', by: 'agent', at: START, week: 4 }]
    });
    await s.repos.teams.update({ ...three!, name: 'Pivot to Touchdowns', nameSetBy: 'agent' });
    const detail = { leagueId: LEAGUE_ID, slot: 'evening', date: '2026-10-04', week: 5 };
    await routeEvent(
      { services: s.services, kinds: defaultTaskKinds },
      { id: 'checkin-1', source: 'fantasy', 'detail-type': 'Manager Check-In', detail }
    );
    const payloads = s.events.events
      .filter((e) => e.detailType === 'Agent Action Requested')
      .map((e) => e.detail as { teamId: string; payload: Record<string, unknown> });
    const roll = rebrandRoll(0.7 / CHECK_INS_PER_WEEK, `check-in:${LEAGUE_ID}:team-3:2026-10-04-evening`);
    expect(payloads.map((p) => [p.teamId, p.payload.naming])).toEqual([
      [AGENT_TEAM, undefined],
      ['team-3', roll ? 'rebrand' : undefined]
    ]);
  });
});

describe('check-in: a board post', () => {
  it('posts about league news that concerns it, and never twice in a row', async () => {
    const s = await league(LOUD);
    const id = rolled(LOUD, ['board']);
    const model = new ScriptedModelClient();
    const record = await run(s, checkIn(id), model);
    expect(record.finalAction).toContain('post_message');
    expect(record.reasoningSummary).toContain('Posted in #trash-talk about the league news.');
    const prompt = model.transcript[0]?.systemPrompt ?? '';
    expect(prompt).toContain('Week 4: Team 2 blew out Team 3 150-100.');
    expect(prompt).toContain('add one `post_chat` action');
    const [line] = await posted(s, 'trash-talk');
    // Scripted: one of the personality's own sample lines.
    expect(resolveAgentConfig(LOUD).personality.sampleLines).toContain(line?.text);

    // Nobody else has spoken since: it holds its tongue.
    const again = await run(s, checkIn(id));
    expect(again.reasoningSummary).toContain('Held my tongue in #trash-talk: I had the last word there.');
    expect(await posted(s, 'trash-talk')).toHaveLength(1);
  });

  it('stays quiet when the dice say so, with no news, or with the chat budget spent', async () => {
    const quiet = await league(QUIET);
    const record = await run(quiet, checkIn(rolled(QUIET, [])));
    // It only lists the rooms, for a person's question waiting on it (#218): no news, no chat read.
    const names = record.toolsCalled.map((c) => c.name);
    expect(names).toContain('list_chat_rooms');
    expect(names).not.toContain('get_chat_context');
    expect(names).not.toContain('get_chat');

    const noNews = await setup();
    await noNews.seat(AGENT_TEAM, LOUD);
    const none = await run(noNews, checkIn(rolled(LOUD, ['board'])));
    expect(none.toolsCalled.map((c) => c.name)).toContain('get_chat_context');
    expect(await posted(noNews, 'trash-talk')).toEqual([]);

    const spent = await league(LOUD);
    for (let i = 0; i < 25; i++)
      await spent.repos.chat.put({
        id: `spent-${i}`,
        leagueId: LEAGUE_ID,
        roomId: 'trades',
        kind: 'agent',
        author: { teamId: AGENT_TEAM, teamName: 'Team 2', name: 'Hype' },
        text: 'LOUD',
        mentionedTeamIds: [],
        event: null,
        createdAt: '2026-10-04T14:00:00.000Z'
      } as ChatMessage);
    const broke = await run(spent, checkIn(rolled(LOUD, ['board', 'matchup', 'dm'])));
    expect(broke.toolsCalled.map((c) => c.name)).not.toContain('get_chat_context');
  });

  it('sends its @mentions through the usual banter guards', async () => {
    const s = await league(LOUD);
    await run(
      s,
      checkIn(rolled(LOUD, ['board'])),
      scripted([{ type: 'post_chat', message: '@Team 3 got DEMOLISHED 150-100!', room: 'league' }])
    );
    const mention = s.events.events.find((e) => e.detailType === 'Chat Mention');
    expect(mention?.detail).toMatchObject({
      roomId: 'league',
      authorType: 'agent',
      mentionedTeamIds: ['team-3'],
      replyToAgentDepth: 0
    });
    const decisions = await routeEvent(
      { services: s.services, kinds: defaultTaskKinds },
      { id: 'mention-1', source: 'fantasy', 'detail-type': 'Chat Mention', detail: mention?.detail }
    );
    // Team 3's zen master rarely bites: the banter gate (its appetite) turns the retort down.
    expect(decisions).toEqual([
      { teamId: 'team-3', leagueId: LEAGUE_ID, decision: 'declined', kind: 'chat_reply' }
    ]);
  });
});

describe('check-in: matchup talk', () => {
  it('talks about its matchup, tags the opponent, and stops at three posts a week', async () => {
    const s = await league(LOUD);
    // Team 3's starting running back is out.
    const back = await s.repos.players.get('team-3-rb1');
    await s.repos.players.putMany([{ ...back!, injuryStatus: 'Out' }]);
    const id = rolled(LOUD, ['matchup']);
    const model = new ScriptedModelClient();
    const record = await run(s, checkIn(id), model);
    expect(record.reasoningSummary).toContain('Talked matchup with Team 3.');
    expect(model.transcript[0]?.systemPrompt).toContain('Their starters who will not play: RB1 (Out).');
    const [line] = await posted(s, ROOM);
    expect(line?.text.startsWith('@Team 3 This one is mine.')).toBe(true);
    expect(line?.mentionedTeamIds).toEqual(['team-3']);

    // Someone answers, and it posts twice more; then the week's limit holds it.
    for (let i = 0; i < 3; i++) {
      await s.repos.chat.put({
        id: `answer-${i}`,
        leagueId: LEAGUE_ID,
        roomId: ROOM,
        kind: 'user',
        author: { teamId: 'team-3', teamName: 'Team 3', name: 'Zen' },
        text: 'Breathe.',
        mentionedTeamIds: [],
        event: null,
        createdAt: new Date(s.clock.now().getTime() + 1000).toISOString()
      } as ChatMessage);
      s.clock.advance(60_000);
      await run(s, checkIn(id));
    }
    expect(await posted(s, ROOM)).toHaveLength(3);
  });
});

describe('check-in: a direct message with a goal', () => {
  async function offerToAllen(s: Setup) {
    // Allen (a person) has a player the agent wants; the agent offers its rb4 for him.
    await s.repos.players.putMany([
      {
        id: 'h-rb',
        name: 'H RB',
        firstName: 'H',
        lastName: 'RB',
        team: 'SF',
        position: 'RB',
        status: 'active',
        injuryStatus: null,
        aliases: [],
        rank: null,
        updatedAt: START
      }
    ]);
    const allen = await s.repos.teams.get(LEAGUE_ID, 'team-1');
    await s.repos.teams.update({ ...allen!, roster: ['h-rb'] });
    const res = await executeOperation({
      registry: s.registry,
      operation: s.registry.get('propose_trade')!,
      ctx: createContext(s.services, {
        type: 'agent',
        agentId: AGENT_ID,
        teamId: AGENT_TEAM,
        leagueId: LEAGUE_ID
      } as never),
      input: { leagueId: LEAGUE_ID, withTeamId: 'team-1', send: ['rb4'], receive: ['h-rb'] },
      idempotencyKey: `offer-${++seq}`
    });
    const body = res.body as { data?: { trade: { id: string } }; error?: unknown };
    if (body.data === undefined) throw new Error(JSON.stringify(body.error));
    return body.data.trade.id;
  }
  const DM = 'dm-team-1-team-2';

  it('follows up on an offer once, then waits for an answer unless the offer changes', async () => {
    const s = await league(LOUD);
    const tradeId = await offerToAllen(s);
    s.clock.advance(25 * 3_600_000);
    const first = await run(s, checkIn(rolled(LOUD, ['dm'])));
    expect(first.reasoningSummary).toContain(
      "Messaged Allen's Team to follow up on the offer sent a day ago."
    );
    expect((await posted(s, DM)).map((m) => m.text)).toEqual(['Did you get a chance to look at my offer?']);

    // No answer yet: no second DM, even a day later.
    s.clock.advance(25 * 3_600_000);
    const second = await run(s, checkIn(rolled(LOUD, ['dm'])));
    expect(second.reasoningSummary ?? '').not.toContain('Messaged');
    expect(await posted(s, DM)).toHaveLength(1);

    // Allen turns the offer down: the offer changed, so it may ask what it would take.
    await executeOperation({
      registry: s.registry,
      operation: s.registry.get('respond_to_trade')!,
      ctx: createContext(s.services, ALLEN),
      input: { leagueId: LEAGUE_ID, tradeId, response: 'reject' },
      idempotencyKey: `reject-${++seq}`
    });
    s.clock.advance(3_600_000);
    const third = await run(s, checkIn(rolled(LOUD, ['dm'])));
    expect(third.reasoningSummary).toContain(
      "Messaged Allen's Team to ask what it would take, after they turned down an offer."
    );
    expect(await posted(s, DM)).toHaveLength(2);
  });

  it('keeps a pending offer out of the league board, and lets the DM talk about it (#263)', async () => {
    const s = await league(LOUD);
    await offerToAllen(s);
    s.clock.advance(25 * 3_600_000);
    const model = scripted([
      { type: 'post_chat', message: 'H RB would look great in my lineup. Just saying.' },
      {
        type: 'send_dm',
        goal: 1,
        message: 'Still keen on H RB. I sent you an offer yesterday, any thoughts?'
      }
    ]);
    const record = await run(s, checkIn(rolled(LOUD, ['board', 'dm'])), model);
    expect(model.transcript[0]?.systemPrompt).toContain(PUBLIC_POSTS);
    // The offer is the two teams' business: its player stays off the public board.
    expect(await posted(s, 'trash-talk')).toEqual([]);
    expect(record.reasoningSummary).toContain(
      'Held back a post in #trash-talk: it touched on a private move.'
    );
    // The same offer in their DM goes out as written.
    expect((await posted(s, DM)).map((m) => m.text)).toEqual([
      'Still keen on H RB. I sent you an offer yesterday, any thoughts?'
    ]);
  });

  it('keeps a true claim about its own offer in the DM, and cuts a false one (#264)', async () => {
    const s = await league(LOUD);
    await offerToAllen(s);
    s.clock.advance(25 * 3_600_000);
    const record = await run(
      s,
      checkIn(rolled(LOUD, ['dm'])),
      scripted([
        {
          type: 'send_dm',
          goal: 1,
          message: 'I sent you an offer yesterday. Glad you accepted my offer! Any thoughts?'
        }
      ])
    );
    // The offer is real and theirs to answer; nobody accepted it.
    expect((await posted(s, DM)).map((m) => m.text)).toEqual([
      'I sent you an offer yesterday. Any thoughts?'
    ]);
    expect(record.reasoningSummary).toContain('Cut a line claiming a move I did not make.');
  });

  it('sends no DM without a goal from the list', async () => {
    const s = await league(LOUD);
    await offerToAllen(s);
    s.clock.advance(25 * 3_600_000);
    const record = await run(
      s,
      checkIn(rolled(LOUD, ['dm'])),
      scripted([
        { type: 'send_dm', goal: 7, message: 'hey whats up' },
        { type: 'send_dm', message: 'just saying hi' }
      ])
    );
    // Nothing went out, and the record says so rather than leaving the summary to imply it did.
    expect(record.finalAction).toBe('chat_not_sent');
    expect(record.reasoningSummary).toContain(
      'Wanted to send a direct message, but not for one of the listed goals'
    );
    expect(await posted(s, DM)).toEqual([]);
  });
});

describe('check-in: chat actions that were not on offer', () => {
  it('says which chat actions it has, and records a post it asked for that went nowhere', async () => {
    const s = await league(QUIET);
    const model = new ScriptedModelClient({
      script: () =>
        ({
          steps: [],
          decision: {
            summary: 'Fired one shot at Team 3.',
            actions: [
              { type: 'post_chat', message: 'Team 3 cannot score.' },
              { type: 'matchup_post', message: 'See you Sunday.' }
            ]
          }
        }) as FakeScript
    });
    // Something to think about (a placeholder name), but no roll passed: no chat is on offer.
    const record = await run(s, checkIn(rolled(QUIET, []), { naming: 'placeholder' }), model);
    const prompt = model.transcript[0]?.systemPrompt ?? '';
    expect(prompt).toContain('No chat actions are on offer this check-in');
    // The model left out the rename, but a placeholder never stays: the fallback named the team.
    expect(record.finalAction).toBe('rename_team+chat_not_sent');
    expect(record.reasoningSummary).toContain('Fired one shot at Team 3.');
    expect(record.reasoningSummary).toContain('no board post was on offer this time: nothing went out.');
    expect(record.reasoningSummary).toContain('matchup talk was not on offer this time: nothing went out.');
    expect(await posted(s, 'trash-talk')).toEqual([]);
    expect(await posted(s, ROOM)).toEqual([]);
  });

  it('lists the chat actions a roll offered', async () => {
    const s = await league(LOUD);
    const model = new ScriptedModelClient();
    await run(s, checkIn(rolled(LOUD, ['board'])), model);
    expect(model.transcript[0]?.systemPrompt ?? '').toContain(
      'Chat actions on offer this check-in: post_chat.'
    );
  });
});

describe('check-in: no claim of a move the turn did not make (#264)', () => {
  it('cuts "Offer sent." from a board post when no offer went out, and says so', async () => {
    const s = await league(LOUD);
    const model = scripted([
      { type: 'post_chat', room: 'waivers-news', message: 'Cooper Kupp is a solid pickup. Offer sent.' }
    ]);
    const record = await run(s, checkIn(rolled(LOUD, ['board'])), model);
    expect(model.transcript[0]?.systemPrompt).toContain(MOVES_NOT_MADE);
    expect((await posted(s, 'waivers-news')).map((m) => m.text)).toEqual(['Cooper Kupp is a solid pickup.']);
    expect(record.reasoningSummary).toContain(
      'Posted in #waivers-news about the league news. Cut a line claiming a move I did not make.'
    );
  });

  it('holds back a post that is nothing but the claim', async () => {
    const s = await league(LOUD);
    const back = await s.repos.players.get('team-3-rb1');
    await s.repos.players.putMany([{ ...back!, injuryStatus: 'Out' }]);
    const record = await run(
      s,
      checkIn(rolled(LOUD, ['matchup'])),
      scripted([{ type: 'matchup_post', message: 'Offer sent, take it or leave it.' }])
    );
    expect(record.finalAction).toContain('chat_withheld');
    expect(record.reasoningSummary).toContain('Held back a post in my matchup room: it claimed a move');
    expect(await posted(s, ROOM)).toEqual([]);
  });
});

describe('check-in: private memory stays out of public posts (#263)', () => {
  it('holds back matchup talk about an offer turned down in private', async () => {
    const s = await league(LOUD);
    const back = await s.repos.players.get('team-3-rb1');
    await s.repos.players.putMany([{ ...back!, injuryStatus: 'Out' }]);
    const model = scripted([
      { type: 'matchup_post', message: 'remember when I turned down your trade offer on 2025-09-09?' }
    ]);
    const record = await run(s, checkIn(rolled(LOUD, ['matchup'])), model);
    expect(model.transcript[0]?.systemPrompt).toContain(PUBLIC_POSTS);
    expect(await posted(s, ROOM)).toEqual([]);
    expect(record.finalAction).toContain('chat_withheld');
    // The activity log says why, without the words.
    expect(record.reasoningSummary).toContain(
      'Held back a post in my matchup room: it touched on a private move.'
    );
    expect(record.reasoningSummary).not.toContain('2025-09-09');
  });
});
