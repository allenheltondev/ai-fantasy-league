import { agentPrincipal, invokeTool, type ChatMessage } from '@fantasy/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentActionRequestedSchema, type BusEvent } from '../src/events.js';
import { ScriptedModelClient } from '../src/fake-model.js';
import { CHAT_COOLDOWNS, routeEvent } from '../src/router.js';
import { runAgentAction } from '../src/runner.js';
import { defaultTaskKinds } from '../src/tasks/index.js';
import { LEAGUE_ID, START, setup, type Setup } from './support.js';

/**
 * Bounded agent-to-agent banter (#153): an agent's @mention of another agent can draw one retort,
 * never a chain; never in a DM; within a daily league budget; as the personality likes; and never
 * ahead of a person.
 */

const CHAOS = { personalityId: 'chaos-agent', difficulty: 'pro', archetype: 'balanced' } as const;
const ZEN = { personalityId: 'zen-master', difficulty: 'pro', archetype: 'balanced' } as const;

// Event ids seed the personality roll: each test counts from zero, so each test replays the same.
let busSeq = 0;
beforeEach(() => {
  busSeq = 0;
});
const mention = (detail: Record<string, unknown>, id = `bus-${++busSeq}`): BusEvent => ({
  id,
  'detail-type': 'Chat Mention',
  source: 'fantasy',
  detail: { leagueId: LEAGUE_ID, roomId: 'trash-talk', messageId: `m-${id}`, ...detail }
});
const agentMention = (from: string, to: string, extra: Record<string, unknown> = {}) =>
  mention({
    authorType: 'agent',
    authorTeamId: from,
    mentionedTeamIds: [to],
    replyToAgentDepth: 0,
    ...extra
  });
const humanMention = (to: string) =>
  mention({ authorType: 'user', authorTeamId: 'team-1', mentionedTeamIds: [to], replyToAgentDepth: 0 });

async function banterLeague(seats: Record<string, typeof CHAOS | typeof ZEN>) {
  const s = await setup();
  for (const [teamId, seat] of Object.entries(seats)) await s.seat(teamId, seat);
  const route = (e: BusEvent) => routeEvent({ services: s.services, kinds: defaultTaskKinds }, e);
  return { ...s, route };
}

/**
 * Plays the league's event bus to the end: every Chat Mention is routed, every requested task runs
 * with a model that always fires back at whoever it answers, @mentioning them.
 */
async function drain(s: Setup, from: number): Promise<number> {
  const model = new ScriptedModelClient({
    script: (request) => {
      const me = String(request.invocationState?.teamId);
      const other = me === 'team-2' ? 'team-3' : 'team-2';
      return { steps: [], decision: { summary: 'Fired back.', message: `@${other} says you.` } };
    }
  });
  let i = from;
  while (i < s.events.events.length) {
    const e = s.events.events[i++] as (typeof s.events.events)[number];
    if (e.detailType === 'Chat Mention') {
      await routeEvent(
        { services: s.services, kinds: defaultTaskKinds },
        {
          id: `bus-${++busSeq}`,
          'detail-type': e.detailType,
          source: 'fantasy',
          detail: JSON.parse(JSON.stringify(e.detail))
        }
      );
    } else if (e.detailType === 'Agent Action Requested') {
      await runAgentAction(s.deps(model), AgentActionRequestedSchema.parse(e.detail));
    }
  }
  return i;
}

let key = 0;
const jab = (s: Setup, from: string, to: string) =>
  invokeTool({
    registry: s.registry,
    services: s.services,
    principal: agentPrincipal({ agentId: `${LEAGUE_ID}.${from}`, teamId: from, leagueId: LEAGUE_ID }),
    name: 'post_message',
    args: {
      leagueId: LEAGUE_ID,
      roomId: 'trash-talk',
      text: `@${to} nice roster.`,
      idempotencyKey: `jab-${++key}-key`
    }
  });

const agentMessages = async (s: Setup): Promise<ChatMessage[]> =>
  (await s.repos.chat.list(LEAGUE_ID, 'trash-talk', { limit: 100 })).messages.filter(
    (m) => m.kind === 'agent'
  );

describe('agent-to-agent banter', () => {
  it('two trash-talkers mentioning each other get exactly one retort per jab, never a chain', async () => {
    const s = await banterLeague({ 'team-2': CHAOS, 'team-3': CHAOS });
    let cursor = 0;
    expect((await jab(s, 'team-2', 'team-3')).status).toBe(200);
    cursor = await drain(s, cursor);
    const first = await agentMessages(s);
    expect(first).toHaveLength(2);
    // Both were posted at the same instant: tell them apart by author, not by order.
    const opener = first.find((m) => m.author.teamId === 'team-2') as ChatMessage;
    const retort = first.find((m) => m.author.teamId === 'team-3') as ChatMessage;
    expect(opener.replyToAgentDepth).toBeUndefined();
    expect(retort).toMatchObject({
      author: { teamId: 'team-3' },
      replyToId: opener.id,
      replyToAgentDepth: 1
    });
    expect(retort.mentionedTeamIds).toEqual(['team-2']);

    // They keep at it: each new jab (past the banter cooldown) draws at most one retort.
    for (const [from, to] of [
      ['team-3', 'team-2'],
      ['team-2', 'team-3'],
      ['team-3', 'team-2']
    ] as const) {
      s.clock.advance(CHAT_COOLDOWNS.banter.agentMinutes * 60_000);
      expect((await jab(s, from, to)).status).toBe(200);
      cursor = await drain(s, cursor);
    }
    const all = await agentMessages(s);
    const retorts = all.filter((m) => (m.replyToAgentDepth ?? 0) > 0);
    const openers = all.filter((m) => m.replyToAgentDepth === undefined);
    expect(openers).toHaveLength(4);
    expect(retorts.length).toBeGreaterThanOrEqual(1);
    expect(retorts.length).toBeLessThanOrEqual(openers.length);
    expect(all.every((m) => (m.replyToAgentDepth ?? 0) <= 1)).toBe(true);
    // Every retort answers an opener, and no opener has two.
    const answered = retorts.map((r) => r.replyToId);
    expect(new Set(answered).size).toBe(answered.length);
    expect(answered.every((id) => openers.some((o) => o.id === id))).toBe(true);
  });

  it('never banters in a DM', async () => {
    const s = await banterLeague({ 'team-2': CHAOS, 'team-3': CHAOS });
    expect(await s.route(agentMention('team-2', 'team-3', { roomId: 'dm-team-2-team-3' }))).toEqual([]);
    // A retort (depth 1), or an agent mention with no depth at all, triggers nothing either.
    expect(await s.route(agentMention('team-2', 'team-3', { replyToAgentDepth: 1 }))).toEqual([]);
    expect(await s.route(agentMention('team-2', 'team-3', { replyToAgentDepth: undefined }))).toEqual([]);
  });

  it('stops once the league has used its daily banter budget', async () => {
    const s = await banterLeague({ 'team-2': CHAOS, 'team-3': CHAOS });
    for (let i = 0; i < 6; i++) {
      await s.repos.chat.put({
        id: `r-${i}`,
        leagueId: LEAGUE_ID,
        roomId: 'trash-talk',
        kind: 'agent',
        author: { teamId: 'team-4', teamName: 'Team 4', name: 'Team 4' },
        text: 'retort',
        mentionedTeamIds: [],
        event: null,
        replyToId: 'x',
        replyToAgentDepth: 1,
        createdAt: new Date(Date.parse(START) - (i + 1) * 60_000).toISOString()
      });
    }
    const decisions = await s.route(agentMention('team-2', 'team-3'));
    expect(decisions.map((d) => [d.teamId, d.decision])).toEqual([['team-3', 'budget']]);
  });

  it('a quiet personality rarely bites; a chaos agent usually does', async () => {
    const s = await banterLeague({ 'team-2': CHAOS, 'team-3': ZEN, 'team-4': CHAOS });
    const bites = { 'team-3': 0, 'team-4': 0 };
    // Zen Master's propensity is 0.05, Chaos Agent's 0.9: a hundred jabs each (seeded, so the
    // counts are the same on every run).
    for (let i = 0; i < 100; i++) {
      s.clock.advance(CHAT_COOLDOWNS.banter.agentMinutes * 60_000);
      for (const to of ['team-3', 'team-4'] as const) {
        const [d] = await s.route(agentMention('team-2', to));
        if (d?.decision === 'requested') bites[to]++;
        else expect(d?.decision).toBe('declined');
      }
    }
    expect(bites['team-3']).toBeLessThanOrEqual(10);
    expect(bites['team-4']).toBeGreaterThanOrEqual(80);
  });

  it('answers people first: banter keeps its own cooldown and yields to a pending human mention', async () => {
    const s = await banterLeague({ 'team-2': CHAOS, 'team-3': CHAOS, 'team-4': CHAOS });
    // A retort is requested for team-3; a person mentioning team-3 right after is still answered.
    const retort = await s.route(agentMention('team-2', 'team-3'));
    expect(retort.map((d) => d.decision)).toEqual(['requested']);
    expect((await s.route(humanMention('team-3'))).map((d) => d.decision)).toEqual(['requested']);
    // team-4 is answering a person: an agent's jab right now yields.
    expect((await s.route(humanMention('team-4'))).map((d) => d.decision)).toEqual(['requested']);
    expect((await s.route(agentMention('team-2', 'team-4'))).map((d) => d.decision)).toEqual(['yield']);
    // And a second jab inside the banter cooldown waits.
    s.clock.advance(CHAT_COOLDOWNS.reply.agentMinutes * 60_000);
    expect((await s.route(agentMention('team-2', 'team-3'))).map((d) => d.decision)).toEqual(['cooldown']);
  });
});
