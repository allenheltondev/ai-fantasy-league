import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ApiFetch } from '../api';
import type { PlayerCardData } from '../draft/research';
import { PlayerCardProvider, PlayerLink, PlayerList } from './PlayerLink';

const CHASE = { id: 'fx-chase', name: "Ja'Marr Chase", team: 'CIN', position: 'WR' };
const LAMB = { id: 'fx-lamb', name: 'CeeDee Lamb', team: 'DAL', position: 'WR' };

function cardFor(overrides: Partial<PlayerCardData> = {}): PlayerCardData {
  return {
    player: CHASE,
    scoring: { source: 'league' },
    bye: 10,
    injuryStatus: null,
    lastSeason: null,
    projection: null,
    thisSeason: {
      season: 2026,
      points: 27,
      ppg: 13.5,
      games: 2,
      weekly: [
        { week: 1, points: 20 },
        { week: 3, points: 7 }
      ],
      totals: { rec: 12, rec_yd: 150, rec_td: 1 }
    },
    nextWeek: {
      season: 2026,
      week: 4,
      points: 11,
      totals: { rec: 6, rec_yd: 80 },
      bye: false,
      opponent: { team: 'BAL', home: true },
      kickoff: '2026-10-04T17:00:00.000Z'
    },
    news: [],
    ...overrides
  };
}

function fakeApi(card: PlayerCardData) {
  const calls: { path: string; query: unknown }[] = [];
  const api = vi.fn(async (path: string, request: { query?: unknown } = {}) => {
    calls.push({ path, query: request.query });
    return { data: card, league: null, warnings: [] };
  }) as unknown as ApiFetch;
  return { api, calls };
}

describe('PlayerLink', () => {
  it('opens the player card: this season so far and the next game', async () => {
    const user = userEvent.setup();
    const { api, calls } = fakeApi(cardFor());
    render(
      <PlayerCardProvider leagueId="L1" api={api}>
        <p>
          Start <PlayerLink player={CHASE} /> today
        </p>
      </PlayerCardProvider>
    );
    await user.click(screen.getByRole('button', { name: "Ja'Marr Chase" }));
    const card = await screen.findByTestId('player-card');
    expect(calls).toEqual([{ path: '/players/card', query: { playerId: 'fx-chase', leagueId: 'L1' } }]);
    const season = within(await screen.findByTestId('card-this-season'));
    expect(season.getByText('This season (2026)')).toBeInTheDocument();
    expect(season.getByLabelText('This season totals')).toHaveTextContent('150');
    expect(
      season.getByRole('img', { name: /Weekly points this season: week 1 20, week 3 7/ })
    ).toBeInTheDocument();
    const next = within(screen.getByTestId('card-next-week'));
    expect(next.getByText('Week 4')).toBeInTheDocument();
    expect(next.getByText(/^vs BAL, /)).toBeInTheDocument();
    expect(next.getByText('11')).toBeInTheDocument();
    // Outside the draft room there is nothing to queue or draft.
    expect(within(card).queryByRole('button', { name: 'Queue' })).toBeNull();
  });

  it('shows a bye, or a week without a projection yet', async () => {
    const user = userEvent.setup();
    const bye = fakeApi(
      cardFor({
        thisSeason: null,
        nextWeek: {
          season: 2026,
          week: 4,
          points: null,
          totals: {},
          bye: true,
          opponent: null,
          kickoff: null
        }
      })
    );
    const { unmount } = render(
      <PlayerCardProvider leagueId="L1" api={bye.api}>
        <PlayerLink player={LAMB} />
      </PlayerCardProvider>
    );
    await user.click(screen.getByRole('button', { name: 'CeeDee Lamb' }));
    const next = within(await screen.findByTestId('card-next-week'));
    expect(next.getByText('BYE')).toBeInTheDocument();
    expect(next.getByText('On bye: no points this week.')).toBeInTheDocument();
    expect(screen.queryByTestId('card-this-season')).toBeNull();
    unmount();

    const pending = fakeApi(
      cardFor({
        nextWeek: {
          season: 2026,
          week: 4,
          points: null,
          totals: {},
          bye: false,
          opponent: { team: 'PHI', home: false },
          kickoff: null
        }
      })
    );
    render(
      <PlayerCardProvider leagueId="L1" api={pending.api}>
        <PlayerLink player={LAMB} />
      </PlayerCardProvider>
    );
    await user.click(screen.getByRole('button', { name: 'CeeDee Lamb' }));
    const week = within(await screen.findByTestId('card-next-week'));
    expect(week.getByText('at PHI')).toBeInTheDocument();
    expect(
      week.getByText("No projection for this week yet; he's averaging 13.5 pts a game this season.")
    ).toBeInTheDocument();
  });

  it('says when the opponent is not scheduled yet', async () => {
    const user = userEvent.setup();
    const tbd = fakeApi(
      cardFor({
        nextWeek: { season: 2026, week: 4, points: 9, totals: {}, bye: false, opponent: null, kickoff: null }
      })
    );
    render(
      <PlayerCardProvider leagueId="L1" api={tbd.api}>
        <PlayerLink player={LAMB} />
      </PlayerCardProvider>
    );
    await user.click(screen.getByRole('button', { name: 'CeeDee Lamb' }));
    const week = within(await screen.findByTestId('card-next-week'));
    expect(week.getByText('Opponent not scheduled yet')).toBeInTheDocument();
  });

  it('closes, and a click on the name never reaches the row around it', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi(cardFor());
    const row = vi.fn();
    render(
      <PlayerCardProvider leagueId="L1" api={api}>
        <div role="presentation" onClick={row}>
          <PlayerLink player={CHASE}>J. Chase</PlayerLink>
        </div>
      </PlayerCardProvider>
    );
    await user.click(screen.getByRole('button', { name: 'J. Chase' }));
    expect(row).not.toHaveBeenCalled();
    expect(await screen.findByTestId('player-card')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('player-card')).toBeNull();
  });

  it('is plain text outside a league, where there is no card to open', () => {
    render(
      <p>
        <PlayerLink player={CHASE} />
      </p>
    );
    expect(screen.getByText("Ja'Marr Chase").tagName).toBe('SPAN');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('player card without projections', () => {
  it('falls back to his season average when the week has no projection yet', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi(
      cardFor({
        nextWeek: {
          season: 2026,
          week: 4,
          points: null,
          totals: {},
          bye: false,
          opponent: null,
          kickoff: null
        }
      })
    );
    render(
      <PlayerCardProvider leagueId="L1" api={api}>
        <PlayerLink player={CHASE} />
      </PlayerCardProvider>
    );
    await user.click(screen.getByRole('button', { name: "Ja'Marr Chase" }));
    const week = within(await screen.findByTestId('card-next-week'));
    expect(
      week.getByText("No projection for this week yet; he's averaging 13.5 pts a game this season.")
    ).toBeInTheDocument();
    expect(screen.queryByTestId('card-no-data')).toBeNull();
  });

  it('says plainly when there is no data at all', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi(
      cardFor({
        thisSeason: null,
        nextWeek: {
          season: 2026,
          week: 4,
          points: null,
          totals: {},
          bye: false,
          opponent: { team: 'BAL', home: false },
          kickoff: null
        }
      })
    );
    render(
      <PlayerCardProvider leagueId="L1" api={api}>
        <PlayerLink player={LAMB} />
      </PlayerCardProvider>
    );
    await user.click(screen.getByRole('button', { name: 'CeeDee Lamb' }));
    expect(await screen.findByTestId('card-no-data')).toHaveTextContent(
      'No NFL stats or projections for him yet'
    );
    // The week still shows who he plays.
    expect(within(screen.getByTestId('card-next-week')).getByText('at BAL')).toBeInTheDocument();
  });
});

describe('PlayerList', () => {
  it('lists several players as links that open their cards', async () => {
    const user = userEvent.setup();
    const { api, calls } = fakeApi(cardFor({ player: LAMB }));
    render(
      <PlayerCardProvider leagueId="L1" api={api}>
        <p data-testid="list">
          <PlayerList players={[CHASE, LAMB]} />
        </p>
        <p data-testid="none">
          <PlayerList players={[]} />
        </p>
      </PlayerCardProvider>
    );
    expect(screen.getByTestId('list')).toHaveTextContent("Ja'Marr Chase, CeeDee Lamb");
    expect(screen.getByTestId('none')).toHaveTextContent('nothing');
    await user.click(screen.getByRole('button', { name: 'CeeDee Lamb' }));
    expect(await screen.findByTestId('player-card')).toBeInTheDocument();
    expect(calls[0]?.query).toEqual({ playerId: 'fx-lamb', leagueId: 'L1' });
  });
});
