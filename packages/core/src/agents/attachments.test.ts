import { describe, expect, it } from 'vitest';
import { emptyAgenda, reconcileAgenda } from './agenda.js';
import {
  ATTACHMENT_LIMITS,
  ATTACHMENT_POLICY,
  activeAttachments,
  attachmentAdjustment,
  attachmentConviction,
  attachmentPrompt,
  attachmentScale,
  attachmentSummary,
  draftStrength,
  emptyAttachments,
  observePerformance,
  observeRoster,
  recordAcquisition,
  recordDeparture,
  type Acquisition,
  type PlayerAttachments
} from './attachments.js';

const T0 = '2026-09-01T12:00:00.000Z';
const day = (n: number) => new Date(Date.parse(T0) + n * 86_400_000).toISOString();
const drafted = (overrides: Partial<Acquisition> = {}): Acquisition => ({
  sourceId: 'draft:lg:3',
  kind: 'drafted',
  playerId: 'rb1',
  name: 'Robbie Back',
  position: 'RB',
  at: T0,
  round: 1,
  ...overrides
});
const week = (w: number, points: number, projected = 15, at = day(w * 7)) => ({
  at,
  week: w,
  results: [{ playerId: 'rb1', points, projected }]
});
const pref = (state: PlayerAttachments, id = 'rb1') => state.preferences.find((p) => p.playerId === id);

describe('player attachments', () => {
  it('creates an attributed attachment from a real pick, keyed by its source event', () => {
    const state = recordAcquisition(emptyAttachments(), drafted());
    expect(pref(state)).toMatchObject({
      type: 'attachment',
      status: 'held',
      strength: 0.7,
      conviction: 0.7,
      confidence: 0.5,
      sources: [{ id: 'draft:lg:3', kind: 'drafted', round: 1, at: T0 }],
      createdAt: T0,
      heldSince: T0,
      visibility: 'public'
    });
    expect(Date.parse(pref(state)!.reviewAt)).toBeGreaterThan(Date.parse(T0));
    // A redelivered pick, or the same pick replayed later, changes nothing.
    expect(recordAcquisition(state, drafted())).toBe(state);
    expect(recordAcquisition(state, drafted({ at: day(3) }))).toBe(state);
  });

  it('never adds sources up: a second acquisition keeps the strongest strength', () => {
    let state = recordAcquisition(emptyAttachments(), drafted({ round: 8 }));
    expect(pref(state)?.strength).toBe(draftStrength(8));
    state = recordAcquisition(state, {
      ...drafted(),
      sourceId: 'trade:t1:rb1',
      kind: 'traded_for',
      at: day(1)
    });
    expect(pref(state)?.strength).toBe(Math.max(draftStrength(8), ATTACHMENT_POLICY.tradedFor));
    expect(pref(state)?.sources).toHaveLength(2);
    expect(draftStrength(1)).toBe(0.7);
    expect(draftStrength(15)).toBe(0.4);
  });

  it('decays slowly and only down to a floor with time alone', () => {
    const p = pref(recordAcquisition(emptyAttachments(), drafted()))!;
    expect(attachmentConviction(p, T0)).toBe(0.7);
    const sixWeeks = attachmentConviction(p, day(42));
    expect(sixWeeks).toBeCloseTo(0.7 * (0.5 + 0.5 * 0.5), 2);
    expect(attachmentConviction(p, day(3650))).toBe(0.35);
    // Decay is time-derived, never compounded by repeated reads.
    expect(attachmentConviction(p, day(42))).toBe(sixWeeks);
  });

  it('revises a conviction from sustained results, but one bad week cannot erase it', () => {
    let state = recordAcquisition(emptyAttachments(), drafted());
    state = observePerformance(state, week(1, 2));
    expect(pref(state)!.conviction).toBeGreaterThan(ATTACHMENT_POLICY.minConviction + 0.2);
    expect(pref(state)!.revisions).toEqual([]);
    for (const w of [2, 3, 4, 5]) state = observePerformance(state, week(w, 1));
    const after = pref(state)!;
    expect(after.conviction).toBeLessThan(ATTACHMENT_POLICY.minConviction);
    expect(after.confidence).toBe(0.9);
    expect(after.revisions.at(-1)?.reason).toContain('Fell short of projection in 5 of the last 5 weeks');
    expect(activeAttachments(state, day(35))).toEqual([]);
    // Strong weeks can rebuild it, within the cap.
    for (const w of [6, 7, 8, 9, 10, 11]) state = observePerformance(state, week(w, 40));
    expect(pref(state)!.performance).toHaveLength(ATTACHMENT_LIMITS.weeks);
    expect(pref(state)!.conviction).toBeLessThanOrEqual(1);
    expect(pref(state)!.revisions.at(-1)?.reason).toContain('beat projection');
  });

  it('replaces a corrected week instead of double counting, and ignores stale reads', () => {
    let state = recordAcquisition(emptyAttachments(), drafted());
    state = observePerformance(state, week(1, 2, 15, day(8)));
    const once = pref(state)!.conviction;
    // The same week read again (a redelivery) counts once.
    expect(observePerformance(state, week(1, 2, 15, day(9)))).toBe(state);
    // A stat correction replaces the week.
    const corrected = observePerformance(state, week(1, 20, 15, day(10)));
    expect(pref(corrected)!.performance).toHaveLength(1);
    expect(pref(corrected)!.performance[0]?.points).toBe(20);
    expect(pref(corrected)!.conviction).toBeGreaterThan(once);
    // An older read of the same week arriving late cannot roll the correction back.
    expect(observePerformance(corrected, week(1, 0, 15, day(9)))).toBe(corrected);
    // No projection, no expectation to judge.
    expect(observePerformance(state, week(2, 0, 0))).toBe(state);
  });

  it('ends on departure with a causal record and ignores out-of-order evidence', () => {
    let state = recordAcquisition(emptyAttachments(), drafted());
    state = recordDeparture(state, {
      sourceId: 'trade:t9:out:rb1',
      playerId: 'rb1',
      at: day(20),
      reason: 'Traded away.'
    });
    expect(pref(state)).toMatchObject({ status: 'departed', departedAt: day(20), conviction: 0 });
    expect(pref(state)?.revisions.at(-1)?.reason).toBe('Traded away.');
    expect(attachmentConviction(pref(state)!, day(20))).toBe(0);
    // A pickup older than the departure (delivered late) does not bring him back.
    const late = recordAcquisition(state, {
      ...drafted(),
      sourceId: 'trade:t0:rb1',
      kind: 'traded_for',
      at: day(10)
    });
    expect(pref(late)?.status).toBe('departed');
    // A later reacquisition does, as a fresh hold.
    const back = recordAcquisition(state, {
      ...drafted(),
      sourceId: 'trade:t10:rb1',
      kind: 'traded_for',
      at: day(30)
    });
    expect(pref(back)).toMatchObject({ status: 'held', heldSince: day(30), departedAt: null });
    // A departure from before the latest acquisition is stale.
    expect(
      pref(recordDeparture(back, { sourceId: 'x', playerId: 'rb1', at: day(25), reason: 'late' }))?.status
    ).toBe('held');
    expect(pref(observeRoster(back, { at: day(31), playerIds: ['rb1'] }))?.status).toBe('held');
    expect(pref(observeRoster(back, { at: day(31), playerIds: [] }))?.status).toBe('departed');
  });

  it('bounds held preferences, history, and the seen keys', () => {
    let state = emptyAttachments();
    for (let round = 1; round <= 15; round++)
      state = recordAcquisition(
        state,
        drafted({ sourceId: `draft:lg:${round}`, playerId: `p${round}`, round, at: day(round) })
      );
    const held = state.preferences.filter((p) => p.status === 'held');
    expect(held).toHaveLength(ATTACHMENT_LIMITS.active);
    expect(held.map((p) => p.playerId)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    // A pick that did not make the cut is still seen: its redelivery does not reshuffle anything.
    expect(recordAcquisition(state, drafted({ sourceId: 'draft:lg:15', playerId: 'p15', round: 15 }))).toBe(
      state
    );
    for (let i = 0; i < 200; i++)
      state = recordDeparture(state, {
        sourceId: `s${i}`,
        playerId: `p${(i % 5) + 1}`,
        at: day(100 + i),
        reason: 'x'
      });
    expect(state.seen.length).toBeLessThanOrEqual(ATTACHMENT_LIMITS.seen);
    expect(state.preferences.length).toBeLessThanOrEqual(
      ATTACHMENT_LIMITS.active + ATTACHMENT_LIMITS.history
    );
  });
});

describe('attachment policy', () => {
  const held = recordAcquisition(
    emptyAttachments(),
    drafted({ playerId: 'wr1', name: 'Wide One', position: 'WR' })
  );
  const rbNeed = reconcileAgenda(emptyAgenda(), {
    at: T0,
    taskId: 'need',
    week: 1,
    complete: false,
    holes: ['RB']
  });
  const input = {
    attachments: held,
    at: T0,
    sends: [{ id: 'wr1', position: 'WR' }],
    receives: [{ id: 'rb9', position: 'RB' }],
    tradeFrequency: 0.4
  };

  it('adds a small premium for sending an attached player, inspectable apart from the base', () => {
    const adjustment = attachmentAdjustment(input);
    expect(adjustment).toMatchObject({ waived: 0, override: null });
    expect(adjustment.premium).toBeGreaterThan(0);
    expect(adjustment.adjustment).toBe(adjustment.premium);
    expect(adjustment.players).toEqual([
      expect.objectContaining({ playerId: 'wr1', conviction: 0.7, waived: false })
    ]);
    expect(attachmentSummary(adjustment)).toContain('Held Wide One to a higher bar');
    // Nothing attached, nothing sent, or no state: no adjustment.
    expect(attachmentAdjustment({ ...input, sends: [{ id: 'other', position: 'WR' }] }).adjustment).toBe(0);
    expect(attachmentAdjustment({ ...input, attachments: undefined }).adjustment).toBe(0);
    expect(attachmentSummary(attachmentAdjustment({ ...input, attachments: undefined }))).toBe('');
  });

  it('caps the premium per player and in all, and differs by personality', () => {
    let many = emptyAttachments();
    for (const id of ['a', 'b', 'c', 'd'])
      many = recordAcquisition(many, drafted({ sourceId: id, playerId: id, name: id, position: 'WR' }));
    const sends = ['a', 'b', 'c', 'd'].map((id) => ({ id, position: 'WR' }));
    for (const tradeFrequency of [0, 0.2, 0.5, 0.9, 1]) {
      const a = attachmentAdjustment({ ...input, attachments: many, sends, tradeFrequency });
      expect(a.adjustment).toBeLessThanOrEqual(ATTACHMENT_POLICY.maxPremium);
      for (const p of a.players) expect(p.premium).toBeLessThanOrEqual(ATTACHMENT_POLICY.maxPlayerPremium);
    }
    expect(attachmentScale(0.2)).toBeGreaterThan(attachmentScale(0.9));
    expect(attachmentScale(-5)).toBe(1.25);
    const cautious = attachmentAdjustment({ ...input, tradeFrequency: 0.2 }).adjustment;
    const dealer = attachmentAdjustment({ ...input, tradeFrequency: 0.9 }).adjustment;
    expect(cautious).toBeGreaterThan(dealer);
  });

  it('lets a pressing agenda need outweigh the attachment, never below the base bar', () => {
    const need = attachmentAdjustment({ ...input, agenda: rbNeed });
    expect(need.adjustment).toBe(0);
    expect(need.waived).toBe(need.premium);
    expect(need.override).toEqual({ goalId: 'repair_position:W1:RB', slot: 'RB' });
    expect(need.players[0]?.waived).toBe(true);
    // Generic in the activity log (no slot or goal id), and absent from the agent's own record.
    expect(attachmentSummary(need)).toBe('Set aside my attachment to Wide One for a roster need.');
    expect(attachmentSummary(need, 'memory')).toBe('');
    // The adjustment is never negative: the base bar (and its floor) still apply in full.
    expect(need.adjustment).toBeGreaterThanOrEqual(0);
    // Receiving a player who does not fill the need does not trigger the override.
    expect(
      attachmentAdjustment({ ...input, agenda: rbNeed, receives: [{ id: 'te', position: 'TE' }] }).override
    ).toBeNull();
    // An attached player who could fill the need himself is not moved for it.
    const rbHeld = recordAcquisition(emptyAttachments(), drafted());
    const own = attachmentAdjustment({
      ...input,
      attachments: rbHeld,
      sends: [{ id: 'rb1', position: 'RB' }],
      agenda: rbNeed
    });
    expect(own).toMatchObject({ waived: 0, override: null });
    expect(own.adjustment).toBeGreaterThan(0);
    // A completed or stale goal is not pressing.
    const done = reconcileAgenda(rbNeed, { at: day(1), taskId: 'x', week: 1, complete: false, holes: [] });
    expect(attachmentAdjustment({ ...input, agenda: done }).override).toBeNull();
  });

  it('has no effect for a new agent or a new occupant: no fabricated affection', () => {
    expect(activeAttachments(emptyAttachments(), T0)).toEqual([]);
    expect(attachmentPrompt(emptyAttachments(), T0, 'public')).toEqual([]);
    expect(attachmentAdjustment({ ...input, attachments: emptyAttachments() })).toMatchObject({
      premium: 0,
      adjustment: 0,
      players: []
    });
  });

  it('describes held attachments by their evidence, never the numbers, within visibility', () => {
    const lines = attachmentPrompt(held, T0, 'public');
    expect(lines).toEqual([expect.stringContaining('Wide One (WR): you drafted him in round 1')]);
    expect(lines.join(' ')).not.toMatch(/\d\.\d|premium|bar/);
    expect(attachmentPrompt(held, T0, 'public', ['someone-else'])).toEqual([]);
    const sealed: PlayerAttachments = {
      ...held,
      preferences: held.preferences.map((p) => ({
        ...p,
        visibility: { teams: [], trades: [{ tradeId: 't', until: 'public' as const }], waiverClaims: [] }
      }))
    };
    expect(attachmentPrompt(sealed, T0, 'public')).toEqual([]);
    expect(attachmentPrompt(sealed, T0, 'owner')).toHaveLength(1);
    const { round: _round, ...pickup } = drafted();
    const traded = recordAcquisition(emptyAttachments(), { ...pickup, kind: 'traded_for' });
    expect(attachmentPrompt(traded, T0, 'public')[0]).toContain('you traded for him');
  });
});
