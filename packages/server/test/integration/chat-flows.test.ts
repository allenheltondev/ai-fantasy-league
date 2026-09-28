import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentPrincipal } from '../../src/auth/principal.js';
import type { ChatMessage } from '../../src/chat/model.js';
import type { Services } from '../../src/context.js';
import { registry } from '../../src/operations/index.js';
import type { Realtime, RealtimeToken } from '../../src/realtime/realtime.js';
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
        messageId: data<{ message: ChatMessage }>(res).message.id,
        authorTeamId: 'team-2',
        authorType: 'user',
        mentionedTeamIds: ['team-3', 'team-1']
      });
      await as(h, BOB).post(`${L}/chat/messages`, { text: 'no mentions here, alice@example.com' });
      expect(h.events.events.filter((e) => e.detailType === 'Chat Mention')).toHaveLength(1);
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
      expect(message).toMatchObject({
        kind: 'agent',
        author: { teamId: 'team-3', teamName: 'Team 3', name: 'Team 3' },
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

    it('lists post_message in allowedActions for members', async () => {
      const res = await as(h, BOB).get(`${L}/chat/messages`);
      expect((res.body as { league: { allowedActions: string[] } }).league.allowedActions).toContain(
        'post_message'
      );
    });

    it('vends no realtime token when realtime is off, so the app polls', async () => {
      expect(data(await as(h, BOB).get(`${L}/realtime`))).toEqual({
        enabled: false,
        token: null,
        endpoint: null,
        cacheName: null,
        topics: null,
        expiresAt: null,
        pollIntervalSeconds: 5
      });
    });

    it('vends a subscribe-only token for the league when realtime is on', async () => {
      const requests: unknown[] = [];
      const realtime: Realtime = {
        async issueSubscribeToken(request): Promise<RealtimeToken> {
          requests.push(request);
          return {
            token: 'tok',
            endpoint: 'cell-1.example',
            cacheName: 'cache',
            topics: { league: 'fantasy.league.lg-chat', global: 'fantasy.global' },
            expiresAt: '2026-09-10T12:30:00.000Z'
          };
        },
        publish: async () => undefined
      };
      (h.services as { realtime: Realtime }).realtime = realtime;
      expect(data(await as(h, BOB).get(`${L}/realtime`))).toEqual({
        enabled: true,
        token: 'tok',
        endpoint: 'cell-1.example',
        cacheName: 'cache',
        topics: { league: 'fantasy.league.lg-chat', global: 'fantasy.global' },
        expiresAt: '2026-09-10T12:30:00.000Z',
        pollIntervalSeconds: 5
      });
      expect(requests).toEqual([{ leagueId: 'lg-chat', subscriber: 'user#bob', ttlSeconds: 1800 }]);
      expect(registry.get('get_realtime_token')?.auth).toBe('user');
    });
  });
}

describe('system messages and chat in one partition', () => {
  it('stores system messages beside people, idempotently per event', async () => {
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
      await as(h, ALICE).post(`${L}/chat/messages`, { text: 'great pick' });
      const page = data<Page>(await as(h, ALICE).get(`${L}/chat/messages`));
      expect(page.messages.map((m) => [m.kind, m.text])).toEqual([
        ['user', 'great pick'],
        ['system', "Bob's Team drafted Bijan Robinson (round 1, pick 2)."]
      ]);
      expect(page.messages[1]).toMatchObject({
        id: 'sys-evt-1',
        author: { teamId: null, name: 'League' },
        event: { detailType: 'Draft Pick Made', eventId: 'evt-1' },
        createdAt: '2026-09-10T11:00:00.000Z'
      });
    } finally {
      await h.close();
    }
  });
});
