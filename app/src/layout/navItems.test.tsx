import { render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import type { AppNavItem } from '@readysetcloud/ui';
import { LeagueApiContext } from '../api/league';
import { TeamFace } from '../chat/mentions';
import { AgentAvatar, ManagerTag } from '../components/AgentAvatar';
import { TeamMark } from '../draft/marks';
import { TeamAvatar } from '../features/home/TeamBadge';
import { draftIsLive, leagueTabs, movedSectionTarget, otherTeamPath, teamPath } from '../routes/leagueRoutes';
import { useLeagueOutlet } from '../routes/leagueContext';
import {
  LeagueTeamsContext,
  rollTeamAvatarSeed,
  teamAvatarSeed,
  useTeamAvatarSeed
} from '../routes/leagueTeams';
import { fakeApi, state, team } from '../test/fakeApi';
import { renderApp, signInAs } from '../test/render';
import { leagueIdIn, leagueSubpath, navItems } from './navItems';

const ALICE = { sub: 'alice', email: 'alice@example.com', given_name: 'Alice' };

const find = (items: AppNavItem[], id: string) => items.find((i) => i.id === id);
const nav = (pathname: string, extra: Partial<Parameters<typeof navItems>[0]> = {}) =>
  navItems({ pathname, phase: 'regular_season', offers: 0, unread: 0, ...extra });

describe('the league IA (#178)', () => {
  it('moves old section URLs to their new homes, keeping the query', () => {
    expect(movedSectionTarget('roster', '')).toBe('team/lineup');
    expect(movedSectionTarget('matchup', '?team=team-3')).toBe('team/matchup?team=team-3');
    expect(movedSectionTarget('trades', '?trade=t1')).toBe('team/trades?trade=t1');
    expect(movedSectionTarget('players', '')).toBe('league/players');
    expect(movedSectionTarget('standings', '')).toBe('league/standings');
    expect(movedSectionTarget('standings', '?view=playoffs')).toBe('league/playoffs');
    expect(movedSectionTarget('standings', '?view=history&x=1')).toBe('league/history?x=1');
    expect(movedSectionTarget('standings', '?view=nope')).toBe('league/standings');
  });

  it('keeps the Draft a section until it is over, then a League tab', () => {
    expect(draftIsLive('setup')).toBe(true);
    expect(draftIsLive('drafting')).toBe(true);
    expect(draftIsLive('regular_season')).toBe(false);
    expect(leagueTabs('drafting').map((t) => t.path)).not.toContain('draft');
    expect(leagueTabs(null).map((t) => t.path)).not.toContain('draft');
    expect(leagueTabs('complete').map((t) => t.path)).toContain('draft');
  });

  it('builds and reads paths with encoded ids', () => {
    expect(teamPath('a b', 'lineup')).toBe('/leagues/a%20b/team/lineup');
    expect(otherTeamPath('L1', 'team/2')).toBe('/leagues/L1/team/teams/team%2F2');
    expect(leagueIdIn('/leagues/a%20b/home')).toBe('a b');
    expect(leagueIdIn('/leagues/new')).toBeNull();
    expect(leagueIdIn('/')).toBeNull();
    expect(leagueSubpath('/leagues/L1/team/lineup', 'L1')).toBe('team/lineup');
    expect(leagueSubpath('/elsewhere', 'L1')).toBe('');
  });
});

describe('the side nav items', () => {
  it('lists My Leagues and Create League outside a league', () => {
    const items = nav('/leagues/new', { phase: null });
    expect(items.map((i) => i.label)).toEqual(['My Leagues', 'Create League']);
    expect(find(items, 'create')?.active).toBe(true);
    expect(find(nav('/', { phase: null }), 'leagues')?.active).toBe(true);
  });

  it('groups a league in setup under League and My Team, the Draft among them', () => {
    const items = nav('/leagues/L1/home', { phase: 'setup' });
    expect(items.map((i) => [i.label, i.section ?? null])).toEqual([
      ['My Leagues', null],
      ['Home', 'League'],
      ['Draft', 'League'],
      ['Scoreboard', 'League'],
      ['Chat', 'League'],
      ['Lineup', 'My Team'],
      ['Matchup', 'My Team'],
      ['Roster & moves', 'My Team'],
      ['Trades', 'My Team'],
      ['Achievements', 'My Team'],
      ['Team profile', 'My Team'],
      ['Other teams', 'My Team'],
      ['League info', null]
    ]);
    expect(find(items, 'home')?.active).toBe(true);
    expect(find(items, 'draft')?.badge).toBeUndefined();
    expect(items.every((i) => i.icon !== undefined)).toBe(true);
  });

  it('calls the last item Settings only for the commissioner, League info for everyone else', () => {
    const member = find(nav('/leagues/L1/settings'), 'settings');
    expect(member).toMatchObject({ label: 'League info', href: '/leagues/L1/settings', active: true });
    const commissioner = find(nav('/leagues/L1/home', { commissioner: true }), 'settings');
    expect(commissioner).toMatchObject({ label: 'Settings', href: '/leagues/L1/settings', active: false });
    expect(member?.icon).not.toEqual(commissioner?.icon);
  });

  it('marks the draft live, then folds it into Scoreboard once it is over', () => {
    const drafting = nav('/leagues/L1/draft', { phase: 'drafting' });
    expect(find(drafting, 'draft')).toMatchObject({ active: true, badge: 'Live', badgeTone: 'success' });
    const after = nav('/leagues/L1/draft');
    expect(find(after, 'draft')).toBeUndefined();
    expect(find(after, 'league')?.active).toBe(true);
  });

  it('marks the page you are on, another team counting as Other teams', () => {
    const items = nav('/leagues/L1/team/teams/team-2');
    expect(find(items, 'team-teams')?.active).toBe(true);
    expect(find(items, 'team-lineup')?.active).toBe(false);
    expect(find(nav('/leagues/L1/league/standings'), 'league')?.active).toBe(true);
  });

  it('carries the trade-offer and chat-unread badges, and drops chat’s while you are in it', () => {
    const items = nav('/leagues/L1/home', { offers: 2, unread: 120 });
    expect(find(items, 'team-trades')).toMatchObject({
      badge: '2',
      badgeLabel: '2 offers waiting',
      badgeTone: 'error'
    });
    expect(find(items, 'chat')).toMatchObject({ badge: '99+', badgeLabel: '99+ unread' });
    const one = nav('/leagues/L1/chat', { offers: 1, unread: 3 });
    expect(find(one, 'team-trades')?.badgeLabel).toBe('1 offer waiting');
    expect(find(one, 'chat')?.badge).toBeUndefined();
  });
});

describe('the shell', () => {
  it('shows the chat unread count and switches leagues from the header bar', async () => {
    const user = userEvent.setup();
    signInAs(ALICE);
    const api = fakeApi({
      listMyLeagues: vi.fn(async () => [
        { id: 'L1', name: 'Sunday Funday' },
        { id: 'L2', name: 'Monday Mayhem' }
      ]) as never,
      listChatRooms: vi.fn(async () => ({
        defaultRoomId: 'trash-talk',
        rooms: [
          { roomId: 'trash-talk', unreadCount: 2 },
          { roomId: 'draft', unreadCount: 1 }
        ]
      }))
    });
    renderApp('/leagues/L1/home', undefined, api);
    const sideNav = await screen.findByRole('navigation', { name: 'Primary navigation' });
    expect(await within(sideNav).findByRole('link', { name: 'Chat 3 unread' })).toBeInTheDocument();
    const switcher = await screen.findByLabelText('League');
    await waitFor(() => expect(within(switcher).getAllByRole('option')).toHaveLength(2));
    await user.selectOptions(switcher, 'L2');
    await waitFor(() => expect(api.getLeagueState).toHaveBeenCalledWith('L2'));
  });

  it('shares every team with the pages, for their avatars', async () => {
    signInAs(ALICE);
    const api = fakeApi({
      getLeagueState: vi.fn(async () =>
        state({ teams: [team(1, { name: "Alice's Team", ownerName: 'Alice', avatarSeed: 'a1' })] })
      )
    });
    renderApp('/leagues/L1/team/teams', undefined, api);
    expect(await screen.findByText('No other teams')).toBeInTheDocument();
  });
});

describe('team avatars (#178)', () => {
  const teams = [
    team(1, {
      name: "Alice's Team",
      seatType: 'human',
      open: false,
      ownerName: 'Alice',
      avatarSeed: 'alice-seed'
    }),
    team(2, { name: 'Robots', manager: { name: 'Mei Park', avatarSeed: 'mei', personality: null } })
  ];

  it('picks an AI manager’s avatar, else the one a person picked', () => {
    expect(teamAvatarSeed(teams[1]!)).toBe('mei');
    expect(teamAvatarSeed(teams[0]!)).toBe('alice-seed');
    expect(teamAvatarSeed({ avatarSeed: null, manager: null })).toBeNull();
    expect(rollTeamAvatarSeed(() => 0)).toBe('aaaaaaaaaa');
    expect(rollTeamAvatarSeed()).toMatch(/^[a-z0-9]{10}$/);
  });

  it('shows a person’s picked avatar wherever manager avatars show', () => {
    const seat = { teamId: 'team-1', teamName: "Alice's Team", ownerName: 'Alice', manager: null };
    render(
      <MemoryRouter>
        <LeagueApiContext.Provider value={fakeApi()}>
          <LeagueTeamsContext.Provider value={teams}>
            <div data-testid="tag">
              <ManagerTag manager={null} teamId="team-1" />
            </div>
            <div data-testid="dashboard">
              <TeamAvatar team={seat} />
            </div>
            <div data-testid="draft">
              <TeamMark teamId="team-1" teamName="Alice's Team" />
            </div>
            <div data-testid="chat">
              <TeamFace team={{ id: 'team-1', name: "Alice's Team", ownerName: 'Alice' }} />
            </div>
            <div data-testid="none">
              <ManagerTag manager={null} teamId="team-9" />
            </div>
          </LeagueTeamsContext.Provider>
        </LeagueApiContext.Provider>
      </MemoryRouter>
    );
    // The same seed draws the same picture: count its cells.
    const want = render(<AgentAvatar seed="alice-seed" label="x" />).container.querySelectorAll(
      'rect'
    ).length;
    const cells = (id: string) => screen.getByTestId(id).querySelectorAll('rect').length;
    expect(within(screen.getByTestId('tag')).getByText('Alice')).toBeInTheDocument();
    for (const id of ['tag', 'dashboard', 'draft', 'chat']) expect(cells(id)).toBe(want);
    expect(screen.getByTestId('none')).toBeEmptyDOMElement();
  });
});

describe('outside a league', () => {
  it('has no league context and no picked avatars', () => {
    expect(renderHook(() => useLeagueOutlet(), { wrapper: MemoryRouter }).result.current).toBeNull();
    expect(renderHook(() => useTeamAvatarSeed(null)).result.current).toBeNull();
    expect(renderHook(() => useTeamAvatarSeed('team-1')).result.current).toBeNull();
  });
});
