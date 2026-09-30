import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CONTINUATION_LIMITS,
  aimedAt,
  answeredBefore,
  asksSomething,
  continuationAddressee,
  type ContinuationInput,
  type ContinuationMessage
} from './continuation.js';

const PERSON = 'team-1';
const AGENT = 'team-2';
const OTHER_AGENT = 'team-3';
const OTHER_PERSON = 'team-4';
const NOW = '2026-10-06T13:00:00.000Z';
const minutesAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();

let n = 0;
function msg(
  kind: 'user' | 'agent' | 'system',
  teamId: string | null,
  minutes: number,
  extra: Partial<ContinuationMessage> = {}
): ContinuationMessage {
  return {
    id: `m${++n}`,
    kind,
    author: { teamId },
    mentionedTeamIds: [],
    createdAt: minutesAgo(minutes),
    ...extra
  };
}

/** The room, oldest first as written; the input wants it newest first. */
function input(
  oldestFirst: ContinuationMessage[],
  overrides: Partial<ContinuationInput> = {}
): ContinuationInput {
  return {
    author: { kind: 'user', teamId: PERSON },
    mentioned: [],
    dm: false,
    recent: [...oldestFirst].reverse(),
    now: NOW,
    ...overrides
  };
}

/** A person mentions the agent and the agent answers with a reply: the usual opening. */
function opening(minutes = 3) {
  const asked = msg('user', PERSON, minutes + 1, { mentionedTeamIds: [AGENT] });
  const answered = msg('agent', AGENT, minutes, { replyToId: asked.id });
  return [asked, answered];
}

describe('continuationAddressee', () => {
  it('continues a back-and-forth with the agent that answered last', () => {
    expect(continuationAddressee(input(opening()))).toBe(AGENT);
    // An agent's mention of the person opens it too, and so do the person's earlier continuations.
    expect(
      continuationAddressee(
        input([
          msg('agent', AGENT, 5, { mentionedTeamIds: [PERSON] }),
          msg('user', PERSON, 4, { addressedTeamIds: [AGENT] }),
          msg('user', PERSON, 3, { mentionedTeamIds: [AGENT] })
        ])
      )
    ).toBe(AGENT);
    // A third party's chatter that addresses nobody does not interrupt it.
    expect(continuationAddressee(input([...opening(), msg('user', OTHER_PERSON, 1)]))).toBe(AGENT);
    // Nor does a league announcement.
    expect(continuationAddressee(input([...opening(), msg('system', null, 1)]))).toBe(AGENT);
  });

  it('lets the exchange lapse after the window', () => {
    const minutes = CONTINUATION_LIMITS.windowMs / 60_000;
    expect(continuationAddressee(input(opening(minutes)))).toBe(AGENT);
    expect(continuationAddressee(input(opening(minutes + 1)))).toBeNull();
  });

  it('infers nothing when another person takes the agent over', () => {
    expect(
      continuationAddressee(
        input([...opening(), msg('user', OTHER_PERSON, 1, { mentionedTeamIds: [AGENT] })])
      )
    ).toBeNull();
    const [asked, answered] = opening();
    expect(
      continuationAddressee(
        input([
          asked as ContinuationMessage,
          answered as ContinuationMessage,
          msg('user', OTHER_PERSON, 1, { replyToId: (answered as ContinuationMessage).id })
        ])
      )
    ).toBeNull();
    // Nor when the agent has turned to someone else, or someone else was the last to answer.
    expect(
      continuationAddressee(
        input([...opening(), msg('agent', AGENT, 1, { mentionedTeamIds: [OTHER_PERSON] })])
      )
    ).toBeNull();
    expect(
      continuationAddressee(
        input([...opening(), msg('user', OTHER_PERSON, 1, { mentionedTeamIds: [PERSON] })])
      )
    ).toBeNull();
    // Another agent that answered the person last takes the conversation with it.
    expect(
      continuationAddressee(
        input([...opening(), msg('agent', OTHER_AGENT, 1, { mentionedTeamIds: [PERSON] })])
      )
    ).toBe(OTHER_AGENT);
  });

  it('infers nothing once the person has addressed someone else', () => {
    expect(
      continuationAddressee(
        input([...opening(), msg('user', PERSON, 1, { mentionedTeamIds: [OTHER_AGENT] })])
      )
    ).toBeNull();
    const other = msg('user', OTHER_PERSON, 2);
    expect(
      continuationAddressee(input([...opening(), other, msg('user', PERSON, 1, { replyToId: other.id })]))
    ).toBeNull();
  });

  it('lets an explicit mention win, and never infers for agents, the league, or a DM', () => {
    expect(continuationAddressee(input(opening(), { mentioned: [OTHER_AGENT] }))).toBeNull();
    expect(continuationAddressee(input(opening(), { mentioned: [AGENT] }))).toBeNull();
    expect(
      continuationAddressee(input(opening(), { author: { kind: 'agent', teamId: OTHER_AGENT } }))
    ).toBeNull();
    expect(continuationAddressee(input(opening(), { author: { kind: 'user', teamId: null } }))).toBeNull();
    expect(continuationAddressee(input(opening(), { author: { kind: 'system', teamId: null } }))).toBeNull();
    expect(continuationAddressee(input(opening(), { dm: true }))).toBeNull();
  });

  it('needs an agent to have spoken to the person', () => {
    expect(continuationAddressee(input([]))).toBeNull();
    expect(continuationAddressee(input([msg('agent', AGENT, 1)]))).toBeNull();
    // A person answering a person is their own conversation.
    expect(
      continuationAddressee(input([msg('user', OTHER_PERSON, 1, { mentionedTeamIds: [PERSON] })]))
    ).toBeNull();
    // A reply to a message outside the lookback aims at nobody the rule can see.
    expect(continuationAddressee(input([msg('agent', AGENT, 1, { replyToId: 'gone' })]))).toBeNull();
  });

  it('only ever names an agent that aimed the newest message at the person (property)', () => {
    const teams = [PERSON, AGENT, OTHER_AGENT, OTHER_PERSON];
    const arbitrary = fc.array(
      fc.record({
        kind: fc.constantFrom('user', 'agent', 'system'),
        teamId: fc.constantFrom(...teams),
        mentions: fc.subarray(teams, { maxLength: 2 }),
        reply: fc.option(fc.nat(12), { nil: undefined }),
        minutes: fc.integer({ min: 0, max: 20 })
      }),
      { maxLength: 12 }
    );
    fc.assert(
      fc.property(arbitrary, fc.boolean(), (rows, mentioned) => {
        const built: ContinuationMessage[] = [];
        rows
          .sort((a, b) => b.minutes - a.minutes)
          .forEach((r, i) => {
            const replyTo = r.reply === undefined ? undefined : built[r.reply % Math.max(1, i)]?.id;
            built.push({
              id: `p${i}`,
              kind: r.kind,
              author: { teamId: r.kind === 'system' ? null : r.teamId },
              mentionedTeamIds: r.mentions,
              ...(replyTo === undefined ? {} : { replyToId: replyTo }),
              createdAt: minutesAgo(r.minutes)
            });
          });
        const found = continuationAddressee(input(built, mentioned ? { mentioned: [AGENT] } : {}));
        if (found === null) return;
        expect(mentioned).toBe(false);
        const newestFirst = [...built].reverse();
        const byId = new Map(newestFirst.map((m) => [m.id, m]));
        const opener = newestFirst.find(
          (m) => m.kind !== 'system' && m.author.teamId !== PERSON && aimedAt(m, byId).includes(PERSON)
        );
        expect(opener).toMatchObject({ kind: 'agent', author: { teamId: found } });
      })
    );
  });
});

describe('aimedAt', () => {
  it('reads mentions, the inferred addressee, and the replied-to author, never the author', () => {
    const asked = msg('user', PERSON, 2);
    const reply = msg('agent', AGENT, 1, {
      replyToId: asked.id,
      mentionedTeamIds: [AGENT, OTHER_PERSON],
      addressedTeamIds: [OTHER_AGENT]
    });
    expect(aimedAt(reply, new Map([[asked.id, asked]]))).toEqual([OTHER_PERSON, OTHER_AGENT, PERSON]);
    expect(aimedAt(msg('user', PERSON, 1, { replyToId: null }), new Map())).toEqual([]);
  });
});

describe('answeredBefore', () => {
  it('counts only a reply to the message or one naming it (#215)', () => {
    const first = msg('user', PERSON, 5);
    const second = msg('user', PERSON, 4);
    const third = msg('user', PERSON, 3);
    const reply = msg('agent', AGENT, 1, { replyToId: third.id, answersMessageIds: [first.id] });
    const newestFirst = [reply, third, second, first];
    // The reply covers what it replies to and what it names; the message it left out stays open.
    expect([1, 2, 3].map((i) => answeredBefore(newestFirst, i, AGENT))).toEqual([true, false, true]);
    // Another agent's reply answers nothing for this one; a reply to someone else covers nothing.
    expect(answeredBefore(newestFirst, 1, OTHER_AGENT)).toBe(false);
    const theirs = msg('user', OTHER_PERSON, 2);
    const elsewhere = [msg('agent', AGENT, 1, { replyToId: theirs.id }), theirs, second];
    expect(answeredBefore(elsewhere, 2, AGENT)).toBe(false);
    // A newer message from the same person, answered, does not cover the earlier one.
    expect(answeredBefore([msg('agent', AGENT, 1, { replyToId: third.id }), third, second], 2, AGENT)).toBe(
      false
    );
    // An unrelated line of the agent's, in a DM or anywhere, answers nothing.
    expect(answeredBefore([msg('agent', AGENT, 1), first], 1, AGENT)).toBe(false);
    expect(answeredBefore([msg('agent', AGENT, 1, { replyToId: null }), first], 1, AGENT)).toBe(false);
    expect(answeredBefore([], 0, AGENT)).toBe(false);
  });
});

describe('asksSomething', () => {
  it('reads a question mark, or a sentence opening like a question or a request', () => {
    for (const text of [
      'You up?',
      'what do you want for Kelce',
      'Nice win. Would you move your RB2',
      'lmk if you are in',
      'Let me know what you think',
      'thoughts on my offer',
      'Tell me your price'
    ])
      expect(asksSomething(text), text).toBe(true);
    for (const text of ['gg', 'My RB went down', 'Kelce is washed. Lol.', 'Whatever, I am winning this week'])
      expect(asksSomething(text), text).toBe(false);
  });
});
