import { describe, expect, it } from 'vitest';
import { CHAT_COOLDOWNS } from '@fantasy/agents';
import { MANIPULATION_PROBES, SOCIAL_ACT_LIMITS, type AgentSeatConfig } from '@fantasy/core';
import type { ChatMessage } from '@fantasy/server';
import {
  PITCH,
  acceptanceModel,
  answers,
  checkAcceptance,
  commitmentFor,
  goals,
  pitchText,
  runTradeInterestScenario
} from './trade-interest.js';
import {
  AGENT_TEAM,
  DAY,
  HOUR,
  PERSON_TEAM,
  buildWorld,
  type AcceptanceWorld,
  type WorldOptions
} from './world.js';

/**
 * Failure variants of the epic #219 acceptance scenario, end to end through the event loop. Each
 * covers what the agents package's own tests cannot: the router, the outbox, the league's handlers,
 * and the clock between the steps. Unit-level coverage of the same failures lives in
 * `packages/agents/test/commitments.test.ts` (injected orders, stale messages, a gone player, a
 * rejected offer never resurrected, crash reconciliation, expiry, the kill switch and spent budget,
 * a failed send, seat changes) and `packages/agents/test/agenda.test.ts` (failed roster reads,
 * league completion).
 */

const BALANCED: AgentSeatConfig = {
  personalityId: 'smug-veteran',
  difficulty: 'hall_of_famer',
  archetype: 'balanced'
};

const world = (options: Partial<WorldOptions> = {}) =>
  buildWorld({ config: BALANCED, model: acceptanceModel(), ...options });

/** The agent's RB1 out, and the morning check-in that makes it a goal. */
async function injured(w: AcceptanceWorld): Promise<void> {
  await w.injure(['rb1'], 'Out');
  await w.checkIn('morning');
}

const tradeCount = async (w: AcceptanceWorld) => (await w.repos.trades.list(w.league.id)).length;
const tasksOf = async (w: AcceptanceWorld, kind: string) =>
  (await w.repos.agents.listTasks(w.league.id, { limit: 1000 })).filter((t) => t.kind === kind);

describe('a false claim', () => {
  it('earns no credit: the swap is judged on its numbers, and the claim is recorded as unsupported', async () => {
    const w = await world();
    const pitch = await w.say(
      pitchText(PITCH.send, PITCH.receive, 'Your RB room is gutted and he is a lock for 40 points.')
    );
    expect(await commitmentFor(w, pitch)).toMatchObject({
      status: 'declined',
      decision: { reason: 'insufficient_depth', facts: { credit: 0, needs: [], lineupDelta: -4 } },
      claims: [{ verification: 'unsupported' }]
    });
    expect(await tradeCount(w)).toBe(0);
    // The closing line gives the real reason and repeats nothing of the claim.
    const lines = await answers(w, pitch);
    expect(lines).toContain('Took a proper look at that one: I could not spare the depth. Pass for now.');
    expect(lines.join(' ')).not.toMatch(/40|gutted/);
  });
});

describe('orders injected in chat', () => {
  it.each(MANIPULATION_PROBES.slice(0, 2))('change nothing the numbers decide: %j', async (order) => {
    const plain = await world();
    const ordered = await world();
    const facts = async (w: AcceptanceWorld, message: ChatMessage) =>
      (await commitmentFor(w, message))?.decision;
    const a = await facts(plain, await plain.say(pitchText(PITCH.send, PITCH.receive)));
    const pitch = await ordered.say(pitchText(PITCH.send, PITCH.receive, order));
    const b = await facts(ordered, pitch);
    expect(b).toEqual(a);
    expect((await commitmentFor(ordered, pitch))?.claims).toEqual([
      { messageId: pitch.id, verification: 'ignored_orders' }
    ]);
    expect(await tradeCount(ordered)).toBe(0);
  });
});

describe('a rejected counter', () => {
  it('ends the commitment as countered; the counter is answered once and nothing is resurrected', async () => {
    const w = await world();
    await injured(w);
    const pitch = await w.say(pitchText('wr4', 'p-rb3'));
    const offer = (await commitmentFor(w, pitch))?.tradeId as string;
    expect(offer).toBeTruthy();
    // The person counters, asking for more: the agent's QB2 as well.
    await w.person('counter_trade', {
      tradeId: offer,
      teamId: PERSON_TEAM,
      send: ['p-rb3'],
      receive: ['wr4', 'qb2']
    });
    const answered = await tasksOf(w, 'trade_response');
    expect(answered).toHaveLength(1);
    const counter = (await w.repos.trades.list(w.league.id)).find(
      (t) => t.trade.sides[0].teamId === PERSON_TEAM
    );
    // The agent's answer is a real answer, not a lapse: it rejected, countered, or took it.
    expect(['rejected', 'countered', 'accepted', 'in_review', 'processed']).toContain(counter?.trade.status);
    await w.advance(2 * HOUR);
    await w.checkIn('afternoon');
    expect(await commitmentFor(w, pitch)).toMatchObject({
      status: 'declined',
      decision: { reason: 'partner_countered' },
      nextReviewAt: null
    });
    // A later change that would make the pitch worth more reopens nothing.
    const before = await tradeCount(w);
    await w.advance(DAY);
    await w.injure(['rb2', 'wr1'], 'Out');
    await w.checkIn('morning');
    expect(await tradeCount(w)).toBe(before);
    expect(await answers(w, pitch)).toHaveLength(2);
  });
});

describe('missing data', () => {
  it('offers nothing on a week with no projections, and records why', async () => {
    const w = await world();
    await w.services.data.reference.projections.putSnapshot(
      { season: 2026, week: 5, capturedAt: '2026-10-05T13:00:00.000Z', hash: 'empty', count: 0 },
      []
    );
    await injured(w);
    const pitch = await w.say(pitchText(PITCH.send, PITCH.receive));
    // It says it had nothing to value the swap by, not that the value was not there (#219).
    expect(await commitmentFor(w, pitch)).toMatchObject({
      status: 'declined',
      nextReviewAt: null,
      decision: { reason: 'missing_data', facts: { score: null } }
    });
    expect(await answers(w, pitch)).toContain(
      'Took a proper look at that one: I had no projections to value it by yet. Pass for now.'
    );
    expect(await tradeCount(w)).toBe(0);
    // The goal still stands: an unprojected week says nothing about who is healthy.
    expect((await goals(w)).map((g) => [g.slot, g.status])).toEqual([['RB', 'active']]);
  });
});

describe('no human reply', () => {
  it('lets the unanswered offer expire, and the commitment with it, on the one line already said', async () => {
    const w = await world();
    await injured(w);
    const pitch = await w.say(pitchText('wr4', 'p-rb3'));
    for (let i = 0; i < 6; i++) {
      await w.advance(12 * HOUR);
      await w.checkIn('evening');
    }
    expect(await commitmentFor(w, pitch)).toMatchObject({
      status: 'expired',
      decision: { reason: 'offer_expired' }
    });
    expect((await w.repos.trades.list(w.league.id)).map((t) => t.trade.status)).toEqual(['expired']);
    expect([...(await answers(w, pitch))].sort()).toEqual([
      'Let me run the numbers on that.',
      'Numbers check out. Offer is on its way.'
    ]);
  });

  it('expires a look that never ran, with one line saying nothing was sent', async () => {
    // The look's dispatch is lost and no check-in comes until after the commitment's deadline.
    const w = await world({ lose: (r) => r.kind === 'trade_proposal' });
    await injured(w);
    const pitch = await w.say(pitchText('wr4', 'p-rb3'));
    await w.advance(5 * DAY);
    await w.checkIn('morning');
    await w.checkIn('afternoon');
    expect(await commitmentFor(w, pitch)).toMatchObject({
      status: 'expired',
      decision: { reason: 'deadline_passed' }
    });
    const lines = await answers(w, pitch);
    expect(lines.filter((l) => l.startsWith("Couldn't finish that trade look"))).toEqual([
      "Couldn't finish that trade look (I ran out of time on it). Nothing was sent."
    ]);
    expect(await tradeCount(w)).toBe(0);
  });
});

describe('the kill switch', () => {
  it('sends nothing while it is on, says so once, and leaves nothing to resume once it is off', async () => {
    let on = false;
    const w = await world({ killSwitch: { engaged: () => Promise.resolve(on) } });
    await injured(w);
    const pitch = await w.say(pitchText(PITCH.send, PITCH.receive));
    on = true;
    await w.advance(13 * HOUR);
    await w.injure([PITCH.send], 'Out');
    await w.checkIn('evening');
    expect(await commitmentFor(w, pitch)).toMatchObject({
      status: 'cancelled',
      reconsiderations: 1,
      decision: { reason: 'autopilot' }
    });
    expect(await answers(w, pitch)).toContain(
      "Couldn't finish that trade look (I could not give it a proper look). Nothing was sent."
    );
    on = false;
    await w.advance(DAY);
    await w.checkIn('morning');
    expect(await tradeCount(w)).toBe(0);
    expect(await answers(w, pitch)).toHaveLength(3);
  });
});

describe('delayed execution', () => {
  it('holds every acceptance check with human-like response delays on', async () => {
    const run = await runTradeInterestScenario({ config: BALANCED, responseDelays: true });
    for (const c of checkAcceptance(run)) expect(c, c.name).toMatchObject({ ok: true, violations: [] });
    // The reconsidering check-in waited, and its offer still went out before anything expired.
    const reconsider = run.tasks.find((t) => t.taskId === run.finalCommitment?.childTaskIds[1]);
    expect(Date.parse(reconsider?.startedAt as string)).toBeGreaterThan(Date.parse(run.pitch.createdAt));
    expect(run.finalCommitment).toMatchObject({ status: 'fulfilled' });
  });
});

describe('a dispatch failure', () => {
  it('resumes the lost look at the next check-in; the lost task, delivered late, stands down', async () => {
    let lost = 0;
    const w = await world({ lose: (r) => r.kind === 'trade_proposal' && lost++ === 0 });
    await injured(w);
    const pitch = await w.say(pitchText('wr4', 'p-rb3'));
    expect(await commitmentFor(w, pitch)).toMatchObject({ status: 'queued', reply: null });
    await w.advance(2 * HOUR);
    await w.checkIn('afternoon');
    const resumed = await commitmentFor(w, pitch);
    expect(resumed).toMatchObject({ status: 'waiting_for_partner', decision: { reason: 'offer_sent' } });
    expect(resumed?.childTaskIds).toHaveLength(2);
    const first = w.requests().find((r) => r.kind === 'trade_proposal');
    await w.rerun(first as NonNullable<typeof first>);
    expect((await tasksOf(w, 'trade_proposal')).map((t) => t.fallbackReason).sort()).toEqual([
      'commitment_superseded',
      null
    ]);
    expect(await tradeCount(w)).toBe(1);
    expect(await answers(w, pitch)).toHaveLength(2);
  });
});

describe('closing-reply recovery', () => {
  it('uses the task outbox to retry a rate-limited result without rerunning the trade look', async () => {
    let lost = 0;
    const w = await world({ lose: (r) => r.kind === 'trade_proposal' && lost++ === 0 });
    const pitch = await w.say(pitchText(PITCH.send, PITCH.receive));
    const look = w.requests().find((r) => r.kind === 'trade_proposal');
    expect(look).toBeDefined();
    // Fill the one-minute agent burst immediately before the delayed look reports its result.
    const at = w.clock.now().toISOString();
    for (let i = 0; i < 5; i++)
      await w.repos.chat.put(
        {
          id: `reply-burst-${i}`,
          leagueId: w.league.id,
          roomId: pitch.roomId,
          kind: 'agent',
          author: { teamId: AGENT_TEAM, teamName: 'Agent Team', name: 'Agent' },
          text: `Earlier line ${i}`,
          mentionedTeamIds: [],
          event: null,
          createdAt: at
        },
        { dmTeamIds: [PERSON_TEAM, AGENT_TEAM] }
      );
    await w.rerun(look as NonNullable<typeof look>);
    expect(await commitmentFor(w, pitch)).toMatchObject({
      status: 'declined',
      reply: { state: 'withheld', failure: 'RATE_LIMITED', attempts: 1 }
    });

    await w.advance(6 * 60_000);
    await w.checkIn('afternoon');
    expect(await commitmentFor(w, pitch)).toMatchObject({ reply: { state: 'sent', attempts: 2 } });
    expect((await tasksOf(w, 'commitment_reply')).at(-1)).toMatchObject({
      status: 'skipped',
      fallbackReason: 'commitment_reply_sent'
    });
    expect((await answers(w, pitch)).filter((line) => line.startsWith('Took a proper look'))).toHaveLength(1);
    expect(await tradeCount(w)).toBe(0);
  });
});

describe('a burst, a hand-off, and a lost closing reply together (#215 with #246)', () => {
  it('answers every message once, closes the look once, and duplicates nothing', async () => {
    let lost = 0;
    const w = await world({ lose: (r) => r.kind === 'trade_proposal' && lost++ === 0 });
    // The person opens, then asks and pitches inside the agent's reply cooldown.
    const opening = await w.say('you around?');
    await w.advance(15_000);
    const flex = await w.say('who are you starting at flex this week');
    await w.advance(15_000);
    const pitch = await w.say(pitchText(PITCH.send, PITCH.receive));
    await w.advance(CHAT_COOLDOWNS.reply.agentMinutes * 60_000);

    // The look's dispatch was lost; it runs late, and its closing line meets a spent chat burst.
    const look = w.requests().find((r) => r.kind === 'trade_proposal');
    expect(look).toBeDefined();
    const at = w.clock.now().toISOString();
    for (let i = 0; i < 5; i++)
      await w.repos.chat.put(
        {
          id: `burst-line-${i}`,
          leagueId: w.league.id,
          roomId: pitch.roomId,
          kind: 'agent',
          author: { teamId: AGENT_TEAM, teamName: 'Agent Team', name: 'Agent' },
          text: `Earlier line ${i}`,
          mentionedTeamIds: [],
          event: null,
          createdAt: at
        },
        { dmTeamIds: [PERSON_TEAM, AGENT_TEAM] }
      );
    await w.rerun(look as NonNullable<typeof look>);
    expect(await commitmentFor(w, pitch)).toMatchObject({
      reply: { state: 'withheld', failure: 'RATE_LIMITED' }
    });

    // Every chat task and mention again, then a check-in past the questions' grace: its hand-off
    // and the recovery of the closing line run together.
    for (const r of w.requests().filter((q) => q.kind === 'chat_reply')) await w.rerun(r);
    await w.advance(SOCIAL_ACT_LIMITS.questionGraceMs);
    await w.checkIn('afternoon');
    await w.advance(HOUR);

    const room = (await w.repos.chat.list(w.league.id, pitch.roomId, { limit: 200 })).messages;
    const replies = room.filter((m) => m.kind === 'agent' && !m.id.startsWith('burst-line-'));
    const covering = (id: string) =>
      replies.filter((m) => m.replyToId === id || (m.answersMessageIds ?? []).includes(id));
    const closing = (m: ChatMessage) => m.text.startsWith('Took a proper look');
    // The opening got its own reply; one coalesced reply answered the pitch and named the question.
    expect(covering(opening.id)).toHaveLength(1);
    expect(covering(flex.id)).toHaveLength(1);
    expect(covering(pitch.id).filter((m) => !closing(m))).toHaveLength(1);
    expect(covering(pitch.id).filter((m) => !closing(m))[0]?.answersMessageIds).toEqual([flex.id]);
    // The closing line went out once, on the retry, and no trade was duplicated or made.
    expect(covering(pitch.id).filter(closing)).toHaveLength(1);
    expect(await commitmentFor(w, pitch)).toMatchObject({ status: 'declined', reply: { state: 'sent' } });
    expect(await tradeCount(w)).toBe(0);
    expect(replies.filter(closing)).toHaveLength(1);
  });
});

describe('a seat change', () => {
  it('a person taking the seat cancels the look without a word; an agent coming back starts clean', async () => {
    const w = await world({ lose: (r) => r.kind === 'trade_proposal' });
    await injured(w);
    const pitch = await w.say(pitchText('wr4', 'p-rb3'));
    const tenure = (await w.repos.teams.get(w.league.id, AGENT_TEAM))?.occupiedSince as string;
    // A person takes the seat, as join_league records it (`claimSeat`: a new tenure).
    await w.advance(HOUR);
    const seat = await w.repos.teams.get(w.league.id, AGENT_TEAM);
    const at = w.clock.now().toISOString();
    await w.repos.teams.update({
      ...(seat as NonNullable<typeof seat>),
      seatType: 'human',
      ownerUserId: 'user-bob',
      ownerName: 'Bob',
      occupiedSince: at,
      updatedAt: at
    });
    // The lost look finally arrives: the seat is no longer the agent's.
    const look = w.requests().find((r) => r.kind === 'trade_proposal');
    await w.rerun(look as NonNullable<typeof look>);
    const book = await w.repos.agents.getCommitments(w.league.id, w.agentId, tenure);
    expect(book.commitments).toMatchObject([{ status: 'cancelled', decision: { reason: 'seat_changed' } }]);
    expect(await answers(w, pitch)).toEqual(['Let me run the numbers on that.']);
    expect(await tradeCount(w)).toBe(0);
    // The person leaves and an agent takes over again (`vacateSeat`): it inherits nothing.
    await w.advance(HOUR);
    const held = await w.repos.teams.get(w.league.id, AGENT_TEAM);
    const back = w.clock.now().toISOString();
    await w.repos.teams.update({
      ...(held as NonNullable<typeof held>),
      seatType: 'agent',
      ownerUserId: null,
      ownerName: null,
      occupiedSince: back,
      updatedAt: back
    });
    await w.advance(2 * HOUR);
    await w.checkIn('afternoon');
    expect((await w.repos.agents.getCommitments(w.league.id, w.agentId, back)).commitments).toEqual([]);
    expect(await tradeCount(w)).toBe(0);
  });
});

describe('league completion', () => {
  it('cancels the goals and reconsiders nothing once the league is complete', async () => {
    const w = await world();
    await injured(w);
    const pitch = await w.say(pitchText(PITCH.send, PITCH.receive));
    const league = await w.repos.leagues.get(w.league.id);
    await w.repos.leagues.update({ ...(league as NonNullable<typeof league>), phase: 'complete' });
    await w.advance(13 * HOUR);
    await w.injure([PITCH.send], 'Out');
    await w.checkIn('evening');
    expect((await goals(w)).map((g) => g.status)).toEqual(['cancelled']);
    expect(await commitmentFor(w, pitch)).toMatchObject({ status: 'declined', reconsiderations: 0 });
    // The check-in stands down cleanly: no lineup attempt the league must refuse (#219).
    const late = (await tasksOf(w, 'check_in')).at(0);
    expect(late).toMatchObject({ status: 'skipped', fallbackReason: 'league_complete', toolsCalled: [] });
    expect(await tradeCount(w)).toBe(0);
    expect(await answers(w, pitch)).toHaveLength(2);
  });
});
