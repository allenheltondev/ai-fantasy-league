import { describe, expect, it } from 'vitest';
import {
  observePerformance,
  recordAcquisition,
  emptyAttachments,
  type PlayerAttachments
} from './attachments.js';
import { emptyCommitments, openTradeInterest, type CommitmentBook } from './commitments.js';
import {
  MEMORY_LIMITS,
  emptyMemory,
  memoryForAudience,
  memorySeals,
  rememberEvent,
  type AgentLeagueMemory,
  type MemoryEvent
} from './memory.js';
import {
  SOCIAL_ACT_LIMITS,
  SocialActBookSchema,
  ambientOpportunities,
  ambientTurn,
  answerAsk,
  askOpportunities,
  checkSocialAct,
  emptySocialActs,
  openAsk,
  openAsks,
  pendingQuestions,
  playerRemarks,
  playersNamed,
  questionOpportunities,
  recordSocialAct,
  selectSocialAct,
  settleAsks,
  socialActPack,
  socialActWords,
  socialScore,
  type AmbientInput,
  type AskInput,
  type QuestionMessage,
  type SocialActBook,
  type SocialActEntry,
  type SocialCandidate,
  type SocialEvidence,
  type SocialSelectionInput
} from './social-acts.js';

const T0 = '2026-10-04T15:00:00.000Z';
const at = (hours: number) => new Date(Date.parse(T0) + hours * 3_600_000).toISOString();
const SELF = 'team-2';
const LOUD = { chattiness: 0.95, persuadability: 0.5 };
const QUIET = { chattiness: 0.08, persuadability: 0.5 };

/** A seed whose board roll comes out as asked for this chattiness. */
function seed(chattiness: number, pass: boolean): string {
  for (let i = 0; i < 10_000; i++) if (ambientTurn(chattiness, `s-${i}`) === pass) return `s-${i}`;
  throw new Error('no such seed');
}

const msg = (over: Partial<QuestionMessage> & { id: string; at: number }): QuestionMessage => ({
  kind: 'user',
  author: { teamId: 'team-1', name: 'Allen' },
  text: 'Would you move your RB?',
  mentionedTeamIds: [SELF],
  replyToId: null,
  createdAt: at(over.at),
  ...over
});

const remember = (events: MemoryEvent[], memory: AgentLeagueMemory = emptyMemory()) =>
  events.reduce(rememberEvent, memory);

/** A memory with a week 2 win over team-3, a processed trade with it, and week 4 final. */
function memory(): AgentLeagueMemory {
  return remember([
    {
      type: 'matchup',
      opponentTeamId: 'team-3',
      week: 1,
      pointsFor: 90,
      pointsAgainst: 99,
      at: at(-24 * 21)
    },
    {
      type: 'trade',
      teamId: 'team-3',
      tradeId: 't-old',
      outcome: 'accepted',
      direction: 'incoming',
      summary: 'An offer from team-3 was accepted.',
      at: at(-24 * 20)
    },
    {
      type: 'matchup',
      opponentTeamId: 'team-3',
      week: 2,
      pointsFor: 110,
      pointsAgainst: 95,
      at: at(-24 * 14)
    },
    {
      type: 'trade',
      teamId: 'team-3',
      tradeId: 't-fair',
      outcome: 'processed',
      direction: 'outgoing',
      summary: 'Your offer to team-3 was processed.',
      at: at(-24 * 10),
      sent: ['WR5'],
      received: ['RB9'],
      value: 1
    },
    { type: 'matchup', opponentTeamId: 'team-1', week: 4, pointsFor: 150, pointsAgainst: 100, at: at(-12) }
  ]);
}

const LEAGUE = {
  throughWeek: 4,
  standings: [
    { teamId: 'team-1', teamName: 'Big Tuna', streak: 'L1' },
    { teamId: SELF, teamName: 'Hype Squad', streak: 'W2' },
    { teamId: 'team-3', teamName: 'Zen Garden', streak: 'W3' },
    { teamId: 'team-4', teamName: 'Fourth', streak: 'L2' }
  ],
  lastWeek: [
    { homeTeamId: SELF, homeScore: 150, awayTeamId: 'team-1', awayScore: 100 },
    { homeTeamId: 'team-3', homeScore: 162, awayTeamId: 'team-4', awayScore: 90 }
  ]
};

const ambient = (over: Partial<AmbientInput> = {}): AmbientInput => ({
  self: SELF,
  now: T0,
  week: 5,
  memory: memory(),
  league: LEAGUE,
  opponentTeamId: 'team-3',
  roomId: 'trash-talk',
  audience: 'public',
  ...over
});

function candidate(over: Partial<SocialCandidate> = {}): SocialCandidate {
  return {
    act: 'callback',
    reason: 'rematch',
    counterpartTeamId: 'team-3',
    subject: 'your week 2 game against Zen Garden',
    topic: 'callback:team-3:result:w2',
    eventKey: 'callback:w5:team-2|team-3',
    roomId: 'trash-talk',
    audience: 'public',
    evidence: ['result:w2'],
    at: at(-24 * 14),
    expiresAt: at(12),
    human: false,
    relevance: 0.85,
    salience: 0.5,
    agendaId: null,
    commitmentId: null,
    replyToId: null,
    ...over
  };
}

const fact = (id: string, over: Partial<SocialEvidence> = {}): SocialEvidence => ({
  id,
  line: `Week 2: you beat Zen Garden 110-95.`,
  at: at(-24 * 14),
  visibility: 'public',
  ...over
});

const select = (over: Partial<SocialSelectionInput> = {}) =>
  selectSocialAct({
    now: T0,
    taskId: 'task-1',
    seed: seed(LOUD.chattiness, true),
    personality: LOUD,
    candidates: [candidate()],
    evidence: [fact('result:w2')],
    history: emptySocialActs(),
    postsLeft: 10,
    lastWord: [],
    ...over
  });

const entry = (over: Partial<SocialActEntry> = {}): SocialActEntry => ({
  id: 'e-1',
  taskId: 'task-0',
  act: 'callback',
  reason: 'rematch',
  topic: 'callback:team-3:result:w2',
  eventKey: 'callback:w5:team-2|team-3',
  roomId: 'trash-talk',
  counterpartTeamId: 'team-3',
  evidence: ['result:w2'],
  commitmentId: null,
  at: at(-1),
  outcome: 'posted',
  detail: null,
  ...over
});

const history = (...entries: SocialActEntry[]): SocialActBook =>
  entries.reduce(recordSocialAct, emptySocialActs());

describe('pendingQuestions', () => {
  it("finds a person's unanswered questions to this agent, after the grace and within the window", () => {
    const newest: QuestionMessage[] = [
      msg({ id: 'fresh', at: -0.05 }),
      msg({ id: 'agent', at: -0.5, kind: 'agent' }),
      msg({ id: 'mine', at: -0.6, author: { teamId: SELF, name: 'Me' } }),
      msg({ id: 'statement', at: -0.7, text: 'Nice win.' }),
      msg({ id: 'other', at: -0.8, mentionedTeamIds: ['team-4'] }),
      msg({ id: 'q', at: -1 }),
      msg({ id: 'old', at: -30 })
    ];
    expect(pendingQuestions(newest, { roomId: 'trash-talk', dm: false }, SELF, T0)).toEqual([
      { messageId: 'q', roomId: 'trash-talk', fromTeamId: 'team-1', author: 'Allen', dm: false, at: at(-1) }
    ]);
  });

  it('treats only a reply to it, or one naming it, as the answer (#215)', () => {
    const reply = msg({
      id: 'r',
      at: -0.5,
      kind: 'agent',
      author: { teamId: SELF, name: 'Me' },
      replyToId: 'q'
    });
    const room = [reply, msg({ id: 'q', at: -1 })];
    expect(pendingQuestions(room, { roomId: 'trash-talk', dm: false }, SELF, T0)).toEqual([]);
    // An unrelated line of its own in a DM (an outreach, a closing line elsewhere) answers nothing.
    const later = msg({ id: 'later', at: -0.5, kind: 'agent', author: { teamId: SELF, name: 'Me' } });
    const dm = [later, msg({ id: 'q', at: -1, mentionedTeamIds: [] })];
    expect(pendingQuestions(dm, { roomId: 'dm-team-1-team-2', dm: true }, SELF, T0)).toHaveLength(1);
    expect(
      pendingQuestions([later, msg({ id: 'q', at: -1 })], { roomId: 'trash-talk', dm: false }, SELF, T0)
    ).toHaveLength(1);
  });

  it('counts a request without a question mark, and not a plain statement', () => {
    const asks = msg({ id: 'ask', at: -1, text: 'lmk what you want for your WR2' });
    const says = msg({ id: 'says', at: -1, text: 'My RB went down.' });
    expect(pendingQuestions([asks, says], { roomId: 'trash-talk', dm: false }, SELF, T0)).toMatchObject([
      { messageId: 'ask' }
    ]);
  });

  it('counts a conversation continued without a mention, and one reply for a whole burst', () => {
    const continued = msg({ id: 'c', at: -1, mentionedTeamIds: [], addressedTeamIds: [SELF] });
    expect(pendingQuestions([continued], { roomId: 'trash-talk', dm: false }, SELF, T0)).toHaveLength(1);
    // The reply to the burst's newest message answers the earlier ones it names; one it left open
    // is still pending.
    const reply = { kind: 'agent' as const, author: { teamId: SELF, name: 'Me' }, replyToId: 'b3' };
    const burst = [
      msg({ id: 'r', at: -0.3, ...reply, answersMessageIds: ['b1', 'b2'] }),
      msg({ id: 'b3', at: -0.4 }),
      msg({ id: 'b2', at: -0.45, mentionedTeamIds: [], addressedTeamIds: [SELF] }),
      msg({ id: 'b1', at: -0.5 })
    ];
    expect(pendingQuestions(burst, { roomId: 'trash-talk', dm: false }, SELF, T0)).toEqual([]);
    const leftOpen = [msg({ id: 'r', at: -0.3, ...reply, answersMessageIds: ['b2'] }), ...burst.slice(1)];
    expect(pendingQuestions(leftOpen, { roomId: 'trash-talk', dm: false }, SELF, T0)).toMatchObject([
      { messageId: 'b1' }
    ]);
  });
});

describe('questionOpportunities', () => {
  const q = (over = {}) => ({
    messageId: 'q1',
    roomId: 'dm-team-1-team-2',
    fromTeamId: 'team-1',
    author: 'Allen',
    dm: true,
    at: at(-1),
    ...over
  });
  function book(): CommitmentBook {
    return openTradeInterest(emptyCommitments(), {
      at: at(-2),
      taskId: 'look',
      selfTeamId: SELF,
      source: { roomId: 'dm-team-1-team-2', messageId: 'pitch', fromTeamId: 'team-1', visibility: 'dm' },
      send: ['a'],
      receive: ['b'],
      expiresAt: at(90),
      agendaId: 'goal-rb'
    }).book;
  }

  it('answers in the room it was asked, heard only by the asker in a DM, linked to an open commitment', () => {
    const { candidates, evidence } = questionOpportunities([q(), q({ messageId: 'pitch' })], book());
    // The pitch that opened the commitment gets the commitment's own closing line instead.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      act: 'answer_question',
      human: true,
      roomId: 'dm-team-1-team-2',
      audience: { teams: ['team-1'] },
      replyToId: 'q1',
      commitmentId: 'trade_interest:pitch',
      agendaId: 'goal-rb',
      expiresAt: at(23)
    });
    expect(evidence[0]).toMatchObject({ id: 'message:q1', visibility: { teams: ['team-1'] } });
    const room = questionOpportunities([q({ dm: false, roomId: 'league' })], null).candidates[0];
    expect(room).toMatchObject({ audience: 'public', commitmentId: null, agendaId: null });
  });
});

describe('ambientOpportunities', () => {
  it('draws on its own records: its result, a rival week, a shared history with the opponent', () => {
    const { candidates, evidence } = ambientOpportunities(ambient());
    expect(candidates.map((c) => [c.act, c.reason, c.topic])).toEqual([
      ['react_to_result', 'big_win', 'react:w4'],
      ['congratulate', 'top_score', 'congratulate:w4:team-3'],
      ['congratulate', 'win_streak', 'congratulate:streak:team-3:3'],
      ['callback', 'rematch', 'callback:team-3:result:w2'],
      ['callback', 'traded_with_opponent', 'callback:team-3:trade:t-fair']
    ]);
    expect(evidence.map((e) => e.line)).toEqual([
      'Week 4 final: you beat Big Tuna 150-100.',
      "Week 4's top score: Zen Garden with 162.",
      'Zen Garden has won 3 in a row.',
      'Week 2: you beat Zen Garden 110-95.',
      'This week (week 5) you play Zen Garden.',
      'On 2026-09-24 a trade with Zen Garden went through: you sent WR5 for RB9.'
    ]);
    // A fair trade and two games: the opponent matters to it.
    expect(candidates[3]?.salience).toBeGreaterThan(0);
    // Fresh until 36 hours after its own record of the week's final.
    expect(candidates[0]?.expiresAt).toBe(at(24));
    expect(candidates[3]?.eventKey).toBe('callback:w5:team-2|team-3');
  });

  it('words every margin, and names teams by id when the standings do not', () => {
    const reasons = [
      [131, 100, 'big_win'],
      [105, 100, 'close_win'],
      [100, 100, 'close_loss'],
      [100, 115, 'loss'],
      [60, 100, 'big_loss']
    ] as const;
    for (const [pf, pa, reason] of reasons) {
      const league = {
        ...LEAGUE,
        standings: [],
        lastWeek: [{ homeTeamId: 'team-1', homeScore: pa, awayTeamId: SELF, awayScore: pf }]
      };
      const { candidates, evidence } = ambientOpportunities(ambient({ league, opponentTeamId: null }));
      expect(candidates[0]).toMatchObject({ act: 'react_to_result', reason, counterpartTeamId: 'team-1' });
      expect(evidence[0]?.line).toContain('team-1');
    }
  });

  it('says nothing about a week it holds no record of, nor its own top score or a streak of two', () => {
    const noFinal = remember([], emptyMemory());
    expect(ambientOpportunities(ambient({ memory: noFinal, opponentTeamId: null })).candidates).toEqual([]);
    expect(ambientOpportunities(ambient({ league: null, opponentTeamId: null })).candidates).toEqual([]);
    const own = {
      ...LEAGUE,
      standings: LEAGUE.standings.map((s) => ({ ...s, streak: s.teamId === SELF ? 'W5' : null })),
      lastWeek: [{ homeTeamId: SELF, homeScore: 180, awayTeamId: 'team-1', awayScore: 100 }]
    };
    expect(
      ambientOpportunities(ambient({ league: own, opponentTeamId: null })).candidates.map((c) => c.act)
    ).toEqual(['react_to_result']);
    // No matchup this week, or no week: no callback.
    expect(ambientOpportunities(ambient({ week: null })).candidates.some((c) => c.act === 'callback')).toBe(
      false
    );
  });

  it('cannot call back what it never observed, and a private offer never reaches a public room', () => {
    // The agent's records hold no game against team-4 and no trade with it.
    expect(
      ambientOpportunities(ambient({ opponentTeamId: 'team-4' })).candidates.some((c) => c.act === 'callback')
    ).toBe(false);
    // A rejected offer to team-3 is sealed to the two teams: filtered out for a public room.
    const withOffer = remember(
      [
        {
          type: 'trade',
          teamId: 'team-4',
          tradeId: 't-private',
          outcome: 'rejected',
          direction: 'outgoing',
          summary: 'Your offer to team-4 was rejected.',
          at: at(-48)
        }
      ],
      emptyMemory()
    );
    const heard = memoryForAudience(withOffer, 'public', () => true).memory;
    expect(ambientOpportunities(ambient({ memory: heard, opponentTeamId: 'team-4' })).candidates).toEqual([]);
    // Even unfiltered, an unaccepted offer is not a shared deal to call back.
    expect(ambientOpportunities(ambient({ memory: withOffer, opponentTeamId: 'team-4' })).candidates).toEqual(
      []
    );
  });

  it('admits a documented wrong call only from an attachment its results revised down', () => {
    let state: PlayerAttachments = recordAcquisition(emptyAttachments(), {
      sourceId: 'draft:lg:3',
      kind: 'drafted',
      playerId: 'p-bust',
      name: 'Bust Back',
      position: 'RB',
      at: at(-24 * 30),
      round: 1
    });
    // No record yet: no admission.
    expect(
      ambientOpportunities(ambient({ attachments: state })).candidates.some(
        (c) => c.act === 'acknowledge_mistake'
      )
    ).toBe(false);
    for (let week = 1; week <= 3; week++)
      state = observePerformance(state, {
        at: at(-24 * (4 - week)),
        week,
        results: [{ playerId: 'p-bust', points: 2, projected: 15 }]
      });
    const { candidates, evidence } = ambientOpportunities(ambient({ attachments: state }));
    const admit = candidates.find((c) => c.act === 'acknowledge_mistake');
    expect(admit).toMatchObject({ reason: 'fell_short', topic: 'admit:p-bust', counterpartTeamId: null });
    expect(evidence.find((e) => e.id === admit?.evidence[0])?.line).toBe(
      'You drafted Bust Back in round 1; he fell short of projection in 3 of the last 3 weeks.'
    );
    // A week later it is stale.
    expect(
      ambientOpportunities(ambient({ attachments: state, now: at(24 * 8) })).candidates.some(
        (c) => c.act === 'acknowledge_mistake'
      )
    ).toBe(false);
    // A player it traded for is worded as such.
    const traded = {
      ...state,
      preferences: state.preferences.map((p) => ({
        ...p,
        sources: [{ id: 'trade:x:p', kind: 'traded_for' as const, at: at(-24 * 30) }]
      }))
    };
    expect(
      ambientOpportunities(ambient({ attachments: traded })).evidence.some((e) =>
        e.line.startsWith('You traded for Bust Back')
      )
    ).toBe(true);
  });
});

describe('selectSocialAct', () => {
  it("puts a person's question first, and ambient talk yields to it", () => {
    const question = candidate({
      act: 'answer_question',
      reason: 'person_asked',
      topic: 'answer:q1',
      eventKey: 'answer:q1',
      roomId: 'dm-team-1-team-2',
      audience: { teams: ['team-1'] },
      evidence: ['message:q1'],
      human: true,
      at: at(-1),
      replyToId: 'q1'
    });
    const older = { ...question, topic: 'answer:q0', evidence: ['message:q0'], at: at(-3), replyToId: 'q0' };
    const evidence = [
      fact('result:w2'),
      fact('message:q1', { visibility: { teams: ['team-1'], trades: [], waiverClaims: [] } }),
      fact('message:q0', { visibility: { teams: ['team-1'], trades: [], waiverClaims: [] } })
    ];
    const picked = select({
      candidates: [candidate(), question, older],
      evidence,
      seed: seed(QUIET.chattiness, false),
      personality: QUIET
    });
    // Even a quiet manager answers, the oldest question first; the rest wait.
    expect(picked).toMatchObject({ act: 'answer_question', abstention: null });
    expect(picked.chosen?.replyToId).toBe('q0');
    expect(picked.waiting.map((c) => c.replyToId)).toEqual(['q1']);
    expect(picked.dropped).toEqual([{ candidate: candidate(), why: 'yield' }]);
  });

  it('keeps a question waiting when no post is left, and drops ambient talk instead of queueing it', () => {
    const question = candidate({
      act: 'answer_question',
      human: true,
      topic: 'answer:q1',
      evidence: ['message:q1']
    });
    const evidence = [fact('result:w2'), fact('message:q1')];
    const spent = select({ candidates: [candidate(), question], evidence, postsLeft: 0 });
    expect(spent).toMatchObject({ act: 'stay_quiet', chosen: null, abstention: 'budget' });
    expect(spent.waiting).toEqual([question]);
    expect(spent.dropped.map((d) => d.why)).toEqual(['yield']);
    // The last post of the day is kept for people: ambient talk never takes it.
    const last = select({ postsLeft: SOCIAL_ACT_LIMITS.humanReserve });
    expect(last).toMatchObject({ act: 'stay_quiet', abstention: 'budget' });
    expect(last.dropped.map((d) => d.why)).toEqual(['budget']);
    expect(select({ postsLeft: null }).act).toBe('callback');
  });

  it('lets a quiet manager stay quiet most check-ins', () => {
    const count = (personality: typeof LOUD) =>
      Array.from({ length: 300 }, (_, i) => select({ personality, seed: `roll-${i}` })).filter(
        (s) => s.chosen !== null
      ).length;
    expect(count(QUIET)).toBeLessThanOrEqual(3);
    expect(count(LOUD)).toBeGreaterThan(60);
    expect(select({ personality: QUIET, seed: seed(QUIET.chattiness, false) })).toMatchObject({
      act: 'stay_quiet',
      abstention: 'quiet'
    });
  });

  it('drops the expired, the unverified, the private, the repeated, and a room where it had the last word', () => {
    const cases: [Partial<SocialSelectionInput>, string][] = [
      [{ candidates: [candidate({ expiresAt: T0 })] }, 'expired'],
      [{ candidates: [candidate({ evidence: [] })] }, 'unverified_evidence'],
      [{ candidates: [candidate({ evidence: ['result:w9'] })] }, 'unverified_evidence'],
      [
        {
          evidence: [fact('result:w2', { visibility: { teams: ['team-3'], trades: [], waiverClaims: [] } })]
        },
        'private_evidence'
      ],
      [{ history: history(entry()) }, 'repeat'],
      [{ lastWord: ['trash-talk'] }, 'last_word']
    ];
    for (const [over, why] of cases) {
      const picked = select(over);
      expect(picked).toMatchObject({ act: 'stay_quiet', abstention: 'no_opportunity' });
      expect(picked.dropped.map((d) => d.why)).toEqual([why]);
    }
    // A released seal lets it through; past the topic's cooldown it may come back.
    const released = select({
      evidence: [
        fact('result:w2', {
          visibility: { teams: [], trades: [{ tradeId: 't', until: 'public' }], waiverClaims: [] }
        })
      ],
      sealed: () => false
    });
    expect(released.act).toBe('callback');
    expect(select({ history: history(entry({ at: at(-24 * 22) })) }).act).toBe('callback');
  });

  it('hands a question on again only after the retry wait, but the same task may redo it', () => {
    const question = candidate({
      act: 'answer_question',
      human: true,
      topic: 'answer:q1',
      evidence: ['message:q1']
    });
    const evidence = [fact('message:q1')];
    const handed = entry({
      act: 'answer_question',
      topic: 'answer:q1',
      outcome: 'handed_on',
      taskId: 'task-0'
    });
    expect(select({ candidates: [question], evidence, history: history(handed) }).act).toBe('stay_quiet');
    expect(
      select({ candidates: [question], evidence, history: history({ ...handed, taskId: 'task-1' }) }).act
    ).toBe('answer_question');
    expect(
      select({ candidates: [question], evidence, history: history({ ...handed, at: at(-5) }) }).act
    ).toBe('answer_question');
  });

  it('scores relevance, novelty, salience and personality, and passes on a weak one', () => {
    const react = candidate({
      act: 'react_to_result',
      topic: 'react:w4',
      counterpartTeamId: 'team-1',
      relevance: 0.6,
      salience: 0
    });
    const both = select({ candidates: [react, candidate()] });
    expect(both.chosen?.act).toBe('callback');
    expect(both.dropped).toEqual([{ candidate: react, why: 'outscored' }]);
    expect(both.scores.map((s) => s.topic)).toEqual(['callback:team-3:result:w2', 'react:w4']);
    // Novelty: a callback posted lately, to the same team, makes another less worth it.
    const lately = history(entry({ topic: 'callback:team-3:trade:t', at: at(-2) }));
    expect(socialScore(candidate(), lately, LOUD, T0)).toBeLessThan(
      socialScore(candidate(), emptySocialActs(), LOUD, T0)
    );
    // Only posted acts count against novelty.
    const withheld = history(entry({ topic: 'callback:team-3:trade:t', at: at(-2), outcome: 'withheld' }));
    expect(socialScore(candidate(), withheld, LOUD, T0)).toBe(
      socialScore(candidate(), emptySocialActs(), LOUD, T0)
    );
    // A stubborn manager rarely admits a mistake.
    const admit = candidate({
      act: 'acknowledge_mistake',
      counterpartTeamId: null,
      relevance: 0.7,
      salience: 0
    });
    expect(socialScore(admit, emptySocialActs(), { persuadability: 0.1 }, T0)).toBeLessThan(
      socialScore(admit, emptySocialActs(), { persuadability: 0.9 }, T0)
    );
    const weak = select({ candidates: [candidate({ relevance: 0.1, salience: 0 })], history: lately });
    expect(weak).toMatchObject({ act: 'stay_quiet', abstention: 'low_score' });
    expect(weak.dropped.map((d) => d.why)).toEqual(['low_score']);
    expect(weak.scores).toHaveLength(1);
  });

  it('abstains with nothing to say', () => {
    expect(select({ candidates: [] })).toMatchObject({
      act: 'stay_quiet',
      abstention: 'no_opportunity',
      dropped: []
    });
  });
});

describe('the social act pack and its check', () => {
  const pack = () =>
    socialActPack(
      candidate({ evidence: ['result:w2', 'matchup:w5', 'gone'] }),
      [fact('result:w2'), fact('matchup:w5', { line: 'This week (week 5) you play Zen Garden.' })],
      ['You are 3-1, 2nd.']
    );

  it('gives the model the purpose and only the facts it may cite', () => {
    expect(pack()).toEqual({
      act: 'callback',
      reason: 'rematch',
      roomId: 'trash-talk',
      counterpartTeamId: 'team-3',
      purpose:
        'bring back a real moment you share with them, because it bears on this week: your week 2 game against Zen Garden',
      facts: [
        { id: 'result:w2', line: 'Week 2: you beat Zen Garden 110-95.' },
        { id: 'matchup:w5', line: 'This week (week 5) you play Zen Garden.' }
      ],
      context: ['You are 3-1, 2nd.']
    });
  });

  it('accepts a grounded line and rejects the rest', () => {
    const ok = checkSocialAct(pack(), {
      message: '  Week 2 I beat you 110-95.   Week 5, same story; I sit 2nd. ',
      evidence: ['result:w2', 'result:w2']
    });
    expect(ok).toEqual({
      ok: true,
      message: 'Week 2 I beat you 110-95. Week 5, same story; I sit 2nd.',
      evidence: ['result:w2']
    });
    const bad: [Parameters<typeof checkSocialAct>[1], string][] = [
      [{ message: '  ', evidence: ['result:w2'] }, 'empty'],
      [{ message: 'Remember week 2?', evidence: [] }, 'no_evidence'],
      [{ message: 'Remember week 2?', evidence: ['trade:t9'] }, 'unknown_evidence'],
      [{ message: 'I beat you 120-95 in week 2.', evidence: ['result:w2'] }, 'unsupported_number']
    ];
    for (const [draft, reason] of bad) expect(checkSocialAct(pack(), draft)).toEqual({ ok: false, reason });
    expect(
      checkSocialAct(pack(), { message: 'Still want Secret Guy? Week 2 says no.', evidence: ['result:w2'] }, [
        'Secret Guy',
        ' '
      ])
    ).toEqual({
      ok: false,
      reason: 'private_detail'
    });
    // A name the facts already state is not private.
    expect(
      checkSocialAct(pack(), { message: 'Zen Garden, week 2 again.', evidence: ['result:w2'] }, [
        'Zen Garden'
      ]).ok
    ).toBe(true);
  });
});

describe('the social act history', () => {
  it('replaces an entry by id and keeps the newest within its bound', () => {
    let book = emptySocialActs();
    for (let i = 0; i < SOCIAL_ACT_LIMITS.history + 5; i++)
      book = recordSocialAct(book, entry({ id: `e-${i}` }));
    book = recordSocialAct(book, entry({ id: 'e-10', outcome: 'withheld', detail: 'room_flooded' }));
    expect(book.acts).toHaveLength(SOCIAL_ACT_LIMITS.history);
    expect(book.acts.at(-1)).toMatchObject({ id: 'e-10', outcome: 'withheld' });
    expect(book.acts[0]?.id).toBe('e-5');
    expect(SocialActBookSchema.parse(book)).toEqual(book);
    expect(() => SocialActBookSchema.parse({ ...book, acts: [...book.acts, entry()] })).toThrow();
    expect(() =>
      SocialActBookSchema.parse({ schemaVersion: 1, acts: [{ ...entry(), act: 'stay_quiet' }] })
    ).toThrow();
  });

  it('words each act for the activity log', () => {
    expect(socialActWords('callback')).toBe('a callback');
    expect(socialActWords('acknowledge_mistake')).toBe('an admission');
  });
});

describe('callbacks by destination (#218)', () => {
  it('goes to the matchup room, and calls back a player it traded them who starts against it', () => {
    const matchupRoom = { roomId: 'm-2026-W05-W05-M3', audience: 'public' as const };
    const found = ambientOpportunities(ambient({ matchupRoom, opponentStarters: ['RB1', 'WR5'] }));
    const callbacks = found.candidates.filter((c) => c.act === 'callback');
    expect(callbacks.map((c) => [c.reason, c.roomId])).toEqual([
      ['rematch', matchupRoom.roomId],
      ['traded_with_opponent', matchupRoom.roomId],
      ['former_player', matchupRoom.roomId]
    ]);
    const former = callbacks.find((c) => c.reason === 'former_player');
    expect(former?.evidence).toEqual(['trade:t-fair', 'starter:w5:team-3:wr5']);
    expect(found.evidence.find((e) => e.id === 'starter:w5:team-3:wr5')?.line).toBe(
      "WR5 is in Zen Garden's starting lineup against you this week."
    );
    // Board acts stay on the board.
    expect(found.candidates.find((c) => c.act === 'react_to_result')?.roomId).toBe('trash-talk');
    // A player it traded who is not starting is no callback.
    expect(
      ambientOpportunities(ambient({ matchupRoom, opponentStarters: ['RB1'] })).candidates.some(
        (c) => c.reason === 'former_player'
      )
    ).toBe(false);
  });

  it('keeps a record private to the two teams to their DM, heard by the opponent alone', () => {
    const talks = remember(
      [
        {
          type: 'trade',
          teamId: 'team-3',
          tradeId: 't-private',
          outcome: 'rejected',
          direction: 'outgoing',
          summary: 'Your offer to team-3 was rejected.',
          at: at(-48)
        }
      ],
      emptyMemory()
    );
    const dm = {
      roomId: 'dm-team-2-team-3',
      memory: memoryForAudience(talks, { teams: ['team-3'] }, () => true).memory
    };
    const found = ambientOpportunities(ambient({ memory: emptyMemory(), dm }));
    const callback = found.candidates.find((c) => c.act === 'callback');
    expect(callback).toMatchObject({ roomId: dm.roomId, audience: { teams: ['team-3'] } });
    // The selector lets it into the DM, never into a public room.
    const inDm = select({
      candidates: found.candidates.filter((c) => c.act === 'callback'),
      evidence: found.evidence
    });
    expect(inDm.chosen?.roomId).toBe(dm.roomId);
    const inPublic = select({
      candidates: [{ ...(callback as SocialCandidate), roomId: 'trash-talk', audience: 'public' }],
      evidence: found.evidence
    });
    expect(inPublic.dropped.map((d) => d.why)).toEqual(['private_evidence']);
    // Filtered for a public room, the offer is not there to call back at all.
    const heard = memoryForAudience(talks, 'public', () => true).memory;
    expect(
      ambientOpportunities(ambient({ memory: emptyMemory(), dm: { ...dm, memory: heard } })).candidates.some(
        (c) => c.act === 'callback'
      )
    ).toBe(false);
  });
});

describe('player callbacks from stored chat remarks (#280)', () => {
  const MATCHUP = { roomId: 'm-2026-W05-W05-M3', audience: 'public' as const };
  const DM_3 = 'dm-team-2-team-3';
  const ROSTER = ['Puka Nacua', 'Kyren Williams', 'Josh Allen', 'Bijan Robinson'];
  const said = (over: Partial<QuestionMessage> & { id: string; at: number; text: string }): QuestionMessage =>
    msg({ author: { teamId: 'team-3', name: 'Zed' }, mentionedTeamIds: [], ...over });
  /** What `playerRemarks` stores for one message in one room. */
  const stored = (message: QuestionMessage, room: { roomId: string; dm: boolean; teamIds: string[] }) =>
    playerRemarks([message], room, SELF, ROSTER);
  const PUBLIC = { roomId: 'trash-talk', dm: false, teamIds: [] };
  const IN_DM = { roomId: DM_3, dm: true, teamIds: [SELF, 'team-3'] };
  const laughed = said({ id: 'm-laugh', at: -24 * 4, text: 'lol you claimed Nacua?? enjoy the bench' });

  it('stores who said what about a player, where, and when, with the room’s audience', () => {
    expect(stored(laughed, PUBLIC)).toEqual([
      {
        type: 'remark',
        messageId: 'm-laugh',
        roomId: 'trash-talk',
        authorTeamId: 'team-3',
        author: 'Zed',
        players: ['Puka Nacua'],
        text: 'lol you claimed Nacua?? enjoy the bench',
        at: at(-24 * 4),
        visibility: 'public'
      }
    ]);
    // In a DM it is the two teams' alone, for good (a seal naming no moves never lifts).
    expect(stored(laughed, IN_DM)[0]?.visibility).toEqual({
      teams: ['team-3'],
      trades: [],
      waiverClaims: []
    });
    // Its own words, the league's, and messages naming none of its players are not remarks.
    const own = said({ id: 'm-own', at: -1, text: 'Nacua eats', author: { teamId: SELF, name: 'Me' } });
    const league = said({
      id: 'm-sys',
      at: -1,
      text: 'Nacua scored',
      kind: 'system',
      author: { teamId: null, name: 'League' }
    });
    for (const m of [own, league, said({ id: 'm-none', at: -1, text: 'Talk is cheap.' })])
      expect(stored(m, PUBLIC)).toEqual([]);
    // A DM it is not in is never a source.
    expect(stored(laughed, { roomId: 'dm-team-1-team-3', dm: true, teamIds: ['team-1', 'team-3'] })).toEqual(
      []
    );
  });

  it('names a player by full name or an unshared last name, never inside another word', () => {
    expect(playersNamed('Kyren Williams and josh allen', ROSTER)).toEqual(['Kyren Williams', 'Josh Allen']);
    expect(playersNamed('Robinson is a bust', ROSTER)).toEqual(['Bijan Robinson']);
    expect(playersNamed('Nacuaesque', ROSTER)).toEqual([]);
    // A last name two of them share names neither.
    expect(playersNamed('Williams again', [...ROSTER, 'Javonte Williams'])).toEqual([]);
  });

  it('keeps one record per message, bounded, and filters it by audience', () => {
    const dmRemark = stored(laughed, IN_DM)[0] as MemoryEvent;
    const again = remember([dmRemark, dmRemark]);
    expect(again.remarks).toHaveLength(1);
    const many = remember(
      Array.from({ length: MEMORY_LIMITS.remarks + 3 }, (_, i) =>
        stored(said({ id: `m-${i}`, at: -100 + i, text: 'Nacua!' }), PUBLIC)
      ).flat()
    );
    expect(many.remarks).toHaveLength(MEMORY_LIMITS.remarks);
    expect(many.remarks[0]?.messageId).toBe('m-3');
    // The DM remark is heard in that DM alone: not in public, not in another team's DM.
    expect(memoryForAudience(again, { teams: ['team-3'] }, () => true).memory.remarks).toHaveLength(1);
    expect(memoryForAudience(again, 'public', () => true).memory.remarks).toEqual([]);
    expect(memoryForAudience(again, { teams: ['team-1'] }, () => true).memory.remarks).toEqual([]);
    expect(memorySeals(again)).toEqual([{ teams: ['team-3'], trades: [], waiverClaims: [] }]);
  });

  it('calls back a public remark in the matchup room when the player starts in the game', () => {
    const heard = remember(stored(laughed, PUBLIC), memory());
    const found = ambientOpportunities(
      ambient({ memory: heard, matchupRoom: MATCHUP, ownStarters: ['Puka Nacua'], opponentStarters: ['RB1'] })
    );
    const callback = found.candidates.find((c) => c.reason === 'player_remark');
    expect(callback).toMatchObject({
      act: 'callback',
      counterpartTeamId: 'team-3',
      roomId: MATCHUP.roomId,
      audience: 'public',
      topic: 'callback:team-3:remark:m-laugh',
      evidence: ['remark:m-laugh', 'starter:w5:team-2:puka nacua'],
      at: at(-24 * 4)
    });
    const lines = Object.fromEntries(found.evidence.map((e) => [e.id, e.line]));
    expect(lines['remark:m-laugh']).toBe(
      `On ${at(-24 * 4).slice(0, 10)} in #trash-talk, Zed of Zen Garden wrote about Puka Nacua: "lol you claimed Nacua?? enjoy the bench"`
    );
    expect(lines['starter:w5:team-2:puka nacua']).toBe(
      'Puka Nacua is in your starting lineup against Zen Garden this week.'
    );
    // It is the act chosen (the most relevant), and its pack holds the remark's real words.
    const chosen = select({ candidates: found.candidates, evidence: found.evidence }).chosen;
    expect(chosen?.reason).toBe('player_remark');
    const pack = socialActPack(chosen as SocialCandidate, found.evidence);
    expect(
      checkSocialAct(pack, {
        message: 'You said "Enjoy the bench." about Puka Nacua. He starts against you.',
        evidence: ['remark:m-laugh', 'starter:w5:team-2:puka nacua']
      }).ok
    ).toBe(true);
    // A quote nobody said is rejected; a paraphrase that quotes nothing is fine.
    expect(
      checkSocialAct(pack, {
        message: 'You laughed: "worst pickup ever." Now Nacua starts against you.',
        evidence: ['remark:m-laugh']
      })
    ).toEqual({ ok: false, reason: 'invented_quote' });
    expect(
      checkSocialAct(pack, {
        message: 'You had words about Nacua when I got him. He starts against you.',
        evidence: ['remark:m-laugh']
      }).ok
    ).toBe(true);
    // Their own starter counts too.
    const theirs = ambientOpportunities(
      ambient({ memory: heard, matchupRoom: MATCHUP, opponentStarters: ['Puka Nacua'] })
    );
    expect(theirs.evidence.find((e) => e.id === 'starter:w5:team-3:puka nacua')?.line).toBe(
      "Puka Nacua is in Zen Garden's starting lineup against you this week."
    );
  });

  it('keeps a DM remark to that DM: never a public room or another team’s DM', () => {
    const all = remember(stored(laughed, IN_DM), memory());
    const dm = { roomId: DM_3, memory: memoryForAudience(all, { teams: ['team-3'] }, () => true).memory };
    const found = ambientOpportunities(
      ambient({
        memory: memoryForAudience(all, 'public', () => true).memory,
        matchupRoom: MATCHUP,
        ownStarters: ['Puka Nacua'],
        dm
      })
    );
    const remarks = found.candidates.filter((c) => c.reason === 'player_remark');
    expect(remarks.map((c) => [c.roomId, c.audience])).toEqual([[DM_3, { teams: ['team-3'] }]]);
    const callback = remarks[0] as SocialCandidate;
    // The selector lets it into their DM only.
    expect(select({ candidates: [callback], evidence: found.evidence }).chosen?.roomId).toBe(DM_3);
    for (const elsewhere of [
      { roomId: MATCHUP.roomId, audience: 'public' as const },
      { roomId: 'dm-team-1-team-2', audience: { teams: ['team-1'] } }
    ])
      expect(
        select({ candidates: [{ ...callback, ...elsewhere }], evidence: found.evidence }).dropped.map(
          (d) => d.why
        )
      ).toEqual(['private_evidence']);
    // Filtered for another team's DM, the remark is not there to call back at all.
    const other = { roomId: DM_3, memory: memoryForAudience(all, { teams: ['team-1'] }, () => true).memory };
    expect(
      ambientOpportunities(
        ambient({ memory: emptyMemory(), ownStarters: ['Puka Nacua'], dm: other })
      ).candidates.some((c) => c.reason === 'player_remark')
    ).toBe(false);
  });

  it('makes no callback from a missing, stale, or unrelated remark', () => {
    const found = (heard: AgentLeagueMemory, over: Partial<AmbientInput> = {}) =>
      ambientOpportunities(
        ambient({ memory: heard, matchupRoom: MATCHUP, ownStarters: ['Puka Nacua'], ...over })
      ).candidates.some((c) => c.reason === 'player_remark');
    expect(found(memory())).toBe(false);
    const stale = said({
      id: 'm-old',
      at: -SOCIAL_ACT_LIMITS.remarkFreshMs / 3_600_000 - 1,
      text: 'Nacua? lol'
    });
    expect(found(remember(stored(stale, PUBLIC), memory()))).toBe(false);
    // Said by a team it does not play this week.
    const bystander = said({
      id: 'm-by',
      at: -2,
      text: 'Nacua? lol',
      author: { teamId: 'team-1', name: 'Allen' }
    });
    expect(found(remember(stored(bystander, PUBLIC), memory()))).toBe(false);
    // About a player who is not starting in the game.
    expect(found(remember(stored(laughed, PUBLIC), memory()), { ownStarters: ['Josh Allen'] })).toBe(false);
  });
});

describe('ask_relevant_question (#218)', () => {
  const partner = {
    teamId: 'team-1',
    teamName: 'Big Tuna',
    roomId: 'dm-team-1-team-2',
    players: [{ id: 'p-rb', name: 'Tuna RB', position: 'RB' }]
  };
  const goal = { id: 'repair_position:W5:RB', slot: 'RB' as const, status: 'active' as const };
  const asking = (over: Partial<AskInput> = {}): AskInput => ({
    self: SELF,
    now: T0,
    goals: [goal],
    commitments: null,
    partners: [partner],
    history: emptySocialActs(),
    ...over
  });
  const pitched = (): CommitmentBook =>
    openTradeInterest(emptyCommitments(), {
      at: at(-24),
      taskId: 'trade_proposal.x',
      selfTeamId: SELF,
      source: { roomId: 'dm-team-1-team-2', messageId: 'pitch-1', fromTeamId: 'team-1', visibility: 'dm' },
      send: ['wr5'],
      receive: ['p-rb'],
      expiresAt: at(48),
      agendaId: null
    }).book;
  const declined = (
    reason: 'value_below_floor' | 'insufficient_depth' = 'value_below_floor'
  ): CommitmentBook => {
    const book = pitched();
    return {
      schemaVersion: 1,
      commitments: book.commitments.map((c) => ({
        ...c,
        status: 'declined' as const,
        decision: { reason, at: at(-20), taskId: 'trade_proposal.x', facts: null }
      }))
    };
  };
  const posted = (over: Partial<SocialActEntry> = {}): SocialActEntry =>
    entry({
      id: 'ask-1',
      act: 'ask_relevant_question',
      reason: 'need_partner',
      topic: `ask:${goal.id}:team-1`,
      eventKey: 'ask:team-1',
      roomId: 'dm-team-1-team-2',
      counterpartTeamId: 'team-1',
      evidence: ['roster:team-1:p-rb'],
      messageId: 'q-1',
      agendaId: goal.id,
      expects: 'trade_interest',
      expiresAt: at(47),
      ...over
    });

  it('asks a person whose player fills an active need, in their DM, from public facts only', () => {
    const found = askOpportunities(asking());
    expect(found.candidates).toMatchObject([
      {
        act: 'ask_relevant_question',
        reason: 'need_partner',
        counterpartTeamId: 'team-1',
        roomId: 'dm-team-1-team-2',
        audience: { teams: ['team-1'] },
        agendaId: goal.id,
        expects: 'trade_interest',
        evidence: ['roster:team-1:p-rb'],
        expiresAt: at(SOCIAL_ACT_LIMITS.askFreshMs / 3_600_000)
      }
    ]);
    expect(found.evidence).toEqual([
      { id: 'roster:team-1:p-rb', line: 'Big Tuna rosters Tuna RB (RB).', at: T0, visibility: 'public' }
    ]);
    const chosen = select({ candidates: found.candidates, evidence: found.evidence }).chosen;
    expect(socialActPack(chosen as SocialCandidate, found.evidence).purpose).toContain(
      'whether Big Tuna would move Tuna RB'
    );
  });

  it('asks nothing without an active need it could fill, or while a question or a look is open', () => {
    expect(askOpportunities(asking({ goals: [{ ...goal, status: 'completed' }] })).candidates).toEqual([]);
    expect(askOpportunities(asking({ goals: [{ ...goal, slot: 'QB' }] })).candidates).toEqual([]);
    // One question at a time, whoever it went to.
    expect(
      askOpportunities(asking({ history: history(posted({ counterpartTeamId: 'team-4' })) })).candidates
    ).toEqual([]);
    // A lapsed question no longer blocks.
    expect(
      askOpportunities(asking({ history: history(posted({ expiresAt: at(-1) })) })).candidates
    ).toHaveLength(1);
    // An open trade look with them is already the conversation.
    expect(askOpportunities(asking({ commitments: pitched() })).candidates).toEqual([]);
  });

  it('asks what they would add to a pitch it declined on value, heard only in their DM', () => {
    const found = askOpportunities(asking({ goals: [], commitments: declined() }));
    expect(found.candidates).toMatchObject([
      {
        reason: 'declined_offer',
        commitmentId: 'trade_interest:pitch-1',
        roomId: 'dm-team-1-team-2',
        expects: 'revised_offer'
      }
    ]);
    expect(found.evidence[0]?.visibility).toEqual({ teams: ['team-1'], trades: [], waiverClaims: [] });
    // Not for another reason, a pitch too old, or a person it cannot reach.
    expect(
      askOpportunities(asking({ goals: [], commitments: declined('insufficient_depth') })).candidates
    ).toEqual([]);
    expect(
      askOpportunities(asking({ goals: [], now: at(24 * 4), commitments: declined() })).candidates
    ).toEqual([]);
    expect(askOpportunities(asking({ goals: [], partners: [], commitments: declined() })).candidates).toEqual(
      []
    );
  });

  it('reads the next message in that DM as the answer, once, and never a lapsed question', () => {
    const book = history(posted());
    expect(openAsk(book, 'dm-team-1-team-2', 'team-1', T0)?.id).toBe('ask-1');
    expect(openAsk(book, 'dm-team-1-team-4', 'team-1', T0)).toBeNull();
    expect(openAsk(book, 'dm-team-1-team-2', 'team-4', T0)).toBeNull();
    expect(openAsk(book, 'dm-team-1-team-2', 'team-1', at(48))).toBeNull();
    const answered = answerAsk(book, 'ask-1', 'a-1');
    expect(answered.acts[0]).toMatchObject({ outcome: 'answered', answerId: 'a-1' });
    expect(openAsks(answered, T0)).toEqual([]);
    // Answered stays answered.
    expect(answerAsk(answered, 'ask-1', 'a-2').acts[0]?.answerId).toBe('a-1');
    expect(SocialActBookSchema.parse(answered)).toEqual(answered);
  });

  it('cancels a question whose goal closed or whose look moved on, and expires an unanswered one', () => {
    const book = history(posted());
    expect(settleAsks(book, { now: T0, goals: [goal], commitments: null })).toBe(book);
    expect(settleAsks(book, { now: T0, goals: [], commitments: null }).acts[0]).toMatchObject({
      outcome: 'cancelled',
      detail: 'goal_closed'
    });
    // Without the agenda at hand, a goal is not second-guessed.
    expect(settleAsks(book, { now: T0, goals: null, commitments: null })).toBe(book);
    expect(settleAsks(book, { now: at(48), goals: [goal], commitments: null }).acts[0]).toMatchObject({
      outcome: 'expired',
      detail: 'no_answer'
    });
    const onPitch = history(posted({ commitmentId: 'trade_interest:pitch-1', agendaId: null }));
    expect(settleAsks(onPitch, { now: T0, goals: null, commitments: declined() })).toBe(onPitch);
    expect(settleAsks(onPitch, { now: T0, goals: null, commitments: pitched() }).acts[0]).toMatchObject({
      outcome: 'cancelled',
      detail: 'commitment_moved'
    });
    // Other acts are never touched.
    const other = history(entry());
    expect(settleAsks(other, { now: at(48), goals: [], commitments: null })).toBe(other);
  });
});
