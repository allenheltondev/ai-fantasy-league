import { useEffect, useState, type ReactNode } from 'react';
import type { AppNavItem } from '@readysetcloud/ui';
import { useLeagueApi } from '../api/league';
import type { Phase } from '../api/types';
import { countLabel } from '../notifications/types';
import { draftIsLive, leaguePath, TEAM_PAGES, type TeamPagePath } from '../routes/leagueRoutes';
import {
  AchievementsIcon,
  ChatIcon,
  CreateIcon,
  DraftIcon,
  HomeIcon,
  InfoIcon,
  LeagueIcon,
  LeaguesIcon,
  LineupIcon,
  MatchupIcon,
  MovesIcon,
  ProfileIcon,
  SettingsIcon,
  TeamsIcon,
  TradesIcon
} from './navIcons';

/** How often the nav re-reads chat unread counts (the chat page itself keeps its own live). */
export const CHAT_UNREAD_POLL_MS = 30_000;

const TEAM_ICONS: Record<TeamPagePath, ReactNode> = {
  lineup: <LineupIcon />,
  matchup: <MatchupIcon />,
  moves: <MovesIcon />,
  trades: <TradesIcon />,
  achievements: <AchievementsIcon />,
  profile: <ProfileIcon />,
  teams: <TeamsIcon />
};

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
 * My Leagues, then the league (Home, the Draft while it is on, Scoreboard, Chat), then My
 * Team's pages, then Settings, with the trade-offer and chat-unread badges. Only the commissioner
 * can change anything there, so everyone else sees the same page as League info.
 */
export function navItems({
  pathname,
  phase,
  offers,
  unread,
  commissioner = false
}: {
  pathname: string;
  phase: Phase | null;
  offers: number;
  unread: number;
  /** You run the league: the last item is Settings rather than League info. */
  commissioner?: boolean;
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
  const subpath = leagueSubpath(pathname, leagueId);
  const on = (page: string) => subpath === page || subpath.startsWith(`${page}/`);
  const href = (page: string) => leaguePath(leagueId, page);
  const items: AppNavItem[] = [
    leagues,
    {
      id: 'home',
      label: 'Home',
      href: href('home'),
      icon: <HomeIcon />,
      active: on('home'),
      section: 'League'
    }
  ];
  if (draftIsLive(phase)) {
    items.push({
      id: 'draft',
      label: 'Draft',
      href: href('draft'),
      icon: <DraftIcon />,
      active: on('draft'),
      section: 'League',
      ...(phase === 'drafting' ? { badge: 'Live', badgeTone: 'success' as const } : {})
    });
  }
  items.push(
    {
      id: 'league',
      label: 'Scoreboard',
      href: href('league'),
      icon: <LeagueIcon />,
      // After the draft, its results are a League page (the old /draft link still works).
      active: on('league') || (phase !== null && !draftIsLive(phase) && on('draft')),
      section: 'League'
    },
    {
      id: 'chat',
      label: 'Chat',
      href: href('chat'),
      icon: <ChatIcon />,
      active: on('chat'),
      section: 'League',
      ...(unread > 0 && !on('chat')
        ? { badge: countLabel(unread), badgeLabel: `${countLabel(unread)} unread` }
        : {})
    },
    ...TEAM_PAGES.map((page): AppNavItem => ({
      id: `team-${page.path}`,
      label: page.label,
      href: href(`team/${page.path}`),
      icon: TEAM_ICONS[page.path],
      active: on(`team/${page.path}`),
      section: 'My Team',
      ...(page.path === 'trades' && offers > 0
        ? {
            badge: countLabel(offers),
            badgeLabel: `${countLabel(offers)} ${offers === 1 ? 'offer' : 'offers'} waiting`,
            badgeTone: 'error' as const
          }
        : {})
    })),
    {
      id: 'settings',
      label: commissioner ? 'Settings' : 'League info',
      href: href('settings'),
      icon: commissioner ? <SettingsIcon /> : <InfoIcon />,
      active: on('settings')
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
