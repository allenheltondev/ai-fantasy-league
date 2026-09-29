import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { documentTitle, pageName, TitleBadgeContext, usePageTitle, useTitleBadge } from './pageTitle';

const TEAMS = [{ id: 'team-4', name: 'Team 4' }];

describe('pageName (#212)', () => {
  it.each([
    ['/', 'My Leagues'],
    ['/leagues', 'My Leagues'],
    ['/leagues/', 'My Leagues'],
    ['/leagues/new', 'Create League'],
    ['/nowhere', 'Page not found'],
    ['/leagues/L1/home', 'Home'],
    ['/leagues/L1/draft', 'Draft'],
    ['/leagues/L1/chat', 'Chat'],
    ['/leagues/L1/team/matchup', 'Matchup'],
    ['/leagues/L1/team/moves', 'Roster & moves'],
    ['/leagues/L1/team/profile', 'Team profile'],
    ['/leagues/L1/team/teams', 'Other teams'],
    ['/leagues/L1/team', 'Lineup'],
    ['/leagues/L1/league/players', 'Players'],
    ['/leagues/L1/league/draft', 'League info'],
    ['/leagues/L1/league/history', 'League info'],
    ['/leagues/L1/league', 'Scoreboard'],
    ['/leagues/L1/settings', 'League info'],
    ['/leagues/L1/roster', 'League'],
    ['/leagues/L1', 'League']
  ])('%s is %s', (path, name) => {
    expect(pageName(path, { teams: TEAMS })).toEqual({ heading: name, title: name });
  });

  it("calls Settings what the nav calls it: the commissioner's Settings, everyone else's League info", () => {
    expect(pageName('/leagues/L1/settings', { commissioner: true }).title).toBe('Settings');
    expect(pageName('/leagues/L1/settings', { commissioner: false }).title).toBe('League info');
  });

  it("names another team's tab after the team, under the Other teams heading", () => {
    expect(pageName('/leagues/L1/team/teams/team-4', { teams: TEAMS })).toEqual({
      heading: 'Other teams',
      title: 'Team 4'
    });
    // Before the teams load, or for a team that isn't there.
    expect(pageName('/leagues/L1/team/teams/team-9', { teams: TEAMS }).title).toBe('Other teams');
    expect(pageName('/leagues/L1/team/teams/team-4').title).toBe('Other teams');
  });

  it('decodes ids in the path', () => {
    expect(
      pageName('/leagues/L%201/team/teams/a%20b', { teams: [{ id: 'a b', name: 'Spaced' }] }).title
    ).toBe('Spaced');
  });
});

describe('documentTitle (#212)', () => {
  it('reads page · league · app inside a league, page · app outside one', () => {
    expect(documentTitle({ page: 'Matchup', league: 'Test League' })).toBe(
      'Matchup · Test League · AI Fantasy Football'
    );
    expect(documentTitle({ page: 'My Leagues' })).toBe('My Leagues · AI Fantasy Football');
    expect(documentTitle({ page: 'Chat', league: '' })).toBe('Chat · AI Fantasy Football');
  });

  it('leads with a live badge', () => {
    expect(documentTitle({ page: 'Draft', league: 'Test League', badge: '⏰ Your pick' })).toBe(
      '⏰ Your pick · Draft · Test League · AI Fantasy Football'
    );
  });
});

describe('usePageTitle (#212)', () => {
  it('sets the title, follows changes, and restores the one before on unmount', () => {
    document.title = 'Before';
    const { rerender, unmount } = renderHook(({ title }) => usePageTitle(title), {
      initialProps: { title: 'Home · AI Fantasy Football' }
    });
    expect(document.title).toBe('Home · AI Fantasy Football');
    rerender({ title: 'Chat · AI Fantasy Football' });
    expect(document.title).toBe('Chat · AI Fantasy Football');
    unmount();
    expect(document.title).toBe('Before');
  });
});

describe('useTitleBadge inside the shell (#212)', () => {
  it('hands the badge to the shell while active, and takes it back', () => {
    const setBadge = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TitleBadgeContext.Provider value={setBadge}>{children}</TitleBadgeContext.Provider>
    );
    document.title = 'Draft';
    const { rerender, unmount } = renderHook(({ on }) => useTitleBadge(on, '⏰ Your pick'), {
      initialProps: { on: false },
      wrapper
    });
    expect(setBadge).not.toHaveBeenCalled();
    rerender({ on: true });
    expect(setBadge).toHaveBeenLastCalledWith('⏰ Your pick');
    unmount();
    expect(setBadge).toHaveBeenLastCalledWith(null);
    // The shell builds the title; the hook leaves it alone.
    expect(document.title).toBe('Draft');
  });
});
