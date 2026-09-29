import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AgentLeagueMemorySchema,
  MEMORY_LIMITS,
  OWNER_ONLY,
  decisionVisibility,
  emptyMemory,
  estimateTokens,
  mayHear,
  memoryForAudience,
  memorySeals,
  rememberEvent,
  rivalVisibility,
  summarizeMemory,
  tradeVisibility,
  type MemorySeal,
  type MemoryEvent
} from './memory.js';

const AT = '2026-10-12T12:00:00.000Z';

describe('agent league memory', () => {
  it('parses stored memory written before the structured fields existed', () => {
    expect(AgentLeagueMemorySchema.parse({ notes: ['old note'] })).toEqual({
      ...emptyMemory(),
      // A bare-string note from before #206 has no visibility: it is kept to the agent alone.
      notes: [{ text: 'old note' }]
    });
  });

  it('builds grudges from matchup results, trades, and keeps the biggest first', () => {
    let m = emptyMemory();
    m = rememberEvent(m, {
      type: 'matchup',
      opponentTeamId: 'team-3',
      week: 1,
      pointsFor: 80,
      pointsAgainst: 120,
      at: AT
    });
    m = rememberEvent(m, {
      type: 'matchup',
      opponentTeamId: 'team-4',
      week: 2,
      pointsFor: 100,
      pointsAgainst: 90,
      at: AT
    });
    m = rememberEvent(m, {
      type: 'matchup',
      opponentTeamId: 'team-5',
      week: 3,
      pointsFor: 90,
      pointsAgainst: 95,
      at: AT
    });
    m = rememberEvent(m, {
      type: 'matchup',
      opponentTeamId: 'team-6',
      week: 4,
      pointsFor: 90,
      pointsAgainst: 90,
      at: AT
    });
    expect(m.rivals.map((r) => [r.teamId, r.grudge])).toEqual([
      ['team-3', 3],
      ['team-5', 2],
      ['team-4', 1],
      ['team-6', 1]
    ]);
    expect(m.rivals[0]?.reason).toBe('Week 1: lost to them 80-120.');
    expect(m.rivals.find((r) => r.teamId === 'team-6')?.reason).toContain('tied');

    m = rememberEvent(m, {
      type: 'trade',
      teamId: 'team-4',
      tradeId: 't1',
      outcome: 'proposed',
      summary: 'Asked for their WR1.',
      at: AT
    });
    expect(m.rivals.find((r) => r.teamId === 'team-4')?.grudge).toBe(1);
    m = rememberEvent(m, {
      type: 'trade',
      teamId: 'team-4',
      tradeId: 't1',
      outcome: 'vetoed',
      summary: 'League vetoed it.',
      at: AT
    });
    expect(m.trades).toEqual([expect.objectContaining({ tradeId: 't1', outcome: 'vetoed' })]);
    expect(m.rivals.find((r) => r.teamId === 'team-4')?.grudge).toBe(3);
  });

  it('keeps notes, decisions, and the chat snapshot bounded and clipped', () => {
    let m = emptyMemory();
    for (let i = 0; i < 30; i++) {
      m = rememberEvent(m, { type: 'note', text: `note ${i}` });
      m = rememberEvent(m, {
        type: 'decision',
        kind: 'lineup',
        action: 'set_lineup',
        summary: `d${i}`,
        at: AT
      });
    }
    m = rememberEvent(m, { type: 'note', text: '   ' });
    expect(m.notes).toHaveLength(MEMORY_LIMITS.notes);
    expect(m.notes.at(-1)).toEqual({ text: 'note 29', visibility: OWNER_ONLY });
    expect(m.decisions).toHaveLength(MEMORY_LIMITS.decisions);
    const long = 'x'.repeat(1000);
    m = rememberEvent(m, {
      type: 'chat',
      roomId: 'trash-talk',
      at: AT,
      messages: Array.from({ length: 12 }, (_, i) => ({
        author: `A${i}`,
        text: i === 11 ? long : 'hi',
        at: AT
      }))
    });
    const room = m.chatRooms[0];
    expect(room?.messages).toHaveLength(MEMORY_LIMITS.chat);
    expect(room?.messages.at(-1)?.text.length).toBe(MEMORY_LIMITS.text);
    expect(AgentLeagueMemorySchema.safeParse(m).success).toBe(true);
  });

  it('summarizes the most useful memories first, within the token budget', () => {
    let m = emptyMemory();
    m = rememberEvent(m, {
      type: 'matchup',
      opponentTeamId: 'team-3',
      week: 1,
      pointsFor: 80,
      pointsAgainst: 120,
      at: AT
    });
    m = rememberEvent(m, {
      type: 'trade',
      teamId: 'team-4',
      tradeId: 't1',
      outcome: 'processed',
      summary: 'Got their RB.',
      at: AT
    });
    m = rememberEvent(m, { type: 'note', text: 'I like rb3.' });
    m = rememberEvent(m, {
      type: 'decision',
      kind: 'waivers',
      action: 'claim_waiver',
      summary: 'Bid $12 on wr9.',
      at: AT
    });
    m = rememberEvent(m, {
      type: 'relationship',
      teamId: 'team-3',
      note: 'Rivalry after the week 1 blowout.',
      at: AT
    });
    m = rememberEvent(m, {
      type: 'chat',
      roomId: 'trash-talk',
      at: AT,
      messages: [{ author: 'Allen', text: 'Your kicker stinks.', at: AT }]
    });
    const names = (id: string) => ({ 'team-3': 'Bench Mob', 'team-4': 'Taco Corp' })[id] ?? id;
    const all = summarizeMemory(m, { teamName: names });
    expect(all).toEqual([
      'Rivalry with Bench Mob (grudge 3): Week 1: lost to them 80-120.',
      'Rivalry with Taco Corp (grudge 1): Trade processed: Got their RB.',
      'Trade with Taco Corp (processed): Got their RB.',
      'Your note: I like rb3.',
      'You did waivers -> claim_waiver: Bid $12 on wr9.',
      'Between you and Bench Mob: Rivalry after the week 1 blowout.',
      'Last chat you were in here: Allen: Your kicker stinks.'
    ]);
    const tight = summarizeMemory(m, { tokenBudget: 30 });
    expect(tight.length).toBeLessThan(all.length);
    expect(tight[0]).toContain('team-3');
    expect(summarizeMemory(emptyMemory())).toEqual([]);
  });

  it('never exceeds its budget or its limits (property)', () => {
    const event: fc.Arbitrary<MemoryEvent> = fc.oneof(
      fc.record({ type: fc.constant('note' as const), text: fc.string({ maxLength: 400 }) }),
      fc.record({
        type: fc.constant('decision' as const),
        kind: fc.constantFrom('lineup', 'waivers'),
        action: fc.string({ maxLength: 20 }),
        summary: fc.string({ maxLength: 400 }),
        at: fc.constant(AT)
      }),
      fc.record({
        type: fc.constant('matchup' as const),
        opponentTeamId: fc.constantFrom('t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'),
        week: fc.integer({ min: 1, max: 17 }),
        pointsFor: fc.integer({ min: 0, max: 200 }),
        pointsAgainst: fc.integer({ min: 0, max: 200 }),
        at: fc.constant(AT)
      }),
      fc.record({
        type: fc.constant('trade' as const),
        teamId: fc.constantFrom('t1', 't2', 't3'),
        tradeId: fc.string({ minLength: 1, maxLength: 4 }),
        outcome: fc.constantFrom('proposed', 'rejected', 'processed', 'vetoed' as const),
        summary: fc.string({ maxLength: 400 }),
        at: fc.constant(AT)
      }),
      fc.record({
        type: fc.constant('relationship' as const),
        teamId: fc.constantFrom('t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'),
        note: fc.string({ maxLength: 400 }),
        at: fc.constant(AT)
      }),
      fc.record({
        type: fc.constant('chat' as const),
        roomId: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'),
        at: fc.constant(AT),
        messages: fc.array(
          fc.record({
            author: fc.string({ maxLength: 80 }),
            text: fc.string({ maxLength: 400 }),
            at: fc.constant(AT)
          }),
          { maxLength: 12 }
        )
      })
    );
    fc.assert(
      fc.property(fc.array(event, { maxLength: 60 }), fc.integer({ min: 0, max: 600 }), (events, budget) => {
        const m = events.reduce(rememberEvent, emptyMemory());
        expect(AgentLeagueMemorySchema.safeParse(m).success).toBe(true);
        expect(m.rivals.length).toBeLessThanOrEqual(MEMORY_LIMITS.rivals);
        expect(m.trades.length).toBeLessThanOrEqual(MEMORY_LIMITS.trades);
        expect(m.relationships.length).toBeLessThanOrEqual(MEMORY_LIMITS.relationships);
        expect(m.chatRooms.length).toBeLessThanOrEqual(MEMORY_LIMITS.chatRooms);
        expect(new Set(m.relationships.map((r) => r.teamId)).size).toBe(m.relationships.length);
        const lines = summarizeMemory(m, { tokenBudget: budget });
        expect(lines.reduce((sum, l) => sum + estimateTokens(l) + 1, 0)).toBeLessThanOrEqual(budget);
      })
    );
  });

  it('keeps one chat snapshot per room and one relationship note per team, bounded and clipped', () => {
    let m = emptyMemory();
    for (let i = 0; i < MEMORY_LIMITS.chatRooms + 3; i++) {
      m = rememberEvent(m, {
        type: 'chat',
        roomId: `room-${i}`,
        at: AT,
        messages: [{ author: 'A', text: `in room ${i}`, at: AT }]
      });
    }
    // The same room again replaces its snapshot and becomes the newest.
    m = rememberEvent(m, {
      type: 'chat',
      roomId: 'room-5',
      at: AT,
      messages: [{ author: 'B', text: 'again', at: AT }]
    });
    expect(m.chatRooms).toHaveLength(MEMORY_LIMITS.chatRooms);
    expect(m.chatRooms.at(-1)).toMatchObject({ roomId: 'room-5', messages: [{ text: 'again' }] });
    expect(m.chatRooms.filter((r) => r.roomId === 'room-5')).toHaveLength(1);
    expect(m.chatRooms.some((r) => r.roomId === 'room-0')).toBe(false);

    for (let i = 0; i < MEMORY_LIMITS.relationships + 4; i++) {
      m = rememberEvent(m, { type: 'relationship', teamId: `t${i}`, note: `note ${i}`, at: AT });
    }
    m = rememberEvent(m, { type: 'relationship', teamId: 't9', note: 'x'.repeat(500), at: AT });
    m = rememberEvent(m, { type: 'relationship', teamId: 't10', note: '   ', at: AT });
    expect(m.relationships).toHaveLength(MEMORY_LIMITS.relationships);
    expect(m.relationships.at(-1)).toMatchObject({ teamId: 't9' });
    expect(m.relationships.at(-1)?.note.length).toBe(MEMORY_LIMITS.relationshipText);
    expect(m.relationships.find((r) => r.teamId === 't10')?.note).toBe('note 10');
    expect(AgentLeagueMemorySchema.safeParse(m).success).toBe(true);
  });

  it('drops a pre-rooms chat snapshot when reading stored memory', () => {
    const stored = { notes: ['n'], chat: [{ author: 'Allen', text: 'old', at: AT }] };
    expect(AgentLeagueMemorySchema.parse(stored)).toEqual({ ...emptyMemory(), notes: [{ text: 'n' }] });
  });

  it('applies a league event once per event id, so a redelivery never bumps a grudge twice', () => {
    const loss: MemoryEvent = {
      type: 'matchup',
      opponentTeamId: 'team-3',
      week: 1,
      pointsFor: 80,
      pointsAgainst: 90,
      at: AT,
      eventId: 'evt-1'
    };
    const veto: MemoryEvent = {
      type: 'trade',
      teamId: 'team-3',
      tradeId: 't1',
      outcome: 'vetoed',
      summary: 'Vetoed.',
      at: AT,
      eventId: 'evt-2'
    };
    let m = [loss, loss, veto, veto].reduce(rememberEvent, emptyMemory());
    expect(m.rivals).toEqual([expect.objectContaining({ teamId: 'team-3', grudge: 4 })]);
    expect(m.seen).toEqual(['evt-1', 'evt-2']);
    // Events without an id (the agent's own task records) always apply; the seen list stays bounded.
    for (let i = 0; i < MEMORY_LIMITS.seen + 5; i++) m = rememberEvent(m, { ...loss, eventId: `e${i}` });
    expect(m.seen).toHaveLength(MEMORY_LIMITS.seen);
    expect(rememberEvent(m, { ...loss, eventId: undefined }).rivals[0]?.grudge).toBe(
      (m.rivals[0]?.grudge ?? 0) + 2
    );
  });

  it('remembers the players and the value of a trade, and who won it', () => {
    let m = rememberEvent(emptyMemory(), {
      type: 'trade',
      teamId: 'team-4',
      tradeId: 't1',
      outcome: 'accepted',
      summary: 'Accepted their offer.',
      at: AT,
      sent: ['Bench Guy'],
      received: ['Star Back'],
      value: 12.34
    });
    // The processed step (from the league event) keeps what the acceptance knew.
    m = rememberEvent(m, {
      type: 'trade',
      teamId: 'team-4',
      tradeId: 't1',
      outcome: 'processed',
      summary: 'The trade went through.',
      at: AT,
      eventId: 'evt-9'
    });
    expect(m.trades).toEqual([
      expect.objectContaining({
        outcome: 'processed',
        sent: ['Bench Guy'],
        received: ['Star Back'],
        value: 12.3
      })
    ]);
    expect(summarizeMemory(m).find((l) => l.startsWith('Trade with'))).toBe(
      'Trade with team-4 (processed): The trade went through. [you sent Bench Guy for Star Back; value for you +12.3 (you won it)]'
    );
    const lost = rememberEvent(emptyMemory(), {
      type: 'trade',
      teamId: 'team-4',
      tradeId: 't2',
      outcome: 'processed',
      summary: 'Done.',
      at: AT,
      received: [],
      value: -4
    });
    expect(summarizeMemory(lost)).toContain(
      'Trade with team-4 (processed): Done. [you sent nothing for nothing; value for you -4 (they won it)]'
    );
    const even = rememberEvent(emptyMemory(), {
      type: 'trade',
      teamId: 'team-4',
      tradeId: 't3',
      outcome: 'accepted',
      summary: 'Even.',
      at: AT,
      value: 0
    });
    expect(summarizeMemory(even)).toContain('Trade with team-4 (accepted): Even. [value for you 0 (even)]');
  });
});

describe('memory visibility (#206)', () => {
  const holds = () => true;
  const lifted = () => false;
  const withTeam1: MemorySeal = {
    teams: ['team-1'],
    trades: [{ tradeId: 't', until: 'public' }],
    waiverClaims: []
  };
  const mine: MemorySeal = { teams: [], trades: [], waiverClaims: ['c'] };

  it('lets each audience hear only what its readers may know', () => {
    for (const audience of ['public', 'owner', { teams: ['team-1'] }] as const)
      expect(mayHear('public', audience, holds)).toBe(true);
    // Anything released is public.
    expect(mayHear(withTeam1, 'public', lifted)).toBe(true);
    expect(mayHear(withTeam1, 'public', holds)).toBe(false);
    // The agent's own secrets reach only its sealed moves; shared ones only the teams that know.
    expect(mayHear(mine, 'owner', holds)).toBe(true);
    expect(mayHear(withTeam1, 'owner', holds)).toBe(false);
    expect(mayHear(withTeam1, { teams: ['team-1'] }, holds)).toBe(true);
    expect(mayHear(withTeam1, { teams: ['team-1', 'team-3'] }, holds)).toBe(false);
    expect(mayHear(mine, { teams: ['team-1'] }, holds)).toBe(false);
    expect(mayHear(withTeam1, { teams: [] }, holds)).toBe(false);
  });

  it('records visibility on new memories and classifies what was stored before it', () => {
    let m = emptyMemory();
    m = rememberEvent(m, { type: 'note', text: 'n' });
    m = rememberEvent(m, { type: 'decision', kind: 'lineup', action: 'a', summary: 's', at: AT });
    // Without a visibility, a new note or decision is the agent's alone.
    expect(m.notes[0]?.visibility).toEqual(OWNER_ONLY);
    expect(m.decisions[0]?.visibility).toEqual(OWNER_ONLY);
    // Stored before #206: sealable kinds stay private, the rest were never secret.
    expect(decisionVisibility({ kind: 'waivers', action: 'a', summary: 's', at: AT })).toEqual(OWNER_ONLY);
    expect(decisionVisibility({ kind: 'lineup', action: 'a', summary: 's', at: AT })).toBe('public');
    // A private offer stays with the other team until the trade is public; a rejection, for good.
    expect(tradeVisibility({ teamId: 'team-1', tradeId: 't', outcome: 'processed' })).toBe('public');
    expect(tradeVisibility({ teamId: 'team-1', tradeId: 't', outcome: 'rejected' })).toEqual(withTeam1);
    const rival = { teamId: 'team-3', grudge: 1, at: AT };
    expect(rivalVisibility({ ...rival, reason: 'Trade expired: An offer from team-3 was expired.' })).toEqual(
      {
        teams: ['team-3'],
        trades: [],
        waiverClaims: []
      }
    );
    expect(rivalVisibility({ ...rival, reason: 'Week 3: lost to them 80-140.' })).toBe('public');
  });

  it('seals the grudge a private offer leaves, and a later public reason replaces it', () => {
    let m = rememberEvent(emptyMemory(), {
      type: 'trade',
      teamId: 'team-3',
      tradeId: 't3',
      outcome: 'rejected',
      summary: 'Your offer to team-3 was rejected.',
      at: AT
    });
    expect(m.rivals[0]?.visibility).toEqual({
      teams: ['team-3'],
      trades: [{ tradeId: 't3', until: 'public' }],
      waiverClaims: []
    });
    expect(memoryForAudience(m, 'public', holds).memory.rivals).toEqual([]);
    m = rememberEvent(m, {
      type: 'matchup',
      opponentTeamId: 'team-3',
      week: 4,
      pointsFor: 90,
      pointsAgainst: 100,
      at: AT
    });
    expect(memoryForAudience(m, 'public', holds).memory.rivals).toEqual([
      expect.objectContaining({ teamId: 'team-3', grudge: 3, visibility: 'public' })
    ]);
  });

  it('filters every kind of memory and reports the seals it kept', () => {
    let m = emptyMemory();
    m = rememberEvent(m, { type: 'note', text: 'bid plan', visibility: mine });
    m = rememberEvent(m, { type: 'note', text: 'public note', visibility: 'public' });
    m = rememberEvent(m, {
      type: 'decision',
      kind: 'waivers',
      action: 'claim',
      summary: 'bid',
      at: AT,
      visibility: mine
    });
    m = rememberEvent(m, {
      type: 'trade',
      teamId: 'team-1',
      tradeId: 't',
      outcome: 'proposed',
      summary: 'x',
      at: AT
    });
    const open = memoryForAudience(m, 'public', holds);
    expect(open.memory.notes.map((n) => n.text)).toEqual(['public note']);
    expect(open.memory.decisions).toEqual([]);
    expect(open.memory.trades).toEqual([]);
    expect(open.seals).toEqual([]);
    const owner = memoryForAudience(m, 'owner', holds);
    expect(owner.memory.notes).toHaveLength(2);
    expect(owner.memory.decisions).toHaveLength(1);
    expect(owner.seals).toEqual([mine, mine]);
    // Once lifted, a memory is kept without a seal to carry.
    expect(memoryForAudience(m, 'public', lifted).seals).toEqual([]);
    expect(memorySeals(m)).toEqual([
      mine,
      mine,
      { ...withTeam1, trades: [{ tradeId: 't', until: 'public' }] }
    ]);
    expect(summarizeMemory(owner.memory)).toContain('Your note: bid plan');
  });
});
