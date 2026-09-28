import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  SYSTEM_MESSAGE_TEMPLATES,
  eventPlayers,
  fillTemplate,
  renderSystemMessage,
  type RenderOptions
} from './system-messages.js';

const NAMES: Record<string, string> = { 'team-1': 'Allen FC', 'team-2': 'Robo Ballers', 'team-3': 'Tuna' };
const options: RenderOptions = { teamName: (id) => NAMES[id] ?? null };
const render = (type: string, detail: Record<string, unknown>) => renderSystemMessage(type, detail, options);

describe('eventPlayers', () => {
  it('finds player refs two levels deep, deduplicated and capped', () => {
    const p = (id: string, team: unknown = 'SF') => ({ id, name: id.toUpperCase(), team, position: 'WR' });
    expect(
      eventPlayers({
        player: p('a'),
        awarded: [{ player: p('b', null), dropPlayer: p('a') }, { player: null }],
        deep: { x: { y: { z: p('too-deep') } } },
        partial: { id: 'x', name: 'X' },
        n: 3
      })
    ).toEqual([p('a'), { id: 'b', name: 'B', team: null, position: 'WR' }]);
    const many = Array.from({ length: 20 }, (_, i) => p(`p${i}`));
    expect(eventPlayers({ many })).toHaveLength(12);
  });
});

describe('renderSystemMessage', () => {
  it('renders draft picks with the most specific alternative that resolves', () => {
    expect(
      render('Draft Pick Made', {
        teamId: 'team-2',
        player: { id: 'p1', name: 'Bijan Robinson', team: 'ATL', position: 'RB' },
        round: 1,
        pick: 3
      })
    ).toEqual({
      text: 'Robo Ballers drafted Bijan Robinson (round 1, pick 3).',
      moment: false,
      subjectTeamId: null,
      players: [{ id: 'p1', name: 'Bijan Robinson', team: 'ATL', position: 'RB' }]
    });
    expect(render('Draft Pick Made', { teamId: 'team-2', player: 'Bijan Robinson' })?.text).toBe(
      'Robo Ballers drafted Bijan Robinson.'
    );
    expect(render('Draft Pick Made', { teamId: 'team-2', playerName: 'Bijan Robinson' })).toBeNull();
    expect(render('Draft Pick Made', { teamId: 'team-9', player: 'X' })).toBeNull();
  });

  it('renders waiver awards, preferring the FAAB paid, and says nothing when nothing was awarded', () => {
    expect(
      render('Waivers Processed', {
        week: 5,
        awarded: [
          { teamId: 'team-1', player: { name: 'Puka Nacua' }, bid: 31 },
          { teamId: 'team-3', player: 'Jaylen Warren' },
          { teamId: 'team-2', player: 'Tank Bigsby', bid: 12, cost: 9 }
        ]
      })
    ).toEqual({
      text: 'Waivers processed for week 5: Allen FC added Puka Nacua ($31), Tuna added Jaylen Warren, Robo Ballers added Tank Bigsby ($9).',
      moment: true,
      subjectTeamId: null,
      players: []
    });
    expect(render('Waivers Processed', { awarded: [{ teamId: 'team-1', player: 'A' }] })?.text).toBe(
      'Waivers processed: Allen FC added A.'
    );
    expect(render('Waivers Processed', { week: 6, awarded: [] })).toBeNull();
    expect(render('Waivers Processed', { week: 6, awarded: [null] })).toBeNull();
    expect(render('Waivers Processed', { week: 6, awarded: [{ teamId: 'team-1' }] })).toBeNull();
  });

  it('renders trades, with a subject team for moments', () => {
    expect(
      render('Trade Processed', {
        fromTeamId: 'team-1',
        toTeamId: 'team-2',
        fromPlayers: [{ name: 'A' }, 'B'],
        toPlayers: [{ name: 'C' }]
      })
    ).toEqual({
      text: 'Trade complete: Allen FC sends A, B to Robo Ballers for C.',
      moment: true,
      subjectTeamId: 'team-1',
      players: []
    });
    expect(
      render('Trade Processed', { fromTeamId: 'team-1', toTeamId: 'team-2', fromPlayers: [] })?.text
    ).toBe('Trade complete between Allen FC and Robo Ballers.');
    expect(render('Trade Accepted', { fromTeamId: 'team-1', toTeamId: 'team-2' })?.text).toBe(
      'Robo Ballers accepted a trade with Allen FC. It is under review.'
    );
    expect(render('Trade Vetoed', {})).toEqual({
      text: 'A trade was vetoed.',
      moment: true,
      subjectTeamId: null,
      players: []
    });
  });

  it('renders week results and stat corrections', () => {
    expect(render('Week Provisionally Final', { week: 5, topTeamId: 'team-3', topScore: 141.256 })).toEqual({
      text: 'Week 5 is in the books (provisional). Top score: Tuna with 141.26.',
      moment: true,
      subjectTeamId: 'team-3',
      players: []
    });
    expect(
      render('Week Provisionally Final', {
        week: 5,
        topTeamId: 'team-3',
        topScore: 141.2,
        blowout: { winnerTeamId: 'team-3', loserTeamId: 'team-1', margin: 60.5 }
      })?.text
    ).toBe(
      'Week 5 is in the books (provisional). Top score: Tuna with 141.2. Biggest blowout: Tuna beat Allen FC by 60.5.'
    );
    expect(render('Week Official Final', { week: 5 })?.text).toBe(
      'Week 5 is official; stat corrections are in.'
    );
    expect(render('Week Official Final', { week: 5, recap: 'Tuna won big.' })?.text).toBe(
      'Week 5 is official. Recap: Tuna won big.'
    );
    expect(
      render('Stat Correction Applied', { week: 4, teamId: 'team-1', oldScore: 100, newScore: 102.5 })?.text
    ).toBe('Stat correction in week 4: Allen FC goes from 100 to 102.5.');
    expect(render('Stat Correction Applied', { week: 4, teamId: 'team-1', oldScore: 'x' })?.text).toBe(
      'A stat correction changed week 4 scores.'
    );
  });

  it('renders membership and settings changes', () => {
    expect(render('Member Joined', { teamId: 'team-2', name: 'Bob' })?.text).toBe(
      'Bob joined the league and took over Robo Ballers.'
    );
    expect(render('Member Joined', { teamId: 'team-2' })?.text).toBe('Robo Ballers has a new manager.');
    expect(render('Member Left', { teamId: 'team-2', reason: 'removed' })?.text).toBe(
      'Robo Ballers was removed from the league by the commissioner.'
    );
    expect(render('Member Left', { teamId: 'team-2', reason: 'left' })?.text).toBe(
      'Robo Ballers left the league.'
    );
    expect(
      render('Settings Changed', { changedPaths: ['trades.reviewPeriodDays', 'waivers.type'] })?.text
    ).toBe('The commissioner changed league settings: trades.reviewPeriodDays, waivers.type.');
    expect(render('Settings Changed', {})?.text).toBe('The commissioner changed league settings.');
    expect(
      render('Agent Seat Changed', {
        teamId: 'team-3',
        changes: [
          { field: 'difficulty', from: 'All-Pro', to: 'Rookie' },
          { field: 'archetype', from: 'Win Now', to: 'Balanced' },
          { field: 'mystery', from: 'A', to: 'B' }
        ]
      })?.text
    ).toMatch(
      /'s AI difficulty from All-Pro to Rookie, AI strategy from Win Now to Balanced, mystery from A to B\.$/
    );
    expect(
      render('Agent Seat Changed', {
        teamId: 'team-3',
        changes: [{ field: 'difficulty', from: 'Pro' }, null]
      })?.text
    ).toMatch(/^The commissioner changed .+'s AI manager\.$/);
    expect(render('Draft Completed', {})?.moment).toBe(true);
  });

  it('ignores event types without a template', () => {
    expect(render('Trade Proposed', { fromTeamId: 'team-1' })).toBeNull();
  });

  it('accepts custom templates and unknown formats resolve to nothing', () => {
    const templates = { Custom: { text: ['{bogus:x}', '{teams:ids} and {a.b}'] } };
    expect(
      renderSystemMessage('Custom', { ids: ['team-1', 'team-2'], a: { b: 7 } }, { ...options, templates })
    ).toEqual({
      text: 'Allen FC, Robo Ballers and 7',
      moment: false,
      subjectTeamId: null,
      players: []
    });
    expect(fillTemplate('{a.b.c}', { a: { b: [1] } }, options)).toBeNull();
    expect(fillTemplate('{a}', { a: '   ' }, options)).toBeNull();
    expect(fillTemplate('{list:a}', { a: 'not a list' }, options)).toBeNull();
    expect(fillTemplate('{player:a}', { a: 5 }, options)).toBeNull();
  });

  it('never throws, whatever the detail', () => {
    const value = fc.anything();
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(SYSTEM_MESSAGE_TEMPLATES)),
        fc.dictionary(
          fc.constantFrom('teamId', 'fromTeamId', 'toTeamId', 'week', 'player', 'awarded', 'reason', 'name'),
          value
        ),
        (type, detail) => {
          const message = render(type, detail);
          if (message !== null) expect(message.text.length).toBeGreaterThan(0);
        }
      )
    );
  });
});
