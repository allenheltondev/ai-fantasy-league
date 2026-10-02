import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeagueApi } from '../../api/league';
import type { DepthChartPlayer, NflDepthChart } from '../../api/types';
import type { PlayerCardData } from '../../draft/research';
import { fakeApi, state } from '../../test/fakeApi';
import { renderApp, signInAs } from '../../test/render';

/** An NFL team's page (League › Players): its depth chart, with links to each player's card. */

const ALICE = { sub: 'alice', email: 'alice@example.com', given_name: 'Alice' };

function player(id: string, extra: Partial<DepthChartPlayer> = {}): DepthChartPlayer {
  return {
    id,
    name: `Player ${id}`,
    team: 'KC',
    position: 'WR',
    depth: 1,
    number: null,
    injuryStatus: null,
    ...extra
  };
}

const KC: NflDepthChart = {
  team: { code: 'KC', city: 'Kansas City', nickname: 'Chiefs' },
  slots: [
    { slot: 'QB', label: 'QB', players: [player('qb1', { position: 'QB', number: 15 })] },
    {
      slot: 'LWR',
      label: 'WR (left)',
      players: [
        player('wr1'),
        player('wr2', { depth: 2, injuryStatus: 'Questionable' }),
        player('wr3', { depth: null })
      ]
    }
  ],
  others: [player('ir1', { position: 'RB', depth: null, injuryStatus: 'IR' })]
};

/** The player card loads through fetch (the league shell's card drawer). */
function stubCardFetch() {
  const card = (playerId: string): PlayerCardData => ({
    player: { id: playerId, name: `Player ${playerId}`, team: 'KC', position: 'QB' },
    scoring: { source: 'league' },
    bye: 10,
    injuryStatus: null,
    lastSeason: null,
    projection: null,
    thisSeason: null,
    nextWeek: null,
    news: []
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const data = url.pathname.endsWith('/players/card') ? card(url.searchParams.get('playerId') ?? '') : {};
      return new Response(JSON.stringify({ data, league: null, warnings: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    })
  );
}

function open(path: string, overrides: Partial<LeagueApi> = {}) {
  const api = fakeApi({
    getLeagueState: vi.fn(async () => state({ phase: 'regular_season', week: 3 })),
    getNflDepthChart: vi.fn(async () => KC),
    ...overrides
  });
  renderApp(path, undefined, api);
  return api;
}

beforeEach(() => {
  signInAs(ALICE);
  stubCardFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe('NFL team page', () => {
  it('shows the depth chart starters first, with pictures, numbers and injuries', async () => {
    const api = open('/leagues/L1/league/players/nfl/kc');
    expect(await screen.findByRole('heading', { level: 2, name: 'Kansas City Chiefs' })).toBeInTheDocument();
    expect(api.getNflDepthChart).toHaveBeenCalledWith('KC');
    expect(document.title).toMatch(/^KC depth chart · /);
    const qb = screen.getByRole('region', { name: 'QB' });
    expect(within(qb).getByTestId('depth-qb1')).toHaveTextContent('1Player qb1#15');
    const wr = screen.getByRole('region', { name: 'WR (left)' });
    const rows = within(wr).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual(['1Player wr1', '2Player wr2Q', '–Player wr3']);
    const others = screen.getByRole('region', { name: 'Not on the depth chart' });
    expect(within(others).getByTestId('depth-ir1')).toHaveTextContent('Player ir1RB · IR');
    expect(screen.getByRole('link', { name: '← All players' })).toHaveAttribute(
      'href',
      '/leagues/L1/league/players'
    );
    expect(screen.getByLabelText('NFL team')).toHaveValue('KC');
  });

  it("opens a player's card, whose team links back to the team page", async () => {
    const user = userEvent.setup();
    open('/leagues/L1/league/players/nfl/KC');
    await user.click(await screen.findByRole('button', { name: 'Player qb1' }));
    const card = await screen.findByTestId('player-card');
    const link = within(card).getByRole('link', { name: 'KC' });
    expect(link).toHaveAttribute('href', '/leagues/L1/league/players/nfl/KC');
    await user.click(link);
    await waitFor(() => expect(screen.queryByTestId('player-card')).not.toBeInTheDocument());
  });

  it('jumps to another team from the picker', async () => {
    const user = userEvent.setup();
    const api = open('/leagues/L1/league/players/nfl/KC');
    await screen.findByRole('heading', { level: 2, name: 'Kansas City Chiefs' });
    await user.selectOptions(screen.getByLabelText('NFL team'), 'BUF');
    await waitFor(() => expect(api.getNflDepthChart).toHaveBeenCalledWith('BUF'));
  });

  it('says when a team has no depth chart yet, or the load fails', async () => {
    open('/leagues/L1/league/players/nfl/NYJ', {
      getNflDepthChart: vi.fn(async () => ({ ...KC, slots: [], others: [] }))
    });
    expect(await screen.findByText('No depth chart yet')).toBeInTheDocument();
  });

  it('shows why the depth chart could not load', async () => {
    open('/leagues/L1/league/players/nfl/KC', {
      getNflDepthChart: vi.fn(async () => {
        throw new Error('boom');
      })
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('handles a code that is not an NFL team without calling the server', async () => {
    const api = open('/leagues/L1/league/players/nfl/XYZ');
    expect(await screen.findByText('Team not found')).toBeInTheDocument();
    expect(screen.getByLabelText('NFL team')).toHaveValue('');
    expect(api.getNflDepthChart).not.toHaveBeenCalled();
  });
});
