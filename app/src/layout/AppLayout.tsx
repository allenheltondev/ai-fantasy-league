import { useState } from 'react';
import { Outlet, Link, useLocation, useNavigate } from 'react-router';
import { AppNav, Container, readySetCloudServices, type AppNavLinkProps } from '@readysetcloud/ui';
import { useAuth, type IdClaims } from '@readysetcloud/ui/auth';
import { APP_NAME } from '../auth/AuthScreens';
import { NotificationBell } from '../notifications/NotificationBell';
import { NotificationPanel } from '../notifications/NotificationPanel';
import { NotificationsProvider } from '../notifications/NotificationsContext';

function RouterLink({ href, ...rest }: AppNavLinkProps) {
  return <Link to={href} {...rest} />;
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

export function AppLayout() {
  const { user, signOut } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const active = activeNavId(pathname);
  const [panelOpen, setPanelOpen] = useState(false);
  const openPanel = () => setPanelOpen(true);

  return (
    <NotificationsProvider>
      <div className="relative min-h-screen bg-background text-foreground">
        <AppNav
          appName={APP_NAME}
          currentServiceId="fantasy"
          homeHref="/"
          linkComponent={RouterLink}
          services={readySetCloudServices}
          authState="authenticated"
          user={{ name: displayName(user), email: typeof user.email === 'string' ? user.email : undefined }}
          // The bell (#165) sits with the header's actions on wider screens...
          actions={<NotificationBell onOpen={openPanel} className="relative max-[640px]:hidden" />}
          navItems={[
            { id: 'leagues', label: 'My Leagues', href: '/', active: active === 'leagues' },
            { id: 'create', label: 'Create League', href: '/leagues/new', active: active === 'create' }
          ]}
          onSignOut={() => {
            void signOut().then(() => navigate('/login', { replace: true }));
          }}
        />
        {/* ...and on a phone, where the actions fold into the menu, beside the menu button. */}
        <NotificationBell
          onOpen={openPanel}
          className="absolute right-[calc(clamp(1rem,4vw,1.5rem)+3rem)] top-[0.625rem] min-[641px]:hidden"
        />
        {panelOpen ? <NotificationPanel onClose={() => setPanelOpen(false)} /> : null}
        <Container className="py-6">
          <Outlet />
        </Container>
      </div>
    </NotificationsProvider>
  );
}
