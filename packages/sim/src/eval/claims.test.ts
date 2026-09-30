import type { ChatMessage } from '@fantasy/server';
import { describe, expect, it } from 'vitest';
import { checkClaims, tallyClaims, type ClaimLedger, type ClaimVerdict } from './claims.js';

/**
 * Adversarial fixtures for the claim checks (#247): each says something plausible that is wrong in
 * one specific way, next to a supported paraphrase of the same fact. The checks must tell them
 * apart, and a transcript with no claims of a kind must report n = 0.
 */

const AGENT = 'team-2';
const PERSON = 'team-1';
const OTHER = 'team-3';
const DM = 'dm-team-1-team-2';
const at = (h: number) => new Date(Date.parse('2026-10-06T13:00:00.000Z') + h * 3_600_000).toISOString();

let n = 0;
const msg = (text: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m${++n}`,
  leagueId: 'lg',
  roomId: 'trash-talk',
  kind: 'agent',
  author: { teamId: AGENT, teamName: 'Hype Squad', name: 'Hype' },
  text,
  mentionedTeamIds: [],
  event: null,
  createdAt: at(10),
  ...over
});
const person = (text: string, over: Partial<ChatMessage> = {}) =>
  msg(text, { kind: 'user', author: { teamId: PERSON, teamName: 'Big Tuna', name: 'Allen' }, ...over });

const ledger = (messages: ChatMessage[], over: Partial<ClaimLedger> = {}): ClaimLedger => ({
  teamNames: { [PERSON]: 'Big Tuna', [AGENT]: 'Hype Squad', [OTHER]: 'Zen Garden', 'team-4': 'Fourth' },
  results: [
    { teamId: AGENT, opponentTeamId: OTHER, week: 2, pointsFor: 110, pointsAgainst: 95 },
    { teamId: OTHER, opponentTeamId: AGENT, week: 2, pointsFor: 95, pointsAgainst: 110 },
    { teamId: PERSON, opponentTeamId: 'team-4', week: 3, pointsFor: 131.5, pointsAgainst: 88 },
    { teamId: 'team-4', opponentTeamId: PERSON, week: 3, pointsFor: 88, pointsAgainst: 131.5 }
  ],
  trades: [
    {
      tradeId: 't-done',
      teams: [AGENT, PERSON],
      history: [
        { status: 'proposed', at: at(1) },
        { status: 'accepted', at: at(2) },
        { status: 'processed', at: at(5) }
      ],
      sent: { [AGENT]: ['Wr4 Agent'], [PERSON]: ['Rb3 Person'] }
    },
    {
      tradeId: 't-gone',
      teams: [PERSON, OTHER],
      history: [
        { status: 'proposed', at: at(1) },
        { status: 'withdrawn', at: at(2) }
      ]
    }
  ],
  messages,
  drafted: { [AGENT]: ['Qb1 Agent', 'Rb1 Agent'] },
  changes: [{ teamId: AGENT, counterpartTeamId: PERSON, at: at(4) }],
  ...over
});

const judge = (m: ChatMessage, others: ChatMessage[] = [], over: Partial<ClaimLedger> = {}): ClaimVerdict[] =>
  checkClaims(ledger([...others, m], over)).filter((v) => v.messageId === m.id && v.kind !== 'privacy');

describe('score claims', () => {
  it('supports the right score for the teams named, in the right week, either way round', () => {
    expect(judge(msg('Week 2: I beat Zen Garden 110-95.'))).toMatchObject([{ kind: 'score', ok: true }]);
    expect(judge(msg('Zen Garden fell 95-110 to me.'))).toMatchObject([{ ok: true }]);
    // A paraphrase naming the other game's teams by name is fine too.
    expect(judge(msg('Big Tuna hung 131.5-88 on Fourth in week 3.'))).toMatchObject([{ ok: true }]);
  });

  it('catches the right score pinned on the wrong teams, the wrong week, and an invented one', () => {
    expect(judge(msg('Big Tuna beat Zen Garden 110-95.'))).toMatchObject([
      { ok: false, problem: 'wrong_team' }
    ]);
    // Said with no team named: it must be the speaker's own game.
    expect(judge(msg('What a game, 131.5-88.'))).toMatchObject([{ ok: false, problem: 'wrong_team' }]);
    expect(judge(msg('Week 3: I beat Zen Garden 110-95.'))).toMatchObject([
      { ok: false, problem: 'wrong_week' }
    ]);
    expect(judge(msg('I beat Zen Garden 150-90.'))).toMatchObject([{ ok: false, problem: 'invented' }]);
  });
});

describe('trade status claims', () => {
  it('supports a processed trade called done, and an offer the speaker really sent', () => {
    expect(judge(msg('The trade went through, enjoy the depth.', { roomId: DM }))).toMatchObject([
      { kind: 'trade_status', ok: true }
    ]);
    expect(judge(msg('Offer is on its way.', { roomId: DM, createdAt: at(1) }))).toMatchObject([
      { ok: true }
    ]);
  });

  it('catches an offer called done before it was, and a withdrawn one called done', () => {
    expect(judge(msg('Done deal, pleasure.', { roomId: DM, createdAt: at(3) }))).toMatchObject([
      { ok: false, problem: 'unsupported_status' }
    ]);
    // Zen Garden's offer to Big Tuna was withdrawn; the person speaking about it as done is wrong.
    const zen = msg('Our trade went through, Big Tuna.', {
      author: { teamId: OTHER, teamName: 'Zen Garden', name: 'Zen' },
      mentionedTeamIds: [PERSON]
    });
    expect(judge(zen)).toMatchObject([{ ok: false, problem: 'withdrawn_as_completed' }]);
  });
});

describe('quotes, history, privacy, and changes of mind', () => {
  const said = person('you will regret passing on Rb3 Person', { roomId: DM, createdAt: at(3) });

  it('supports a real quote and catches an invented one', () => {
    expect(
      judge(msg('You said "you will regret passing on Rb3 Person". We will see.', { roomId: DM }), [said])
    ).toMatchObject([{ kind: 'quote', ok: true }]);
    expect(
      judge(msg('You said "my team is garbage this year". Agreed.', { roomId: DM }), [said])
    ).toMatchObject([{ kind: 'quote', ok: false, problem: 'invented_quote' }]);
  });

  it('checks player history against the draft and processed trades', () => {
    expect(judge(msg('I drafted Qb1 Agent and never looked back.'))).toMatchObject([{ ok: true }]);
    expect(judge(msg('I drafted Rb3 Person in round 2.'))).toMatchObject([
      { kind: 'player_history', ok: false, problem: 'fabricated_history' }
    ]);
    expect(judge(msg('You traded me Rb3 Person and he is balling.', { roomId: DM }))).toMatchObject([
      { ok: true }
    ]);
    expect(judge(msg('You traded me Rb2 Person, thanks.', { roomId: DM }))).toMatchObject([
      { ok: false, problem: 'fabricated_history' }
    ]);
    // Without records, a claim is listed as unverifiable, not judged.
    expect(judge(msg('I drafted Rb3 Person.'), [], { drafted: undefined })).toMatchObject([
      { problem: 'unverifiable' }
    ]);
  });

  it('catches DM words repeated in a public room, and keeps them fine in the DM', () => {
    const leak = msg('Allen told me you will regret passing on Rb3 Person, lol.', { createdAt: at(4) });
    expect(checkClaims(ledger([said, leak])).find((v) => v.messageId === leak.id)).toMatchObject({
      kind: 'privacy',
      ok: false,
      problem: 'private_leak'
    });
    const inDm = msg('Noted: you will regret passing on Rb3 Person.', { roomId: DM, createdAt: at(4) });
    expect(checkClaims(ledger([said, inDm])).filter((v) => v.kind === 'privacy')).toEqual([]);
  });

  it('supports a recorded change of mind and catches an unjustified one', () => {
    expect(judge(msg('Fine, you convinced me.', { roomId: DM, createdAt: at(5) }))).toMatchObject([
      { kind: 'changed_mind', ok: true }
    ]);
    expect(judge(msg('On second thought, fine.', { roomId: DM, createdAt: at(3) }))).toMatchObject([
      { ok: false, problem: 'unjustified_change' }
    ]);
    expect(judge(msg('You convinced me.', { roomId: DM }), [], { changes: undefined })).toMatchObject([
      { problem: 'unverifiable' }
    ]);
  });
});

describe('tallies', () => {
  it('reports n = 0 for kinds never claimed, and keeps unverifiable claims apart', () => {
    const quiet = tallyClaims(checkClaims(ledger([msg('gg'), person('Week 2 was 110-95')])));
    expect(quiet.score).toEqual({ n: 0, supported: 0, unverifiable: 0, problems: {} });
    expect(quiet.trade_status.n).toBe(0);
    expect(quiet.privacy.n).toBe(1);
    const mixed = tallyClaims(
      checkClaims(
        ledger(
          [
            msg('Week 2: I beat Zen Garden 110-95.'),
            msg('I beat Zen Garden 150-90.'),
            msg('I drafted Rb3 Person.')
          ],
          { drafted: undefined }
        )
      )
    );
    expect(mixed.score).toEqual({ n: 2, supported: 1, unverifiable: 0, problems: { invented: 1 } });
    expect(mixed.player_history).toMatchObject({ n: 0, unverifiable: 1 });
  });
});
