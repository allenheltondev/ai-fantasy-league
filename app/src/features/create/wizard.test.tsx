import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { catalog, fakeApi, league, team } from '../../test/fakeApi';
import { renderApp, signInAs } from '../../test/render';

const ALICE = { sub: 'alice', email: 'alice@example.com', given_name: 'Alice' };

/** An 8-team league as create_league returns it: Alice on team-1, seven open agent seats. */
function created(count = 8) {
  return league({
    id: 'NEW',
    name: "Alice's League",
    teams: Array.from({ length: count }, (_, i) =>
      i === 0
        ? team(1, { seatType: 'human', open: false, ownerUserId: 'alice', ownerName: 'Alice' })
        : team(i + 1)
    ).reverse()
  });
}

beforeEach(() => signInAs(ALICE));

async function next(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Next' }));
}

describe('create league wizard', () => {
  it('creates a valid league by clicking Next through every step', async () => {
    const user = userEvent.setup();
    const api = fakeApi({ createLeague: vi.fn(async () => created()) });
    renderApp('/leagues/new', undefined, api);
    expect(await screen.findByLabelText('League name')).toHaveValue("Alice's League");
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    await next(user);
    expect(screen.getByTestId('seat-split')).toHaveTextContent('1 human, 7 AI');
    await next(user);
    expect(await screen.findAllByTestId('agent-card')).toHaveLength(7);
    expect(api.getAgentCatalog).toHaveBeenCalledTimes(1);
    await next(user);
    const review = screen.getByTestId('review');
    expect(review).toHaveTextContent("Alice's League");
    expect(review).toHaveTextContent('Half-PPR');
    expect(review).toHaveTextContent('Persona 0 (Rookie)');
    await user.click(screen.getByRole('button', { name: 'Create league' }));
    await waitFor(() => expect(screen.getByTestId('league-section-settings')).toBeInTheDocument());
    expect(api.createLeague).toHaveBeenCalledWith({
      name: "Alice's League",
      teamCount: 8,
      preset: 'yahoo_standard'
    });
    expect(api.setSeatType).not.toHaveBeenCalled();
    expect(api.configureAgentSeat).toHaveBeenCalledTimes(7);
    expect(api.configureAgentSeat).toHaveBeenCalledWith(
      'NEW',
      'team-2',
      expect.objectContaining({ personalityId: 'p0' })
    );
    expect(api.configureAgentSeat).toHaveBeenCalledWith(
      'NEW',
      'team-8',
      expect.objectContaining({ personalityId: 'p6' })
    );
    expect(await screen.findByText("Alice's League is ready.")).toBeInTheDocument();
  });

  it('customizes teams, scoring, human seats, and the AI managers', async () => {
    const user = userEvent.setup();
    const api = fakeApi({ createLeague: vi.fn(async () => created(4)) });
    renderApp('/leagues/new', undefined, api);
    const name = await screen.findByLabelText('League name');
    await user.clear(name);
    expect(screen.getByText('Give the league a name.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.type(name, 'Friends');
    await user.selectOptions(screen.getByLabelText('Teams'), '4');
    await user.click(screen.getByRole('button', { name: 'PPR' }));
    await next(user);
    await user.selectOptions(screen.getByLabelText('Human seats'), '2');
    expect(screen.getByTestId('seat-split')).toHaveTextContent('2 human, 2 AI');
    await next(user);
    await waitFor(() => expect(screen.getAllByTestId('agent-card')).toHaveLength(2));
    expect(api.getAgentCatalog).toHaveBeenLastCalledWith({ suggest: 2 });

    await user.click(screen.getByRole('button', { name: 'Randomize all' }));
    expect(api.getAgentCatalog).toHaveBeenCalledTimes(3);
    await user.selectOptions(screen.getByLabelText('Difficulty for all'), 'hall_of_famer');
    for (const pill of screen.getAllByTestId('difficulty-pill'))
      expect(pill).toHaveTextContent('Hall of Famer');
    const first = screen.getAllByTestId('agent-card')[0] as HTMLElement;
    await user.selectOptions(within(first).getByLabelText('Difficulty'), 'rookie');
    expect(within(first).getByTestId('difficulty-pill')).toHaveTextContent('Rookie');
    await user.click(within(first).getByRole('button', { name: 'Shuffle' }));
    expect(
      within(screen.getAllByTestId('agent-card')[0] as HTMLElement).getByRole('heading')
    ).not.toHaveTextContent('Persona 0');
    await next(user);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await next(user);
    const review = screen.getByTestId('review');
    expect(review).toHaveTextContent('PPR');
    expect(review).toHaveTextContent('2 human, 2 AI');
    await user.click(screen.getByRole('button', { name: 'Create league' }));
    await waitFor(() => expect(api.configureAgentSeat).toHaveBeenCalledTimes(2));
    expect(api.createLeague).toHaveBeenCalledWith({ name: 'Friends', teamCount: 4, preset: 'full_ppr' });
    expect(api.setSeatType).toHaveBeenCalledWith('NEW', 'team-2', 'human');
    expect(api.configureAgentSeat).toHaveBeenCalledWith(
      'NEW',
      'team-3',
      expect.objectContaining({ difficulty: 'rookie' })
    );
  });

  it('handles an all-human league and a catalog without suggestions', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      getAgentCatalog: vi.fn(async () => catalog(null)),
      createLeague: vi.fn(async () => created())
    });
    renderApp('/leagues/new', undefined, api);
    await user.selectOptions(await screen.findByLabelText('Teams'), '4');
    await next(user);
    await user.selectOptions(screen.getByLabelText('Human seats'), '4');
    await next(user);
    expect(screen.getByText(/no AI managers/)).toBeInTheDocument();
    await next(user);
    expect(screen.getByTestId('review')).toHaveTextContent('AI managersNone');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.selectOptions(screen.getByLabelText('Human seats'), '3');
    await next(user);
    // The catalog returned no suggestion, so there are no cards to show.
    expect(screen.queryAllByTestId('agent-card')).toHaveLength(0);
  });

  it('shows the server fix when a step fails, and still lands on a created league', async () => {
    const user = userEvent.setup();
    let catalogCalls = 0;
    const api = fakeApi({
      getAgentCatalog: vi.fn(async (query: { suggest?: number } = {}) => {
        catalogCalls++;
        if (catalogCalls === 2)
          throw new ApiError(503, { code: 'DOWN', message: 'Catalog down.', fix: 'Retry.' });
        return catalog(query.suggest ?? null);
      }),
      createLeague: vi
        .fn()
        .mockRejectedValueOnce(
          new ApiError(429, { code: 'LEAGUE_QUOTA_EXCEEDED', message: 'Too many.', fix: 'Delete one.' })
        )
        .mockResolvedValue(created(6)),
      configureAgentSeat: vi.fn(async () => {
        throw new ApiError(409, { code: 'CONFLICT', message: 'Seat busy.' });
      })
    });
    renderApp('/leagues/new', undefined, api);
    await user.selectOptions(await screen.findByLabelText('Teams'), '6');
    await next(user);
    await next(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Catalog down.Retry.');
    expect(screen.getByTestId('seat-split')).toBeInTheDocument();
    await next(user);
    expect(await screen.findAllByTestId('agent-card')).toHaveLength(5);
    await next(user);
    await user.click(screen.getByRole('button', { name: 'Create league' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many.Delete one.');
    await user.click(screen.getByRole('button', { name: 'Create league' }));
    expect(
      await screen.findByText(/was created, but a seat could not be set up: Seat busy\./)
    ).toBeInTheDocument();
    expect(await screen.findByTestId('league-section-settings')).toBeInTheDocument();
  });

  it('shows an error when the catalog cannot load, and names the league for a user without a name', async () => {
    signInAs({ sub: 'x' });
    renderApp(
      '/leagues/new',
      undefined,
      fakeApi({
        getAgentCatalog: vi.fn(async () => {
          throw new Error('offline');
        })
      })
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    renderApp('/leagues/new');
    expect(await screen.findByLabelText('League name')).toHaveValue("My's League");
  });
});
