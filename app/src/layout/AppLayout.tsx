import { useState } from 'react';
import { Outlet, Link, useLocation, useNavigate } from 'react-router';
import { AppNav, Container, readySetCloudServices, type AppNavLinkProps } from '@readysetcloud/ui';
import { useAuth, type IdClaims } from '@readysetcloud/ui/auth';
import { APP_NAME } from '../auth/AuthScreens';
import { transitionClick } from '../motion/pageTransition';
import { NotificationPanel } from '../notifications/NotificationPanel';
import { NotificationsProvider, useNotifications } from '../notifications/NotificationsContext';
import { CurrentLeagueProvider, useCurrentLeague } from '../routes/currentLeague';
import { forgetLastLeague } from '../routes/lastLeague';
import { PageHeaderBar } from './PageHeaderBar';
import { documentTitle, pageName, TitleBadgeContext, usePageTitle } from './pageTitle';
import { leagueIdIn, navItems, useChatUnread } from './navItems';

/**
 * AppNav's in-app links through the router, so navigation stays client-side, cross-fading between
 * pages where the browser can. Module scope, for a stable component identity.
 */
function RouterNavLink({ href, ...rest }: AppNavLinkProps) {
  const navigate = useNavigate();
  return <Link to={href} {...rest} onClick={transitionClick(() => navigate(href))} />;
}

export function displayName(user: IdClaims): string | undefined {
  const name = [user.given_name, user.family_name].filter(Boolean).join(' ');
  if (name) return name;
  return typeof user.email === 'string' ? user.email : undefined;
}

/** Which top-level item a path belongs to. */
export function activeNavId(pathname: string): 'leagues' | 'create' | null {
  if (pathname === '/leagues/new') return 'create';
  if (pathname === '/' || pathname.startsWith('/leagues')) return 'leagues';
  return null;
}

/** The shared side nav (#178), with the league's sections and their badges when you're in one. */
function SideNav() {
  const { user, signOut } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const current = useCurrentLeague();
  const offers = useNotifications().offersWaiting(current?.leagueId ?? '');
  const unread = useChatUnread(current?.leagueId ?? null, pathname);
  const items = navItems({
    pathname,
    phase: current?.state.data?.phase ?? null,
    offers,
    unread,
    commissioner: current?.state.data?.youAreCommissioner === true
  });
  return (
    <AppNav
      appName={APP_NAME}
      currentServiceId="fantasy"
      homeHref="/"
      layout="side"
      linkComponent={RouterNavLink}
      services={readySetCloudServices}
      authState="authenticated"
      user={{ name: displayName(user), email: typeof user.email === 'string' ? user.email : undefined }}
      navItems={items}
      onSignOut={() => {
        // The next person on this browser starts at My Leagues, not in your league (#212).
        forgetLastLeague();
        void signOut().then(() => navigate('/login', { replace: true }));
      }}
      className="sm:sticky sm:top-0 sm:h-screen sm:self-start sm:overflow-y-auto"
    />
  );
}

/**
 * The browser tab's title (#212), set here once for every page from its route: "Matchup · Test
 * League · AI Fantasy Football", led by a page's live badge ("⏰ Your pick").
 */
function PageTitle({ badge }: { badge: string | null }) {
  const { pathname } = useLocation();
  const data = useCurrentLeague()?.state.data ?? null;
  const page = pageName(pathname, { commissioner: data?.youAreCommissioner === true, teams: data?.teams });
  usePageTitle(documentTitle({ page: page.title, league: data?.name ?? null, badge }));
  return null;
}

/**
 * The signed-in shell (#178): the side nav (a top bar with a menu on a phone), and beside it a
 * quiet header bar (the league switcher and the notification bell) over the page.
 */
export function AppLayout() {
  const { pathname } = useLocation();
  const [panelOpen, setPanelOpen] = useState(false);
  const [badge, setBadge] = useState<string | null>(null);

  return (
    <NotificationsProvider>
      <CurrentLeagueProvider leagueId={leagueIdIn(pathname)}>
        <PageTitle badge={badge} />
        <div className="flex min-h-screen flex-col bg-background text-foreground sm:flex-row">
          <SideNav />
          <div className="flex min-w-0 flex-1 flex-col">
            <PageHeaderBar onOpenNotifications={() => setPanelOpen(true)} />
            {panelOpen ? <NotificationPanel onClose={() => setPanelOpen(false)} /> : null}
            <main id="main-content" className="flex-1">
              <Container className="py-6" style={{ maxWidth: '90rem' }}>
                <TitleBadgeContext.Provider value={setBadge}>
                  <Outlet />
                </TitleBadgeContext.Provider>
              </Container>
            </main>
          </div>
        </div>
      </CurrentLeagueProvider>
    </NotificationsProvider>
  );
}
