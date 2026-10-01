import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
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
import { CollapseNavIcon, ExpandNavIcon } from './navIcons';
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
 *
 * On a wide screen the rail can fold to icons only (focus mode), giving the page the room. The
 * fold toggle sits on the rail's edge and shows when you hover the rail or tab to it.
 */
function SideNav({
  onOpenNotifications,
  collapsed,
  onCollapse
}: {
  onOpenNotifications: () => void;
  /** Icons only; never on a phone, where the rail is a top bar. */
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
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
  const rail = useRef<HTMLDivElement>(null);
  useRailTooltips(rail, collapsed);
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
      <div ref={rail} className="nav-rail sm:sticky sm:top-0 sm:z-20 sm:h-screen sm:self-start">
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
          actions={phone ? undefined : bell}
          onSignOut={() => {
            // The next person on this browser starts at My Leagues, not in your league (#212).
            forgetLastLeague();
            void signOut().then(() => navigate('/login', { replace: true }));
          }}
          className={`sm:overflow-y-auto${collapsed ? ' app-nav-rail-collapsed' : ''}`}
        />
        {phone ? null : (
          <button
            type="button"
            data-testid="nav-toggle"
            aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
            aria-expanded={!collapsed}
            title={collapsed ? 'Expand menu' : 'Collapse menu'}
            onClick={() => onCollapse(!collapsed)}
            className="nav-rail-toggle"
          >
            {collapsed ? <ExpandNavIcon /> : <CollapseNavIcon />}
          </button>
        )}
      </div>
    </>
  );
}

/**
 * A folded rail shows only icons, so each link and the brand carry their name as a hover tooltip.
 * AppNav takes no per-link attributes, so the titles go on its rendered links.
 */
function useRailTooltips(rail: RefObject<HTMLElement | null>, collapsed: boolean) {
  useEffect(() => {
    const links = rail.current?.querySelectorAll<HTMLElement>('.app-nav-link, .app-nav-brand') ?? [];
    for (const link of links) {
      if (!collapsed) link.removeAttribute('title');
      else {
        // A link's label is its own text, apart from its icon and badge.
        const label = link.classList.contains('app-nav-brand')
          ? link.querySelector('.app-nav-brand-name')?.textContent
          : [...link.childNodes]
              .filter((node) => node.nodeType === Node.TEXT_NODE)
              .map((node) => node.textContent)
              .join('')
              .trim();
        if (label) link.title = label;
      }
    }
  });
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
          <SideNav onOpenNotifications={() => setPanelOpen(true)} collapsed={focused} onCollapse={setFocus} />
          <div className="flex min-w-0 flex-1 flex-col">
            {panelOpen ? <NotificationPanel onClose={() => setPanelOpen(false)} /> : null}
            <main id="main-content" className="flex-1">
              {/* In focus mode the page takes the full width beside the folded rail. */}
              <Container className="py-6" style={{ maxWidth: focused ? 'none' : '90rem' }}>
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
