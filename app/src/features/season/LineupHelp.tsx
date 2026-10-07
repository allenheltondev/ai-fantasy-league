import { InfoPopover } from '../../components/InfoPopover';
import { leagueTabPath, teamPath } from '../../routes/leagueRoutes';
import { HelpHeading, HelpLinks, rulesLink, useHelpContext } from '../help/PageHelp';

/**
 * A beginner's guide to the lineup, behind a small info icon beside the week so it never gets in
 * a regular's way: how a lineup scores and moves, and where the rest of a manager's week happens
 * (adds and drops, trades, the matchup, player research, the league's rules), each a link there.
 */
export function LineupHelp(props: {
  /** The league's slot names (QB, W/R/T, BN, IR…). */
  slots: readonly string[];
}) {
  const { leagueId, allowedActions, commissioner } = useHelpContext();
  // A combined slot (W/R/T) is a flex; say what that means with the league's own.
  const flex = props.slots.find((slot) => slot.includes('/'));
  const hasIr = props.slots.includes('IR');
  return (
    <InfoPopover
      label="How do lineups work?"
      title="Lineup help"
      icon="info"
      testId="lineup-help"
      width="w-80 sm:w-96"
    >
      <HelpHeading first>Setting your lineup</HelpHeading>
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
      <HelpLinks
        links={[
          [
            teamPath(leagueId, 'moves'),
            'Roster & moves',
            'add a free agent, put in a waiver claim, or drop a player.'
          ],
          allowedActions.includes('propose_trade') && [
            teamPath(leagueId, 'trades'),
            'Trades',
            'offer a trade to another team, or answer offers you’ve received.'
          ],
          [teamPath(leagueId, 'matchup'), 'My matchup', 'who you’re up against this week, scored live.'],
          [
            leagueTabPath(leagueId, 'players'),
            'Players',
            'research anyone in the league and see who’s available.'
          ],
          rulesLink(leagueId, commissioner, 'how scoring works, roster slots, and the league’s rules.')
        ]}
      />
    </InfoPopover>
  );
}
