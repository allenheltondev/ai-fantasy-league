/**
 * The sign-in flows, one route each, all from `@readysetcloud/ui/auth`:
 *
 *   /login            LoginForm
 *   /signup           SignUpForm (also the confirm step, below)
 *   /signup/confirm   SignUpForm started at the confirm step, for an account
 *                     sign-in found unconfirmed (email and, in memory only,
 *                     the password arrive via router state)
 *   /forgot-password  ForgotPasswordForm
 */

import type { ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { Alert } from '@readysetcloud/ui';
import { ForgotPasswordForm, LoginForm, SignUpForm, useAuth } from '@readysetcloud/ui/auth';
import { useAppConfig } from '../config/ConfigContext';

export const APP_NAME = 'Fantasy';

interface FlowState {
  from?: string;
  email?: string;
  password?: string;
  startAtReset?: boolean;
}

function flowState(state: unknown): FlowState {
  if (typeof state !== 'object' || state === null) return {};
  const record = state as Record<string, unknown>;
  const out: FlowState = {};
  if (typeof record.from === 'string') out.from = record.from;
  if (typeof record.email === 'string') out.email = record.email;
  if (typeof record.password === 'string') out.password = record.password;
  if (record.startAtReset === true) out.startAtReset = true;
  return out;
}

/** Only same-app paths are valid post-sign-in destinations. */
export function safeReturnPath(from: string | undefined): string {
  if (!from || !from.startsWith('/') || from.startsWith('//')) return '/';
  if (/^\/(login|signup|forgot-password)(\/|$)/.test(from)) return '/';
  return from;
}

export function AuthLogo() {
  return (
    <span className="app-nav-brand" aria-hidden="true">
      <span className="app-nav-brand-mark" />
      <span className="app-nav-brand-name">{APP_NAME}</span>
    </span>
  );
}

function AuthPage({ children }: { children: ReactNode }) {
  const { auth } = useAppConfig();
  const { signedIn } = useAuth();
  const location = useLocation();
  if (signedIn) return <Navigate to={safeReturnPath(flowState(location.state).from)} replace />;
  return (
    <main className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 px-4 py-10">
      {auth === null && (
        <div className="w-full max-w-md" data-testid="auth-not-configured">
          <Alert variant="info">
            Sign-in is not configured for this environment (no /auth-config.json). Run{' '}
            <code>make dev-auth-config</code> or set VITE_COGNITO_CLIENT_ID.
          </Alert>
        </div>
      )}
      {children}
    </main>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { from } = flowState(location.state);
  return (
    <AuthPage>
      <LoginForm
        logo={<AuthLogo />}
        onSuccess={() => navigate(safeReturnPath(from), { replace: true })}
        onNeedsConfirmation={(email, password) =>
          navigate('/signup/confirm', { state: { email, password, from } })
        }
        onPasswordResetRequired={(email) =>
          navigate('/forgot-password', { state: { email, startAtReset: true, from } })
        }
        forgotPasswordLink={
          <Link className="auth-link" to="/forgot-password" state={{ from }}>
            Forgot password?
          </Link>
        }
        signUpPrompt={
          <>
            New to Ready, Set, Cloud?{' '}
            <Link className="auth-link" to="/signup" state={{ from }}>
              Create an account
            </Link>
          </>
        }
      />
    </AuthPage>
  );
}

export function SignUpPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { email, password, from } = flowState(location.state);
  return (
    <AuthPage>
      <SignUpForm
        logo={<AuthLogo />}
        onSuccess={() => navigate('/login', { replace: true, state: { from } })}
        initialConfirmEmail={email}
        initialConfirmPassword={password}
        signInPrompt={
          <>
            Already have an account?{' '}
            <Link className="auth-link" to="/login" state={{ from }}>
              Sign in
            </Link>
          </>
        }
      />
    </AuthPage>
  );
}

export function ForgotPasswordPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { email, startAtReset, from } = flowState(location.state);
  return (
    <AuthPage>
      <ForgotPasswordForm
        logo={<AuthLogo />}
        onSuccess={() => navigate('/login', { replace: true, state: { from } })}
        initialEmail={email}
        startAtReset={startAtReset}
        autoSignIn
        signInLink={
          <Link className="auth-link" to="/login" state={{ from }}>
            Back to sign in
          </Link>
        }
      />
    </AuthPage>
  );
}
