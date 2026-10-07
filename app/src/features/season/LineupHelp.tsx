import { Link } from 'react-router';
import { InfoPopover } from '../../components/InfoPopover';
import { leaguePath, leagueTabPath, teamPath } from '../../routes/leagueRoutes';

/**
 * A beginner's guide to the lineup, behind a small info icon beside the week so it never gets in
 * a regular's way: how a lineup scores and moves, and where the rest of a manager's week happens
 * (adds and drops, trades, the matchup, player research, the league's rules), each a link there.
 */
export function LineupHelp(props: {
  leagueId: string;
  /** The league's allowed actions for you: trades only show while you can propose one. */
  allowedActions: readonly string[];
  /** The league's slot names (QB, W/R/T, BN, IR…). */
  slots: readonly string[];
  /** You run the league: its rules are under Settings rather than League info. */
  commissioner: boolean;
}) {
  const { leagueId } = props;
  const can = (action: string) => props.allowedActions.includes(action);
  // A combined slot (W/R/T) is a flex; say what that means with the league's own.
  const flex = props.slots.find((slot) => slot.includes('/'));
  const hasIr = props.slots.includes('IR');
  const link =
    'font-medium text-primary-700 underline decoration-primary-300 underline-offset-2 hover:decoration-primary-700';
  return (
    <InfoPopover
      label="How do lineups work?"
      title="Lineup help"
      icon="info"
      testId="lineup-help"
      width="w-80 sm:w-96"
    >
      <h3 className="font-semibold">Setting your lineup</h3>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          Only <strong>starters</strong> score. Bench points don&rsquo;t count, so fill every starting slot.
          {flex !== undefined && <> {flex} is a flex slot: any of those positions can play there.</>}
        </li>
        <li>
          Drag a player to a slot, or tap him and then tap where he goes. Nothing changes until you Save.
        </li>
        <li>
          <strong>Optimize lineup</strong> starts your highest-projected players. Check it, then Save.
        </li>
        <li>
          Each player locks when his game kicks off. Until then you can swap him in or out, even mid-week.
        </li>
        <li>
          Players who are Out or on a bye score 0: bench them
          {hasIr ? ', or rest an Out or IR player in an IR slot to free a bench spot' : ''}.
        </li>
        <li>Tap a player&rsquo;s name for his stats, news, and projections.</li>
      </ul>
      <h3 className="pt-2 font-semibold">Beyond your lineup</h3>
      <ul className="space-y-1">
        <li>
          <Link to={teamPath(leagueId, 'moves')} className={link}>
            Roster &amp; moves
          </Link>
          : add a free agent, put in a waiver claim, or drop a player.
        </li>
        {can('propose_trade') && (
          <li>
            <Link to={teamPath(leagueId, 'trades')} className={link}>
              Trades
            </Link>
            : offer a trade to another team, or answer offers you&rsquo;ve received.
          </li>
        )}
        <li>
          <Link to={teamPath(leagueId, 'matchup')} className={link}>
            My matchup
          </Link>
          : who you&rsquo;re up against this week, scored live.
        </li>
        <li>
          <Link to={leagueTabPath(leagueId, 'players')} className={link}>
            Players
          </Link>
          : research anyone in the league and see who&rsquo;s available.
        </li>
        <li>
          <Link to={leaguePath(leagueId, 'settings')} className={link}>
            {props.commissioner ? 'Settings' : 'League info'}
          </Link>
          : how scoring works, roster slots, and the league&rsquo;s rules.
        </li>
      </ul>
    </InfoPopover>
  );
}
