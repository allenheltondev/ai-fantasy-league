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

  it('lets the commissioner turn off "Let this manager name its team" (#194)', async () => {
    const user = userEvent.setup();
    const api = await open();
    const card = await screen.findByTestId('agent-card');
    const toggle = within(card).getByRole('checkbox', { name: /Let this manager name its team/ });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(api.configureAgentSeat).toHaveBeenCalledWith(
      'L1',
      'team-4',
      expect.objectContaining({ namesTeam: false })
    );
    await waitFor(() => expect(within(card).getByRole('checkbox')).not.toBeChecked());
    expect(card).toHaveTextContent('Off: it keeps the name you give it.');
  });

  it('never shows the naming switch to anyone but the commissioner (#194)', async () => {
    // A member, even one the league somehow lets configure seats, sees no switch.
    signInAs({ sub: 'bob', given_name: 'Bob' });
    const detail = league();
    await open(
      fakeApi({
        getLeagueState: vi.fn(async () =>
          state({
            youAreCommissioner: false,
            yourTeam: detail.teams[1]!,
            allowedActions: ['rename_team', 'configure_agent_seat']
          })
        )
      })
    );
    const card = await screen.findByTestId('agent-card');
    expect(within(card).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/Let this manager name its team/)).not.toBeInTheDocument();
  });

  it('hides the naming switch from a commissioner who cannot configure seats now', async () => {
    await open(fakeApi({ getLeagueState: vi.fn(async () => state({ allowedActions: ['rename_team'] })) }));
    const card = await screen.findByTestId('agent-card');
    expect(within(card).queryByRole('checkbox')).not.toBeInTheDocument();
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
          {
            id: 'i1',
            code: 'K7M-Q2X',
            status: 'active',
            email: null,
            teamId: null,
            maxUses: 1,
            uses: 0,
            expiresAt: '2026-10-01T00:00:00Z'
          },
          {
            id: 'i0',
            code: null,
            status: 'revoked',
            email: null,
            teamId: null,
            maxUses: 1,
            uses: 0,
            expiresAt: '2026-10-01T00:00:00Z'
          }
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
    expect(screen.getByLabelText('Join code')).toHaveValue('K7M-Q2X');
    const list = await screen.findByRole('list', { name: 'Invites' });
    expect(within(list).getByText('Revoked')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Revoke' }));
    expect(api.revokeInvite).toHaveBeenCalledWith('L1', 'i1');

    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByText(/Copy failed/)).toBeInTheDocument();
  });

  it('shows the join code next to the link, and again in the invite list', async () => {
    vi.restoreAllMocks(); // the test above leaves a failing clipboard behind
    const user = userEvent.setup();
    const api = fakeApi({
      listInvites: vi.fn(async () => [
        {
          id: 'i1',
          code: 'K7M-Q2X',
          status: 'active' as const,
          email: null,
          teamId: null,
          maxUses: 1,
          uses: 0,
          expiresAt: '2026-10-01T00:00:00Z'
        },
        {
          id: 'i0',
          code: null,
          status: 'active' as const,
          email: null,
          teamId: null,
          maxUses: 1,
          uses: 0,
          expiresAt: '2026-10-01T00:00:00Z'
        }
      ])
    });
    await open(api);
    // Codes stay visible in the list, so a lost link is not a lost invite.
    const list = await screen.findByRole('list', { name: 'Invites' });
    const [coded, old] = within(list).getAllByRole('listitem') as [HTMLElement, HTMLElement];
    expect(within(coded).getByText('K7M-Q2X')).toBeInTheDocument();
    expect(within(old).queryByText('Join code')).not.toBeInTheDocument();
    expect(within(old).queryByText(/[2-9A-Z]{3}-[2-9A-Z]{3}/)).not.toBeInTheDocument();
    expect(within(old).queryByRole('button', { name: 'Copy code' })).not.toBeInTheDocument();
    await user.click(within(coded).getByRole('button', { name: 'Copy code' }));
    expect(await navigator.clipboard.readText()).toBe('K7M-Q2X');
    expect(await screen.findByText('Invite code copied.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create invite link' }));
    expect(await screen.findByLabelText('Invite link')).toBeInTheDocument();
    expect(screen.getByLabelText('Join code')).toHaveValue('K7M-Q2X');
    // The new invite's Copy code button comes before the list's.
    await user.click(screen.getAllByRole('button', { name: 'Copy code' })[0]!);
    expect(await navigator.clipboard.readText()).toBe('K7M-Q2X');
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

  it('keeps invites revocable while the draft runs', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      getLeague: vi.fn(async () => league({ phase: 'drafting' })),
      getLeagueState: vi.fn(async () => state({ phase: 'drafting', allowedActions: ['revoke_invite'] })),
      listInvites: vi.fn(async () => [
        {
          id: 'i1',
          code: 'K7M-Q2X',
          status: 'active' as const,
          email: null,
          teamId: null,
          maxUses: 1,
          uses: 0,
          expiresAt: '2026-10-01T00:00:00Z'
        }
      ])
    });
    await open(api);
    expect(screen.queryByRole('button', { name: 'Create invite link' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create takeover code' })).not.toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Invites' });
    await user.click(within(list).getByRole('button', { name: 'Revoke' }));
    expect(api.revokeInvite).toHaveBeenCalledWith('L1', 'i1');
  });

  it('offers a takeover next to open-seat invites before the draft', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      getLeagueState: vi.fn(async () =>
        state({ allowedActions: ['create_invite', 'create_takeover_invite', 'revoke_invite'] })
      ),
      listInvites: vi.fn(async () => [
        {
          id: 'i-gone',
          code: 'G0N-E22',
          status: 'revoked' as const,
          email: null,
          // Its seat was removed when the league shrank.
          teamId: 'team-9',
          maxUses: 1,
          uses: 0,
          expiresAt: '2026-10-01T00:00:00Z'
        }
      ])
    });
    await open(api);
    expect(screen.getByRole('button', { name: 'Create invite link' })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Invites' });
    expect(within(list).getByText('Takes over team-9')).toBeInTheDocument();
    // An AI team whose manager has no name yet shows just the team.
    const picker = screen.getByLabelText('AI team to hand over');
    expect(within(picker).getByRole('option', { name: 'Team 4' })).toBeInTheDocument();
    await user.selectOptions(picker, 'team-4');
    await user.click(screen.getByRole('button', { name: 'Create takeover code' }));
    expect(api.createTakeoverInvite).toHaveBeenCalledWith('L1', 'team-4');
    const joinCode = await screen.findByLabelText('Join code');
    expect(joinCode).toHaveValue('T4K-30V');
    await user.click(joinCode);
    await user.click(screen.getAllByRole('button', { name: 'Copy code' })[0]!);
    expect(await navigator.clipboard.readText()).toBe('T4K-30V');
  });

  it('hands a picked AI team to a person mid-season with a takeover code', async () => {
    const user = userEvent.setup();
    const inSeason = league({
      phase: 'regular_season',
      week: 5,
      teams: [
        ...league().teams.slice(0, 3),
        team(4, {
          name: 'Robo Ballers',
          manager: { name: 'Marcus Hale', avatarSeed: 's', personality: null }
        })
      ]
    });
    const api = fakeApi({
      getLeague: vi.fn(async () => inSeason),
      getLeagueState: vi.fn(async () =>
        state({
          phase: 'regular_season',
          week: 5,
          allowedActions: ['create_takeover_invite', 'revoke_invite', 'update_league_settings']
        })
      ),
      listInvites: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([
          {
            id: 'i-takeover',
            code: 'T4K-30V',
            status: 'active',
            email: null,
            teamId: 'team-4',
            maxUses: 1,
            uses: 0,
            expiresAt: '2026-10-01T00:00:00Z'
          }
        ])
    });
    await open(api);
    // Open-seat invites stop at the draft; only the takeover form is offered.
    expect(screen.queryByRole('button', { name: 'Create invite link' })).not.toBeInTheDocument();
    const create = screen.getByRole('button', { name: 'Create takeover code' });
    expect(create).toBeDisabled();
    const picker = screen.getByLabelText('AI team to hand over');
    // Only AI-played teams can be handed over.
    expect(
      within(picker)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['Pick a team', 'Robo Ballers (Marcus Hale)']);
    await user.selectOptions(picker, 'team-4');
    await user.click(create);
    expect(api.createTakeoverInvite).toHaveBeenCalledWith('L1', 'team-4');
    expect(await screen.findByLabelText('Join code')).toHaveValue('T4K-30V');
    const list = await screen.findByRole('list', { name: 'Invites' });
    expect(within(list).getByText('Takes over Robo Ballers')).toBeInTheDocument();
    // Once above the new code, once in the list.
    expect(screen.getAllByText('Takes over Robo Ballers')).toHaveLength(2);
    expect(within(list).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });
});
