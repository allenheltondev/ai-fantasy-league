import { Link, useLocation, useNavigate } from 'react-router';
import { transitionClick } from '../motion/pageTransition';
import { leaguePath, onPage, pageGroupOf } from '../routes/leagueRoutes';
import { leagueSubpath } from './navItems';

/**
 * The pages under the side-nav item you are on (Matchup: My matchup | Scoreboard), as tabs across
 * the top of the page. Nothing on a page that is the only one under its item.
 */
export function PageTabs({
  leagueId,
  badges = {}
}: {
  leagueId: string;
  /** A count on a page's tab, by its path, with what it counts for screen readers. */
  badges?: Record<string, { count: string; label: string }>;
}) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const subpath = leagueSubpath(pathname, leagueId);
  const group = pageGroupOf(subpath);
  if (group === null) return null;
  return (
    <nav aria-label={`${group.label} pages`} className="page-tabs mb-6 max-w-full overflow-x-auto">
      <div className="segmented-control">
        {group.pages.map((page) => {
          const to = leaguePath(leagueId, page.path);
          const current = onPage(subpath, page.path);
          const badge = badges[page.path];
          return (
            <Link
              key={page.path}
              to={to}
              className="segmented-control-option gap-1.5"
              aria-current={current ? 'page' : undefined}
              onClick={transitionClick(() => navigate(to))}
            >
              {page.label}
              {badge === undefined ? null : (
                <>
                  {' '}
                  <span
                    aria-hidden="true"
                    className="rounded-full bg-error-600 px-1.5 text-xs font-bold leading-5 text-white"
                  >
                    {badge.count}
                  </span>
                  <span className="sr-only">{badge.label}</span>
                </>
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
