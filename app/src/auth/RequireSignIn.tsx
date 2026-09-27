import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { RequireAuth } from '@readysetcloud/ui/auth';

/** Signed-out visitors go to /login, which returns them here afterwards. */
export function RequireSignIn({ children }: { children: ReactNode }) {
  const location = useLocation();
  const from = `${location.pathname}${location.search}${location.hash}`;
  return <RequireAuth fallback={<Navigate to="/login" replace state={{ from }} />}>{children}</RequireAuth>;
}
