import { createContext, useContext, useEffect } from 'react';
import { APP_NAME } from '../auth/AuthScreens';
import { LEAGUE_PAGES, TEAM_PAGES } from '../routes/leagueRoutes';
import { leagueIdIn, leagueSubpath } from './navItems';

/**
 * What a page is called (#212), from its route: the name of its (visually hidden) `<h1>`, and the
 * name its browser tab leads with. They differ only on a sub-view the side nav doesn't name, like
 * another team's page: its heading is the section ("Other teams"), its tab the team ("Team 4").
 */
export interface PageName {
  heading: string;
  title: string;
}

const same = (name: string): PageName => ({ heading: name, title: name });

/** The league pieces a page's name can depend on. */
export interface PageNameContext {
  /** You run the league: its last page is Settings rather than League info. */
  commissioner?: boolean;
  /** The league's teams, to name another team's page. */
  teams?: readonly { id: string; name: string }[];
}

/** The page at `pathname`. Pages outside a league name themselves visibly; these are for the tab. */
export function pageName(pathname: string, context: PageNameContext = {}): PageName {
  const leagueId = leagueIdIn(pathname);
  if (leagueId === null) {
    if (pathname === '/' || pathname === '/leagues' || pathname === '/leagues/') return same('My Leagues');
    if (pathname === '/leagues/new') return same('Create League');
    return same('Page not found');
  }
  const [section = '', page = '', detail] = leagueSubpath(pathname, leagueId)
    .split('/')
    .map((part) => decodeURIComponent(part));
  switch (section) {
    case 'home':
      return same('Home');
    case 'draft':
      return same('Draft');
    case 'chat':
      return same('Chat');
    case 'settings':
      return same(context.commissioner === true ? 'Settings' : 'League info');
    case 'league':
      if (page === 'history' || page === 'draft') return same('League info');
      return same(LEAGUE_PAGES.find((tab) => tab.path === page)?.label ?? 'Scoreboard');
    case 'team': {
      if (page === 'teams' && detail !== undefined && detail !== '') {
        const team = context.teams?.find((t) => t.id === detail);
        return { heading: 'Other teams', title: team?.name ?? 'Other teams' };
      }
      return same(TEAM_PAGES.find((p) => p.path === page)?.label ?? 'Lineup');
    }
    default:
      return same('League');
  }
}

/**
 * The tab title: `<Page> · <League> · AI Fantasy Football` inside a league, `<Page> · AI Fantasy
 * Football` outside one (or while the league's name loads), led by a live badge ("⏰ Your pick").
 */
export function documentTitle({
  page,
  league = null,
  badge = null
}: {
  page: string;
  league?: string | null;
  badge?: string | null;
}): string {
  return [badge, page, league, APP_NAME].filter((part) => part !== null && part !== '').join(' · ');
}

/** Sets the tab title while mounted, and puts back the one before it on unmount. */
export function usePageTitle(title: string) {
  useEffect(() => {
    const previous = document.title;
    return () => {
      document.title = previous;
    };
  }, []);
  useEffect(() => {
    document.title = title;
  }, [title]);
}

/** The shell's slot for a page's live badge, which leads the tab title. */
export const TitleBadgeContext = createContext<((badge: string | null) => void) | null>(null);

/**
 * Leads the tab title with `badge` while `active` (it's your pick), so a manager in another tab
 * sees it. Inside the shell the badge joins the one title it builds; a page rendered on its own
 * prefixes whatever title is there and restores it afterwards.
 */
export function useTitleBadge(active: boolean, badge: string) {
  const setBadge = useContext(TitleBadgeContext);
  useEffect(() => {
    if (!active) return undefined;
    if (setBadge !== null) {
      setBadge(badge);
      return () => setBadge(null);
    }
    const original = document.title;
    document.title = `${badge} · ${original}`;
    return () => {
      document.title = original;
    };
  }, [active, badge, setBadge]);
}
