import { useEffect, useState, type ReactNode } from 'react';
import type { AppNavItem } from '@readysetcloud/ui';
import { useLeagueApi } from '../api/league';
import type { Phase } from '../api/types';
import { countLabel } from '../notifications/types';
import { draftIsLive, leaguePath, onPage, PAGE_GROUPS, type PageGroup } from '../routes/leagueRoutes';
import {
  ChatIcon,
  CreateIcon,
  DraftIcon,
  HomeIcon,
  InfoIcon,
  LeaguesIcon,
  LineupIcon,
  MatchupIcon,
  MovesIcon,
  PlayersIcon,
  SettingsIcon,
  StandingsIcon,
  TeamsIcon
} from './navIcons';

const GROUP_ICONS: Record<PageGroup['id'], ReactNode> = {
  matchup: <MatchupIcon />,
  moves: <MovesIcon />,
  standings: <StandingsIcon />,
  players: <PlayersIcon />,
  teams: <TeamsIcon />
};

/** How often the nav re-reads chat unread counts (the chat page itself keeps its own live). */
export const CHAT_UNREAD_POLL_MS = 30_000;

/** The league in a path (`/leagues/:id/...`), or null outside one (and on the create wizard). */
export function leagueIdIn(pathname: string): string | null {
  const match = /^\/leagues\/([^/]+)/.exec(pathname);
  if (match === null || match[1] === 'new') return null;
  return decodeURIComponent(match[1] as string);
}

/** The page shown, relative to `/leagues/:id/`: "team/lineup", "chat", or "". */
export function leagueSubpath(pathname: string, leagueId: string): string {
  const base = leaguePath(leagueId, '');
  return pathname.startsWith(base) ? pathname.slice(base.length) : '';
}

/**
 * The side nav (#178), as `AppNav` items. Outside a league: My Leagues and Create League. In one:
 * My Leagues (where you switch leagues), then the league's items under its name: Home, the Draft
 * while it is on, Lineup, Matchup, Moves, Standings, Players, Chat, Teams, and Settings. Items that
 * hold several pages (PAGE_GROUPS) show them as tabs, so the menu stays short on a phone. Only the
 * commissioner can change anything in Settings, so everyone else sees it as League info.
 */
export function navItems({
  pathname,
  phase,
  offers,
  unread,
  commissioner = false,
  leagueName = null
}: {
  pathname: string;
  phase: Phase | null;
  offers: number;
  unread: number;
  /** You run the league: the last item is Settings rather than League info. */
  commissioner?: boolean;
  /** Heads the league's items, so you can see which league you are in. */
  leagueName?: string | null;
}): AppNavItem[] {
  const leagueId = leagueIdIn(pathname);
  const leagues: AppNavItem = {
    id: 'leagues',
    label: 'My Leagues',
    // The list itself: `/` goes back into your last league (#212).
    href: '/leagues',
    icon: <LeaguesIcon />,
    active: pathname === '/' || pathname === '/leagues'
  };
  if (leagueId === null) {
    return [
      leagues,
      {
        id: 'create',
        label: 'Create League',
        href: '/leagues/new',
        icon: <CreateIcon />,
        active: pathname === '/leagues/new'
      }
    ];
  }
  const section = leagueName === null || leagueName === '' ? 'League' : leagueName;
  const subpath = leagueSubpath(pathname, leagueId);
  const on = (page: string) => onPage(subpath, page);
  const href = (page: string) => leaguePath(leagueId, page);
  const group = (id: PageGroup['id'], extra: Partial<AppNavItem> = {}): AppNavItem => {
    const { label, pages } = PAGE_GROUPS.find((g) => g.id === id) as PageGroup;
    return {
      id,
      label,
      href: href(pages[0].path),
      icon: GROUP_ICONS[id],
      active: pages.some((page) => on(page.path)),
      section,
      ...extra
    };
  };
  const items: AppNavItem[] = [
    leagues,
    { id: 'home', label: 'Home', href: href('home'), icon: <HomeIcon />, active: on('home'), section }
  ];
  if (draftIsLive(phase)) {
    items.push({
      id: 'draft',
      label: 'Draft',
      href: href('draft'),
      icon: <DraftIcon />,
      active: on('draft'),
      section,
      ...(phase === 'drafting' ? { badge: 'Live', badgeTone: 'success' as const } : {})
    });
  }
  items.push(
    {
      id: 'lineup',
      label: 'Lineup',
      href: href('team/lineup'),
      icon: <LineupIcon />,
      active: on('team/lineup'),
      section
    },
    group('matchup'),
    group(
      'moves',
      offers > 0
        ? {
            badge: countLabel(offers),
            badgeLabel: `${countLabel(offers)} trade ${offers === 1 ? 'offer' : 'offers'} waiting`,
            badgeTone: 'error' as const
          }
        : {}
    ),
    group('standings'),
    group('players'),
    {
      id: 'chat',
      label: 'Chat',
      href: href('chat'),
      icon: <ChatIcon />,
      active: on('chat'),
      section,
      ...(unread > 0 && !on('chat')
        ? { badge: countLabel(unread), badgeLabel: `${countLabel(unread)} unread` }
        : {})
    },
    group('teams'),
    {
      id: 'settings',
      label: commissioner ? 'Settings' : 'League info',
      href: href('settings'),
      icon: commissioner ? <SettingsIcon /> : <InfoIcon />,
      section,
      // After the draft, its results (and the league's history) are League info views.
      active: on('settings') || on('league/history') || (!draftIsLive(phase) && phase !== null && on('draft'))
    }
  );
  return items;
}

/** Unread chat messages across a league's rooms, re-read on each page change and on a timer. */
export function useChatUnread(leagueId: string | null, pathname: string): number {
  const api = useLeagueApi();
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (leagueId === null) {
      setUnread(0);
      return undefined;
    }
    let live = true;
    const load = () =>
      api.listChatRooms(leagueId).then(
        (data) => live && setUnread(data.rooms.reduce((sum, room) => sum + room.unreadCount, 0)),
        () => undefined
      );
    void load();
    const timer = setInterval(() => void load(), CHAT_UNREAD_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, leagueId, pathname]);
  return unread;
}
