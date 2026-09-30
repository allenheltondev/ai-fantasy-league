/**
 * The league's information architecture (#178): its top-level sections, the pages under My Team
 * and League, and where each older section URL now lives. Links and redirects build on these, so a
 * page moves in one place.
 */

import type { Phase } from '../api/types';

/** My Team's pages, in side-nav order. */
export const TEAM_PAGES = [
  { path: 'lineup', label: 'Lineup' },
  { path: 'matchup', label: 'Matchup' },
  { path: 'moves', label: 'Roster & moves' },
  { path: 'trades', label: 'Trades' },
  { path: 'achievements', label: 'Achievements' },
  { path: 'profile', label: 'Team profile' },
  { path: 'teams', label: 'Other teams' }
] as const;

export type TeamPagePath = (typeof TEAM_PAGES)[number]['path'];

/** The League pages that have a side-nav item of their own, in nav order (#178). */
export const LEAGUE_PAGES = [
  { path: 'scoreboard', label: 'Scoreboard' },
  { path: 'standings', label: 'Standings' },
  { path: 'playoffs', label: 'Playoffs' },
  { path: 'transactions', label: 'Transactions' },
  { path: 'players', label: 'Players' }
] as const;

export type LeagueTabPath = (typeof LEAGUE_PAGES)[number]['path'];

/**
 * Side-nav items that hold more than one page, shown as tabs across the top of each: one nav item
 * per job, so the menu stays short on a phone. Paths are relative to the league; the first page is
 * where the nav item goes.
 */
export const PAGE_GROUPS = [
  {
    id: 'matchup',
    label: 'Matchup',
    pages: [
      { path: 'team/matchup', label: 'My matchup' },
      { path: 'league/scoreboard', label: 'Scoreboard' }
    ]
  },
  {
    id: 'moves',
    label: 'Moves',
    pages: [
      { path: 'team/moves', label: 'Roster & moves' },
      { path: 'team/trades', label: 'Trades' }
    ]
  },
  {
    id: 'standings',
    label: 'Standings',
    pages: [
      { path: 'league/standings', label: 'Standings' },
      { path: 'league/playoffs', label: 'Playoffs' }
    ]
  },
  {
    id: 'players',
    label: 'Players',
    pages: [
      { path: 'league/players', label: 'Players' },
      { path: 'league/transactions', label: 'Transactions' }
    ]
  },
  {
    id: 'teams',
    label: 'Teams',
    pages: [
      { path: 'team/profile', label: 'My team' },
      { path: 'team/teams', label: 'Other teams' },
      { path: 'team/achievements', label: 'Achievements' }
    ]
  }
] as const;

export type PageGroup = (typeof PAGE_GROUPS)[number];

/** Whether `subpath` (relative to the league) is `page` or one under it. */
export function onPage(subpath: string, page: string): boolean {
  return subpath === page || subpath.startsWith(`${page}/`);
}

/** The nav item a page (relative to the league) sits under, if it shares one with other pages. */
export function pageGroupOf(subpath: string): PageGroup | null {
  return PAGE_GROUPS.find((group) => group.pages.some((page) => onPage(subpath, page.path))) ?? null;
}

/** Before and during the draft, the Draft section is its own item; afterwards its results are in League info. */
export function draftIsLive(phase: Phase | null | undefined): boolean {
  return phase === 'setup' || phase === 'drafting';
}

/** `/leagues/:id/<page>`, with the id encoded. */
export function leaguePath(leagueId: string, page: string): string {
  return `/leagues/${encodeURIComponent(leagueId)}/${page}`;
}

export const teamPath = (leagueId: string, page: TeamPagePath) => leaguePath(leagueId, `team/${page}`);
export const leagueTabPath = (leagueId: string, tab: LeagueTabPath) => leaguePath(leagueId, `league/${tab}`);
/** A read-only view of another team, with "Propose trade" as its only action. */
export const otherTeamPath = (leagueId: string, teamId: string) =>
  leaguePath(leagueId, `team/teams/${encodeURIComponent(teamId)}`);

/**
 * Where each section URL from before #178 now lives, relative to the league. Deep links (old
 * bookmarks, notifications already sent) redirect, keeping their query (`?trade=`, `?team=`).
 */
export const MOVED_SECTIONS = {
  roster: 'team/lineup',
  matchup: 'team/matchup',
  trades: 'team/trades',
  standings: 'league/standings',
  players: 'league/players'
} as const;

/**
 * The new home of an old section URL. Standings kept its playoffs and history as `?view=` tabs;
 * playoffs is a League page of its own now, and history lives in League info.
 */
export function movedSectionTarget(section: keyof typeof MOVED_SECTIONS, search: string): string {
  const params = new URLSearchParams(search);
  if (section === 'standings') {
    const view = params.get('view');
    params.delete('view');
    const rest = params.toString();
    if (view === 'history') return `settings?view=history${rest === '' ? '' : `&${rest}`}`;
    return `league/${view === 'playoffs' ? 'playoffs' : 'standings'}${rest === '' ? '' : `?${rest}`}`;
  }
  return `${MOVED_SECTIONS[section]}${search}`;
}
