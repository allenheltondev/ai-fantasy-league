import { beforeAll, describe, expect, it } from 'vitest';
import type { AgentSeatConfig } from '@fantasy/core';
import {
  CANARY,
  PITCH,
  checkAcceptance,
  choiceProfile,
  decisionViolations,
  runTradeInterestScenario,
  type AcceptanceCheck,
  type AcceptanceRun
} from './trade-interest.js';
import { AGENT_TEAM, PERSON_TEAM } from './world.js';

/**
 * The epic #219 acceptance scenario (trade-interest.ts), end to end through the event loop on the
 * simulated clock with the scripted model: every check is a hard assertion, for a balanced manager
 * and again for a cautious and a trade-happy one, which must stay valid and choose differently.
 */

const manager = (archetype: AgentSeatConfig['archetype']): AgentSeatConfig => ({
  personalityId: 'smug-veteran',
  difficulty: 'hall_of_famer',
  archetype
});

let balanced: AcceptanceRun;
let cautious: AcceptanceRun;
let eager: AcceptanceRun;
beforeAll(async () => {
  balanced = await runTradeInterestScenario({ config: manager('balanced') });
  cautious = await runTradeInterestScenario({ config: manager('analytics_only') });
  eager = await runTradeInterestScenario({ config: manager('trade_happy') });
}, 60_000);

const named = (checks: AcceptanceCheck[], name: AcceptanceCheck['name']) =>
  checks.find((c) => c.name === name) as AcceptanceCheck;
const look = (run: AcceptanceRun, phase: string) => run.looks.find((l) => l.phase === phase)?.commitment;

describe('the epic #219 acceptance scenario', () => {
  it('holds every check for a balanced manager', () => {
    const checks = checkAcceptance(balanced);
    expect(checks.map((c) => c.name)).toEqual([
      'one_objective',
      'commitment_from_pitch',
      'accurate_decisions',
      'linked_once',
      'reconsidered',
      'goal_closed',
      'audience_recall'
    ]);
    for (const c of checks) expect(c, c.name).toMatchObject({ ok: true, violations: [] });
  });

  it('turns an authoritative injury into exactly one RB goal, and a pitch into a commitment tied to it', () => {
    expect(balanced.goalsAfterInjury).toMatchObject([{ slot: 'RB', status: 'active', missing: 1 }]);
    const goal = balanced.goalsAfterInjury[0]?.id;
    expect(look(balanced, 'pitch')).toMatchObject({
      id: `trade_interest:${balanced.pitch.id}`,
      kind: 'trade_interest',
      agendaId: goal,
      counterpartTeamId: PERSON_TEAM,
      source: { messageId: balanced.pitch.id, visibility: 'dm' },
      intent: { send: [PITCH.send], receive: [PITCH.receive] }
    });
  });

  it('declines first for the depth it would lose, then reconsiders after WR2 goes down and sends a fresh offer', () => {
    expect(look(balanced, 'pitch')).toMatchObject({
      status: 'declined',
      tradeId: null,
      decision: {
        reason: 'insufficient_depth',
        facts: { lineupDelta: -4, needs: ['RB'], receivePositions: ['RB'] }
      },
      claims: [{ verification: 'unsupported' }]
    });
    const again = look(balanced, 'reconsider');
    expect(again).toMatchObject({
      status: 'waiting_for_partner',
      reconsiderations: 1,
      decision: { reason: 'offer_sent', facts: { needs: ['RB', 'W/R/T'] } },
      claims: [{ verification: 'supported' }]
    });
    expect(again?.tradeId).not.toBe(balanced.withdrawnTradeId);
    const offer = balanced.trades.find((t) => t.trade.tradeId === again?.tradeId)?.trade;
    expect(offer?.sides.map((s) => [s.teamId, s.sends])).toEqual([
      [AGENT_TEAM, [PITCH.send]],
      [PERSON_TEAM, [PITCH.receive]]
    ]);
    // The person accepted it; the review ran out; the commitment knows the partner's answer.
    expect(offer?.status).toBe('processed');
    expect(balanced.finalCommitment).toMatchObject({
      status: 'fulfilled',
      decision: { reason: 'partner_accepted' }
    });
    expect(balanced.trades.find((t) => t.trade.tradeId === balanced.withdrawnTradeId)?.trade.status).toBe(
      'withdrawn'
    );
  });

  it('answers the pitch once, closes each look with one line, and duplicates nothing on redelivery', () => {
    expect([...balanced.replies].sort()).toEqual(
      [
        'Let me run the numbers on that.',
        'Took a proper look at that one: I could not spare the depth. Pass for now.',
        'Earlier I passed because I could not spare the depth. My W/R/T situation changed, so I sent you an offer.'
      ].sort()
    );
    expect(balanced.redelivery.tradesAfter).toBe(balanced.redelivery.tradesBefore);
    expect(balanced.redelivery.repliesAfter).toBe(balanced.redelivery.repliesBefore);
  });

  it('closes every goal once the need is met, and stops trade outreach', () => {
    expect(balanced.closedAt).not.toBeNull();
    expect(balanced.goalsAtEnd.every((g) => g.status === 'completed')).toBe(true);
    expect(named(checkAcceptance(balanced), 'goal_closed').violations).toEqual([]);
  });

  it('recalls the trade in the DM, keeps private offers out of the league room, and the canary in the DM', () => {
    const recall = named(checkAcceptance(balanced), 'audience_recall');
    expect(recall.evidence[0]).toMatch(/Trade with Allen's Team \(processed; record\)/);
    // The withdrawn offer is remembered as withdrawn, never as an open one (#219's memory fix).
    expect(balanced.recall.dm?.systemPrompt).toMatch(/An offer from team-1 was withdrawn/);
    expect(balanced.recall.room?.systemPrompt).not.toMatch(/withdrawn|An offer from/);
    expect(balanced.recall.room?.systemPrompt).not.toContain(CANARY);
    expect(balanced.chat.filter((m) => m.text.includes(CANARY)).map((m) => m.roomId)).toEqual([
      balanced.pitch.roomId
    ]);
  });

  it('is deterministic: the same run gives the same decisions, trades, lines, and usage', async () => {
    const again = await runTradeInterestScenario({ config: manager('balanced') });
    const shape = (r: AcceptanceRun) => ({
      looks: r.looks,
      trades: r.trades.map((t) => t.trade),
      replies: r.replies,
      usage: r.usage,
      goals: r.goalsAtEnd
    });
    expect(shape(again)).toEqual(shape(balanced));
  });
});

describe('a cautious and a trade-happy manager in the same scenario', () => {
  it('both stay valid and coherent', () => {
    for (const run of [cautious, eager])
      for (const c of checkAcceptance(run))
        expect(c, `${run.config.archetype} ${c.name}`).toMatchObject({ ok: true });
  });

  it('choose differently, measurably: the bar, the marginal pitch, and the offers sent', () => {
    expect(choiceProfile(cautious)).toEqual({
      archetype: 'analytics_only',
      bar: 2,
      marginal: 'value_below_floor',
      offersSent: 1,
      offersAccepted: 1
    });
    expect(choiceProfile(eager)).toEqual({
      archetype: 'trade_happy',
      bar: 1,
      marginal: 'offer_sent',
      offersSent: 2,
      offersAccepted: 1
    });
    // The same marginal swap: the cautious manager's score misses its bar, the eager one's clears it.
    const [c, e] = [look(cautious, 'marginal'), look(eager, 'marginal')];
    expect(c?.decision?.facts?.score).toBeLessThan(c?.decision?.facts?.bar as number);
    expect(e?.decision?.facts?.score).toBeGreaterThanOrEqual(e?.decision?.facts?.bar as number);
  });
});

describe('the checks catch a broken run', () => {
  const tamper = (change: (r: AcceptanceRun) => void): AcceptanceRun => {
    const r = structuredClone(balanced);
    change(r);
    return r;
  };
  const broken = (r: AcceptanceRun, name: AcceptanceCheck['name']) => named(checkAcceptance(r), name);

  it('a second goal, or none', () => {
    const two = tamper((r) => r.goalsAfterInjury.push({ ...r.goalsAfterInjury[0]!, slot: 'TE' }));
    expect(broken(two, 'one_objective')).toMatchObject({ ok: false });
    const none = tamper((r) => (r.goalsAfterInjury = []));
    expect(broken(none, 'one_objective').violations[0]).toMatch(/found none/);
  });

  it('a missing or misdirected commitment', () => {
    expect(
      broken(
        tamper((r) => (r.looks = [])),
        'commitment_from_pitch'
      ).ok
    ).toBe(false);
    const wrong = tamper((r) => {
      const c = r.looks.find((l) => l.phase === 'pitch')?.commitment;
      if (c) {
        c.source.messageId = 'other';
        c.intent.send = ['qb1'];
        c.agendaId = null;
        (c as { kind: string }).kind = 'other';
      }
    });
    expect(broken(wrong, 'commitment_from_pitch').violations).toHaveLength(4);
  });

  it('a decision its facts do not support', () => {
    const c = structuredClone(look(balanced, 'reconsider'))!;
    expect(decisionViolations({ ...c, tradeId: 'gone' }, balanced.trades)[0]).toMatch(/not in the league/);
    const low = { ...c, decision: { ...c.decision!, facts: { ...c.decision!.facts!, score: 0 } } };
    expect(decisionViolations(low, balanced.trades)[0]).toMatch(/below its bar/);
    const other = { ...c, intent: { send: ['qb1'], receive: [PITCH.receive] } };
    expect(decisionViolations(other, balanced.trades)[0]).toMatch(/not the pitched swap/);
    const d = structuredClone(look(balanced, 'pitch'))!;
    const high = { ...d, decision: { ...d.decision!, facts: { ...d.decision!.facts!, score: 9 } } };
    expect(decisionViolations(high, [])[0]).toMatch(/cleared the bar/);
    const shallow = { ...d, decision: { ...d.decision!, facts: { ...d.decision!.facts!, lineupDelta: 2 } } };
    expect(decisionViolations(shallow, [])[0]).toMatch(/insufficient_depth with a lineup change of 2/);
    expect(decisionViolations({ ...d, decision: null }, [])).toEqual([]);
    expect(decisionViolations({ ...d, decision: { ...d.decision!, reason: 'lopsided' } }, [])).toEqual([]);
    expect(
      broken(
        tamper((r) => r.looks.push({ phase: 'pitch', commitment: high })),
        'accurate_decisions'
      ).ok
    ).toBe(false);
  });

  it('broken links and duplicates', () => {
    expect(
      broken(
        tamper((r) => (r.finalCommitment = null)),
        'linked_once'
      ).ok
    ).toBe(false);
    const r = tamper((x) => {
      const c = x.finalCommitment!;
      c.childTaskIds = [...c.childTaskIds, 'trade_proposal.missing'];
      c.tradeId = 'gone';
      x.replies.push('A second closing line.');
      x.redelivery.tradesAfter++;
      x.trades.push(structuredClone(x.trades.find((t) => t.trade.sides[0].teamId === AGENT_TEAM)!));
    });
    expect(broken(r, 'linked_once').violations).toHaveLength(5);
  });

  it('no reconsideration, a resurrected offer, or a withdrawn offer remembered as open', () => {
    expect(
      broken(
        tamper((r) => (r.looks = r.looks.filter((l) => l.phase !== 'reconsider'))),
        'reconsidered'
      ).ok
    ).toBe(false);
    const r = tamper((x) => {
      const again = x.looks.find((l) => l.phase === 'reconsider')!.commitment!;
      again.reconsiderations = 0;
      again.decision!.facts!.needs = ['RB'];
      again.tradeId = x.withdrawnTradeId;
      x.trades.find((t) => t.trade.tradeId === x.withdrawnTradeId)!.trade.status = 'proposed';
      x.recall.dm!.systemPrompt = '# What you remember\n- An offer from team-1 was proposed.';
    });
    expect(broken(r, 'reconsidered').violations).toHaveLength(5);
  });

  it('no goal, a goal left open, or outreach after it closed', () => {
    const unclosed = tamper((r) => (r.closedAt = null));
    expect(broken(unclosed, 'goal_closed').violations).toEqual(['a goal never closed']);
    const none = tamper((r) => (r.goalsAtEnd = []));
    expect(broken(none, 'goal_closed').violations).toEqual(['no goal was ever set']);
    const r = tamper((x) => {
      x.goalsAtEnd[0]!.status = 'active';
      x.tasks.push({ ...x.tasks[0]!, kind: 'trade_proposal', startedAt: x.closedAt! });
    });
    expect(broken(r, 'goal_closed').violations).toHaveLength(2);
  });

  it('recall that leaks, or none', () => {
    const r = tamper((x) => {
      x.recall.dm!.systemPrompt = '';
      x.recall.room!.systemPrompt = `# What you remember from this league\n- Trade with X (rejected; record): no.`;
      x.runs.push({ ...x.runs[0]!, kind: 'check_in', systemPrompt: CANARY });
      x.chat.push({ ...x.chat[0]!, roomId: 'trash-talk', text: CANARY });
    });
    expect(broken(r, 'audience_recall').violations).toHaveLength(4);
    const empty = tamper((x) => (x.recall = { dm: null, room: null }));
    expect(broken(empty, 'audience_recall').ok).toBe(false);
  });
});
