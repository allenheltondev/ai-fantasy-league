import { describe, expect, it } from 'vitest';
import {
  AGENDA_LIMITS,
  agendaPriority,
  agendaPrompt,
  emptyAgenda,
  reconcileAgenda,
  type AgendaObservation
} from './agenda.js';

const observation = (overrides: Partial<AgendaObservation> = {}): AgendaObservation => ({
  at: '2026-10-01T12:00:00.000Z',
  taskId: 'one',
  week: 5,
  complete: false,
  holes: ['RB'],
  ...overrides
});

describe('persistent roster repair agenda', () => {
  it('keeps a stable objective and its provenance across repeated looks, with no duplicate goals', () => {
    const first = reconcileAgenda(emptyAgenda(), observation({ holes: ['RB', 'RB'] }));
    const second = reconcileAgenda(
      first,
      observation({ at: '2026-10-02T12:00:00.000Z', taskId: 'two', holes: ['RB', 'RB'] })
    );
    expect(second.goals).toEqual(first.goals);
    expect(second.goals[0]).toMatchObject({
      id: 'repair_position:W5:RB',
      missing: 2,
      audience: 'owner_decisions',
      sourceTaskId: 'one'
    });
    const partial = reconcileAgenda(second, observation({ at: '2026-10-03T12:00:00.000Z' }));
    expect(partial.goals[0]).toMatchObject({ missing: 1, createdAt: first.goals[0]?.createdAt });
  });

  it('completes only after the shortage disappears and can reopen the same need', () => {
    const first = reconcileAgenda(emptyAgenda(), observation());
    const done = reconcileAgenda(first, observation({ holes: [], at: '2026-10-02T12:00:00.000Z' }));
    expect(done.goals[0]?.status).toBe('completed');
    expect(agendaPrompt(done)).toEqual([]);
    const reopened = reconcileAgenda(done, observation({ at: '2026-10-03T12:00:00.000Z' }));
    expect(reopened.goals).toHaveLength(1);
    expect(reopened.goals[0]).toMatchObject({
      id: first.goals[0]?.id,
      status: 'active',
      createdAt: first.goals[0]?.createdAt
    });
  });

  it('rejects older observations and week regressions', () => {
    const first = reconcileAgenda(emptyAgenda(), observation());
    expect(reconcileAgenda(first, observation({ at: '2026-09-30T12:00:00.000Z', holes: [] }))).toEqual(first);
    expect(reconcileAgenda(first, observation({ at: '2026-10-02T12:00:00.000Z', week: 4 }))).toEqual(first);
  });

  it('expires old-week needs and terminally cancels them at season completion', () => {
    const first = reconcileAgenda(emptyAgenda(), observation());
    const rolled = reconcileAgenda(first, observation({ at: '2026-10-08T12:00:00.000Z', week: 6 }));
    expect(rolled.goals.map((g) => g.status)).toEqual(['active', 'expired']);
    const closed = reconcileAgenda(
      rolled,
      observation({ at: '2026-12-31T12:00:00.000Z', week: 18, complete: true })
    );
    expect(closed.closed).toBe(true);
    expect(closed.goals.some((g) => g.status === 'active')).toBe(false);
    expect(reconcileAgenda(closed, observation({ at: '2027-01-01T12:00:00.000Z', week: 18 }))).toEqual(
      closed
    );
  });

  it('keeps only three priorities, retains unfinished priorities, and bounds history', () => {
    const first = reconcileAgenda(emptyAgenda(), observation({ holes: ['QB', 'RB', 'WR', 'TE'] }));
    expect(first.goals.map((g) => g.slot)).toEqual(['QB', 'RB', 'WR']);
    const reordered = reconcileAgenda(first, observation({ holes: ['TE', 'WR', 'RB', 'QB'] }));
    expect(reordered.goals.map((g) => g.slot)).toEqual(['QB', 'RB', 'WR']);
    let agenda = first;
    for (let week = 6; week <= 18; week++)
      agenda = reconcileAgenda(
        agenda,
        observation({ week, holes: ['QB', 'RB', 'WR'], at: new Date(Date.UTC(2026, 9, week)).toISOString() })
      );
    expect(agenda.goals.filter((g) => g.status === 'active')).toHaveLength(AGENDA_LIMITS.active);
    expect(agenda.goals.filter((g) => g.status !== 'active')).toHaveLength(AGENDA_LIMITS.history);
    expect(reconcileAgenda(emptyAgenda(), observation({ week: null })).goals).toEqual([]);
  });

  it('expresses priorities as bounded preferences, including flex eligibility', () => {
    const agenda = reconcileAgenda(emptyAgenda(), observation({ holes: ['RB', 'W/R/T'] }));
    expect(agendaPriority(agenda, 'RB')).toBe(3);
    expect(agendaPriority(agenda, 'WR')).toBe(2);
    expect(agendaPriority(agenda, 'QB')).toBe(0);
    expect(agendaPriority(undefined, 'RB')).toBe(0);
    expect(agendaPrompt(agenda).join(' ')).toContain('A pending claim or offer does not complete it');
  });
});
