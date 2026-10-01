import { useState, useSyncExternalStore } from 'react';
import { Outlet, Link, useLocation, useNavigate } from 'react-router';
import { AppNav, Container, readySetCloudServices, type AppNavLinkProps } from '@readysetcloud/ui';
import { useAuth, type IdClaims } from '@readysetcloud/ui/auth';
import { APP_NAME } from '../auth/AuthScreens';
import { transitionClick } from '../motion/pageTransition';
import { NotificationBell } from '../notifications/NotificationBell';
import { NotificationPanel } from '../notifications/NotificationPanel';
import { NotificationsProvider, useNotifications } from '../notifications/NotificationsContext';
import { CurrentLeagueProvider, useCurrentLeague } from '../routes/currentLeague';
import { forgetLastLeague } from '../routes/lastLeague';
import { useFocusMode } from './focusMode';
import { HideNavIcon, ShowNavIcon } from './navIcons';
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

/** The width at which AppNav folds into a top bar with a menu button (the design system's breakpoint). */
const PHONE = '(max-width: 640px)';

function subscribePhone(onChange: () => void): () => void {
  const list = window.matchMedia(PHONE);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

/** True on a phone-width screen, where the side nav is a top bar with its links behind a menu. */
function usePhoneLayout(): boolean {
  return useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE).matches);
}

/**
 * The shared side nav (#178), with the league's pages and their badges when you're in one. The
 * notification bell sits with its actions on a wide screen; on a phone those fold into the menu, so
 * the bell sits in the top bar beside the menu button instead, always in reach.
 */
function SideNav({
  onOpenNotifications,
  onHide
}: {
  onOpenNotifications: () => void;
  /** Folds the rail away for focus mode; only offered on a wide screen. */
  onHide: () => void;
}) {
  const { user, signOut } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const current = useCurrentLeague();
  const offers = useNotifications().offersWaiting(current?.leagueId ?? '');
  const unread = useChatUnread(current?.leagueId ?? null, pathname);
  const phone = usePhoneLayout();
  const items = navItems({
    pathname,
    phase: current?.state.data?.phase ?? null,
    offers,
    unread,
    commissioner: current?.state.data?.youAreCommissioner === true,
    leagueName: current?.state.data?.name ?? null
  });
  const bell = (
    <NotificationBell
      onOpen={onOpenNotifications}
      // On a phone: centered in the 4rem top bar, just left of the menu button.
      className={
        phone ? 'absolute right-[calc(clamp(1rem,4vw,1.5rem)+3.25rem)] top-[0.625rem] z-10' : 'relative'
      }
    />
  );
  return (
    <>
      {phone ? bell : null}
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
        actions={
          phone ? undefined : (
            <>
              <button
                type="button"
                data-testid="hide-nav"
                aria-label="Hide menu (focus mode)"
                title="Hide menu"
                onClick={onHide}
                className="app-nav-icon-btn relative"
              >
                <span className="block h-[22px] w-[22px]">
                  <HideNavIcon />
                </span>
              </button>
              {bell}
            </>
          )
        }
        onSignOut={() => {
          // The next person on this browser starts at My Leagues, not in your league (#212).
          forgetLastLeague();
          void signOut().then(() => navigate('/login', { replace: true }));
        }}
        className="sm:sticky sm:top-0 sm:h-screen sm:self-start sm:overflow-y-auto"
      />
    </>
  );
}

/**
 * Focus mode's stand-in for the rail: a button to bring the menu back and the bell, pinned to the
 * top-left corner over the page so nothing else takes up room.
 */
function FocusBar({ onShow, onOpenNotifications }: { onShow: () => void; onOpenNotifications: () => void }) {
  return (
    <div
      data-testid="focus-bar"
      className="fixed left-3 top-3 z-30 flex items-center gap-1 rounded-full border border-border bg-surface p-1 shadow-md"
    >
      <button
        type="button"
        data-testid="show-nav"
        aria-label="Show menu"
        title="Show menu"
        onClick={onShow}
        className="app-nav-icon-btn relative"
      >
        <span className="block h-[22px] w-[22px]">
          <ShowNavIcon />
        </span>
      </button>
      <NotificationBell onOpen={onOpenNotifications} className="relative" />
    </div>
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
 * The signed-in shell (#178): the side nav (a top bar with a menu on a phone) with the notification
 * bell, and beside it the page. You switch leagues from My Leagues, so there is no bar over the page.
 */
export function AppLayout() {
  const { pathname } = useLocation();
  const [panelOpen, setPanelOpen] = useState(false);
  const [badge, setBadge] = useState<string | null>(null);
  const [focus, setFocus] = useFocusMode();
  // A phone's nav is already just a top bar, so focus mode is for wide screens.
  const phone = usePhoneLayout();
  const focused = focus && !phone;

  return (
    <NotificationsProvider>
      <CurrentLeagueProvider leagueId={leagueIdIn(pathname)}>
        <PageTitle badge={badge} />
        <div className="relative flex min-h-screen flex-col bg-background text-foreground sm:flex-row">
          {focused ? (
            <FocusBar onShow={() => setFocus(false)} onOpenNotifications={() => setPanelOpen(true)} />
          ) : (
            <SideNav onOpenNotifications={() => setPanelOpen(true)} onHide={() => setFocus(true)} />
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            {panelOpen ? <NotificationPanel onClose={() => setPanelOpen(false)} /> : null}
            <main id="main-content" className="flex-1">
              {/* In focus mode the page takes the full width, clear of the corner bar. */}
              <Container
                className={focused ? 'pb-6 pt-16' : 'py-6'}
                style={{ maxWidth: focused ? 'none' : '90rem' }}
              >
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
