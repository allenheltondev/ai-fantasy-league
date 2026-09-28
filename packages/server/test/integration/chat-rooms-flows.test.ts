import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentPrincipal } from '../../src/auth/principal.js';
import type { ChatMessage } from '../../src/chat/model.js';
import { silentLogger } from '../../src/log.js';
import { registry } from '../../src/operations/index.js';
import { InMemoryRealtime, leagueTopic, teamTopic } from '../../src/realtime/realtime.js';
import { relayEvent } from '../../src/realtime/relay.js';
import type { TableContext } from '../../src/repos/dynamo/table.js';
import type { Matchup } from '../../src/repos/types.js';
import { invokeTool } from '../../src/registry/invoke.js';
import { createHarness, type Harness } from '../support/harness.js';
import { as, data, errorCode } from '../support/league-client.js';
import { ALICE, BOB, CAROL, seedLeague } from '../support/leagues.js';

const LG = 'lg-rooms';
const L = `/leagues/${LG}`;
const DM = 'dm-team-2-team-3';
type Page = { messages: ChatMessage[]; nextCursor: string | null };
interface Room {
  roomId: string;
  kind: string;
  title: string;
  archived: boolean;
  week: number | null;
  teamIds: string[];
  lastMessageAt: string | null;
  unreadCount: number;
}
type Rooms = { defaultRoomId: string; rooms: Room[] };

const matchup = (week: number, n: number, home: string, away: string): Matchup => ({
  id: `W0${week}-${n}`,
  leagueId: LG,
  week,
  kind: 'regular',
  homeTeamId: home,
  awayTeamId: away,
  homeScore: null,
  awayScore: null,
  status: 'scheduled'
});

const agent = (teamId: string) => agentPrincipal({ agentId: `${LG}.${teamId}`, teamId, leagueId: LG });

for (const backend of ['memory', 'dynamo'] as const) {
  describe(`chat rooms through the REST adapter (${backend})`, () => {
    let h: Harness;
    let seq = 0;
    const tool = (teamId: string, name: string, args: Record<string, unknown>) =>
      invokeTool({
        registry,
        services: h.services,
        principal: agent(teamId),
        name,
        args: {
          leagueId: LG,
          ...args,
          ...(name === 'get_chat' || name === 'list_chat_rooms'
            ? {}
            : { idempotencyKey: `rooms-tool-${++seq}` })
        }
      });

    beforeEach(async () => {
      h = await createHarness({ backend });
      // team-1 Alice (commissioner), team-2 Bob, team-3 agent, team-4 Carol, team-5 and team-6 agents.
      await seedLeague(h.repos, {
        id: LG,
        owners: [ALICE, BOB, null, CAROL],
        teamCount: 6,
        overrides: { phase: 'regular_season', week: 5 }
      });
      await h.repos.schedule.putMatchups([
        matchup(4, 1, 'team-1', 'team-2'),
        matchup(4, 2, 'team-3', 'team-4'),
        matchup(4, 3, 'team-5', 'team-6'),
        matchup(5, 1, 'team-2', 'team-3'),
        matchup(5, 2, 'team-4', 'team-1'),
        matchup(5, 3, 'team-6', 'team-5'),
        matchup(6, 1, 'team-1', 'team-3')
      ]);
    });
    afterEach(() => h.close());

    it('lists the fixed rooms and this week’s and last week’s matchup rooms, with unread counts', async () => {
      const alice = as(h, ALICE);
      const bob = as(h, BOB);
      const empty = data<Rooms>(await bob.get(`${L}/chat/rooms`));
      expect(empty.defaultRoomId).toBe('trash-talk');
      expect(empty.rooms.map((r) => [r.roomId, r.kind, r.title])).toEqual([
        ['league', 'fixed', 'League'],
        ['trash-talk', 'fixed', 'Trash Talk'],
        ['draft', 'fixed', 'Draft'],
        ['trades', 'fixed', 'Trades'],
        ['waivers-news', 'fixed', 'Waivers & News'],
        ['m-2026-W05-W05-1', 'matchup', "Wk 5: Bob's Team vs Team 3"],
        ['m-2026-W05-W05-2', 'matchup', "Wk 5: Carol's Team vs Alice's Team"],
        ['m-2026-W05-W05-3', 'matchup', 'Wk 5: Team 6 vs Team 5'],
        ['m-2026-W04-W04-1', 'matchup', "Wk 4: Alice's Team vs Bob's Team"],
        ['m-2026-W04-W04-2', 'matchup', "Wk 4: Team 3 vs Carol's Team"],
        ['m-2026-W04-W04-3', 'matchup', 'Wk 4: Team 5 vs Team 6']
      ]);
      expect(empty.rooms[5]).toEqual({
        roomId: 'm-2026-W05-W05-1',
        kind: 'matchup',
        title: "Wk 5: Bob's Team vs Team 3",
        archived: false,
        week: 5,
        teamIds: ['team-2', 'team-3'],
        lastMessageAt: null,
        unreadCount: 0
      });

      for (const text of ['one', 'two']) {
        expect((await alice.post(`${L}/chat/messages`, { roomId: 'draft', text })).status).toBe(200);
        h.clock.advance(1000);
      }
      await alice.post(`${L}/chat/messages`, {
        roomId: 'm-2026-W05-W05-3',
        text: 'any member can talk here'
      });
      const unread = (rooms: Rooms) =>
        Object.fromEntries(
          rooms.rooms.filter((r) => r.unreadCount > 0).map((r) => [r.roomId, r.unreadCount])
        );
      const bobs = data<Rooms>(await bob.get(`${L}/chat/rooms`));
      expect(unread(bobs)).toEqual({ draft: 2, 'm-2026-W05-W05-3': 1 });
      expect(bobs.rooms.find((r) => r.roomId === 'draft')?.lastMessageAt).toBe('2026-09-10T12:00:01.000Z');
      // Your own messages are read.
      expect(unread(data<Rooms>(await alice.get(`${L}/chat/rooms`)))).toEqual({});

      const marked = await bob.post(`${L}/chat/rooms/draft/read`);
      expect(data(marked)).toEqual({ roomId: 'draft', lastReadAt: h.clock.now().toISOString() });
      expect(unread(data<Rooms>(await bob.get(`${L}/chat/rooms`)))).toEqual({ 'm-2026-W05-W05-3': 1 });
      h.clock.advance(1000);
      await alice.post(`${L}/chat/messages`, { roomId: 'draft', text: 'three' });
      expect(unread(data<Rooms>(await bob.get(`${L}/chat/rooms`)))).toEqual({
        draft: 1,
        'm-2026-W05-W05-3': 1
      });

      // Agents keep their own read markers.
      expect((await tool('team-5', 'mark_room_read', { roomId: 'draft' })).status).toBe(200);
      const agentRooms = (await tool('team-5', 'list_chat_rooms', {})).body as { data: Rooms };
      expect(unread(agentRooms.data)).toEqual({ 'm-2026-W05-W05-3': 1 });
    });

    it('reads and posts per room, and trash talk (the default) holds the messages from before rooms', async () => {
      const alice = as(h, ALICE);
      const before = {
        id: 'legacy-1',
        leagueId: LG,
        kind: 'user',
        author: { teamId: 'team-2', teamName: "Bob's Team", name: 'Bob' },
        text: 'from the old group chat',
        mentionedTeamIds: [],
        event: null,
        createdAt: '2026-09-01T00:00:00.000Z'
      };
      if (backend === 'dynamo') {
        // Exactly as the chat stored it before rooms: no roomId.
        const table = (h.repos.chat as unknown as { table: TableContext }).table;
        await table.doc.send(
          new PutCommand({
            TableName: table.tableName,
            Item: { pk: `CHAT#${LG}`, sk: `MSG#${before.createdAt}#legacy-1`, entity: 'chat', ...before }
          })
        );
      } else {
        await h.repos.chat.put({ ...before, roomId: 'trash-talk', kind: 'user' });
      }
      await alice.post(`${L}/chat/messages`, { text: 'default room' });
      await alice.post(`${L}/chat/messages`, { roomId: 'trades', text: 'who wants my kicker' });
      const trash = data<Page>(await alice.get(`${L}/chat/messages`));
      expect(trash.messages.map((m) => [m.roomId, m.text])).toEqual([
        ['trash-talk', 'default room'],
        ['trash-talk', 'from the old group chat']
      ]);
      expect(data<Page>(await alice.get(`${L}/chat/messages?roomId=trash-talk`)).messages).toHaveLength(2);
      const trades = data<Page>(await as(h, CAROL).get(`${L}/chat/messages?roomId=trades`));
      expect(trades.messages.map((m) => m.text)).toEqual(['who wants my kicker']);
      const posted = h.events.events.filter((e) => e.detailType === 'Chat Message Posted');
      expect(posted.map((e) => [e.detail.roomId, e.detail.teamIds])).toEqual([
        ['trash-talk', null],
        ['trades', null]
      ]);

      // A cursor from one room is refused in another.
      for (let i = 0; i < 3; i++) await alice.post(`${L}/chat/messages`, { roomId: 'trades', text: `t${i}` });
      const page = data<Page>(await alice.get(`${L}/chat/messages?roomId=trades&limit=1`));
      expect(
        errorCode(await alice.get(`${L}/chat/messages?roomId=draft&after=${page.nextCursor ?? ''}`))
      ).toBe('INVALID_INPUT');
      for (const roomId of [
        'general',
        'dm-team-2-team-9',
        'm-2026-W06-W06-1',
        'm-2025-W05-W05-1',
        'm-2026-W05-W05-9'
      ]) {
        expect(errorCode(await alice.get(`${L}/chat/messages?roomId=${roomId}`)), roomId).toBe(
          'ROOM_NOT_FOUND'
        );
      }
      expect(errorCode(await alice.post(`${L}/chat/messages`, { roomId: 'bad room', text: 'x' }))).toBe(
        'INVALID_INPUT'
      );
    });

    it('archives last week’s matchup rooms once the week is official', async () => {
      const bob = as(h, BOB);
      const room = 'm-2026-W04-W04-1';
      expect(
        (await bob.post(`${L}/chat/messages`, { roomId: room, text: 'still arguing about week 4' })).status
      ).toBe(200);
      await h.repos.history.beginOfficialWeek(
        {
          leagueId: LG,
          week: 4,
          status: 'running',
          startedAt: h.clock.now().toISOString(),
          completedAt: null,
          provisional: [],
          corrections: 0,
          flipped: 0
        },
        '2000-01-01T00:00:00.000Z'
      );
      // A running official final does not archive anything yet.
      expect(data<Rooms>(await bob.get(`${L}/chat/rooms`)).rooms.some((r) => r.roomId === room)).toBe(true);
      await h.repos.history.completeOfficialWeek({
        leagueId: LG,
        week: 4,
        status: 'complete',
        startedAt: h.clock.now().toISOString(),
        completedAt: h.clock.now().toISOString(),
        provisional: [],
        corrections: 0,
        flipped: 0
      });
      const rooms = data<Rooms>(await bob.get(`${L}/chat/rooms`)).rooms;
      expect(rooms.filter((r) => r.kind === 'matchup').map((r) => r.week)).toEqual([5, 5, 5]);
      const past = data<Rooms>(await bob.get(`${L}/chat/rooms?pastWeek=4`)).rooms.filter((r) => r.week === 4);
      expect(past.map((r) => [r.roomId, r.archived, r.unreadCount])).toEqual([
        [room, true, 0],
        ['m-2026-W04-W04-2', true, 0],
        ['m-2026-W04-W04-3', true, 0]
      ]);
      expect(
        data<Rooms>(await bob.get(`${L}/chat/rooms?pastWeek=6`)).rooms.some((r) => r.kind === 'matchup')
      ).toBe(false);
      expect(data<Page>(await as(h, CAROL).get(`${L}/chat/messages?roomId=${room}`)).messages).toHaveLength(
        1
      );
      const refused = await bob.post(`${L}/chat/messages`, { roomId: room, text: 'one more thing' });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        error: { code: 'ROOM_ARCHIVED', fix: expect.stringMatching(/this week/) }
      });
      // Two weeks back is archived without an official record.
      await h.repos.leagues.update({ ...(await h.repos.leagues.get(LG))!, week: 6 });
      expect(errorCode(await bob.post(`${L}/chat/messages`, { roomId: 'm-2026-W04-W04-2', text: 'x' }))).toBe(
        'ROOM_ARCHIVED'
      );
      expect(
        (await bob.post(`${L}/chat/messages`, { roomId: 'm-2026-W06-W06-1', text: 'week 6!' })).status
      ).toBe(200);
    });

    it('keeps a DM between its two teams: others get FORBIDDEN, and the league topic never sees it', async () => {
      const bob = as(h, BOB);
      const res = await bob.post(`${L}/chat/messages`, {
        roomId: DM,
        text: 'psst @team-3, @Carol wants your RB'
      });
      expect(res.status).toBe(200);
      const message = data<{ message: ChatMessage }>(res).message;
      // In a DM only the other team can be mentioned, and it is always addressed.
      expect(message.mentionedTeamIds).toEqual(['team-3']);
      h.clock.advance(1000);
      const plain = await bob.post(`${L}/chat/messages`, { roomId: DM, text: 'no mention at all' });
      const mentions = h.events.events.filter((e) => e.detailType === 'Chat Mention').map((e) => e.detail);
      expect(mentions).toEqual([
        {
          leagueId: LG,
          roomId: DM,
          messageId: message.id,
          authorTeamId: 'team-2',
          authorType: 'user',
          mentionedTeamIds: ['team-3']
        },
        expect.objectContaining({
          messageId: data<{ message: ChatMessage }>(plain).message.id,
          mentionedTeamIds: ['team-3']
        })
      ]);

      // Third member, commissioner, and another team's agent: FORBIDDEN on every chat operation.
      for (const person of [CAROL, ALICE]) {
        const caller = as(h, person);
        expect(errorCode(await caller.get(`${L}/chat/messages?roomId=${DM}`)), person.name).toBe('FORBIDDEN');
        expect((await caller.get(`${L}/chat/messages?roomId=${DM}`)).status).toBe(403);
        expect(errorCode(await caller.post(`${L}/chat/messages`, { roomId: DM, text: 'let me in' }))).toBe(
          'FORBIDDEN'
        );
        expect(errorCode(await caller.post(`${L}/chat/rooms/${DM}/read`))).toBe('FORBIDDEN');
        expect(data<Rooms>(await caller.get(`${L}/chat/rooms`)).rooms.some((r) => r.kind === 'dm')).toBe(
          false
        );
      }
      for (const [name, args] of [
        ['get_chat', { roomId: DM }],
        ['post_message', { roomId: DM, text: 'hi' }],
        ['mark_room_read', { roomId: DM }]
      ] as const) {
        expect((await tool('team-5', name, args)).status, name).toBe(403);
      }

      // The agent in the DM reads it and answers.
      const read = (await tool('team-3', 'get_chat', { roomId: DM })).body as { data: Page };
      expect(read.data.messages.map((m) => m.text)).toEqual([
        'no mention at all',
        'psst @team-3, @Carol wants your RB'
      ]);
      h.clock.advance(1000);
      expect((await tool('team-3', 'post_message', { roomId: DM, text: 'Make me an offer.' })).status).toBe(
        200
      );
      const bobsRooms = data<Rooms>(await bob.get(`${L}/chat/rooms`));
      expect(bobsRooms.rooms.filter((r) => r.kind === 'dm')).toEqual([
        {
          roomId: DM,
          kind: 'dm',
          title: 'Team 3',
          archived: false,
          week: null,
          teamIds: ['team-2', 'team-3'],
          lastMessageAt: expect.any(String),
          unreadCount: 1
        }
      ]);
      const agentRooms = ((await tool('team-3', 'list_chat_rooms', {})).body as { data: Rooms }).data;
      expect(agentRooms.rooms.find((r) => r.kind === 'dm')?.title).toBe("Bob's Team");

      // Relay every event: DM content reaches only the two team topics.
      const realtime = new InMemoryRealtime();
      for (const [i, e] of h.events.events.entries()) {
        await relayEvent(realtime, silentLogger, {
          id: `e${i}`,
          source: 'fantasy',
          'detail-type': e.detailType,
          detail: e.detail
        });
      }
      expect(realtime.published.filter((p) => p.topic === leagueTopic(LG))).toEqual([]);
      expect([...new Set(realtime.published.map((p) => p.topic))].sort()).toEqual([
        teamTopic(LG, 'team-2'),
        teamTopic(LG, 'team-3')
      ]);
      expect(
        JSON.stringify(
          realtime.published.filter(
            (p) => p.topic !== teamTopic(LG, 'team-2') && p.topic !== teamTopic(LG, 'team-3')
          )
        )
      ).not.toContain('psst');
    });

    it('holds AI managers to daily chat budgets counted across every room', async () => {
      const agentPost = (teamId: string, i: number, hoursAgo: number) =>
        h.repos.chat.put({
          id: `agent-${teamId}-${i}`,
          leagueId: LG,
          roomId: ['trash-talk', 'draft', 'trades', 'm-2026-W05-W05-3'][i % 4] as string,
          kind: 'agent',
          author: { teamId, teamName: teamId, name: teamId },
          text: `beep ${i}`,
          mentionedTeamIds: [],
          event: null,
          createdAt: new Date(Date.parse(h.clock.now().toISOString()) - hoursAgo * 3_600_000).toISOString()
        });
      const budget = async (teamId: string) =>
        ((await tool(teamId, 'list_chat_rooms', {})).body as { data: { postingBudget: unknown } }).data
          .postingBudget;
      expect(await budget('team-5')).toEqual({ agentRemaining: 10, leagueRemaining: 30 });
      expect(
        data<{ postingBudget: unknown }>(await as(h, BOB).get(`${L}/chat/rooms`)).postingBudget
      ).toBeNull();
      // Nine from team-5 today (one more from yesterday does not count).
      for (let i = 0; i < 9; i++) await agentPost('team-5', i, 1 + i);
      await agentPost('team-5', 99, 25);
      expect(await budget('team-5')).toEqual({ agentRemaining: 1, leagueRemaining: 21 });
      expect((await tool('team-5', 'post_message', { roomId: 'league', text: 'last one' })).status).toBe(200);
      h.clock.advance(61_000);
      const refused = await tool('team-5', 'post_message', { roomId: 'draft', text: 'one too many' });
      expect(refused.status).toBe(429);
      expect(refused.body).toMatchObject({
        error: { code: 'RATE_LIMITED', details: { agentRemaining: 0, leagueRemaining: 20 } }
      });
      // The league budget binds every agent.
      for (let i = 0; i < 20; i++) await agentPost('team-6', i, 2);
      expect(await budget('team-3')).toEqual({ agentRemaining: 10, leagueRemaining: 0 });
      expect((await tool('team-3', 'post_message', { text: 'hello?' })).status).toBe(429);
      // People are not budgeted.
      expect((await as(h, BOB).post(`${L}/chat/messages`, { text: 'quiet in here' })).status).toBe(200);
    });

    it('rate-limits an author across rooms', async () => {
      const bob = as(h, BOB);
      for (const roomId of ['trash-talk', 'draft', 'trades', DM, 'm-2026-W05-W05-1']) {
        expect((await bob.post(`${L}/chat/messages`, { roomId, text: `hi ${roomId}` })).status).toBe(200);
        h.clock.advance(1000);
      }
      expect(errorCode(await bob.post(`${L}/chat/messages`, { roomId: 'league', text: 'again' }))).toBe(
        'RATE_LIMITED'
      );
      expect(
        (await as(h, CAROL).post(`${L}/chat/messages`, { roomId: 'league', text: 'me too' })).status
      ).toBe(200);
    });
  });
}
