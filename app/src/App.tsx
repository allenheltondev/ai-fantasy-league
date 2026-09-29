import { Navigate, Route, Routes } from 'react-router';
import { AuthProvider } from '@readysetcloud/ui/auth';
import { leagueApi } from './api';
import { LeagueApiContext, type LeagueApi } from './api/league';
import { ForgotPasswordPage, LoginPage, SignUpPage } from './auth/AuthScreens';
import { ChatPage } from './chat/ChatPage';
import { DraftPage } from './draft/DraftPage';
import { RequireSignIn } from './auth/RequireSignIn';
import { LeagueHomePage } from './features/home/LeagueDashboard';
import { JoinPage } from './features/join/JoinPage';
import {
  HistoryPage,
  LeagueSectionLayout,
  PlayoffsPage,
  ScoreboardPage,
  TransactionsPage
} from './features/league/LeaguePages';
import { PlayersPage } from './features/players/PlayersPage';
import { MatchupPage } from './features/season/MatchupPage';
import { RosterPage } from './features/season/RosterPage';
import { StandingsPage } from './features/season/StandingsPage';
import { SettingsPage } from './features/settings/SettingsPage';
import {
  AchievementsPage,
  MovesPage,
  OtherTeamsPage,
  TeamProfilePage,
  TeamViewPage
} from './features/team/TeamPages';
import { AppLayout } from './layout/AppLayout';
import { MOVED_SECTIONS } from './routes/leagueRoutes';
import {
  CreateLeaguePage,
  HomePage,
  LeagueLayout,
  MovedSection,
  NotFoundPage,
  RedirectTo
} from './routes/pages';
import { TradesPage } from './trades/TradesPage';

/**
 * The route table. The router itself is supplied by the caller (main.tsx, tests), and tests can
 * swap in a fake league API.
 *
 * A league (#178): Home, Draft, My Team (lineup, matchup, moves, trades, achievements, your
 * profile, and the other teams), League (scoreboard, standings, playoffs, players, transactions,
 * history, draft results), Chat, and Settings. Older section URLs redirect to their new homes.
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
              <Route index element={<Navigate to="home" replace />} />
              <Route path="home" element={<LeagueHomePage />} />
              <Route path="draft" element={<DraftPage />} />
              <Route path="team">
                <Route index element={<RedirectTo to="lineup" />} />
                <Route path="lineup" element={<RosterPage />} />
                <Route path="matchup" element={<MatchupPage />} />
                <Route path="moves" element={<MovesPage />} />
                <Route path="trades" element={<TradesPage />} />
                <Route path="achievements" element={<AchievementsPage />} />
                <Route path="profile" element={<TeamProfilePage />} />
                <Route path="teams" element={<OtherTeamsPage />} />
                <Route path="teams/:teamId" element={<TeamViewPage />} />
              </Route>
              <Route path="league" element={<LeagueSectionLayout />}>
                <Route index element={<RedirectTo to="scoreboard" />} />
                <Route path="scoreboard" element={<ScoreboardPage />} />
                <Route path="standings" element={<StandingsPage />} />
                <Route path="playoffs" element={<PlayoffsPage />} />
                <Route path="players" element={<PlayersPage />} />
                <Route path="transactions" element={<TransactionsPage />} />
                <Route path="history" element={<HistoryPage />} />
                <Route path="draft" element={<DraftPage />} />
              </Route>
              <Route path="chat" element={<ChatPage />} />
              <Route path="settings" element={<SettingsPage />} />
              {(Object.keys(MOVED_SECTIONS) as (keyof typeof MOVED_SECTIONS)[]).map((section) => (
                <Route key={section} path={section} element={<MovedSection section={section} />} />
              ))}
            </Route>
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </LeagueApiContext.Provider>
    </AuthProvider>
  );
}
