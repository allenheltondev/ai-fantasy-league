import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { ToastProvider } from '@readysetcloud/ui';
import { describe, expect, it, vi } from 'vitest';
import { LeagueApiContext } from '../api/league';
import { fakeApi } from '../test/fakeApi';
import { CHAT_EVENT, parseTopicItem, type EventConnect, type LeagueEvent } from './leagueEvents';
import { LeagueNotifications } from './LeagueNotifications';
import { notificationFor } from './notifications';

const player = (name: string) => ({ id: name.toLowerCase(), name, team: 'KC', position: 'WR' });

function tradeDetail(overrides: Record<string, unknown> = {}) {
  return {
    leagueId: 'L1',
    tradeId: 'tr1',
    fromTeamId: 'team-2',
    toTeamId: 'team-1',
    fromPlayers: [player('Rashee Rice')],
    toPlayers: [player('Tony Pollard'), player('Jake Ferguson')],
    review: 'none',
    ...overrides
  };
}

const ev = (detailType: string, detail: Record<string, unknown>, eventId?: string): LeagueEvent => ({
  detailType,
  leagueId: 'L1',
  ...(eventId === undefined ? {} : { eventId }),
  detail
});

function chat(mentionedTeamIds: string[], authorTeamId: string | null = 'team-2') {
  return {
    message: {
      id: 'm1',
      leagueId: 'L1',
      kind: 'agent',
      author: { teamId: authorTeamId, teamName: 'Bots', name: 'The Spreadsheet' },
      text: `@Alice ${'that trade is robbery '.repeat(5)}`,
      mentionedTeamIds,
      event: null,
      createdAt: '2026-09-30T12:00:00Z'
    }
  };
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

describe('notificationFor', () => {
  it('announces your waiver awards, with the FAAB paid', () => {
    const detail = {
      awarded: [
        { teamId: 'team-1', player: player('Puka Nacua'), cost: 12 },
        { teamId: 'team-3', player: player('Someone Else'), cost: 3 }
      ]
    };
    expect(notificationFor(ev('Waivers Processed', detail), 'team-1')).toEqual({
      message: 'Waiver claim won: Puka Nacua ($12).',
      variant: 'success'
    });
    const two = {
      awarded: [
        { teamId: 'team-1', player: player('Puka Nacua'), cost: 0 },
        { teamId: 'team-1', player: null, cost: 0 }
      ]
    };
    expect(notificationFor(ev('Waivers Processed', two), 'team-1')?.message).toBe(
      'You won 2 waiver claims: Puka Nacua, a player.'
    );
    expect(notificationFor(ev('Waivers Processed', detail), 'team-9')).toBeNull();
    expect(notificationFor(ev('Waivers Processed', {}), 'team-1')).toBeNull();
  });

  it('tells you about offers and counters sent to you', () => {
    expect(notificationFor(ev('Trade Proposed', tradeDetail()), 'team-1')).toEqual({
      message: "New trade offer: you'd get Rashee Rice for Tony Pollard, Jake Ferguson.",
      variant: 'info'
    });
    expect(notificationFor(ev('Trade Countered', tradeDetail()), 'team-1')?.message).toMatch(/^Counteroffer/);
    // The team that sent it already knows.
    expect(notificationFor(ev('Trade Proposed', tradeDetail()), 'team-2')).toBeNull();
    expect(notificationFor(ev('Trade Countered', tradeDetail()), 'team-2')).toBeNull();
  });

  it('celebrates your accepted and completed trades', () => {
    expect(notificationFor(ev('Trade Accepted', tradeDetail()), 'team-2')).toEqual({
      message: 'Trade accepted! You get Tony Pollard, Jake Ferguson for Rashee Rice.',
      variant: 'success'
    });
    expect(notificationFor(ev('Trade Accepted', tradeDetail()), 'team-1')).toBeNull();
    expect(notificationFor(ev('Trade Accepted', tradeDetail()), 'team-5')).toBeNull();
    expect(notificationFor(ev('Trade Accepted', tradeDetail({ review: 'league_vote' })), 'team-5')).toEqual({
      message: 'A trade was accepted and is up for league review.',
      variant: 'info'
    });
    expect(notificationFor(ev('Trade Processed', tradeDetail()), 'team-1')?.message).toBe(
      'Trade complete: Rashee Rice joined your roster.'
    );
    expect(notificationFor(ev('Trade Processed', tradeDetail()), 'team-5')).toBeNull();
    expect(
      notificationFor(ev('Trade Processed', tradeDetail({ fromPlayers: 'bad' })), 'team-1')?.message
    ).toBe('Trade complete: nothing joined your roster.');
    expect(
      notificationFor(
        ev('Trade Processed', tradeDetail({ fromPlayers: [{ name: 7 }, player('Kyle Pitts')] })),
        'team-1'
      )?.message
    ).toBe('Trade complete: Kyle Pitts joined your roster.');
  });

  it('warns about vetoes', () => {
    expect(notificationFor(ev('Trade Vetoed', tradeDetail()), 'team-1')).toEqual({
      message: 'Your trade was vetoed.',
      variant: 'warning'
    });
    expect(notificationFor(ev('Trade Vetoed', tradeDetail({ voided: true })), 'team-2')?.message).toMatch(
      /no longer works/
    );
    expect(notificationFor(ev('Trade Vetoed', tradeDetail()), 'team-5')).toEqual({
      message: 'A trade was vetoed.',
      variant: 'info'
    });
  });

  it('shows chat mentions of your team, not your own', () => {
    const note = notificationFor(ev(CHAT_EVENT, chat(['team-1'])), 'team-1');
    expect(note?.message).toMatch(/^The Spreadsheet mentioned you: “@Alice that trade/);
    expect(note?.message.endsWith('…”')).toBe(true);
    expect(notificationFor(ev(CHAT_EVENT, chat(['team-3'])), 'team-1')).toBeNull();
    expect(notificationFor(ev(CHAT_EVENT, chat(['team-1'], 'team-1')), 'team-1')).toBeNull();
    expect(notificationFor(ev(CHAT_EVENT, {}), 'team-1')).toBeNull();
    const short = chat(['team-1']);
    const anonymous = { message: { ...short.message, text: 'hi @Alice', author: undefined } };
    expect(notificationFor(ev(CHAT_EVENT, anonymous), 'team-1')?.message).toBe(
      'Someone mentioned you: “hi @Alice”'
    );
    // Toasts carry the room: the message's, or trash talk for messages from before rooms.
    expect(note?.roomId).toBe('trash-talk');
    const inTrades = { message: { ...short.message, roomId: 'trades' } };
    expect(notificationFor(ev(CHAT_EVENT, inTrades), 'team-1')?.roomId).toBe('trades');
  });

  it('shows every direct message you receive, mention or not', () => {
    const dm = { message: { ...chat([]).message, roomId: 'dm-team-1-team-2', text: 'psst' } };
    expect(notificationFor(ev(CHAT_EVENT, dm), 'team-1')).toEqual({
      message: 'The Spreadsheet sent you a message: “psst”',
      variant: 'info',
      roomId: 'dm-team-1-team-2'
    });
    const mine = { message: { ...dm.message, author: { teamId: 'team-1', teamName: 'A', name: 'Alice' } } };
    expect(notificationFor(ev(CHAT_EVENT, mine), 'team-1')).toBeNull();
  });

  it('says nothing without a team, a detail, or for other events', () => {
    expect(notificationFor(ev('Trade Proposed', tradeDetail()), null)).toBeNull();
    expect(notificationFor({ detailType: 'Trade Proposed', leagueId: 'L1' }, 'team-1')).toBeNull();
    expect(notificationFor(ev('Draft Pick Made', {}), 'team-1')).toBeNull();
  });
});

describe('parseTopicItem', () => {
  it('reads events with their id and detail, and chat messages as a chat event', () => {
    expect(
      parseTopicItem(
        JSON.stringify({
          type: 'event',
          detailType: 'Trade Vetoed',
          leagueId: 'L1',
          eventId: 'e1',
          detail: { a: 1 }
        })
      )
    ).toEqual({ detailType: 'Trade Vetoed', leagueId: 'L1', eventId: 'e1', detail: { a: 1 } });
    const message = chat(['team-1']).message;
    expect(parseTopicItem(JSON.stringify({ type: 'chat', leagueId: 'L1', message }))).toEqual({
      detailType: CHAT_EVENT,
      leagueId: 'L1',
      eventId: 'm1',
      detail: { message }
    });
    expect(
      parseTopicItem(JSON.stringify({ type: 'chat', message: { ...message, leagueId: undefined } }))?.leagueId
    ).toBeNull();
    expect(parseTopicItem(JSON.stringify({ type: 'other' }))).toBeNull();
  });
});

describe('LeagueNotifications', () => {
  const LIVE = {
    enabled: true,
    token: 't',
    endpoint: null,
    cacheName: 'c',
    topics: { league: 'fantasy.league.L1', global: 'fantasy.global', team: 'fantasy.team.L1.team-1' },
    expiresAt: null,
    pollIntervalSeconds: 30
  };

  function mount(path = '/leagues/L1/matchup') {
    let push: ((event: LeagueEvent) => void) | null = null;
    const connect: EventConnect = async (target, handlers) => {
      expect(target.topics).toEqual(['fantasy.league.L1', 'fantasy.team.L1.team-1']);
      push = handlers.onEvent;
      return () => undefined;
    };
    const api = fakeApi({ getRealtime: vi.fn(async () => LIVE) });
    render(
      <ToastProvider>
        <LeagueApiContext.Provider value={api}>
          <MemoryRouter initialEntries={[path]}>
            <LeagueNotifications leagueId="L1" yourTeamId="team-1" connect={connect} />
            <Where />
          </MemoryRouter>
        </LeagueApiContext.Provider>
      </ToastProvider>
    );
    return {
      connected: () => waitFor(() => expect(push).not.toBeNull()),
      push: (event: LeagueEvent) => act(() => push!(event))
    };
  }

  it('toasts waiver awards and trade news as they arrive, once per event', async () => {
    const { push, connected } = mount();
    await connected();
    const award = { awarded: [{ teamId: 'team-1', player: player('Puka Nacua'), cost: 7 }] };
    // The award comes on the league topic and again on your team topic: one toast.
    push(ev('Waivers Processed', award, 'w1'));
    push(ev('Waivers Processed', award, 'w1'));
    push(ev('Trade Proposed', tradeDetail(), 't1'));
    push(ev('Trade Vetoed', tradeDetail(), 't2'));
    push(ev('Trade Accepted', tradeDetail({ fromTeamId: 'team-1', toTeamId: 'team-2' }), 't3'));
    expect(await screen.findAllByText('Waiver claim won: Puka Nacua ($7).')).toHaveLength(1);
    expect(screen.getByText(/New trade offer/)).toBeInTheDocument();
    expect(screen.getByText('Your trade was vetoed.')).toBeInTheDocument();
    expect(screen.getByText(/Trade accepted!/)).toBeInTheDocument();
    // An event without an id is shown too; a chat toast links to its room.
    push(ev(CHAT_EVENT, { message: { ...chat(['team-1']).message, roomId: 'trades' } }));
    expect(await screen.findByText(/mentioned you/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      '/leagues/L1/chat?room=trades'
    );
  });

  it('skips chat mentions while you are reading the chat', async () => {
    const { push, connected } = mount('/leagues/L1/chat');
    await connected();
    push(ev(CHAT_EVENT, chat(['team-1']), 'm1'));
    push(ev('Trade Proposed', tradeDetail(), 't1'));
    expect(await screen.findByText(/New trade offer/)).toBeInTheDocument();
    expect(screen.queryByText(/mentioned you/)).not.toBeInTheDocument();
  });
});
