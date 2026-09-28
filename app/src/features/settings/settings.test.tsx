import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import type { LeagueApi } from '../../api/league';
import { catalog, fakeApi, league, state, team } from '../../test/fakeApi';
import { renderApp, signInAs } from '../../test/render';
import { seatConfig } from './AgentManagers';

const notFound = () => new ApiError(404, { code: 'NOT_FOUND', message: 'No config.' });

beforeEach(() => signInAs({ sub: 'alice', given_name: 'Alice' }));

async function open(api: LeagueApi = fakeApi()) {
  renderApp('/leagues/L1/settings', undefined, api);
  await screen.findByTestId('league-section-settings');
  return api;
}

const seat = (id: string) => screen.getByTestId(`seat-${id}`);

describe('settings: seats', () => {
  it('lists every seat with its holder and the commissioner actions', async () => {
    await open();
    expect(screen.getByText('You are the commissioner')).toBeInTheDocument();
    expect(seat('team-1')).toHaveTextContent("Alice's Team(you)");
    expect(seat('team-1')).toHaveTextContent('Alice · Commissioner');
    expect(within(seat('team-2')).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(seat('team-3')).toHaveTextContent('Open, waiting for an invite');
    expect(seat('team-4')).toHaveTextContent('AI manager');
    expect(within(seat('team-1')).queryByRole('group')).not.toBeInTheDocument();
    expect(within(seat('team-2')).queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    expect(within(seat('team-4')).getByRole('button', { name: 'Rename' })).toBeInTheDocument();
  });

  it('switches an open seat between human and AI', async () => {
    const user = userEvent.setup();
    const api = await open();
    await user.click(within(seat('team-3')).getByRole('button', { name: 'AI' }));
    expect(api.setSeatType).toHaveBeenCalledWith('L1', 'team-3', 'agent');
    expect(await screen.findByText('Team 3 is now an AI seat.')).toBeInTheDocument();
    await waitFor(() => expect(api.getLeague).toHaveBeenCalledTimes(2));
  });

  it('renames, removes a member, and transfers the commissioner role', async () => {
    const user = userEvent.setup();
    const api = await open();
    await user.click(within(seat('team-1')).getByRole('button', { name: 'Rename' }));
    const input = within(seat('team-1')).getByLabelText('Team name');
    await user.clear(input);
    await user.type(input, ' Champs ');
    await user.click(within(seat('team-1')).getByRole('button', { name: 'Save' }));
    expect(api.renameTeam).toHaveBeenCalledWith('L1', 'team-1', 'Champs');
    await screen.findByText('Team renamed.');

    await user.click(within(seat('team-2')).getByRole('button', { name: 'Remove' }));
    await user.click(await screen.findByRole('button', { name: 'Remove member' }));
    expect(api.removeMember).toHaveBeenCalledWith('L1', 'bob');
    await screen.findByText('Bob was removed.');

    await user.click(within(seat('team-2')).getByRole('button', { name: 'Make commissioner' }));
    await user.click(await screen.findByRole('button', { name: 'Transfer' }));
    expect(api.transferCommissioner).toHaveBeenCalledWith('L1', 'bob');
    await screen.findByText('Bob is now the commissioner.');
  });

  it('shows a failed seat action with its fix', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      setSeatType: vi.fn(async () => {
        throw new ApiError(409, {
          code: 'CONFLICT',
          message: 'Seat taken.',
          fix: 'Remove the member first.'
        });
      })
    });
    await open(api);
    await user.click(within(seat('team-4')).getByRole('button', { name: 'Human' }));
    expect(await screen.findByText('Remove the member first.')).toBeInTheDocument();
  });

  it('shows members a read-only view with their own rename', async () => {
    signInAs({ sub: 'bob', given_name: 'Bob' });
    const detail = league();
    const api = fakeApi({
      getLeagueState: vi.fn(async () =>
        state({ youAreCommissioner: false, yourTeam: detail.teams[1]!, allowedActions: ['rename_team'] })
      ),
      getAgentSeat: vi.fn(async (_id: string, teamId: string) => ({
        seat: {
          teamId,
          personality: catalog().personalities[2]!,
          difficulty: { id: 'rookie', displayName: 'Rookie' }
        },
        commissioner: null
      }))
    });
    await open(api);
    expect(screen.queryByText('You are the commissioner')).not.toBeInTheDocument();
    expect(within(seat('team-2')).getByRole('button', { name: 'Rename' })).toBeInTheDocument();
    expect(within(seat('team-1')).queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    expect(within(seat('team-3')).queryByRole('group')).not.toBeInTheDocument();
    expect(seat('team-3')).toHaveTextContent('Human');
    expect(seat('team-4')).toHaveTextContent('AI');
    expect(within(seat('team-1')).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Invites' })).not.toBeInTheDocument();
    const card = await screen.findByTestId('agent-card');
    expect(card).toHaveTextContent('Persona 2');
    expect(within(card).getByTestId('difficulty-pill')).toHaveTextContent('Rookie');
    expect(within(card).queryByRole('button', { name: 'Shuffle' })).not.toBeInTheDocument();
    expect(screen.getByText(/Only the commissioner can change the rules/)).toBeInTheDocument();
  });

  it('shows a load failure', async () => {
    renderApp(
      '/leagues/L1/settings',
      undefined,
      fakeApi({
        getLeague: vi.fn(async () => {
          throw new ApiError(403, { code: 'FORBIDDEN', message: 'Not a member.', fix: 'Join first.' });
        })
      })
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Not a member.Join first.');
  });
});

describe('settings: AI managers', () => {
  it('changes a card, shuffles it, and sets every difficulty', async () => {
    const user = userEvent.setup();
    const api = await open();
    const card = await screen.findByTestId('agent-card');
    expect(card).toHaveTextContent('Persona 4');
    await user.selectOptions(within(card).getByLabelText('Difficulty'), 'all_pro');
    expect(api.configureAgentSeat).toHaveBeenCalledWith('L1', 'team-4', {
      personalityId: 'p4',
      difficulty: 'all_pro',
      archetype: 'balanced'
    });
    await waitFor(() => expect(within(card).getByTestId('difficulty-pill')).toHaveTextContent('All-Pro'));
    await user.click(within(card).getByRole('button', { name: 'Shuffle' }));
    await waitFor(() => expect(api.configureAgentSeat).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('agent-card')).not.toHaveTextContent('Persona 4');
    await user.selectOptions(screen.getByLabelText('Difficulty for all'), 'rookie');
    await waitFor(() => expect(within(card).getByTestId('difficulty-pill')).toHaveTextContent('Rookie'));
  });

  it('randomizes every AI seat', async () => {
    const user = userEvent.setup();
    const api = await open();
    await user.click(await screen.findByRole('button', { name: 'Randomize all' }));
    expect(api.randomizeAgentSeats).toHaveBeenCalledWith('L1', ['team-4']);
    expect(await screen.findByText('AI managers randomized.')).toBeInTheDocument();
    await waitFor(() => expect(api.getAgentSeat).toHaveBeenCalledTimes(2));
  });

  it('offers to fill seats that have no AI manager yet, and shows save errors', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      getAgentSeat: vi.fn(async () => {
        throw notFound();
      }),
      randomizeAgentSeats: vi.fn(async () => {
        throw new ApiError(400, { code: 'INVALID_INPUT', message: 'Human seat.', fix: 'Pick agent seats.' });
      })
    });
    await open(api);
    expect(await screen.findByTestId('unconfigured-seats')).toHaveTextContent(
      'No AI manager picked yet for Team 4. Randomize to fill them.'
    );
    await user.click(screen.getByRole('button', { name: 'Randomize all' }));
    expect(await screen.findByText('Pick agent seats.')).toBeInTheDocument();
  });

  it('shows why the AI managers could not load', async () => {
    await open(
      fakeApi({
        getAgentSeat: vi.fn(async () => {
          throw new ApiError(500, { code: 'INTERNAL', message: 'Seat store down.' });
        })
      })
    );
    expect(await screen.findByText('Seat store down.')).toBeInTheDocument();
  });

  it('hides the section when no seat is played by an AI', async () => {
    const detail = league({ teams: league().teams.slice(0, 3) });
    await open(fakeApi({ getLeague: vi.fn(async () => detail) }));
    expect(screen.queryByRole('heading', { name: 'AI managers' })).not.toBeInTheDocument();
  });

  it('shows the public persona when there is no commissioner view', () => {
    expect(
      seatConfig({
        seat: {
          teamId: 'team-4',
          personality: catalog().personalities[1]!,
          difficulty: { id: 'pro', displayName: 'Pro' }
        },
        commissioner: null
      })
    ).toEqual({ personalityId: 'p1', difficulty: 'pro', archetype: '' });
  });

  it("fills in the manager's name and avatar from the seat when the config has none (#159)", () => {
    const view = {
      seat: {
        teamId: 'team-4',
        manager: { name: 'Ana Soto', avatarSeed: 'ana' },
        personality: catalog().personalities[1]!,
        difficulty: { id: 'pro', displayName: 'Pro' }
      },
      commissioner: null
    };
    expect(seatConfig(view)).toMatchObject({ name: 'Ana Soto', avatarSeed: 'ana' });
    const stored = { personalityId: 'p1', difficulty: 'pro', archetype: 'balanced', name: 'Ravi Park' };
    expect(
      seatConfig({ ...view, commissioner: { current: { version: 3, config: stored }, history: [] } })
    ).toEqual({
      ...stored,
      avatarSeed: 'ana'
    });
  });

  it('renames a manager through configure_agent_seat (#159)', async () => {
    const user = userEvent.setup();
    const api = await open();
    const card = await screen.findByTestId('agent-card');
    await user.click(within(card).getByRole('button', { name: /^Rename / }));
    const input = within(card).getByLabelText('Manager name');
    await user.clear(input);
    await user.type(input, 'Imani Brooks{Enter}');
    expect(api.configureAgentSeat).toHaveBeenCalledWith(
      'L1',
      'team-4',
      expect.objectContaining({ name: 'Imani Brooks' })
    );
    expect(await within(card).findByRole('heading', { name: 'Imani Brooks' })).toBeInTheDocument();
  });
});

describe('settings: invites', () => {
  it('creates, copies, and revokes invite links', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      listInvites: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([
          { id: 'i1', status: 'active', email: null, maxUses: 1, uses: 0, expiresAt: '2026-10-01T00:00:00Z' },
          { id: 'i0', status: 'revoked', email: null, maxUses: 1, uses: 0, expiresAt: '2026-10-01T00:00:00Z' }
        ])
    });
    await open(api);
    expect(screen.getByText(/1 human seat\(s\) waiting/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create invite link' }));
    const link = await screen.findByLabelText('Invite link');
    expect(link).toHaveValue(`${window.location.origin}/join/tok`);
    await user.click(link);
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/join/tok`);
    expect(await screen.findByText('Invite link copied.')).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Invites' });
    expect(within(list).getByText('Revoked')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Revoke' }));
    expect(api.revokeInvite).toHaveBeenCalledWith('L1', 'i1');

    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByText(/Copy failed/)).toBeInTheDocument();
  });

  it('explains when no seat waits for a person, and shows invite errors', async () => {
    const user = userEvent.setup();
    const detail = league({
      teams: [league().teams[0]!, team(2), team(3), team(4)]
    });
    const api = fakeApi({
      getLeague: vi.fn(async () => detail),
      createInvite: vi.fn(async () => {
        throw new ApiError(409, { code: 'PHASE_NOT_ALLOWED', message: 'Draft started.', fix: 'Too late.' });
      })
    });
    await open(api);
    expect(screen.getByText(/No seats are waiting for a person/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create invite link' }));
    expect(await screen.findByText('Too late.')).toBeInTheDocument();
  });
});
