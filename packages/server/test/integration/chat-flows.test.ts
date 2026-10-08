import { effectiveManager } from '@fantasy/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentPrincipal } from '../../src/auth/principal.js';
import type { ChatMessage } from '../../src/chat/model.js';
import type { Services } from '../../src/context.js';
import { registry } from '../../src/operations/index.js';
import { authorizeSubscribe } from '../../src/realtime/authorizer.js';
import {
  InMemoryRealtime,
  leagueChannel,
  seatTenureKey,
  teamChannel,
  type Realtime
} from '../../src/realtime/realtime.js';
import { relayEvent } from '../../src/realtime/relay.js';
import { silentLogger } from '../../src/log.js';
import { invokeTool } from '../../src/registry/invoke.js';
import { createHarness, type Harness } from '../support/harness.js';
import { as, data, errorCode } from '../support/league-client.js';
import { ALICE, BOB, CAROL, seedLeague } from '../support/leagues.js';

const L = '/leagues/lg-chat';
type Page = { messages: ChatMessage[]; nextCursor: string | null };

for (const backend of ['memory', 'dynamo'] as const) {
  describe(`group chat through the REST adapter (${backend})`, () => {
    let h: Harness;
    beforeEach(async () => {
      h = await createHarness({ backend });
      // team-1 Alice (commissioner), team-2 Bob, team-3 and team-4 agent seats.
      await seedLeague(h.repos, { id: 'lg-chat', owners: [ALICE, BOB], teamCount: 4 });
    });
    afterEach(() => h.close());

    it('posts, reads newest first, and pages with the after cursor', async () => {
      const alice = as(h, ALICE);
      for (const text of ['one', 'two', 'three']) {
        const res = await alice.post(`${L}/chat/messages`, { text: `  ${text}  ` });
        expect(res.status).toBe(200);
        h.clock.advance(1000);
      }
      const first = data<Page>(await as(h, BOB).get(`${L}/chat/messages?limit=2`));
      expect(first.messages.map((m) => m.text)).toEqual(['three', 'two']);
      expect(first.messages[0]).toMatchObject({
        kind: 'user',
        author: { teamId: 'team-1', teamName: "Alice's Team", name: 'Alice' },
        event: null,
        mentionedTeamIds: []
      });
      expect(first.nextCursor).not.toBeNull();
      const second = data<Page>(
        await alice.get(`${L}/chat/messages?limit=2&after=${encodeURIComponent(first.nextCursor ?? '')}`)
      );
      expect(second).toEqual({ messages: [expect.objectContaining({ text: 'one' })], nextCursor: null });

      const posted = h.events.events.filter((e) => e.detailType === 'Chat Message Posted');
      expect(posted).toHaveLength(3);
      expect(posted[0]?.detail).toMatchObject({ leagueId: 'lg-chat', message: { text: 'one' } });
    });

    it('turns @mentions into Chat Mention events for the other teams', async () => {
      const res = await as(h, BOB).post(`${L}/chat/messages`, {
        text: "@team-3 your bench is a crime scene. @Alice's Team too. @Bob's Team I'm fine."
      });
      expect(data<{ message: ChatMessage }>(res).message.mentionedTeamIds).toEqual([
        'team-3',
        'team-1',
        'team-2'
      ]);
      const mention = h.events.events.find((e) => e.detailType === 'Chat Mention');
      expect(mention?.detail).toEqual({
        leagueId: 'lg-chat',
        roomId: 'trash-talk',
        messageId: data<{ message: ChatMessage }>(res).message.id,
        authorTeamId: 'team-2',
        authorType: 'user',
        mentionedTeamIds: ['team-3', 'team-1'],
        addressedBy: 'mention',
        replyToAgentDepth: 0
      });
      await as(h, BOB).post(`${L}/chat/messages`, { text: 'no mentions here, alice@example.com' });
      expect(h.events.events.filter((e) => e.detailType === 'Chat Mention')).toHaveLength(1);
    });

    it('names AI managers as authors and lets people @mention them by name (#159)', async () => {
      await as(h, ALICE).put(`${L}/agents/team-4`, {
        personalityId: 'stats-nerd',
        difficulty: 'pro',
        archetype: 'balanced',
        name: 'Priya Okafor',
        avatarSeed: 'priya-1'
      });
      const res = await as(h, BOB).post(`${L}/chat/messages`, { text: '@Priya Okafor bring it.' });
      expect(data<{ message: ChatMessage }>(res).message.mentionedTeamIds).toEqual(['team-4']);
      const agent = agentPrincipal({ agentId: 'lg-chat.team-4', teamId: 'team-4', leagueId: 'lg-chat' });
      const reply = await invokeTool({
        registry,
        services: h.services,
        principal: agent,
        name: 'post_message',
        args: { leagueId: 'lg-chat', text: 'Brought. - Priya', idempotencyKey: 'agent-chat-0101' }
      });
      expect((reply.body as { data: { message: ChatMessage } }).data.message.author).toEqual({
        teamId: 'team-4',
        teamName: 'Team 4',
        name: 'Priya Okafor',
        avatarSeed: 'priya-1'
      });
    });

    it('filters by since and mentions of me, and returns compact messages on request', async () => {
      const alice = as(h, ALICE);
      const bob = as(h, BOB);
      await alice.post(`${L}/chat/messages`, { text: '@Bob old news' });
      h.clock.advance(60_000);
      const since = h.clock.now().toISOString();
      h.clock.advance(1000);
      for (const text of ['@Bob one', 'nothing for bob', '@Bob two', '@Bob three']) {
        await alice.post(`${L}/chat/messages`, { text });
        h.clock.advance(1000);
      }
      const recent = data<Page>(await bob.get(`${L}/chat/messages?since=${encodeURIComponent(since)}`));
      expect(recent.messages.map((m) => m.text)).toEqual([
        '@Bob three',
        '@Bob two',
        'nothing for bob',
        '@Bob one'
      ]);
      expect(recent.nextCursor).toBeNull();

      const mine = data<Page>(await bob.get(`${L}/chat/messages?mentionsMe=true&limit=2`));
      expect(mine.messages.map((m) => m.text)).toEqual(['@Bob three', '@Bob two']);
      const rest = data<Page>(
        await bob.get(`${L}/chat/messages?mentionsMe=true&after=${encodeURIComponent(mine.nextCursor ?? '')}`)
      );
      expect(rest).toEqual({
        messages: [
          expect.objectContaining({ text: '@Bob one' }),
          expect.objectContaining({ text: '@Bob old news' })
        ],
        nextCursor: null
      });
      expect(data<Page>(await alice.get(`${L}/chat/messages?mentionsMe=true`)).messages).toEqual([]);

      const compact = data<{ messages: unknown[] }>(await bob.get(`${L}/chat/messages?detail=false&limit=1`));
      expect(compact.messages).toEqual([
        {
          id: expect.any(String),
          roomId: 'trash-talk',
          kind: 'user',
          author: 'Alice',
          teamId: 'team-1',
          text: '@Bob three',
          mentionedTeamIds: ['team-2'],
          createdAt: expect.any(String)
        }
      ]);
    });

    it('stops a filtered read after a bounded scan and hands back a cursor', async () => {
      // 5 pages of 100 messages that do not mention Bob, then one that does.
      const league = 'lg-chat';
      const base = Date.parse(h.clock.now().toISOString());
      await h.repos.chat.put({
        id: 'm-old',
        leagueId: league,
        roomId: 'trash-talk',
        kind: 'user',
        author: { teamId: 'team-1', teamName: "Alice's Team", name: 'Alice' },
        text: '@Bob found me',
        mentionedTeamIds: ['team-2'],
        event: null,
        createdAt: new Date(base).toISOString()
      });
      for (let i = 1; i <= 500; i++) {
        await h.repos.chat.put({
          id: `m-${i}`,
          leagueId: league,
          roomId: 'trash-talk',
          kind: 'user',
          author: { teamId: 'team-1', teamName: "Alice's Team", name: 'Alice' },
          text: `filler ${i}`,
          mentionedTeamIds: [],
          event: null,
          createdAt: new Date(base + i * 1000).toISOString()
        });
      }
      const first = data<Page>(await as(h, BOB).get(`${L}/chat/messages?mentionsMe=true`));
      expect(first.messages).toEqual([]);
      expect(first.nextCursor).not.toBeNull();
      const next = data<Page>(
        await as(h, BOB).get(
          `${L}/chat/messages?mentionsMe=true&after=${encodeURIComponent(first.nextCursor ?? '')}`
        )
      );
      expect(next.messages.map((m) => m.id)).toEqual(['m-old']);
    });

    it('moderates every message: strips control characters and refuses harassment', async () => {
      const posted = await as(h, BOB).post(`${L}/chat/messages`, { text: 'nice\u0000 pick\u200B' });
      expect(data<{ message: ChatMessage }>(posted).message.text).toBe('nice pick');
      const blocked = await as(h, BOB).post(`${L}/chat/messages`, { text: 'just k1ll yourself' });
      expect(blocked.status).toBe(400);
      expect(blocked.body).toMatchObject({
        error: { code: 'MESSAGE_BLOCKED', fix: expect.stringMatching(/Rewrite/) }
      });
      expect(errorCode(await as(h, BOB).post(`${L}/chat/messages`, { text: '\u200B\u0007' }))).toBe(
        'INVALID_INPUT'
      );
      const principal = agentPrincipal({ agentId: 'lg-chat.team-3', teamId: 'team-3', leagueId: 'lg-chat' });
      const agent = await invokeTool({
        registry,
        services: h.services,
        principal,
        name: 'post_message',
        args: { leagueId: 'lg-chat', text: 'KYS @Bob', idempotencyKey: 'agent-chat-mod1' }
      });
      expect(agent.body).toMatchObject({ error: { code: 'MESSAGE_BLOCKED' } });
    });

    it('gives a commissioner without a seat no mentions and no team channel', async () => {
      await seedLeague(h.repos, {
        id: 'lg-seatless',
        owners: [ALICE, BOB],
        teamCount: 4,
        overrides: { commissionerId: CAROL.sub, commissionerName: CAROL.name }
      });
      await as(h, ALICE).post('/leagues/lg-seatless/chat/messages', { text: '@team-3 hello' });
      const carol = as(h, CAROL);
      expect(
        data<Page>(await carol.get('/leagues/lg-seatless/chat/messages?mentionsMe=true')).messages
      ).toEqual([]);
      (h.services as { realtime: Realtime }).realtime = realtimeOn();
      expect(data(await carol.get('/leagues/lg-seatless/realtime'))).toMatchObject({
        enabled: true,
        channels: { league: '/fantasy/league/lg-seatless', team: null }
      });
      // The commissioner may still hear the league.
      expect(await authorizeSubscribe(h.repos, CAROL.sub, leagueChannel('lg-seatless'))).toBeNull();
    });

    it('replays a repeated Idempotency-Key instead of posting twice', async () => {
      const alice = as(h, ALICE);
      const a = await alice.post(`${L}/chat/messages`, { text: 'once' }, 'chat-key-0001');
      const b = await alice.post(`${L}/chat/messages`, { text: 'once' }, 'chat-key-0001');
      expect(data<{ message: ChatMessage }>(b).message.id).toBe(data<{ message: ChatMessage }>(a).message.id);
      expect(data<Page>(await alice.get(`${L}/chat/messages`)).messages).toHaveLength(1);
    });

    it('rate-limits bursts and says how long to wait', async () => {
      const bob = as(h, BOB);
      for (let i = 0; i < 5; i++) {
        expect((await bob.post(`${L}/chat/messages`, { text: `spam ${i}` })).status).toBe(200);
        h.clock.advance(2000);
      }
      const limited = await bob.post(`${L}/chat/messages`, { text: 'one more' });
      expect(limited.status).toBe(429);
      expect(limited.body).toMatchObject({
        error: { code: 'RATE_LIMITED', details: { retryAfterSeconds: 50 } }
      });
      // Other people are not affected, and the window slides.
      expect((await as(h, ALICE).post(`${L}/chat/messages`, { text: 'hi' })).status).toBe(200);
      h.clock.advance(51_000);
      expect((await bob.post(`${L}/chat/messages`, { text: 'back' })).status).toBe(200);
    });

    it('validates length, cursors, and membership', async () => {
      const alice = as(h, ALICE);
      expect(errorCode(await alice.post(`${L}/chat/messages`, { text: '   ' }))).toBe('INVALID_INPUT');
      expect(errorCode(await alice.post(`${L}/chat/messages`, { text: 'x'.repeat(1001) }))).toBe(
        'INVALID_INPUT'
      );
      expect(errorCode(await alice.get(`${L}/chat/messages?after=bm9wZQ`))).toBe('INVALID_INPUT');
      expect(errorCode(await as(h, CAROL).get(`${L}/chat/messages`))).toBe('FORBIDDEN');
      expect(errorCode(await as(h, CAROL).post(`${L}/chat/messages`, { text: 'hi' }))).toBe('FORBIDDEN');
      expect(errorCode(await as(h, CAROL).get(`${L}/realtime`))).toBe('FORBIDDEN');
    });

    it('lets agents post through the same operation, as their own team', async () => {
      const principal = agentPrincipal({ agentId: 'lg-chat.team-3', teamId: 'team-3', leagueId: 'lg-chat' });
      const result = await invokeTool({
        registry,
        services: h.services,
        principal,
        name: 'post_message',
        args: {
          leagueId: 'lg-chat',
          text: '@Bob nice lineup. For a bye week.',
          idempotencyKey: 'agent-chat-0001'
        }
      });
      expect(result.status).toBe(200);
      const message = (result.body as { data: { message: ChatMessage } }).data.message;
      // An unconfigured seat speaks as its default manager (#159).
      const manager = effectiveManager(null, 'lg-chat.team-3');
      expect(message).toMatchObject({
        kind: 'agent',
        author: { teamId: 'team-3', teamName: 'Team 3', name: manager.name, avatarSeed: manager.avatarSeed },
        mentionedTeamIds: ['team-2']
      });
      expect(h.events.events.find((e) => e.detailType === 'Chat Mention')?.detail).toMatchObject({
        authorType: 'agent',
        authorTeamId: 'team-3'
      });
      const outsider = agentPrincipal({ agentId: 'x', teamId: 'team-9', leagueId: 'lg-chat' });
      const denied = await invokeTool({
        registry,
        services: h.services,
        principal: outsider,
        name: 'post_message',
        args: { leagueId: 'lg-chat', text: 'hi', idempotencyKey: 'agent-chat-0002' }
      });
      expect(denied.status).toBe(403);
    });

    it('addresses an untagged follow-up to the AI manager a person is going back and forth with', async () => {
      const agent = agentPrincipal({ agentId: 'lg-chat.team-3', teamId: 'team-3', leagueId: 'lg-chat' });
      const post = async (text: string, replyToId?: string) => {
        const result = await invokeTool({
          registry,
          services: h.services,
          principal: agent,
          name: 'post_message',
          args: {
            leagueId: 'lg-chat',
            text,
            idempotencyKey: `agent-${text.length}-${replyToId ?? ''}`,
            replyToId
          }
        });
        return (result.body as { data: { message: ChatMessage } }).data.message;
      };
      const say = async (who: typeof BOB, text: string) =>
        data<{ message: ChatMessage }>(await as(h, who).post(`${L}/chat/messages`, { text })).message;
      const mentions = () =>
        h.events.events
          .filter((e) => e.detailType === 'Chat Mention')
          .map((e) => e.detail as Record<string, unknown>);

      const asked = await say(BOB, '@team-3 who is your RB1 now?');
      h.clock.advance(30_000);
      await post('Still mine, and still better than yours.', asked.id);
      h.clock.advance(30_000);
      const followUp = await say(BOB, 'Prove it.');
      // The message's mentions stay what was written; the addressee travels on its own.
      expect(followUp.mentionedTeamIds).toEqual([]);
      expect(followUp.addressedTeamIds).toEqual(['team-3']);
      expect(mentions().at(-1)).toEqual({
        leagueId: 'lg-chat',
        roomId: 'trash-talk',
        messageId: followUp.id,
        authorTeamId: 'team-2',
        authorType: 'user',
        mentionedTeamIds: ['team-3'],
        addressedBy: 'continuation',
        replyToAgentDepth: 0
      });
      // It is not a notification: the person's toast still comes from mentions only.
      const posted = h.events.events.filter((e) => e.detailType === 'Chat Message Posted').at(-1);
      expect(posted?.detail).toMatchObject({
        message: { mentionedTeamIds: [], addressedTeamIds: ['team-3'] }
      });

      // Another person stepping in to address the agent ends it for Bob.
      await say(ALICE, '@team-3 leave him alone.');
      const count = mentions().length;
      const after = await say(BOB, 'Whatever.');
      expect(after.addressedTeamIds).toBeUndefined();
      expect(mentions()).toHaveLength(count);

      // And the exchange lapses after the window.
      await post('Anyway.', after.id);
      h.clock.advance(11 * 60_000);
      expect((await say(BOB, 'Hello?')).addressedTeamIds).toBeUndefined();
    });

    it('records the earlier messages a reply also answers, checked against the room (#215)', async () => {
      const agent = agentPrincipal({ agentId: 'lg-chat.team-3', teamId: 'team-3', leagueId: 'lg-chat' });
      let key = 0;
      const post = (args: Record<string, unknown>) =>
        invokeTool({
          registry,
          services: h.services,
          principal: agent,
          name: 'post_message',
          args: { leagueId: 'lg-chat', idempotencyKey: `agent-answers-${++key}`, ...args }
        });
      const say = async (who: typeof BOB, text: string) =>
        data<{ message: ChatMessage }>(await as(h, who).post(`${L}/chat/messages`, { text })).message;
      const first = await say(BOB, '@team-3 you up?');
      h.clock.advance(1_000);
      const second = await say(BOB, '@team-3 who is your RB1?');
      h.clock.advance(1_000);
      const answered = await post({
        text: 'Up, and he is still mine.',
        replyToId: second.id,
        answersMessageIds: [first.id, first.id, second.id]
      });
      expect(answered.status).toBe(200);
      expect((answered.body as { data: { message: ChatMessage } }).data.message).toMatchObject({
        replyToId: second.id,
        answersMessageIds: [first.id]
      });
      // Only with a reply, only other people's messages, never a newer one or an unknown one.
      const mine = (answered.body as { data: { message: ChatMessage } }).data.message;
      h.clock.advance(1_000);
      const third = await say(BOB, '@team-3 and?');
      for (const args of [
        { text: 'No reply.', answersMessageIds: [first.id] },
        { text: 'My own.', replyToId: third.id, answersMessageIds: [mine.id] },
        { text: 'Newer.', replyToId: second.id, answersMessageIds: [third.id] },
        { text: 'Unknown.', replyToId: third.id, answersMessageIds: ['nope'] }
      ]) {
        const refused = await post(args);
        expect(refused.status, args.text).toBe(400);
        expect(refused.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });
      }
    });

    it('lists post_message in allowedActions for members', async () => {
      const res = await as(h, BOB).get(`${L}/chat/messages`);
      expect((res.body as { league: { allowedActions: string[] } }).league.allowedActions).toContain(
        'post_message'
      );
    });

    it('has no realtime endpoint when realtime is off, so the app polls', async () => {
      expect(data(await as(h, BOB).get(`${L}/realtime`))).toEqual({
        enabled: false,
        httpHost: null,
        realtimeHost: null,
        channels: null,
        refreshAt: null,
        pollIntervalSeconds: 5
      });
    });

    it("hands out the endpoint, the league channel, and the caller's own team channel when realtime is on", async () => {
      (h.services as { realtime: Realtime }).realtime = realtimeOn();
      const bobs = await h.repos.teams.get('lg-chat', 'team-2');
      expect(data(await as(h, BOB).get(`${L}/realtime`))).toEqual({
        enabled: true,
        httpHost: 'api.example',
        realtimeHost: 'realtime.example',
        channels: {
          league: '/fantasy/league/lg-chat',
          global: '/fantasy/global',
          team: teamChannel('lg-chat', 'team-2', seatTenureKey(bobs!))
        },
        refreshAt: new Date(h.clock.now().getTime() + 30 * 60_000).toISOString(),
        pollIntervalSeconds: 5
      });
      expect(registry.get('get_realtime_config')?.auth).toBe('user');
    });

    it('cuts a person who leaves their seat off the team channel at once (#281)', async () => {
      (h.services as { realtime: Realtime }).realtime = realtimeOn();
      const before = data<{ channels: { league: string; team: string } }>(
        await as(h, BOB).get(`${L}/realtime`)
      ).channels;
      expect(await authorizeSubscribe(h.repos, BOB.sub, before.team)).toBeNull();
      expect(await authorizeSubscribe(h.repos, BOB.sub, before.league)).toBeNull();
      expect(await authorizeSubscribe(h.repos, ALICE.sub, before.team)).toMatch(/do not hold this seat/);

      expect((await as(h, BOB).post(`${L}/leave`, {})).status).toBe(200);
      // His next subscribe or reconnect is refused, for the team and for the league.
      expect(await authorizeSubscribe(h.repos, BOB.sub, before.team)).toMatch(/do not hold this seat/);
      expect(await authorizeSubscribe(h.repos, BOB.sub, before.league)).toMatch(/not a member/);
      // A socket he still holds hears nothing more: the seat's messages go to a new channel.
      const realtime = new InMemoryRealtime();
      const relayed = await relayEvent(
        realtime,
        silentLogger,
        {
          id: 'evt-after-leave',
          source: 'fantasy',
          'detail-type': 'Notification Created',
          detail: { leagueId: 'lg-chat', teamId: 'team-2', notification: { id: 'n1' } }
        },
        h.repos.teams
      );
      const now = teamChannel(
        'lg-chat',
        'team-2',
        seatTenureKey((await h.repos.teams.get('lg-chat', 'team-2'))!)
      );
      expect(relayed.channels).toEqual([now]);
      expect(now).not.toBe(before.team);
    });
  });
}

describe('system messages and chat in one partition', () => {
  it('stores system messages in their room beside people, idempotently per event', async () => {
    const h = await createHarness({ backend: 'dynamo' });
    try {
      await seedLeague(h.repos, { id: 'lg-chat', owners: [ALICE, BOB], teamCount: 4 });
      const { postSystemMessage } = await import('../../src/chat/system-messages.js');
      const event = {
        id: 'evt-1',
        source: 'fantasy',
        'detail-type': 'Draft Pick Made',
        time: '2026-09-10T11:00:00Z',
        detail: {
          leagueId: 'lg-chat',
          teamId: 'team-2',
          player: { name: 'Bijan Robinson' },
          round: 1,
          pick: 2
        }
      };
      const services: Services = h.services;
      expect((await postSystemMessage(services, event)).status).toBe('posted');
      expect(await postSystemMessage(services, event)).toEqual({
        status: 'duplicate',
        messageId: 'sys-evt-1'
      });
      await as(h, ALICE).post(`${L}/chat/messages`, { roomId: 'draft', text: 'great pick' });
      const page = data<Page>(await as(h, ALICE).get(`${L}/chat/messages?roomId=draft`));
      expect(page.messages.map((m) => [m.kind, m.text])).toEqual([
        ['user', 'great pick'],
        ['system', "Bob's Team drafted Bijan Robinson (round 1, pick 2)."]
      ]);
      expect(data<Page>(await as(h, ALICE).get(`${L}/chat/messages`)).messages).toEqual([]);
      expect(page.messages[1]).toMatchObject({
        id: 'sys-evt-1',
        roomId: 'draft',
        author: { teamId: null, name: 'League' },
        event: { detailType: 'Draft Pick Made', eventId: 'evt-1' },
        createdAt: '2026-09-10T11:00:00.000Z'
      });
    } finally {
      await h.close();
    }
  });
});

function realtimeOn(): Realtime {
  return {
    endpoint: () => ({ httpHost: 'api.example', realtimeHost: 'realtime.example' }),
    publish: async () => undefined
  };
}
