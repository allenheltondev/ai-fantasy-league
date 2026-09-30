import {
  MANIPULATION_PROBES,
  advanceCommitment,
  claimReply,
  recordAcquisition,
  resolveAgentConfig,
  type AgentSeatConfig,
  type Commitment
} from '@fantasy/core';
import {
  agentPrincipal,
  createContext,
  executeOperation,
  seatTenureStart,
  type ChatMessage
} from '@fantasy/server';
import { describe, expect, it, vi } from 'vitest';
import {
  beginLook,
  closeLook,
  commitmentAccess,
  deliverReply,
  failureLines,
  openInterest,
  reviewCommitments
} from '../src/commitments.js';
import type { AgentAblation } from '../src/ablations.js';
import { AgentActionRequestedSchema, type AgentActionRequested } from '../src/events.js';
import { ScriptedModelClient, type FakeScript } from '../src/fake-model.js';
import { taskIdFor } from '../src/router.js';
import { TASK_LOCK_MS, runAgentAction, takeChatActionSlot } from '../src/runner.js';
import { NO_ROOM_LINE } from '../src/tasks/chat-action.js';
import type { TaskContext } from '../src/tasks/kinds.js';
import { ToolBox } from '../src/tools.js';
import { market, projectMarket } from './market.js';
import { AGENT_TEAM, LEAGUE_ID, START, type Setup } from './support.js';

/**
 * Durable commitments (#215), end to end with the fake model: a pitch in chat becomes a typed
 * commitment, the follow-up re-checks the facts and records the actual result before it answers
 * once, and a later check-in reads the partner's answer or reconsiders a decline when an injury
 * changes the agent's needs. The scripted clock runs over several days.
 */

const AGENT_ID = `${LEAGUE_ID}.${AGENT_TEAM}`;
const DM = 'dm-team-1-team-2';
const TENURE = '2026-09-01T00:00:00.000Z';
const DAY = 24 * 60 * 60_000;
const ALLEN = { type: 'user' as const, sub: 'user-123', email: null, name: 'Allen' };
/** No valuation noise; a cautious archetype (bar 2) that a stubborn personality barely bends. */
const STUBBORN: AgentSeatConfig = {
  personalityId: 'smug-veteran',
  difficulty: 'hall_of_famer',
  archetype: 'analytics_only'
};
let seq = 0;

/**
 * The market with Allen (team-1, a person) holding team-3's players and H RB. H RB (15 points)
 * for the agent's healthy bench WR5 (15) is even by value and, while RB1 and RB2 are healthy,
 * changes nothing in the agent's lineup: a pass. The week's games kick off a week out, so nothing
 * locks while the days go by.
 */
async function interest(config: AgentSeatConfig = STUBBORN, yards = 150): Promise<Setup> {
  const s = await market(config);
  const allen = (await s.repos.teams.get(LEAGUE_ID, 'team-1'))!;
  const three = (await s.repos.teams.get(LEAGUE_ID, 'team-3'))!;
  await s.repos.teams.update({ ...three, roster: [] });
  await s.repos.teams.update({ ...allen, roster: [...three.roster, 'h-rb'] });
  for (const team of await s.repos.teams.list(LEAGUE_ID))
    await s.repos.teams.update({ ...team, occupiedSince: TENURE });
  const wr5 = (await s.repos.players.get('wr5'))!;
  await s.repos.players.putMany([
    { ...wr5, injuryStatus: null },
    { ...wr5, injuryStatus: null, id: 'h-rb', name: 'H RB', firstName: 'H', lastName: 'RB', position: 'RB' }
  ]);
  await projectMarket(s, { 'h-rb': { rush_yd: yards }, wr5: { rec_yd: 150 } });
  await s.services.data.reference.schedule.putSeason(
    2026,
    [
      {
        gameId: '2026_05_LAR_SF',
        season: 2026,
        seasonType: 'regular',
        week: 5,
        kickoff: '2026-10-11T17:00:00.000Z',
        homeTeam: 'SF',
        awayTeam: 'LAR',
        status: 'scheduled'
      }
    ],
    {},
    new Date(START)
  );
  return s;
}

async function tell(s: Setup, text: string, roomId = DM): Promise<ChatMessage> {
  const message: ChatMessage = {
    id: `m-${++seq}`,
    leagueId: LEAGUE_ID,
    roomId,
    kind: 'user',
    author: { teamId: 'team-1', teamName: "Allen's Team", name: 'Allen' },
    text,
    mentionedTeamIds: roomId === DM ? [] : [AGENT_TEAM],
    event: null,
    createdAt: new Date(s.clock.now().getTime() - 30_000).toISOString()
  };
  await s.repos.chat.put(message, roomId === DM ? { dmTeamIds: ['team-1', AGENT_TEAM] } : {});
  return message;
}

function request(
  kind: string,
  payload: Record<string, unknown>,
  eventId = `e${++seq}`,
  detailType = 'Chat Mention'
): AgentActionRequested {
  return {
    taskId: taskIdFor(eventId, AGENT_TEAM, kind),
    leagueId: LEAGUE_ID,
    teamId: AGENT_TEAM,
    agentId: AGENT_ID,
    kind,
    trigger: { detailType, eventId, urgent: false },
    payload,
    requestedAt: START
  };
}

const said = (decision: Record<string, unknown>) =>
  new ScriptedModelClient({ script: () => ({ steps: [], decision }) as FakeScript });

const PITCH = "My H RB for your WR5? You'll want the RB depth.";
const TRADE_TALK = { kind: 'trade' as const, players: ['H RB', 'WR5'] };

/** The agent answers the message, and its chat model marks the trade talk. */
async function answer(s: Setup, message: ChatMessage, takeaway = TRADE_TALK) {
  const record = await runAgentAction(
    s.deps(said({ summary: 'Answered.', message: 'Let me look at it.', takeaway })),
    request('chat_reply', { messageId: message.id, roomId: message.roomId })
  );
  // The follow-up runs a little later, so its line lands after the reply.
  s.clock.advance(60_000);
  return record;
}

/** A check-in whose model changes nothing: only its deterministic pass over commitments acts. */
async function checkIn(
  s: Setup,
  id: string,
  model = said({ summary: 'Quiet day.', actions: [{ type: 'none' }] })
) {
  return runAgentAction(s.deps(model), request('check_in', { slot: 'afternoon' }, id, 'Manager Check-In'));
}

const requested = (s: Setup) =>
  s.events.events
    .filter((e) => e.detailType === 'Agent Action Requested')
    .map((e) => AgentActionRequestedSchema.parse(e.detail));
const proposals = (s: Setup) => requested(s).filter((r) => r.kind === 'trade_proposal');

const book = async (s: Setup, tenure = TENURE) =>
  (await s.repos.agents.getCommitments(LEAGUE_ID, AGENT_ID, tenure)).commitments;
const only = async (s: Setup): Promise<Commitment> => {
  const [c, ...rest] = await book(s);
  expect(rest).toEqual([]);
  return c!;
};
const trades = (s: Setup) => s.repos.trades.list(LEAGUE_ID);
/** The agent's lines answering `message`, oldest first. */
const answers = async (s: Setup, message: ChatMessage) =>
  (await s.repos.chat.list(LEAGUE_ID, message.roomId, { limit: 50 })).messages
    .filter((m) => m.kind === 'agent' && m.replyToId === message.id)
    .reverse()
    .map((m) => m.text);

async function hurt(s: Setup, ids: string[], status: string | null = 'Out') {
  for (const id of ids) {
    const p = (await s.repos.players.get(id))!;
    await s.repos.players.putMany([{ ...p, injuryStatus: status }]);
  }
}

async function allen(s: Setup, name: string, input: Record<string, unknown>) {
  const res = await executeOperation({
    registry: s.registry,
    operation: s.registry.get(name)!,
    ctx: createContext(s.services, ALLEN),
    input: { leagueId: LEAGUE_ID, ...input },
    idempotencyKey: `commitments-${++seq}`
  });
  expect((res.body as { error?: unknown }).error).toBeUndefined();
}

describe('a trade interest across several days (#215)', () => {
  it('links conversation → commitment → decline → injury → reconsidered offer → acceptance', async () => {
    const s = await interest();
    // Day 1: Allen pitches in their DM; the agent says it will look.
    const pitch = await tell(s, PITCH);
    await answer(s, pitch);
    const [first] = proposals(s);
    expect(first).toMatchObject({
      taskId: taskIdFor(`e${seq}`, AGENT_TEAM, 'trade_proposal'),
      payload: {
        reason: 'chat',
        withTeamId: 'team-1',
        send: ['wr5'],
        receive: ['h-rb'],
        chat: { roomId: DM, messageId: pitch.id, fromTeamId: 'team-1' },
        commitment: { id: `trade_interest:${pitch.id}`, tenure: TENURE }
      }
    });
    expect(await only(s)).toMatchObject({
      status: 'queued',
      source: { roomId: DM, messageId: pitch.id, visibility: 'dm' },
      counterpartTeamId: 'team-1',
      intent: { send: ['wr5'], receive: ['h-rb'] },
      claims: [{ messageId: pitch.id, verification: 'pending' }],
      childTaskIds: [first!.taskId],
      agendaId: null
    });

    // The look: by its own numbers H RB would not start, so it passes and says why, once.
    const model = new ScriptedModelClient();
    s.clock.advance(60_000);
    const declined = await runAgentAction(s.deps(model), first!);
    expect(declined).toMatchObject({ status: 'skipped', fallbackReason: 'not_convinced' });
    expect(model.transcript).toEqual([]);
    const decided = await only(s);
    expect(decided).toMatchObject({
      status: 'declined',
      decision: {
        reason: 'value_below_floor',
        taskId: first!.taskId,
        facts: { score: 0, bar: 2, credit: 0, lineupDelta: 0, needs: [], receivePositions: ['RB'] }
      },
      claims: [{ verification: 'unsupported' }],
      reply: { key: `trade_interest:${pitch.id}#0`, state: 'sent' },
      nextReviewAt: new Date(s.clock.now().getTime() + 12 * 60 * 60_000).toISOString()
    });
    expect(await answers(s, pitch)).toEqual([
      'Let me look at it.',
      'Took a proper look at that one: the value was not there for me. Pass for now.'
    ]);
    expect(await trades(s)).toEqual([]);

    // Day 2: both starting RBs go down. The morning check-in finds a new RB need that H RB fills.
    s.clock.advance(DAY);
    await hurt(s, ['rb1', 'rb2']);
    const checkModel = said({ summary: 'Quiet day.', actions: [{ type: 'none' }] });
    await checkIn(s, 'ci-day-2', checkModel);
    // The check-in's model never sees the commitment.
    expect(checkModel.transcript[0]?.systemPrompt).not.toMatch(/trade_interest|H RB for|passed/);
    const second = proposals(s).at(-1)!;
    expect(second).toMatchObject({
      taskId: taskIdFor('ci-day-2', AGENT_TEAM, 'trade_proposal'),
      trigger: { detailType: 'Manager Check-In' },
      payload: { commitment: { id: decided.id, tenure: TENURE, change: 'RB' } }
    });
    // The same check-in delivered again hands on the same look, with the same change, and spends nothing.
    const redelivered = await context(s, 'ci-day-2');
    const team = (await s.repos.teams.get(LEAGUE_ID, AGENT_TEAM))!;
    redelivered.agenda = await s.repos.agents.getAgenda(LEAGUE_ID, AGENT_ID, seatTenureStart(team));
    expect((await reviewCommitments(redelivered)).map((f) => f.payload)).toEqual([second.payload]);
    expect(await only(s)).toMatchObject({
      status: 'queued',
      reconsiderations: 1,
      childTaskIds: [first!.taskId, second.taskId],
      decision: { reason: 'value_below_floor' }
    });

    // The reconsideration re-checks everything and sends a fresh, validated offer.
    s.clock.advance(60_000);
    const offered = await runAgentAction(s.deps(new ScriptedModelClient()), second);
    expect(offered).toMatchObject({ status: 'completed', finalAction: 'propose_trade' });
    const [trade] = await trades(s);
    expect([trade?.trade.sides[0].sends, trade?.trade.sides[1].sends]).toEqual([['wr5'], ['h-rb']]);
    expect(await only(s)).toMatchObject({
      status: 'waiting_for_partner',
      tradeId: trade?.trade.tradeId,
      decision: { reason: 'offer_sent', taskId: second.taskId, facts: { needs: ['RB'], lineupDelta: 15 } },
      reply: { key: `trade_interest:${pitch.id}#1`, state: 'sent' }
    });
    expect((await answers(s, pitch)).at(-1)).toBe(
      'Earlier I passed because the value was not there for me. My RB situation changed, so I sent you an offer.'
    );

    // Day 3: Allen accepts; the next check-in records it from the league, not from anyone's say-so.
    s.clock.advance(DAY);
    await allen(s, 'respond_to_trade', { tradeId: trade?.trade.tradeId, response: 'accept' });
    const before = requested(s).length;
    await checkIn(s, 'ci-day-3');
    expect(await only(s)).toMatchObject({ status: 'fulfilled', decision: { reason: 'partner_accepted' } });
    expect(
      requested(s)
        .slice(before)
        .filter((r) => r.kind === 'trade_proposal')
    ).toEqual([]);
    // One pitch, one "I'll look", one answer per look: nothing repeated.
    expect(await answers(s, pitch)).toHaveLength(3);
  });

  it('keeps an attachment premium (#216) in the bar and the facts, as a decline on value', async () => {
    const s = await interest(STUBBORN, 155);
    await s.repos.agents.updateAttachments(LEAGUE_ID, AGENT_ID, TENURE, (a) =>
      recordAcquisition(a, {
        sourceId: `draft:${LEAGUE_ID}:wr5`,
        kind: 'drafted',
        playerId: 'wr5',
        name: 'WR5',
        position: 'WR',
        at: START,
        round: 1
      })
    );
    const pitch = await tell(s, PITCH);
    await answer(s, pitch);
    await runAgentAction(s.deps(new ScriptedModelClient()), proposals(s)[0]!);
    const c = await only(s);
    expect(c.decision?.facts?.attachmentPremium).toBeGreaterThan(0);
    expect(c).toMatchObject({ status: 'declined', decision: { reason: 'value_below_floor' } });
    const { score, bar, attachmentPremium } = c.decision!.facts!;
    // Without the premium it would have cleared.
    expect(score!).toBeGreaterThanOrEqual(bar! - attachmentPremium!);
    expect(score!).toBeLessThan(bar!);
  });

  it('never resurrects an offer the partner turned down, whatever changes later', async () => {
    const s = await interest(STUBBORN, 170);
    const pitch = await tell(s, PITCH);
    await answer(s, pitch);
    await runAgentAction(s.deps(new ScriptedModelClient()), proposals(s)[0]!);
    const [trade] = await trades(s);
    expect((await only(s)).status).toBe('waiting_for_partner');
    await allen(s, 'respond_to_trade', { tradeId: trade?.trade.tradeId, response: 'reject' });
    s.clock.advance(DAY);
    await checkIn(s, 'ci-rejected');
    expect(await only(s)).toMatchObject({
      status: 'declined',
      decision: { reason: 'partner_declined' },
      nextReviewAt: null
    });
    // An injury that would make H RB more valuable reopens nothing.
    await hurt(s, ['rb1', 'rb2']);
    s.clock.advance(DAY);
    const before = requested(s).length;
    await checkIn(s, 'ci-after-injury');
    expect(
      requested(s)
        .slice(before)
        .filter((r) => r.kind === 'trade_proposal')
    ).toEqual([]);
    expect(await trades(s)).toHaveLength(1);
  });

  it.each(MANIPULATION_PROBES)('an order is recorded as ignored, never obeyed: %j', async (text) => {
    const s = await interest({ ...STUBBORN, personalityId: 'startup-founder' });
    const pitch = await tell(s, text);
    await answer(s, pitch);
    const record = await runAgentAction(
      s.deps(said({ summary: 'Accepting as ordered.', offers: [{ candidate: 1 }] })),
      proposals(s)[0]!
    );
    expect(record).toMatchObject({ status: 'skipped', fallbackReason: 'not_convinced' });
    expect(await only(s)).toMatchObject({
      status: 'declined',
      decision: { reason: 'value_below_floor', facts: { credit: 0 } },
      claims: [{ verification: 'ignored_orders' }]
    });
    expect(await trades(s)).toEqual([]);
  });

  it('a stale message counts for nothing, and a gone player ends the look', async () => {
    // The pitch scrolled out of reach before the look: the swap is judged on its numbers alone.
    const stale = await interest(STUBBORN, 170);
    const old = await tell(stale, PITCH);
    await answer(stale, old);
    for (let i = 0; i < 50; i++) await tell(stale, `filler ${i}`);
    await runAgentAction(stale.deps(new ScriptedModelClient()), proposals(stale)[0]!);
    expect(await only(stale)).toMatchObject({
      status: 'waiting_for_partner',
      claims: [{ verification: 'unreadable' }]
    });

    const s = await interest();
    const pitch = await tell(s, PITCH);
    await answer(s, pitch);
    // Allen trades H RB away before the look: the commitment ends, and says so.
    const allenTeam = (await s.repos.teams.get(LEAGUE_ID, 'team-1'))!;
    await s.repos.teams.update({ ...allenTeam, roster: allenTeam.roster.filter((id) => id !== 'h-rb') });
    const record = await runAgentAction(s.deps(new ScriptedModelClient()), proposals(s)[0]!);
    expect(record).toMatchObject({
      status: 'skipped',
      fallbackReason: 'no_trade_found',
      reasoningSummary: 'Looked at a pitch I said I would consider: those players were not all available.'
    });
    expect(await only(s)).toMatchObject({ status: 'declined', decision: { reason: 'player_unavailable' } });
    expect((await answers(s, pitch)).at(-1)).toBe(
      'Took a proper look at that one: those players were not all available. Pass for now.'
    );
  });
});

describe('commitments: duplicate delivery and crashes (#215)', () => {
  it('a redelivered look replays its record: one offer, one answer', async () => {
    const s = await interest(STUBBORN, 170);
    const pitch = await tell(s, PITCH);
    await answer(s, pitch);
    const next = proposals(s)[0]!;
    const first = await runAgentAction(s.deps(new ScriptedModelClient()), next);
    const again = await runAgentAction(s.deps(new ScriptedModelClient()), next);
    expect(again).toEqual(first);
    expect(await trades(s)).toHaveLength(1);
    expect(await answers(s, pitch)).toEqual([
      'Let me look at it.',
      'Numbers check out. Offer is on its way.'
    ]);
  });

  it('the same pitch again is a duplicate: no second look, no second use of the day', async () => {
    const s = await interest(STUBBORN, 170);
    await answer(s, await tell(s, PITCH));
    await answer(s, await tell(s, 'Seriously, H RB for WR5. Think about it.'));
    expect(proposals(s)).toHaveLength(1);
    expect(await book(s)).toHaveLength(1);
    // Two uses left of three.
    expect(await takeChatActionSlot(s.services, LEAGUE_ID, AGENT_ID)).toBe(true);
    expect(await takeChatActionSlot(s.services, LEAGUE_ID, AGENT_ID)).toBe(true);
    expect(await takeChatActionSlot(s.services, LEAGUE_ID, AGENT_ID)).toBe(false);
  });

  it('a crash between the offer and its record is reconciled from the league, never re-sent', async () => {
    const s = await interest(STUBBORN, 170);
    const pitch = await tell(s, PITCH);
    await answer(s, pitch);
    const next = proposals(s)[0]!;
    // The offer goes out; then the process dies before the commitment records it.
    const update = s.repos.agents.updateCommitments.bind(s.repos.agents);
    let writes = 0;
    const spy = vi.spyOn(s.repos.agents, 'updateCommitments').mockImplementation(async (...args) => {
      if (++writes === 2) throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
      return update(...args);
    });
    const crashed = await runAgentAction(s.deps(new ScriptedModelClient()), next);
    expect(crashed).toMatchObject({ fallbackReason: 'retry_scheduled' });
    spy.mockRestore();
    expect(await trades(s)).toHaveLength(1);
    expect((await only(s)).status).toBe('evaluating');
    // The retry finds an earlier attempt acted: no model, no new offer, the real one recorded.
    s.clock.advance(TASK_LOCK_MS);
    const model = new ScriptedModelClient();
    const retried = await runAgentAction(s.deps(model), next);
    expect(retried).toMatchObject({
      status: 'fallback',
      fallbackReason: 'recovered',
      finalAction: 'propose_trade'
    });
    expect(model.transcript).toEqual([]);
    const [trade] = await trades(s);
    expect(await trades(s)).toHaveLength(1);
    expect(await only(s)).toMatchObject({ status: 'waiting_for_partner', tradeId: trade?.trade.tradeId });
    expect(await answers(s, pitch)).toEqual(['Let me look at it.', 'Ran the numbers: offer sent.']);
  });

  it('a lost dispatch is resumed by a check-in, and the superseded task stands down', async () => {
    const s = await interest(STUBBORN, 170);
    const pitch = await tell(s, PITCH);
    await answer(s, pitch);
    const lost = proposals(s)[0]!;
    // Too soon to call it lost.
    s.clock.advance(10 * 60_000);
    await checkIn(s, 'ci-early');
    expect(proposals(s)).toHaveLength(1);
    s.clock.advance(60 * 60_000);
    await checkIn(s, 'ci-resume');
    const resumed = proposals(s).at(-1)!;
    expect(resumed.taskId).toBe(taskIdFor('ci-resume', AGENT_TEAM, 'trade_proposal'));
    expect(resumed.payload).toMatchObject({ commitment: { id: `trade_interest:${pitch.id}` } });
    expect((resumed.payload as { commitment: { change?: string } }).commitment.change).toBeUndefined();
    // A redelivered check-in hands on the same task again (dispatch is idempotent by task id).
    const again = await reviewCommitments(await context(s, 'ci-resume'));
    expect(again.map((f) => f.payload)).toEqual([resumed.payload]);
    expect(await runAgentAction(s.deps(new ScriptedModelClient()), resumed)).toMatchObject({
      finalAction: 'propose_trade'
    });
    expect(await runAgentAction(s.deps(new ScriptedModelClient()), lost)).toMatchObject({
      status: 'skipped',
      fallbackReason: 'commitment_superseded'
    });
    expect(await trades(s)).toHaveLength(1);
    expect(await answers(s, pitch)).toHaveLength(2);
  });
});

describe('commitments: explicit outcomes (#215)', () => {
  it('a seat that changed hands cancels the commitment without a word', async () => {
    const s = await interest(STUBBORN, 170);
    const pitch = await tell(s, PITCH);
    await answer(s, pitch);
    const team = (await s.repos.teams.get(LEAGUE_ID, AGENT_TEAM))!;
    await s.repos.teams.update({ ...team, occupiedSince: s.clock.now().toISOString() });
    const record = await runAgentAction(s.deps(new ScriptedModelClient()), proposals(s)[0]!);
    expect(record).toMatchObject({ status: 'skipped', fallbackReason: 'seat_changed' });
    expect(await only(s)).toMatchObject({ status: 'cancelled', decision: { reason: 'seat_changed' } });
    expect(await book(s, s.clock.now().toISOString())).toEqual([]);
    expect(await trades(s)).toEqual([]);
    expect(await answers(s, pitch)).toEqual(['Let me look at it.']);
  });

  it('a look past its deadline expires and says so; so does one a check-in finds too late', async () => {
    const s = await interest(STUBBORN, 170);
    const late = await tell(s, PITCH);
    await answer(s, late);
    s.clock.advance(5 * DAY);
    const record = await runAgentAction(s.deps(new ScriptedModelClient()), proposals(s)[0]!);
    expect(record).toMatchObject({ status: 'skipped', fallbackReason: 'commitment_expired' });
    expect(await only(s)).toMatchObject({ status: 'expired', decision: { reason: 'deadline_passed' } });
    expect((await answers(s, late)).at(-1)).toBe(
      "Couldn't finish that trade look (I ran out of time on it). Nothing was sent."
    );

    const t = await interest(STUBBORN, 170);
    const lost = await tell(t, PITCH, 'trades');
    await answer(t, lost);
    t.clock.advance(5 * DAY);
    await checkIn(t, 'ci-expire');
    expect(await only(t)).toMatchObject({ status: 'expired' });
    expect((await answers(t, lost)).at(-1)).toBe("Couldn't finish that trade look. Nothing was sent.");
    expect(proposals(t)).toHaveLength(1);
  });

  it('with the budget spent or the kill switch on, nothing is sent and it says so', async () => {
    const s = await interest(STUBBORN, 170);
    const pitch = await tell(s, PITCH);
    await answer(s, pitch);
    const record = await runAgentAction(
      s.deps(new ScriptedModelClient(), { killSwitch: { engaged: async () => true } }),
      proposals(s)[0]!
    );
    expect(record).toMatchObject({ status: 'fallback', fallbackReason: 'kill_switch', finalAction: 'none' });
    expect(await only(s)).toMatchObject({ status: 'cancelled', decision: { reason: 'autopilot' } });
    expect(await trades(s)).toEqual([]);
    expect((await answers(s, pitch)).at(-1)).toBe(
      "Couldn't finish that trade look (I could not give it a proper look). Nothing was sent."
    );
  });

  it('a league room hears the result without the terms', async () => {
    const s = await interest(STUBBORN, 170);
    const pitch = await tell(s, PITCH, 'trades');
    await answer(s, pitch);
    expect(await only(s)).toMatchObject({ source: { visibility: 'room' } });
    await runAgentAction(s.deps(new ScriptedModelClient()), proposals(s)[0]!);
    const lines = await answers(s, pitch);
    expect(lines.at(-1)).toBe('Took a proper look at that trade idea: check your offers.');
    expect(lines.slice(1).join(' ')).not.toMatch(/H RB|WR5|value|bar/);
  });

  it('a failed send never claims success; a pass from the model is its own reason', async () => {
    const s = await interest(STUBBORN, 170);
    const pitch = await tell(s, PITCH);
    await answer(s, pitch);
    // The league refuses the offer (as it would a roster that changed under it).
    const call = ToolBox.prototype.call;
    const refuse = vi.spyOn(ToolBox.prototype, 'call').mockImplementation(async function (
      this: ToolBox,
      name,
      args,
      options
    ) {
      if (name === 'propose_trade')
        return { error: { code: 'CONFLICT' as const, message: 'Roster changed.', fix: 'Retry.' } };
      return call.call(this, name, args, options);
    });
    await runAgentAction(s.deps(new ScriptedModelClient()), proposals(s)[0]!);
    refuse.mockRestore();
    expect(await only(s)).toMatchObject({ status: 'failed', decision: { reason: 'send_failed' } });
    expect((await answers(s, pitch)).at(-1)).toBe(
      "Couldn't finish that trade look (the league would not take the offer). Nothing was sent."
    );

    const t = await interest(STUBBORN, 170);
    const passed = await tell(t, PITCH);
    await answer(t, passed);
    await runAgentAction(
      t.deps(said({ summary: 'Nah.', offers: [], reply: 'Not feeling it.' })),
      proposals(t)[0]!
    );
    expect(await only(t)).toMatchObject({
      status: 'declined',
      decision: { reason: 'model_passed' },
      nextReviewAt: null
    });
    expect((await answers(t, passed)).at(-1)).toBe('Not feeling it.');
  });

  it('with no room for another look, it says so instead of promising one', async () => {
    const s = await interest(STUBBORN, 170);
    for (let i = 0; i < 3; i++) await takeChatActionSlot(s.services, LEAGUE_ID, AGENT_ID);
    const pitch = await tell(s, PITCH);
    await answer(s, pitch);
    expect(proposals(s)).toEqual([]);
    expect(await book(s)).toEqual([]);
    expect((await answers(s, pitch)).sort()).toEqual([NO_ROOM_LINE, 'Let me look at it.']);
  });

  it('a reconsideration waits for a chat-action use, and a store failure fails soft', async () => {
    const s = await interest();
    const pitch = await tell(s, PITCH);
    await answer(s, pitch);
    await runAgentAction(s.deps(new ScriptedModelClient()), proposals(s)[0]!);
    s.clock.advance(13 * 60 * 60_000);
    await hurt(s, ['rb1', 'rb2']);
    for (let i = 0; i < 2; i++) await takeChatActionSlot(s.services, LEAGUE_ID, AGENT_ID);
    await checkIn(s, 'ci-no-use');
    expect(proposals(s)).toHaveLength(1);
    expect((await only(s)).status).toBe('declined');
    // Unreadable commitments leave the check-in working as before.
    vi.spyOn(s.repos.agents, 'getCommitments').mockRejectedValue(new Error('offline'));
    expect(await reviewCommitments(await context(s, 'ci-offline'))).toEqual([]);
    expect(s.logs.join(' ')).toContain('agent commitments unavailable');
  });

  it('without a working store, a pitch still gets the plain #196 look', async () => {
    const s = await interest(STUBBORN, 170);
    vi.spyOn(s.repos.agents, 'getCommitments').mockRejectedValue(new Error('offline'));
    const pitch = await tell(s, PITCH);
    await answer(s, pitch);
    const next = proposals(s)[0]!;
    expect(next.payload).not.toHaveProperty('commitment');
    expect(await runAgentAction(s.deps(new ScriptedModelClient()), next)).toMatchObject({
      finalAction: 'propose_trade'
    });
    expect((await answers(s, pitch)).at(-1)).toBe('Numbers check out. Offer is on its way.');
  });
});

describe('commitments: the runtime edges (#215)', () => {
  it("stands aside without a store, or once the seat is no longer an agent's", async () => {
    const s = await interest(STUBBORN, 170);
    const ctx = await context(s, 'edge');
    const source = { roomId: DM, messageId: 'm-x', fromTeamId: 'team-1' };
    const draft = {
      source,
      visibility: 'dm' as const,
      send: ['wr5'],
      receive: ['h-rb'],
      receivePositions: ['RB']
    };
    const bare = { ...ctx };
    delete bare.commitments;
    expect(await openInterest(bare, draft)).toBeNull();
    expect(await reviewCommitments(bare)).toEqual([]);
    expect(await beginLook(bare, { id: 'x', tenure: TENURE })).toEqual({ skip: 'commitment_unavailable' });
    const human = { ...ctx, commitments: { ...ctx.commitments!, tenure: async () => null } };
    expect(await openInterest(human, draft)).toBeNull();
    expect(await reviewCommitments(human)).toEqual([]);
    expect(await beginLook(ctx, { id: 'missing', tenure: TENURE })).toEqual({ skip: 'commitment_missing' });
  });

  it('records a result once, then recovers a line the budgets temporarily refuse', async () => {
    const s = await interest(STUBBORN, 170);
    const pitch = await tell(s, PITCH);
    await answer(s, pitch);
    const next = proposals(s)[0]!;
    const ctx = { ...(await context(s, 'edge')), taskId: next.taskId };
    const ref = { id: `trade_interest:${pitch.id}`, tenure: TENURE };
    const post = vi
      .spyOn(ctx.tools, 'call')
      .mockResolvedValue({ error: { code: 'RATE_LIMITED', message: 'Budget.', fix: 'Later.' } });
    const event = { type: 'closed', taskId: next.taskId, status: 'cancelled', reason: 'autopilot' } as const;
    expect((await closeLook(ctx, ref, event, failureLines('autopilot'))).applied).toBe(true);
    expect(await only(s)).toMatchObject({ status: 'cancelled', reply: { state: 'withheld' } });
    expect((await closeLook(ctx, ref, event, failureLines('autopilot'))).applied).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
    expect(await beginLook(ctx, ref)).toEqual({ skip: 'commitment_settled' });
    post.mockRestore();

    s.clock.advance(6 * 60_000);
    const recovery = await context(s, 'reply-recovery');
    const followUps = await reviewCommitments(recovery);
    expect(followUps).toEqual([
      {
        kind: 'commitment_reply',
        payload: { id: ref.id, tenure: TENURE, key: `${ref.id}#0` }
      }
    ]);
    expect(
      await runAgentAction(
        s.deps(new ScriptedModelClient()),
        request('commitment_reply', followUps[0]!.payload, 'reply-recovery')
      )
    ).toMatchObject({ status: 'skipped', fallbackReason: 'commitment_reply_sent' });
    expect(await only(s)).toMatchObject({ reply: { state: 'sent', attempts: 2, failure: null } });
    expect((await answers(s, pitch)).at(-1)).toMatch(
      /^Couldn't finish that trade look .* Nothing was sent\.$/
    );
  });

  it('recovers an acknowledgement-lost post without duplicating the closing line', async () => {
    const s = await interest(STUBBORN, 170);
    const pitch = await tell(s, PITCH);
    await answer(s, pitch);
    const next = proposals(s)[0]!;
    const ctx = { ...(await context(s, 'ack-lost')), taskId: next.taskId };
    const ref = { id: `trade_interest:${pitch.id}`, tenure: TENURE };
    const access = ctx.commitments!;
    let writes = 0;
    ctx.commitments = {
      ...access,
      update: async (tenure, change) => {
        writes++;
        if (writes === 2) throw new Error('crashed before acknowledging post');
        return access.update(tenure, change);
      }
    };
    const event = { type: 'closed', taskId: next.taskId, status: 'cancelled', reason: 'autopilot' } as const;
    await expect(closeLook(ctx, ref, event, failureLines('autopilot'))).rejects.toThrow('crashed');
    expect((await answers(s, pitch)).filter((m) => m.includes('Nothing was sent.'))).toHaveLength(1);
    expect(await only(s)).toMatchObject({ reply: { state: 'claimed', attempts: 1 } });

    s.clock.advance(3 * 60_000);
    const recovery = await context(s, 'ack-recovery');
    const follow = (await reviewCommitments(recovery))[0]!;
    expect(follow.kind).toBe('commitment_reply');
    await runAgentAction(
      s.deps(new ScriptedModelClient()),
      request('commitment_reply', follow.payload, 'ack-recovery')
    );
    expect((await answers(s, pitch)).filter((m) => m.includes('Nothing was sent.'))).toHaveLength(1);
    expect(await only(s)).toMatchObject({ reply: { state: 'sent', attempts: 1 } });
  });

  it('reuses a reconsidered look fresh reply key after its post acknowledgement is lost', async () => {
    const s = await interest(STUBBORN, 170);
    const pitch = await tell(s, PITCH);
    await answer(s, pitch);
    const first = proposals(s)[0]!;
    const ref = { id: `trade_interest:${pitch.id}`, tenure: TENURE };
    const firstCtx = { ...(await context(s, 'first-look')), taskId: first.taskId };
    await closeLook(
      firstCtx,
      ref,
      { type: 'closed', taskId: first.taskId, status: 'declined', reason: 'value_below_floor' },
      { dm: 'First pass.', room: 'First pass.' }
    );
    await firstCtx.commitments!.update(TENURE, (book) => ({
      ...book,
      commitments: book.commitments.map((c) =>
        c.id === ref.id && c.reply !== null ? { ...c, reply: { ...c.reply, attempts: 3 } } : c
      )
    }));

    s.clock.advance(DAY);
    const secondTask = taskIdFor('reconsider-crash', AGENT_TEAM, 'trade_proposal');
    await firstCtx.commitments!.update(
      TENURE,
      (book) =>
        advanceCommitment(
          book,
          ref.id,
          { type: 'redispatch', taskId: secondTask, mode: 'reconsider' },
          s.clock.now().toISOString()
        ).book
    );
    const secondCtx = { ...(await context(s, 'reconsider-crash')), taskId: secondTask };
    const access = secondCtx.commitments!;
    let writes = 0;
    secondCtx.commitments = {
      ...access,
      update: async (tenure, change) => {
        writes++;
        if (writes === 2) throw new Error('crashed before acknowledging reconsidered reply');
        return access.update(tenure, change);
      }
    };
    const again = 'Looked again and still passed.';
    await expect(
      closeLook(
        secondCtx,
        ref,
        { type: 'closed', taskId: secondTask, status: 'declined', reason: 'value_below_floor' },
        { dm: again, room: again }
      )
    ).rejects.toThrow('crashed');
    expect(await only(s)).toMatchObject({
      reconsiderations: 1,
      reply: { key: `${ref.id}#1`, state: 'claimed', attempts: 1 }
    });
    expect((await answers(s, pitch)).filter((line) => line === again)).toHaveLength(1);

    s.clock.advance(3 * 60_000);
    const recovery = await context(s, 'reconsider-recovery');
    const follow = (await reviewCommitments(recovery))[0]!;
    expect(follow).toMatchObject({ kind: 'commitment_reply', payload: { key: `${ref.id}#1` } });
    expect(await deliverReply(recovery, { id: ref.id, tenure: TENURE, key: `${ref.id}#1` })).toBe('sent');
    expect((await answers(s, pitch)).filter((line) => line === again)).toHaveLength(1);
  });

  it('does not post from a claim discarded by a commitment CAS retry', async () => {
    const s = await interest(STUBBORN, 170);
    const pitch = await tell(s, PITCH);
    await answer(s, pitch);
    const next = proposals(s)[0]!;
    const ref = { id: `trade_interest:${pitch.id}`, tenure: TENURE };
    const ctx = { ...(await context(s, 'cas-loser')), taskId: next.taskId };
    const access = ctx.commitments!;
    const event = { type: 'closed', taskId: next.taskId, status: 'cancelled', reason: 'autopilot' } as const;
    const lines = failureLines('autopilot');
    ctx.commitments = {
      ...access,
      update: async (tenure, change) => {
        const initial = await access.read(tenure);
        change(initial); // The first CAS candidate loses after claiming locally.
        const won = advanceCommitment(initial, ref.id, event, s.clock.now().toISOString());
        const winner = claimReply(won.book, ref.id, {
          at: s.clock.now().toISOString(),
          owner: 'competing-task',
          text: lines.dm
        });
        return change(winner.book); // Dynamo retries the callback against the winning book.
      }
    };
    const post = vi.spyOn(ctx.tools, 'call');
    expect(await closeLook(ctx, ref, event, lines)).toMatchObject({ applied: false });
    expect(post).not.toHaveBeenCalled();
  });

  it('settles recovered replies when the seat changed or the room is permanently unavailable', async () => {
    const pending = async () => {
      const s = await interest(STUBBORN, 170);
      const pitch = await tell(s, PITCH);
      await answer(s, pitch);
      const next = proposals(s)[0]!;
      const ctx = { ...(await context(s, 'edge')), taskId: next.taskId };
      vi.spyOn(ctx.tools, 'call').mockResolvedValue({
        error: { code: 'RATE_LIMITED', message: 'Later.', fix: 'Wait.' }
      });
      const id = `trade_interest:${pitch.id}`;
      await closeLook(
        ctx,
        { id, tenure: TENURE },
        { type: 'closed', taskId: next.taskId, status: 'cancelled', reason: 'autopilot' },
        failureLines('autopilot')
      );
      s.clock.advance(6 * 60_000);
      return { s, id };
    };

    const changed = await pending();
    const changedCtx = await context(changed.s, 'seat-changed');
    changedCtx.commitments = { ...changedCtx.commitments!, tenure: async () => null };
    expect(await deliverReply(changedCtx, { id: changed.id, tenure: TENURE, key: `${changed.id}#0` })).toBe(
      'suppressed'
    );
    expect(await only(changed.s)).toMatchObject({ reply: { state: 'suppressed', failure: 'seat_changed' } });

    const missing = await pending();
    const missingCtx = await context(missing.s, 'room-missing');
    vi.spyOn(missingCtx.tools, 'call').mockResolvedValue({
      error: { code: 'ROOM_NOT_FOUND', message: 'Gone.', fix: 'None.' }
    });
    expect(await deliverReply(missingCtx, { id: missing.id, tenure: TENURE, key: `${missing.id}#0` })).toBe(
      'suppressed'
    );
    expect(await only(missing.s)).toMatchObject({
      reply: { state: 'suppressed', failure: 'ROOM_NOT_FOUND' }
    });

    const completed = await pending();
    const completedCtx = await context(completed.s, 'league-complete');
    completedCtx.league = { ...completedCtx.league, phase: 'complete' };
    expect(
      await deliverReply(completedCtx, {
        id: completed.id,
        tenure: TENURE,
        key: `${completed.id}#0`
      })
    ).toBe('suppressed');
    expect(await only(completed.s)).toMatchObject({
      reply: { state: 'suppressed', failure: 'league_complete' }
    });

    const unavailableCtx = await context(completed.s, 'no-store');
    unavailableCtx.commitments = undefined;
    expect(
      await deliverReply(unavailableCtx, {
        id: completed.id,
        tenure: TENURE,
        key: `${completed.id}#0`
      })
    ).toBe('unavailable');
  });

  it('keeps waiting on an offer the league has not answered or cannot show', async () => {
    const s = await interest(STUBBORN, 170);
    await answer(s, await tell(s, PITCH));
    await runAgentAction(s.deps(new ScriptedModelClient()), proposals(s)[0]!);
    expect(await reviewCommitments(await context(s, 'ci-open'))).toEqual([]);
    const ctx = await context(s, 'ci-hidden');
    vi.spyOn(ctx.tools, 'call').mockResolvedValue({
      error: { code: 'NOT_FOUND', message: 'Gone.', fix: 'None.' }
    });
    expect(await reviewCommitments(ctx)).toEqual([]);
    expect((await only(s)).status).toBe('waiting_for_partner');
  });

  it('hands on nothing when another task took the commitment first', async () => {
    const s = await interest(STUBBORN, 170);
    await answer(s, await tell(s, PITCH));
    s.clock.advance(2 * 60 * 60_000);
    const ctx = await context(s, 'ci-race');
    const access = ctx.commitments!;
    let raced = false;
    ctx.commitments = {
      ...access,
      update: (tenure, change) =>
        access.update(tenure, (b) => {
          if (raced) return change(b);
          raced = true;
          // Meanwhile another check-in resumed it.
          const at = s.clock.now().toISOString();
          const id = b.commitments[0]!.id;
          return change(
            advanceCommitment(b, id, { type: 'redispatch', taskId: 'other', mode: 'resume' }, at).book
          );
        })
    };
    expect(await reviewCommitments(ctx)).toEqual([]);
    expect((await only(s)).childTaskIds.at(-1)).toBe('other');
  });

  it('dispatches what a check-in with nothing else to do hands on, retrying a failed dispatch', async () => {
    const s = await interest(STUBBORN, 170);
    await answer(s, await tell(s, PITCH));
    s.clock.advance(2 * 60 * 60_000);
    const reserve = vi.spyOn(s.repos.agents, 'reserveDispatch').mockRejectedValueOnce(new Error('offline'));
    const failed = await checkIn(s, 'ci-dispatch');
    expect(failed.fallbackReason).toBe('retry_scheduled');
    reserve.mockRestore();
    s.clock.advance(TASK_LOCK_MS);
    const done = await checkIn(s, 'ci-dispatch');
    expect(done).toMatchObject({ status: 'skipped', fallbackReason: 'nothing_to_do' });
    expect(proposals(s).at(-1)?.taskId).toBe(taskIdFor('ci-dispatch', AGENT_TEAM, 'trade_proposal'));
  });

  it('hands on only players both teams really roster', async () => {
    const s = await interest(STUBBORN, 170);
    await answer(s, await tell(s, 'Give me WR5.'), { kind: 'trade', players: ['WR5', 'Nobody'] });
    expect(proposals(s)).toEqual([]);
    expect(await book(s)).toEqual([]);
  });

  it('declines a lopsided swap as lopsided, even one that favours the agent (#219)', async () => {
    // H RB projects far above WR5: by its own numbers the agent would win big, but the value math
    // calls the swap lopsided. "The value was not there for me" would be false.
    const s = await interest(STUBBORN, 2_000);
    const pitch = await tell(s, PITCH);
    await answer(s, pitch);
    await runAgentAction(s.deps(new ScriptedModelClient()), proposals(s)[0]!);
    const c = await only(s);
    expect(c).toMatchObject({ status: 'declined', decision: { reason: 'lopsided' }, nextReviewAt: null });
    expect(c.decision!.facts!.score!).toBeGreaterThan(c.decision!.facts!.bar!);
    expect(await answers(s, pitch)).toContain(
      'Took a proper look at that one: it was too one-sided to be fair. Pass for now.'
    );
    expect(await trades(s)).toEqual([]);
  });
});

describe("findings from #219's acceptance scenario", () => {
  it('declines a pitch it has no projections for as missing data, not as no value', async () => {
    const s = await interest();
    // A newer, empty snapshot: the week's projections are not out.
    await s.services.data.reference.projections.putSnapshot(
      { season: 2026, week: 5, capturedAt: '2026-10-03T12:00:00.000Z', hash: 'empty', count: 0 },
      []
    );
    const pitch = await tell(s, PITCH);
    await answer(s, pitch);
    await runAgentAction(s.deps(new ScriptedModelClient()), proposals(s)[0]!);
    expect(await only(s)).toMatchObject({
      status: 'declined',
      decision: { reason: 'missing_data', facts: { score: null } },
      nextReviewAt: null
    });
    expect(await answers(s, pitch)).toContain(
      'Took a proper look at that one: I had no projections to value it by yet. Pass for now.'
    );
    expect(await trades(s)).toEqual([]);
  });

  it('a check-in that runs after the league is complete stands down without touching the lineup', async () => {
    const s = await interest();
    const league = (await s.repos.leagues.get(LEAGUE_ID))!;
    await s.repos.leagues.update({ ...league, phase: 'complete' });
    const model = said({ summary: 'Quiet day.', actions: [{ type: 'none' }] });
    const record = await checkIn(s, 'ci-complete', model);
    expect(record).toMatchObject({ status: 'skipped', fallbackReason: 'league_complete', toolsCalled: [] });
    expect(model.transcript).toEqual([]);
    expect(await s.savedLineups()).toEqual([]);
  });
});

describe('evaluation ablations (#219, ablations.ts)', () => {
  const off = (s: Setup, model: ScriptedModelClient, ablations: AgentAblation[]) => ({
    ...s.deps(model),
    ablations
  });

  it('without agenda and commitments, a pitch takes the plain #196 follow-up and no state is written', async () => {
    const s = await interest();
    const pitch = await tell(s, PITCH);
    await runAgentAction(
      off(s, said({ summary: 'Answered.', message: 'Let me look at it.', takeaway: TRADE_TALK }), [
        'no_agenda_commitments'
      ]),
      request('chat_reply', { messageId: pitch.id, roomId: pitch.roomId })
    );
    expect(proposals(s)).toHaveLength(1);
    expect(proposals(s)[0]!.payload).not.toHaveProperty('commitment');
    await hurt(s, ['rb1', 'rb2']);
    await runAgentAction(
      off(s, said({ summary: 'Quiet day.', actions: [{ type: 'none' }] }), ['no_agenda_commitments']),
      request('check_in', { slot: 'afternoon' }, 'ci-off', 'Manager Check-In')
    );
    expect(await book(s)).toEqual([]);
    expect((await s.repos.agents.getAgenda(LEAGUE_ID, AGENT_ID, TENURE)).goals).toEqual([]);
  });

  it('without attachments, a drafted favourite adds no premium to the bar', async () => {
    const s = await interest(STUBBORN, 155);
    await s.repos.agents.updateAttachments(LEAGUE_ID, AGENT_ID, TENURE, (a) =>
      recordAcquisition(a, {
        sourceId: `draft:${LEAGUE_ID}:wr5`,
        kind: 'drafted',
        playerId: 'wr5',
        name: 'WR5',
        position: 'WR',
        at: START,
        round: 1
      })
    );
    await answer(s, await tell(s, PITCH));
    await runAgentAction(off(s, new ScriptedModelClient(), ['no_attachments']), proposals(s)[0]!);
    // The same pitch the premium tips into a decline (above) clears without it.
    expect(await only(s)).toMatchObject({
      status: 'waiting_for_partner',
      decision: { reason: 'offer_sent', facts: { attachmentPremium: 0 } }
    });
  });

  it('without situation or social acts, a check-in reads neither', async () => {
    const s = await interest();
    await runAgentAction(
      off(s, said({ summary: 'Quiet day.', actions: [{ type: 'none' }] }), [
        'no_situation',
        'no_social_acts'
      ]),
      request('check_in', { slot: 'afternoon' }, 'ci-bare', 'Manager Check-In')
    );
    expect(s.logs.some((l) => l.includes('"agent situation"'))).toBe(false);
    expect(s.logs.some((l) => l.includes('"agent social selection"'))).toBe(false);
    await runAgentAction(
      s.deps(said({ summary: 'Quiet day.', actions: [{ type: 'none' }] })),
      request('check_in', { slot: 'evening' }, 'ci-full', 'Manager Check-In')
    );
    expect(s.logs.some((l) => l.includes('"agent situation"'))).toBe(true);
    expect(s.logs.some((l) => l.includes('"agent social selection"'))).toBe(true);
  });
});

/** A task context for driving the check-in's commitment pass directly. */
async function context(s: Setup, eventId: string): Promise<TaskContext> {
  const seat = (await s.repos.agents.getSeat(LEAGUE_ID, AGENT_TEAM))!;
  const principal = agentPrincipal({ agentId: AGENT_ID, teamId: AGENT_TEAM, leagueId: LEAGUE_ID });
  return {
    taskId: taskIdFor(eventId, AGENT_TEAM, 'check_in'),
    principal,
    seat,
    config: resolveAgentConfig(seat.config),
    league: (await s.repos.leagues.get(LEAGUE_ID))!,
    clock: s.clock,
    log: s.services.log,
    trigger: { detailType: 'Manager Check-In', eventId },
    commitments: commitmentAccess(s.services, LEAGUE_ID, AGENT_ID, AGENT_TEAM),
    claimLimit: async () => true,
    tools: new ToolBox({
      registry: s.registry,
      services: s.services,
      principal,
      research: { news: true, projections: true, trending: true, matchupOutlook: true },
      actionsPerTrigger: 10,
      idempotencyPrefix: eventId
    })
  };
}
