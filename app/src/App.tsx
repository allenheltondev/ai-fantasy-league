import { Navigate, Route, Routes } from 'react-router';
import { AuthProvider } from '@readysetcloud/ui/auth';
import { leagueApi } from './api';
import { LeagueApiContext, type LeagueApi } from './api/league';
import { ForgotPasswordPage, LoginPage, SignUpPage } from './auth/AuthScreens';
import { DraftPage } from './draft/DraftPage';
import { RequireSignIn } from './auth/RequireSignIn';
import { JoinPage } from './features/join/JoinPage';
import { AppLayout } from './layout/AppLayout';
import {
  CreateLeaguePage,
  HomePage,
  LEAGUE_SECTIONS,
  LeagueLayout,
  LeagueSectionPage,
  NotFoundPage
} from './routes/pages';

/**
 * The route table. The router itself is supplied by the caller (main.tsx, tests), and tests can
 * swap in a fake league API.
 */
export function App({ api = leagueApi }: { api?: LeagueApi }) {
  return (
    <AuthProvider>
      <LeagueApiContext.Provider value={api}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignUpPage />} />
          <Route path="/signup/confirm" element={<SignUpPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/join/:token" element={<JoinPage />} />
          <Route
            element={
              <RequireSignIn>
                <AppLayout />
              </RequireSignIn>
            }
          >
            <Route index element={<HomePage />} />
            <Route path="leagues/new" element={<CreateLeaguePage />} />
            <Route path="leagues/:leagueId" element={<LeagueLayout />}>
              <Route index element={<Navigate to="matchup" replace />} />
              {LEAGUE_SECTIONS.map((section) => (
                <Route
                  key={section.path}
                  path={section.path}
                  element={
                    section.path === 'draft' ? <DraftPage /> : <LeagueSectionPage section={section.path} />
                  }
                />
              ))}
            </Route>
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </LeagueApiContext.Provider>
    </AuthProvider>
  );
}
