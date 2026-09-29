import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signInAs } from '../../test/render';
import { describeMove, Transactions } from './Transactions';
import { describeError, formatTime } from './types';

/** The transaction log (list_transactions): the league's, or one team's, with older pages. */

const ref = (id: string, name: string, position = 'RB') => ({ id, name, team: 'ATL', position });
const move = (id: string, extra: object) => ({
  id,
  at: '2026-09-12T08:00:00.000Z',
  week: 2,
  teamId: 'team-1',
  teamName: 'Alice FC',
  added: null,
  dropped: null,
  cost: null,
  ...extra
});

function stubLog(fail = false) {
  const queries: URLSearchParams[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      queries.push(url.searchParams);
      if (fail)
        return json(
          { error: { code: 'FORBIDDEN', message: 'FORBIDDEN happened.', fix: 'Join the league.' } },
          403
        );
      const older = url.searchParams.get('cursor') === 'older';
      const data = older
        ? {
            transactions: [move('t3', { type: 'drop', dropped: ref('fx-swift', "D'Andre Swift") })],
            nextCursor: null
          }
        : {
            transactions: [
              move('t1', {
                type: 'waiver_claim',
                added: ref('fx-hall', 'Breece Hall'),
                dropped: ref('fx-jallen', 'Josh Allen', 'QB'),
                cost: 7
              }),
              move('t2', {
                type: 'add',
                teamId: 'team-2',
                teamName: 'Robots',
                added: ref('fx-bijan', 'Bijan Robinson')
              })
            ],
            nextCursor: 'older'
          };
      return json({ data, league: null, warnings: [] });
    })
  );
  return queries;
}

beforeEach(() => signInAs({ sub: 'alice', email: 'alice@example.com' }));
afterEach(() => vi.unstubAllGlobals());

describe('Transactions', () => {
  it('shows the league log with older pages', async () => {
    const queries = stubLog();
    render(<Transactions leagueId="L1" refreshKey={0} />);
    const log = await screen.findByRole('list', { name: 'League transactions' });
    await waitFor(() => expect(log).toHaveTextContent(/claimed Breece Hall for \$7, dropping Josh Allen/));
    expect(log).toHaveTextContent(/added Bijan Robinson/);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show older moves' }));
    await waitFor(() => expect(log).toHaveTextContent(/dropped D'Andre Swift/));
    expect(screen.queryByRole('button', { name: 'Show older moves' })).not.toBeInTheDocument();
    expect(queries.at(-1)?.get('cursor')).toBe('older');
    expect(queries.at(-1)?.get('limit')).toBe('20');
  });

  it("shows one team's moves", async () => {
    stubLog();
    render(<Transactions leagueId="L1" refreshKey={0} teamId="team-2" title="Recent moves" />);
    const log = await screen.findByRole('list', { name: 'Recent moves list' });
    await waitFor(() => expect(log).toHaveTextContent(/added Bijan Robinson/));
    expect(log).not.toHaveTextContent(/Breece Hall/);
  });

  it('reports a failed log', async () => {
    stubLog(true);
    render(<Transactions leagueId="L1" refreshKey={0} />);
    expect(await screen.findByText('FORBIDDEN happened. Join the league.')).toBeInTheDocument();
  });

  it('keeps only the latest read when it refreshes', async () => {
    stubLog();
    const view = render(<Transactions leagueId="L1" refreshKey={0} />);
    view.rerender(<Transactions leagueId="L1" refreshKey={1} />);
    await waitFor(() =>
      expect(screen.getByRole('list', { name: 'League transactions' })).toHaveTextContent(/added Bijan/)
    );
    view.unmount();
    stubLog(true);
    render(<Transactions leagueId="L1" refreshKey={0} />).unmount();
  });

  it('reports a failed older page', async () => {
    stubLog();
    render(<Transactions leagueId="L1" refreshKey={0} />);
    await screen.findByRole('button', { name: 'Show older moves' });
    stubLog(true);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show older moves' }));
    expect(await screen.findByText('FORBIDDEN happened. Join the league.')).toBeInTheDocument();
  });

  it('describes every kind of move, times, and errors', () => {
    const base = move('t', {}) as Parameters<typeof describeMove>[0];
    expect(describeMove({ ...base, type: 'waiver_claim' })).toBe('claimed a player for $0');
    expect(describeMove({ ...base, type: 'add' })).toBe('added a player');
    expect(describeMove({ ...base, type: 'drop' })).toBe('dropped a player');
    expect(formatTime('2026-09-13T08:00:00.000Z')).toBe('2026-09-13 08:00 UTC');
    expect(describeError(new Error('Plain.'))).toBe('Plain.');
    expect(describeError(Object.assign(new Error('Broke.'), { fix: 'Fix it.' }))).toBe('Broke. Fix it.');
    expect(describeError('nope')).toBe('Something went wrong.');
  });
});
