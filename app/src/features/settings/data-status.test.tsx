import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeagueApi } from '../../api/league';
import type { DataStatus } from '../../api/types';
import { fakeApi, league, state } from '../../test/fakeApi';
import { renderApp, signInAs } from '../../test/render';

beforeEach(() => signInAs({ sub: 'alice', given_name: 'Alice' }));

function status(overrides: Partial<DataStatus> = {}): DataStatus {
  return {
    checkedAt: '2026-09-28T20:00:00.000Z',
    nflState: {
      season: 2026,
      seasonType: 'regular',
      week: 3,
      leagueSeason: 2026,
      updatedAt: '2026-09-28T19:45:00.000Z'
    },
    league: { season: 2026, week: 4 },
    players: { total: 1800, byPosition: { QB: 90, RB: 200, WR: 300, TE: 150, K: 40, DEF: 32 } },
    weeks: [
      { season: 2026, week: 4, projections: null, statLines: 0 },
      {
        season: 2026,
        week: 5,
        projections: { capturedAt: '2026-09-28T19:00:00.000Z', count: 412, hash: 'abc', source: 'app' },
        statLines: 0
      },
      {
        season: 2026,
        week: 6,
        projections: { capturedAt: '2026-09-28T19:00:00.000Z', count: 20, hash: 'def', source: 'v1' },
        statLines: 0
      }
    ],
    research: {
      stats: {
        season: 2025,
        updatedAt: '2026-09-28T13:00:00.000Z',
        checkedAt: null,
        players: 640,
        weeks: Array.from({ length: 18 }, (_, i) => i + 1)
      },
      projections: null,
      currentStats: {
        season: 2026,
        updatedAt: '2026-09-28T13:00:00.000Z',
        checkedAt: null,
        players: 812,
        weeks: [1, 2, 3, 4]
      }
    },
    jobs: [
      {
        job: 'ingestProjections',
        latest: {
          finishedAt: '2026-09-28T19:00:00.000Z',
          status: 'ok',
          reason: null,
          summary: '{"weeks":[{"week":4,"stored":false,"reason":"no_projections"}]}',
          durationMs: 900
        },
        lastOk: {
          finishedAt: '2026-09-28T19:00:00.000Z',
          status: 'ok',
          reason: null,
          summary: null,
          durationMs: 900
        }
      },
      {
        job: 'syncSeasonResearch',
        latest: {
          finishedAt: '2026-09-28T19:37:00.000Z',
          status: 'skipped',
          reason: 'no_nfl_state',
          summary: null,
          durationMs: 4
        },
        lastOk: null
      },
      {
        job: 'syncNflState',
        latest: {
          finishedAt: '2026-09-28T19:45:00.000Z',
          status: 'failed',
          reason: 'Sleeper is down',
          summary: null,
          durationMs: 30
        },
        lastOk: null
      },
      { job: 'syncPlayers', latest: null, lastOk: null }
    ],
    ...overrides
  };
}

async function openData(api: LeagueApi) {
  const user = userEvent.setup();
  renderApp('/leagues/L1/settings', undefined, api);
  await screen.findByTestId('league-section-settings');
  await user.click(screen.getByRole('button', { name: 'Data status' }));
  await screen.findByTestId('data-status');
  return user;
}

describe('settings: data status (#181)', () => {
  it('shows the NFL state, players, weekly projections, research sets, and each job run', async () => {
    const api = fakeApi({ getDataStatus: vi.fn(async () => status()) });
    const user = await openData(api);
    const panel = screen.getByTestId('data-status');
    expect(within(panel).getByText('2026 week 3')).toBeInTheDocument();
    expect(within(panel).getByText(/regular season · league season 2026/)).toBeInTheDocument();
    expect(within(panel).getByText('32 DEF · 40 K')).toBeInTheDocument();
    expect(within(panel).getByText('Week 4')).toBeInTheDocument();

    const weeks = within(panel).getByRole('table', { name: 'Weekly projections and stats' });
    const [, week4, week5, week6] = within(weeks).getAllByRole('row');
    expect(week4).toHaveTextContent(/^4None——0$/);
    expect(week5).toHaveTextContent('412 players');
    // Which Sleeper endpoint served each snapshot (#184).
    expect(week5).toHaveTextContent('app (fallback)');
    expect(week6).toHaveTextContent(/20 players.*v1/);

    const research = within(panel).getByRole('table', { name: 'Draft research' });
    expect(within(research).getAllByRole('row')[1]).toHaveTextContent(/2025640\s*18/);
    expect(within(research).getAllByRole('row')[2]).toHaveTextContent('Not stored');
    expect(within(research).getAllByRole('row')[3]).toHaveTextContent(
      /This season's stats so far2026812\s*4/
    );

    const jobs = within(panel).getByRole('table', { name: 'Data jobs' });
    const rows = within(jobs).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('OK');
    expect(rows[1]).toHaveTextContent('no_projections');
    expect(rows[2]).toHaveTextContent('Skipped');
    expect(rows[2]).toHaveTextContent('no nfl state');
    expect(rows[3]).toHaveTextContent('Failed');
    expect(rows[3]).toHaveTextContent('Sleeper is down');
    expect(rows[4]).toHaveTextContent('No run recorded');
    expect(api.getDataStatus).toHaveBeenCalledWith('L1');

    await user.click(within(panel).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.getDataStatus).toHaveBeenCalledTimes(2));
  });

  it('flags a missing NFL state and a league that has not started', async () => {
    const api = fakeApi({
      getDataStatus: vi.fn(async () => status({ nflState: null, league: { season: 2026, week: null } }))
    });
    await openData(api);
    const panel = screen.getByTestId('data-status');
    expect(within(panel).getAllByText('Not stored').length).toBeGreaterThan(0);
    expect(within(panel).getByText('Missing')).toBeInTheDocument();
    expect(within(panel).getByText('Not started')).toBeInTheDocument();
  });

  it('shows a load error', async () => {
    const api = fakeApi({
      getDataStatus: vi.fn(async () => {
        throw new Error('nope');
      })
    });
    const user = userEvent.setup();
    renderApp('/leagues/L1/settings', undefined, api);
    await screen.findByTestId('league-section-settings');
    await user.click(screen.getByRole('button', { name: 'Data status' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('is offered to the commissioner only', async () => {
    const api = fakeApi({
      getLeagueState: vi.fn(async () => state({ youAreCommissioner: false })),
      getLeague: vi.fn(async () => league())
    });
    renderApp('/leagues/L1/settings', undefined, api);
    await screen.findByTestId('league-section-settings');
    expect(screen.queryByRole('button', { name: 'Data status' })).not.toBeInTheDocument();
  });
});
