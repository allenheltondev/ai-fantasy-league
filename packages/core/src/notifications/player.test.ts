import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  designationChange,
  designationOf,
  playerNewsDraft,
  playerStatusDraft,
  type PlayerStatusNoticeInput
} from './player.js';

const cmc = { id: '4034', name: 'Christian McCaffrey', team: 'SF', position: 'RB' };
const injury = (from: string | null, to: string | null) => [{ field: 'injuryStatus', from, to }];
const notice = (over: Partial<PlayerStatusNoticeInput>) =>
  playerStatusDraft({
    teamId: 't1',
    player: cmc,
    changes: injury('Questionable', 'Out'),
    starter: true,
    game: { started: false, today: true },
    ...over
  });

describe('playerStatusDraft', () => {
  it('makes a starter ruled out before his game urgent, one tap from the lineup', () => {
    expect(notice({})).toEqual({
      teamId: 't1',
      key: '',
      kind: 'player_status',
      urgent: true,
      title: 'Starter out: Christian McCaffrey',
      body: "Your starter Christian McCaffrey (RB, SF) is OUT for today's game. Set your lineup.",
      target: { section: 'lineup', tradeId: null, playerId: '4034' }
    });
    expect(
      notice({ changes: injury(null, 'Doubtful'), game: { started: false, today: false } })
    ).toMatchObject({
      urgent: true,
      body: "Your starter Christian McCaffrey (RB, SF) is doubtful for this week's game. Set your lineup."
    });
    expect(notice({ changes: injury('Out', 'IR') })?.title).toBe('Starter on IR: Christian McCaffrey');
  });

  it('keeps bench players, questionable tags, started games, and byes normal', () => {
    expect(notice({ starter: false })).toMatchObject({
      title: 'Christian McCaffrey is out',
      body: "Christian McCaffrey (RB, SF) is OUT for today's game. He is on your bench."
    });
    expect(notice({ changes: injury(null, 'Questionable') })).toMatchObject({
      title: 'Christian McCaffrey is questionable',
      body: "Christian McCaffrey (RB, SF) is questionable for today's game. He is in your lineup."
    });
    expect(notice({ game: { started: true, today: true } })).toMatchObject({
      body: 'Christian McCaffrey (RB, SF) is OUT. He is in your lineup.'
    });
    expect(notice({ game: null })?.urgent).toBeUndefined();
    expect(notice({ player: { ...cmc, team: null }, starter: false, game: null })?.body).toBe(
      'Christian McCaffrey (RB, FA) is OUT. He is on your bench.'
    );
  });

  it('says when a player comes off the report', () => {
    expect(notice({ changes: injury('Out', null) })).toMatchObject({
      title: 'Christian McCaffrey is off the injury report',
      body: 'Christian McCaffrey (RB, SF) is active and in your lineup.'
    });
    expect(notice({ changes: injury('Questionable', null), starter: false })?.body).toBe(
      'Christian McCaffrey (RB, SF) is active.'
    );
  });

  it('says nothing for depth-chart or team moves, repeats, or statuses it does not know', () => {
    expect(notice({ changes: [{ field: 'depthChartOrder', from: 1, to: 2 }] })).toBeNull();
    expect(notice({ changes: [{ field: 'team', from: 'SF', to: 'LV' }] })).toBeNull();
    expect(notice({ changes: injury('Out', 'Out') })).toBeNull();
    expect(notice({ changes: injury('NA', 'Other') })).toBeNull();
  });

  it('reads a move onto or off injured reserve from the roster status', () => {
    expect(designationChange([{ field: 'status', from: 'Active', to: 'Injured Reserve' }])).toEqual({
      from: null,
      to: 'ir'
    });
    expect(
      designationChange([
        { field: 'status', from: 'Injured Reserve', to: 'Active' },
        { field: 'injuryStatus', from: 'IR', to: null }
      ])
    ).toEqual({ from: 'ir', to: null });
    expect(designationOf(7)).toBeNull();
    expect(designationOf(' PUP ')).toBe('pup');
  });

  it('is urgent exactly for a starter sidelined before his game, and quiet on a repeat', () => {
    const status = fc.constantFrom(null, 'Questionable', 'Doubtful', 'Out', 'IR', 'PUP', 'Suspended', 'NA');
    fc.assert(
      fc.property(
        status,
        status,
        fc.boolean(),
        fc.option(fc.record({ started: fc.boolean(), today: fc.boolean() })),
        (from, to, starter, game) => {
          const draft = notice({ changes: injury(from, to), starter, game });
          const before = designationOf(from);
          const after = designationOf(to);
          if (before === after) return draft === null;
          const sidelined = after !== null && after !== 'questionable';
          const urgent = starter && game !== null && !game.started && sidelined;
          return draft !== null && (draft.urgent === true) === urgent && draft.target.playerId === '4034';
        }
      )
    );
  });
});

describe('playerNewsDraft', () => {
  it('quotes the headline and the source, clipped', () => {
    expect(
      playerNewsDraft({ teamId: 't1', player: cmc, title: ' CMC limited in practice ', source: 'ESPN' })
    ).toEqual({
      teamId: 't1',
      key: '',
      kind: 'player_news',
      title: 'News: Christian McCaffrey',
      body: 'CMC limited in practice (ESPN)',
      target: { section: 'lineup', tradeId: null, playerId: '4034' }
    });
    const long = playerNewsDraft({ teamId: 't1', player: cmc, title: 'x'.repeat(200), source: 'PFT' });
    expect(long.body).toBe(`${'x'.repeat(159)}… (PFT)`);
  });
});
