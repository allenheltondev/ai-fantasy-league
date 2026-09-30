import {
  FixedClock,
  emptyMemory,
  emptySocialActs,
  recordSocialAct,
  resolveAgentConfig,
  socialActPack,
  type SocialActBook,
  type SocialCandidate
} from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import type { CheckInLook, Run } from '../src/tasks/check-in.js';
import { NO_SOCIAL, lookSocial } from '../src/tasks/check-in-social.js';
import { chatReplyTask } from '../src/tasks/chat.js';
import type { TaskContext } from '../src/tasks/kinds.js';
import {
  actInstructions,
  fakeActAction,
  lookOpportunities,
  recordAct,
  socialActStep,
  type ChosenAct,
  type ListedRoom
} from '../src/tasks/social-acts.js';
import { AGENT_TEAM, LEAGUE_ID, START } from './support.js';

/**
 * The check-in's grounded social acts (#218) on scripted tool answers and stores: what the look
 * reads and hands on, how a draft is checked and posted, and how failures stay soft.
 */

const ago = (hours: number) => new Date(Date.parse(START) - hours * 3_600_000).toISOString();

interface Script {
  tools?: Record<string, unknown>;
  history?: SocialActBook | 'fails';
  write?: 'fails';
  commitments?: 'none' | 'vacant' | 'fails';
  recall?: boolean;
  shared?: boolean | undefined;
  config?: 'hype-man' | 'zen-master';
}

/** A task context whose tools, stores and claims answer from a script. */
function scripted(script: Script = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const warnings: string[] = [];
  let book = script.history === 'fails' ? emptySocialActs() : (script.history ?? emptySocialActs());
  const ctx = {
    taskId: 'task-1',
    principal: { teamId: AGENT_TEAM },
    config: resolveAgentConfig({
      personalityId: script.config ?? 'hype-man',
      difficulty: 'pro',
      archetype: 'balanced'
    }),
    league: { id: LEAGUE_ID, week: 5 },
    clock: new FixedClock(START),
    log: { info: () => undefined, warn: (m: string) => warnings.push(m) },
    trigger: { eventId: 'evt', detailType: 'Manager Check-In' },
    claimLimit: async () => true,
    socialActs: {
      tenure: async () => 'tenure',
      read: async () => {
        if (script.history === 'fails') throw new Error('down');
        return book;
      },
      update: async (_t: string, change: (b: SocialActBook) => SocialActBook) => {
        if (script.write === 'fails') throw new Error('down');
        book = change(book);
        return book;
      }
    },
    ...(script.commitments === 'none'
      ? {}
      : {
          commitments: {
            tenure: async () => {
              if (script.commitments === 'fails') throw new Error('down');
              return script.commitments === 'vacant' ? null : 'tenure';
            },
            read: async () => ({ schemaVersion: 1, commitments: [] })
          }
        }),
    ...(script.recall === false ? {} : { recall: async () => emptyMemory() }),
    ...(script.shared === undefined ? {} : { claimShared: async () => script.shared }),
    tools: {
      call: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        const answer = script.tools?.[name];
        if (typeof answer === 'function') return (answer as (a: unknown) => unknown)(args);
        if (answer === undefined || typeof answer === 'string')
          return { error: { code: answer ?? 'NOT_FOUND', message: 'no', fix: 'x' } };
        return { data: answer, league: null, warnings: [] };
      }
    }
  } as unknown as TaskContext;
  return { ctx, calls, warnings, book: () => book };
}

const room = (
  roomId: string,
  kind: ListedRoom['kind'],
  lastMessageAt: string | null,
  teamIds: string[] = []
) =>
  ({
    roomId,
    kind,
    title: roomId,
    archived: false,
    week: kind === 'matchup' ? 5 : null,
    teamIds,
    lastMessageAt
  }) as ListedRoom;

const message = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  leagueId: LEAGUE_ID,
  roomId: 'league',
  kind: 'user',
  author: { teamId: 'team-1', teamName: "Allen's Team", name: 'Allen' },
  text: 'Who starts at flex?',
  mentionedTeamIds: [AGENT_TEAM],
  event: null,
  createdAt: ago(2),
  ...over
});

function candidate(over: Partial<SocialCandidate> = {}): SocialCandidate {
  return {
    act: 'callback',
    reason: 'rematch',
    counterpartTeamId: 'team-3',
    subject: 'your week 2 game against Team 3',
    topic: 'callback:team-3:result:w2',
    eventKey: 'callback:w5:team-2|team-3',
    roomId: 'trash-talk',
    audience: 'public',
    evidence: ['result:w2'],
    at: ago(300),
    expiresAt: ago(-12),
    human: false,
    relevance: 0.85,
    salience: 0.2,
    agendaId: null,
    commitmentId: null,
    replyToId: null,
    ...over
  };
}

const chosen = (over: Partial<SocialCandidate> = {}): ChosenAct => {
  const c = candidate(over);
  return {
    candidate: c,
    pack: socialActPack(
      c,
      [{ id: 'result:w2', line: 'Week 2: you beat Team 3 110-95.', at: ago(300), visibility: 'public' }],
      ['You are 3-1, 2nd.']
    )
  };
};

function look(act: ChosenAct | null): CheckInLook {
  return {
    social: { ...NO_SOCIAL, act },
    waivers: {
      pickups: [
        { player: { name: 'Waiver Target' }, drop: { name: 'Bench Guy' } },
        { player: { name: 'Free Agent' }, drop: null }
      ]
    },
    trade: { prep: { candidates: [{ send: { name: 'My Star' }, receive: { name: 'Their Star' } }] } }
  } as unknown as CheckInLook;
}

const newRun = (): Run => ({
  actionsLeft: 3,
  done: [],
  lineupNeeded: false,
  added: false,
  waiverClaims: [],
  trades: [],
  memory: []
});

describe('lookOpportunities', () => {
  it('reads only rooms active in the last day (its own matchup, not others), and hands the oldest question on', async () => {
    const { ctx, calls, book } = scripted({
      tools: {
        get_chat: (args: { roomId: string }) =>
          args.roomId === 'league'
            ? {
                data: { messages: [message('q-new', { createdAt: ago(1) }), message('q-old')] },
                league: null,
                warnings: []
              }
            : { error: { code: 'FORBIDDEN', message: 'no', fix: 'x' } }
      }
    });
    const rooms = [
      room('league', 'fixed', ago(1)),
      room('trash-talk', 'fixed', ago(30)),
      room('trades', 'fixed', null),
      room('m-other', 'matchup', ago(1), ['team-3', 'team-4']),
      room('dm-team-1-team-2', 'dm', ago(2), ['team-1', AGENT_TEAM])
    ];
    const found = await lookOpportunities(ctx, { rooms, postsLeft: 5, seed: 'quiet-roll' });
    expect(calls.filter((c) => c.name === 'get_chat').map((c) => c.args.roomId)).toEqual([
      'league',
      'dm-team-1-team-2'
    ]);
    expect(found.answer?.replyToId).toBe('q-old');
    expect(found.followUps).toEqual([
      { kind: 'chat_reply', payload: { messageId: 'q-old', roomId: 'league', coalesce: true } }
    ]);
    expect(book().acts).toMatchObject([
      { act: 'answer_question', outcome: 'handed_on', topic: 'answer:q-old' }
    ]);
  });

  it('answers without a commitment store, or when it cannot be read', async () => {
    const tools = { get_chat: { messages: [message('q')] } };
    for (const commitments of ['none', 'vacant', 'fails'] as const) {
      const { ctx } = scripted({ tools, commitments });
      const found = await lookOpportunities(ctx, {
        rooms: [room('league', 'fixed', ago(1))],
        postsLeft: null,
        seed: 's'
      });
      expect(found.answer?.commitmentId).toBeNull();
    }
  });

  it('turns ambient acts off without a readable history or memory, and keeps answering', async () => {
    // Every roll passes for this seed search: find one for the loud manager.
    const { ambientTurn } = await import('@fantasy/core');
    const chattiness = resolveAgentConfig({
      personalityId: 'hype-man',
      difficulty: 'pro',
      archetype: 'balanced'
    }).personality.chattiness;
    let seed = '';
    for (let i = 0; seed === ''; i++) if (ambientTurn(chattiness, `turn-${i}`)) seed = `turn-${i}`;
    const broken = scripted({ history: 'fails' });
    expect(await lookOpportunities(broken.ctx, { rooms: [], postsLeft: null, seed })).toMatchObject({
      act: null
    });
    expect(broken.warnings).toContain('social act history unavailable; no ambient acts this time');
    expect(broken.calls.map((c) => c.name)).not.toContain('get_chat_context');
    const forgetful = scripted({ recall: false });
    await lookOpportunities(forgetful.ctx, { rooms: [], postsLeft: null, seed });
    expect(forgetful.calls).toEqual([]);
    // With memory but no league facts (the pack cannot be read), there is nothing to say.
    const blind = scripted({ tools: {} });
    expect(await lookOpportunities(blind.ctx, { rooms: [], postsLeft: null, seed })).toMatchObject({
      act: null,
      answer: null
    });
    expect(blind.calls.map((c) => c.name)).toEqual(['get_chat_context']);
    // No store at all (no seat tenure): nothing ambient either.
    const vacant = scripted();
    (vacant.ctx as { socialActs?: unknown }).socialActs = undefined;
    expect(await lookOpportunities(vacant.ctx, { rooms: [], postsLeft: null, seed })).toMatchObject({
      act: null
    });
  });

  it('chooses an ambient act from its records, reading the room it would post in', async () => {
    const { ambientTurn, rememberEvent } = await import('@fantasy/core');
    const chattiness = resolveAgentConfig({
      personalityId: 'hype-man',
      difficulty: 'pro',
      archetype: 'balanced'
    }).personality.chattiness;
    let seed = '';
    for (let i = 0; seed === ''; i++) if (ambientTurn(chattiness, `turn-${i}`)) seed = `turn-${i}`;
    const memory = rememberEvent(emptyMemory(), {
      type: 'matchup',
      opponentTeamId: 'team-1',
      week: 4,
      pointsFor: 150,
      pointsAgainst: 100,
      at: ago(12)
    });
    const pack = {
      pack: {
        kind: 'league',
        throughWeek: 4,
        standings: [],
        lastWeek: [{ homeTeamId: AGENT_TEAM, homeScore: 150, awayTeamId: 'team-1', awayScore: 100 }],
        powerTop: [],
        headToHead: null
      }
    };
    // The room cannot be read (nothing said there in a day, and the read fails): no last word to hold it.
    const { ctx } = scripted({ tools: { get_chat_context: pack, get_chat: { messages: 'garbled' } } });
    (ctx as { recall: unknown }).recall = async () => memory;
    const found = await lookOpportunities(ctx, { rooms: [], postsLeft: null, seed });
    expect(found.act?.candidate).toMatchObject({ act: 'react_to_result', reason: 'big_win' });
    expect(found.act?.pack.facts).toEqual([
      { id: 'result:w4', line: 'Week 4 final: you beat team-1 150-100.' }
    ]);
  });

  it('lists no rooms when the room list cannot be read', async () => {
    const { ctx } = scripted();
    expect(
      await lookSocial(ctx, undefined, { trade: { shopping: false, offersLeft: 0, prep: null } })
    ).toEqual(NO_SOCIAL);
  });
});

describe('socialActStep', () => {
  it('posts a checked draft once, records it, and does nothing without an act', async () => {
    const { ctx, calls, book } = scripted({
      tools: { get_chat: { messages: [] }, post_message: { message: {} } },
      shared: true
    });
    const run = newRun();
    await socialActStep(ctx, look(null), [], run);
    expect(calls).toEqual([]);
    await socialActStep(
      ctx,
      look(chosen()),
      [{ type: 'social_act', message: 'Week 2: 110-95. Again.', evidence: ['result:w2'] }],
      run
    );
    expect(calls.map((c) => c.name)).toEqual(['get_chat', 'post_message']);
    expect(run.done).toEqual([{ action: 'social_act', line: 'Posted a callback in #trash-talk.' }]);
    expect(book().acts).toMatchObject([{ outcome: 'posted', evidence: ['result:w2'] }]);
  });

  it('passes on an empty draft and rejects one that cites nothing', async () => {
    const { ctx, book } = scripted();
    await socialActStep(ctx, look(chosen()), [{ type: 'social_act' }], newRun());
    expect(book().acts).toMatchObject([{ outcome: 'passed', detail: 'model_passed' }]);
    const bare = scripted();
    await socialActStep(bare.ctx, look(chosen()), [{ type: 'social_act', message: 'Week 2.' }], newRun());
    expect(bare.book().acts).toMatchObject([{ outcome: 'rejected', detail: 'no_evidence' }]);
  });

  it('never names a player from a private pickup or trade idea', async () => {
    for (const name of ['Waiver Target', 'Bench Guy', 'Free Agent', 'My Star', 'Their Star']) {
      const { ctx, book } = scripted();
      const run = newRun();
      await socialActStep(
        ctx,
        look(chosen()),
        [{ type: 'social_act', message: `${name} and week 2.`, evidence: ['result:w2'] }],
        run
      );
      expect(book().acts).toMatchObject([{ outcome: 'rejected', detail: 'private_detail' }]);
    }
  });

  it('holds back on the last word or a flooded event, and records a refused post', async () => {
    const draft = [{ type: 'social_act' as const, message: 'Week 2 again.', evidence: ['result:w2'] }];
    const mine = {
      messages: [message('m', { kind: 'agent', author: { teamId: AGENT_TEAM, teamName: 'Us', name: 'Me' } })]
    };
    const cases: [Script, string, string][] = [
      [{ tools: { get_chat: mine } }, 'withheld', 'last_word'],
      [{ tools: {}, shared: false }, 'withheld', 'room_flooded'],
      [{ tools: { post_message: 'RATE_LIMITED' } }, 'failed', 'RATE_LIMITED']
    ];
    for (const [script, outcome, detail] of cases) {
      const { ctx, book } = scripted(script);
      const run = newRun();
      await socialActStep(ctx, look(chosen()), draft, run);
      expect(book().acts).toMatchObject([{ outcome, detail }]);
      expect(run.done).toHaveLength(1);
    }
  });

  it('keeps going when the history cannot be written', async () => {
    const { ctx, warnings } = scripted({ write: 'fails' });
    await recordAct(ctx, candidate(), 'passed', 'model_passed');
    expect(warnings).toEqual(['social act not recorded']);
    const vacant = scripted();
    (vacant.ctx as { socialActs?: unknown }).socialActs = undefined;
    await recordAct(vacant.ctx, candidate(), 'passed', 'model_passed');
    expect(vacant.book().acts).toEqual([]);
    // A history that already holds entries keeps them.
    const kept = scripted({
      history: recordSocialAct(emptySocialActs(), {
        ...{
          id: 'x',
          taskId: 'x',
          act: 'callback',
          reason: 'rematch',
          topic: 't',
          eventKey: 'e',
          roomId: 'r',
          counterpartTeamId: null,
          evidence: [],
          commitmentId: null,
          at: ago(1),
          outcome: 'posted',
          detail: null
        }
      })
    });
    await recordAct(kept.ctx, candidate(), 'passed', null);
    expect(kept.book().acts).toHaveLength(2);
  });
});

describe('the act in the prompt and in the scripted model', () => {
  it('fences the facts with their ids and adds the context lines', () => {
    const text = actInstructions(chosen());
    expect(text).toContain('[result:w2] Week 2: you beat Team 3 110-95.');
    expect(text).toContain('(context) You are 3-1, 2nd.');
  });

  it('words each act from its first fact', () => {
    for (const [act, lead] of [
      ['callback', 'Not forgetting this one.'],
      ['congratulate', 'Credit where due.'],
      ['acknowledge_mistake', 'I will own that one.'],
      ['react_to_result', 'Noted for the record.']
    ] as const)
      expect(fakeActAction(chosen({ act }))).toEqual({
        type: 'social_act',
        message: `${lead} Week 2: you beat Team 3 110-95.`,
        evidence: ['result:w2']
      });
  });
});

describe('a reply to a league announcement', () => {
  it('talks about the other team it names, and goes on without a readable league list', async () => {
    const { ctx } = scripted({
      tools: {
        list_chat_rooms: { rooms: [room('league', 'fixed', ago(1))], postingBudget: null },
        get_chat: {
          messages: [
            message('sys', {
              kind: 'system',
              author: { teamId: null, teamName: null, name: 'League' },
              text: 'Team 2 and Team 3 meet again?',
              mentionedTeamIds: [AGENT_TEAM, 'team-3']
            })
          ]
        },
        get_league: { teams: 'garbled' }
      }
    });
    const prepared = await chatReplyTask.prepare(ctx, { messageId: 'sys', roomId: 'league' });
    expect(prepared.memoryScope?.teamIds).toContain('team-3');
    expect(prepared.instructions).not.toContain("Who's who");
  });
});
