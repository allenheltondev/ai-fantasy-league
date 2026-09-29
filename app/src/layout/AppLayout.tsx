import { useState } from 'react';
import { Outlet, Link, useLocation, useNavigate } from 'react-router';
import { AppNav, Container, readySetCloudServices, type AppNavLinkProps } from '@readysetcloud/ui';
import { useAuth, type IdClaims } from '@readysetcloud/ui/auth';
import { APP_NAME } from '../auth/AuthScreens';
import { transitionClick } from '../motion/pageTransition';
import { NotificationPanel } from '../notifications/NotificationPanel';
import { NotificationsProvider, useNotifications } from '../notifications/NotificationsContext';
import { CurrentLeagueProvider, useCurrentLeague } from '../routes/currentLeague';
import { PageHeaderBar } from './PageHeaderBar';
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
  const items = navItems({ pathname, phase: current?.state.data?.phase ?? null, offers, unread });
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
        void signOut().then(() => navigate('/login', { replace: true }));
      }}
      className="sm:sticky sm:top-0 sm:h-screen sm:self-start sm:overflow-y-auto"
    />
  );
}

/**
 * The signed-in shell (#178): the side nav (a top bar with a menu on a phone), and beside it a
 * quiet header bar (the league switcher and the notification bell) over the page.
 */
export function AppLayout() {
  const { pathname } = useLocation();
  const [panelOpen, setPanelOpen] = useState(false);

  return (
    <NotificationsProvider>
      <CurrentLeagueProvider leagueId={leagueIdIn(pathname)}>
        <div className="flex min-h-screen flex-col bg-background text-foreground sm:flex-row">
          <SideNav />
          <div className="flex min-w-0 flex-1 flex-col">
            <PageHeaderBar onOpenNotifications={() => setPanelOpen(true)} />
            {panelOpen ? <NotificationPanel onClose={() => setPanelOpen(false)} /> : null}
            <main id="main-content" className="flex-1">
              <Container className="py-6" style={{ maxWidth: '90rem' }}>
                <Outlet />
              </Container>
            </main>
          </div>
        </div>
      </CurrentLeagueProvider>
    </NotificationsProvider>
  );
}
