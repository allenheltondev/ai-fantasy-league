import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  SYSTEM_MESSAGE_TEMPLATES,
  fillTemplate,
  renderSystemMessage,
  type RenderOptions
} from './system-messages.js';

const NAMES: Record<string, string> = { 'team-1': 'Allen FC', 'team-2': 'Robo Ballers', 'team-3': 'Tuna' };
const options: RenderOptions = { teamName: (id) => NAMES[id] ?? null };
const render = (type: string, detail: Record<string, unknown>) => renderSystemMessage(type, detail, options);

describe('renderSystemMessage', () => {
  it('renders draft picks with the most specific alternative that resolves', () => {
    expect(
      render('Draft Pick Made', {
        teamId: 'team-2',
        player: { id: 'p1', name: 'Bijan Robinson' },
        round: 1,
        pick: 3
      })
    ).toEqual({
      text: 'Robo Ballers drafted Bijan Robinson (round 1, pick 3).',
      moment: false,
      subjectTeamId: null
    });
    expect(render('Draft Pick Made', { teamId: 'team-2', player: 'Bijan Robinson' })?.text).toBe(
      'Robo Ballers drafted Bijan Robinson.'
    );
    expect(render('Draft Pick Made', { teamId: 'team-2', playerName: 'Bijan Robinson' })?.text).toBe(
      'Robo Ballers drafted Bijan Robinson.'
    );
    expect(render('Draft Pick Made', { teamId: 'team-9', playerName: 'X' })).toBeNull();
  });

  it('renders waiver awards and the empty case', () => {
    expect(
      render('Waivers Processed', {
        week: 5,
        awarded: [
          { teamId: 'team-1', player: { name: 'Puka Nacua' }, bid: 31 },
          { teamId: 'team-3', player: 'Jaylen Warren' }
        ]
      })
    ).toEqual({
      text: 'Waivers processed for week 5: Allen FC added Puka Nacua ($31), Tuna added Jaylen Warren.',
      moment: true,
      subjectTeamId: null
    });
    expect(render('Waivers Processed', { awarded: [{ teamId: 'team-1', player: 'A' }] })?.text).toBe(
      'Waivers processed: Allen FC added A.'
    );
    expect(render('Waivers Processed', { week: 6, awarded: [] })?.text).toBe(
      'Waivers processed for week 6. No claims were awarded.'
    );
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
      subjectTeamId: 'team-1'
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
      subjectTeamId: null
    });
    const teams = { fromTeamId: 'team-1', toTeamId: 'team-2' };
    const players = { fromPlayers: [{ name: 'A' }], toPlayers: [{ name: 'C' }] };
    expect(render('Trade Accepted', { ...teams, ...players, review: 'none' })?.text).toBe(
      'Robo Ballers accepted a trade with Allen FC: A for C.'
    );
    expect(render('Trade Accepted', { ...teams, review: 'none' })?.text).toBe(
      'Robo Ballers accepted a trade with Allen FC.'
    );
    expect(render('Trade Accepted', { ...teams, ...players, review: 'league_vote' })?.text).toBe(
      'Robo Ballers accepted a trade with Allen FC: A for C. It is under review.'
    );
    expect(render('Trade Vetoed', { ...teams, voided: true, reason: 'A was dropped.' })?.text).toBe(
      'The trade between Allen FC and Robo Ballers was cancelled: A was dropped.'
    );
    expect(render('Trade Vetoed', { ...teams, review: 'commissioner' })?.text).toBe(
      'The commissioner vetoed the trade between Allen FC and Robo Ballers.'
    );
    expect(render('Trade Vetoed', teams)?.text).toBe(
      'The league vetoed the trade between Allen FC and Robo Ballers.'
    );
    expect(render('Trade Deadline Passed', { deadlineWeek: 11 })).toMatchObject({ moment: true });
  });

  it('renders week results and stat corrections', () => {
    expect(render('Week Provisionally Final', { week: 5, topTeamId: 'team-3', topScore: 141.256 })).toEqual({
      text: 'Week 5 is in the books (provisional). Top score: Tuna with 141.26.',
      moment: true,
      subjectTeamId: 'team-3'
    });
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
      subjectTeamId: null
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
