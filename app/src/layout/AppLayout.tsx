import { Outlet, Link, useLocation, useNavigate } from 'react-router';
import { AppNav, Container, readySetCloudServices, type AppNavLinkProps } from '@readysetcloud/ui';
import { useAuth, type IdClaims } from '@readysetcloud/ui/auth';
import { APP_NAME } from '../auth/AuthScreens';

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

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AppNav
        appName={APP_NAME}
        currentServiceId="fantasy"
        homeHref="/"
        linkComponent={RouterLink}
        services={readySetCloudServices}
        authState="authenticated"
        user={{ name: displayName(user), email: typeof user.email === 'string' ? user.email : undefined }}
        navItems={[
          { id: 'leagues', label: 'My Leagues', href: '/', active: active === 'leagues' },
          { id: 'create', label: 'Create League', href: '/leagues/new', active: active === 'create' }
        ]}
        onSignOut={() => {
          void signOut().then(() => navigate('/login', { replace: true }));
        }}
      />
      <Container className="py-6">
        <Outlet />
      </Container>
    </div>
  );
}
