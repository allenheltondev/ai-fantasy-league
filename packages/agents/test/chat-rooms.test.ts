import type { ChatMessage } from '@fantasy/server';
import { describe, expect, it } from 'vitest';
import { AgentActionRequestedSchema, type AgentActionRequested, type BusEvent } from '../src/events.js';
import { ScriptedModelClient } from '../src/fake-model.js';
import { routeEvent } from '../src/router.js';
import { runAgentAction } from '../src/runner.js';
import { DM_SUMMARY, roomPlace } from '../src/tasks/chat.js';
import { defaultTaskKinds } from '../src/tasks/index.js';
import { AGENT_TEAM, LEAGUE_ID, START, setup } from './support.js';

/**
 * Agents in chat rooms (issue #144): they answer in the room of the mention, react to a moment in
 * its room, answer direct messages, and never carry a DM's words anywhere else.
 */

const AGENT_ID = `${LEAGUE_ID}.${AGENT_TEAM}`;
const SEAT = { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'balanced' } as const;
const DM = 'dm-team-1-team-2';
const SECRET = 'Psst: I will give you my whole bench for your kicker';

let seq = 0;
function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: `m-${++seq}`,
    leagueId: LEAGUE_ID,
    roomId: 'trash-talk',
    kind: 'user',
    author: { teamId: 'team-1', teamName: "Allen's Team", name: 'Allen' },
    text: 'hello',
    mentionedTeamIds: [],
    event: null,
    createdAt: '2026-10-04T14:59:00.000Z',
    ...overrides
  };
}

function request(kind: 'chat_reply' | 'chat_moment', payload: Record<string, unknown>): AgentActionRequested {
  return {
    taskId: `${kind}.${++seq}`,
    leagueId: LEAGUE_ID,
    teamId: AGENT_TEAM,
    agentId: AGENT_ID,
    kind,
    trigger: {
      detailType: kind === 'chat_reply' ? 'Chat Mention' : 'Chat Moment',
      eventId: `e${seq}`,
      urgent: false
    },
    payload,
    requestedAt: START
  };
}

async function rooms() {
  const s = await setup();
  await s.seat(AGENT_TEAM, SEAT);
  // Every seat has had its occupant since the league was set up, before these conversations.
  for (const team of await s.repos.teams.list(LEAGUE_ID)) {
    await s.repos.teams.update({ ...team, occupiedSince: '2026-09-01T00:00:00.000Z' });
  }
  await s.repos.schedule.putMatchups([
    {
      id: 'W05-1',
      leagueId: LEAGUE_ID,
      week: 5,
      kind: 'regular',
      homeTeamId: 'team-1',
      awayTeamId: AGENT_TEAM,
      homeScore: 101,
      awayScore: 99,
      status: 'final'
    }
  ]);
  const posts = async (roomId: string) =>
    (await s.repos.chat.list(LEAGUE_ID, roomId, { limit: 100 })).messages.filter((m) => m.kind === 'agent');
  return { ...s, posts };
}

describe('agents in chat rooms (fake model)', () => {
  it('replies in the room of the mention, reading only that room', async () => {
    const s = await rooms();
    await s.repos.chat.put(message({ text: 'trash talk only' }));
    const mention = message({
      roomId: 'trades',
      text: '@Team 2 want my kicker for your backup QB?',
      mentionedTeamIds: [AGENT_TEAM]
    });
    await s.repos.chat.put(mention);
    const model = new ScriptedModelClient();
    const record = await runAgentAction(
      s.deps(model),
      request('chat_reply', { messageId: mention.id, roomId: 'trades' })
    );
    expect(record).toMatchObject({ status: 'completed', finalAction: 'post_message' });
    expect(await s.posts('trades')).toHaveLength(1);
    expect(await s.posts('trash-talk')).toEqual([]);
    const prompt = model.transcript[0]?.systemPrompt ?? '';
    expect(prompt).toContain("Allen mentioned you in the league's #Trades room. Reply to them there.");
    expect(prompt).toContain('want my kicker for your backup QB?');
    expect(prompt).not.toContain('trash talk only');
  });

  it('reacts to a close game in its matchup room', async () => {
    const s = await rooms();
    const room = 'm-2026-W05-W05-1';
    const model = new ScriptedModelClient();
    const record = await runAgentAction(
      s.deps(model),
      request('chat_moment', { moment: "Final (provisional): Allen's Team 101, Team 2 99.", roomId: room })
    );
    expect(record.finalAction).toBe('post_message');
    expect(await s.posts(room)).toHaveLength(1);
    expect(await s.posts('league')).toEqual([]);
    expect(model.transcript[0]?.systemPrompt).toContain(
      `React to it in the matchup room "Wk 5: Allen's Team vs Team 2"`
    );
    // A room that is gone (an unknown room, or someone else's DM) is skipped, not guessed at.
    for (const roomId of ['m-2026-W04-W04-9', 'dm-team-1-team-3']) {
      expect(
        await runAgentAction(
          s.deps(new ScriptedModelClient()),
          request('chat_moment', { moment: 'x', roomId })
        )
      ).toMatchObject({ status: 'skipped', fallbackReason: 'room_unavailable' });
    }
  });

  it('an agent that takes over a seat reads only the DMs from its own time on it', async () => {
    const s = await rooms();
    const old = message({ roomId: DM, text: SECRET, createdAt: '2026-10-04T14:00:00.000Z' });
    await s.repos.chat.put(old, { dmTeamIds: ['team-1', AGENT_TEAM] });
    // The agent took team-2 over after that message (a person left the seat).
    const team = await s.repos.teams.get(LEAGUE_ID, AGENT_TEAM);
    await s.repos.teams.update({ ...team!, occupiedSince: '2026-10-04T14:30:00.000Z' });
    const dm = message({ roomId: DM, text: 'Welcome aboard, robot.', createdAt: '2026-10-04T14:59:30.000Z' });
    await s.repos.chat.put(dm, { dmTeamIds: ['team-1', AGENT_TEAM] });
    const model = new ScriptedModelClient();
    const record = await runAgentAction(
      s.deps(model),
      request('chat_reply', { messageId: dm.id, roomId: DM })
    );
    expect(record.finalAction).toBe('post_message');
    const prompt = model.transcript[0]?.systemPrompt ?? '';
    expect(prompt).toContain('Welcome aboard, robot.');
    // (The chat instructions mention benches in general; the secret's own words must not appear.)
    expect(prompt).not.toContain('whole bench');
    // Answering the old message is not possible: it is not the agent's to read.
    expect(
      await runAgentAction(
        s.deps(new ScriptedModelClient()),
        request('chat_reply', { messageId: old.id, roomId: DM })
      )
    ).toMatchObject({ status: 'skipped', fallbackReason: 'message_not_found' });
  });

  it('answers a person’s DM in the DM and keeps its words there', async () => {
    const s = await rooms();
    await s.repos.chat.put(message({ roomId: 'trash-talk', text: 'public banter' }));
    const dm = message({ roomId: DM, text: SECRET, createdAt: '2026-10-04T14:59:30.000Z' });
    await s.repos.chat.put(dm, { dmTeamIds: ['team-1', AGENT_TEAM] });
    const model = new ScriptedModelClient({
      script: () => ({
        steps: [],
        decision: {
          summary: `Told Allen no to: ${SECRET}`,
          message: 'My bench is not for sale, but my kicker might be.'
        }
      })
    });
    const record = await runAgentAction(
      s.deps(model),
      request('chat_reply', { messageId: dm.id, roomId: DM })
    );
    expect(record).toMatchObject({
      status: 'completed',
      finalAction: 'post_message',
      reasoningSummary: DM_SUMMARY
    });
    expect((await s.posts(DM)).map((m) => m.text)).toEqual([
      'My bench is not for sale, but my kicker might be.'
    ]);
    const prompt = model.transcript[0]?.systemPrompt ?? '';
    expect(prompt).toContain(`Allen sent you ${roomPlace({ kind: 'dm', title: "Allen's Team" })}`);
    expect(prompt).toContain(SECRET);
    expect(prompt).not.toContain('public banter');

    // Nothing from the DM reached memory, the activity log, or the next conversation.
    const memory = await s.repos.agents.getMemory(LEAGUE_ID, AGENT_ID);
    expect(JSON.stringify(memory)).not.toContain('bench');
    expect(memory.chatRooms).toEqual([]);
    expect(memory.relationships).toEqual([]);
    const tasks = await s.repos.agents.listTasks(LEAGUE_ID, {});
    expect(JSON.stringify(tasks)).not.toContain('bench');
    const later = new ScriptedModelClient();
    const mention = message({ text: '@Team 2 you there?', mentionedTeamIds: [AGENT_TEAM] });
    await s.repos.chat.put(mention);
    await runAgentAction(
      s.deps(later),
      request('chat_reply', { messageId: mention.id, roomId: 'trash-talk' })
    );
    const next = later.transcript[0]?.systemPrompt ?? '';
    expect(next).toContain('you there?');
    expect(next).not.toContain('whole bench');
    expect(next).not.toContain('bench is not for sale');
    expect(next).not.toContain('kicker might be');
  });

  it('records a quiet or refused DM reply without the model’s words', async () => {
    const s = await rooms();
    const dm = message({ roomId: DM, text: SECRET });
    await s.repos.chat.put(dm, { dmTeamIds: ['team-1', AGENT_TEAM] });
    const silent = new ScriptedModelClient({
      script: () => ({ steps: [], decision: { summary: `Ignoring: ${SECRET}`, message: '' } })
    });
    expect(
      await runAgentAction(s.deps(silent), request('chat_reply', { messageId: dm.id, roomId: DM }))
    ).toMatchObject({ finalAction: 'none', reasoningSummary: DM_SUMMARY });
    const blocked = new ScriptedModelClient({
      script: () => ({ steps: [], decision: { summary: `Re: ${SECRET}`, message: 'just k1ll yourself' } })
    });
    expect(
      await runAgentAction(s.deps(blocked), request('chat_reply', { messageId: dm.id, roomId: DM }))
    ).toMatchObject({
      finalAction: 'post_message_failed',
      reasoningSummary: `${DM_SUMMARY} post_message failed: MESSAGE_BLOCKED`
    });
    expect(JSON.stringify(await s.repos.agents.listTasks(LEAGUE_ID, {}))).not.toContain('bench');
  });
});

describe('routing chat triggers by room', () => {
  const event = (detailType: string, detail: Record<string, unknown>, id: string): BusEvent => ({
    id,
    'detail-type': detailType,
    source: 'fantasy',
    detail: { leagueId: LEAGUE_ID, ...detail }
  });

  it('sends the room with the task, and a matchup moment to the agents playing in it', async () => {
    const s = await setup();
    for (const team of ['team-2', 'team-3', 'team-4']) await s.seat(team, SEAT);
    const route = (e: BusEvent) => routeEvent({ services: s.services, kinds: defaultTaskKinds }, e);
    const requested = () =>
      s.events.events
        .filter((e) => e.detailType === 'Agent Action Requested')
        .map((e) => AgentActionRequestedSchema.parse(e.detail));
    await route(
      event(
        'Chat Mention',
        {
          roomId: DM,
          messageId: 'm1',
          authorType: 'user',
          authorTeamId: 'team-1',
          mentionedTeamIds: [AGENT_TEAM]
        },
        'evt-dm'
      )
    );
    expect(requested()[0]).toMatchObject({
      teamId: AGENT_TEAM,
      kind: 'chat_reply',
      payload: { messageId: 'm1', roomId: DM }
    });
    await route(
      event(
        'Chat Moment',
        {
          roomId: 'm-2026-W05-W05-2',
          moment: 'A nail-biter.',
          messageId: 'sys-x',
          sourceEventType: 'Week Provisionally Final',
          sourceEventId: 'x',
          teamIds: ['team-1', 'team-4']
        },
        'evt-close'
      )
    );
    expect(
      requested()
        .slice(1)
        .map((r) => [r.teamId, r.payload])
    ).toEqual([['team-4', { moment: 'A nail-biter.', messageId: 'sys-x', roomId: 'm-2026-W05-W05-2' }]]);
  });
});
