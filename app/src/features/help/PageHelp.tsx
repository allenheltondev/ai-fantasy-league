import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { InfoPopover } from '../../components/InfoPopover';
import { useLeagueOutlet } from '../../routes/leagueContext';
import { leaguePath, leagueTabPath, teamPath } from '../../routes/leagueRoutes';

/**
 * Help for newer managers, page by page: what the page's terms mean and where the related moves
 * happen, each a link there. Every panel stays closed behind an info icon until asked for, so a
 * regular never has to see it. Panels say how things work in general and leave the league's own
 * numbers (waiver days, the trade deadline, playoff spots) to League info, which they link to.
 */

/** A link to another page of the league, inside a help panel. */
export function HelpLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="font-medium text-primary-700 underline decoration-primary-300 underline-offset-2 hover:decoration-primary-700"
    >
      {children}
    </Link>
  );
}

/** A panel's section heading. */
export function HelpHeading({ children, first = false }: { children: ReactNode; first?: boolean }) {
  return <h3 className={`font-semibold ${first ? '' : 'pt-2'}`}>{children}</h3>;
}

/** "Where to go next": one link and what it is for, per line. */
export function HelpLinks({ links }: { links: readonly (readonly [string, string, string] | false)[] }) {
  return (
    <>
      <HelpHeading>Where to go next</HelpHeading>
      <ul className="space-y-1">
        {links.map((link) =>
          link === false ? null : (
            <li key={link[1]}>
              <HelpLink to={link[0]}>{link[1]}</HelpLink>: {link[2]}
            </li>
          )
        )}
      </ul>
    </>
  );
}

/** The league's rules, under Settings for the commissioner and League info for everyone else. */
export function rulesLink(leagueId: string, commissioner: boolean, why: string) {
  return [leaguePath(leagueId, 'settings'), commissioner ? 'Settings' : 'League info', why] as const;
}

/**
 * A page's help on a line of its own above the page, its label showing: it stands alone rather
 * than beside what it explains. `start` holds anything else for the line's left end.
 */
export function HelpBar({ start, children }: { start?: ReactNode; children: ReactNode }) {
  return (
    <div className="-my-2 flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">{start}</div>
      {children}
    </div>
  );
}

interface Common {
  leagueId: string;
  /** The league's allowed actions for you: links to closed actions are left out. */
  allowedActions: readonly string[];
  commissioner: boolean;
}

/** The league a help panel links into, from the route and the league layout. */
export function useHelpContext(): Common {
  const { leagueId = '' } = useParams();
  const state = useLeagueOutlet()?.state ?? null;
  return {
    leagueId,
    allowedActions: state?.allowedActions ?? [],
    commissioner: state?.youAreCommissioner === true
  };
}

const can = (props: Common, action: string) => props.allowedActions.includes(action);

/** My Team › Roster & moves: free agents, waivers and claims, drops. */
export function MovesHelp({ waiverType }: { waiverType: 'faab' | 'rolling' | null }) {
  const props = useHelpContext();
  const { leagueId } = props;
  return (
    <InfoPopover
      label="How do adds and drops work?"
      title="Adds and drops help"
      icon="info"
      testId="moves-help"
      width="w-80 sm:w-96"
    >
      <HelpHeading first>Adding players</HelpHeading>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          A <strong>free agent</strong> joins your team as soon as you add him.
        </li>
        <li>
          A player on <strong>waivers</strong> takes a <strong>claim</strong> instead. Claims are settled
          together when waivers run; the player&rsquo;s row says when he clears.
        </li>
        {waiverType === 'rolling' && (
          <li>
            When teams claim the same player, the team highest on the waiver priority list gets him and moves
            to the back of the list.
          </li>
        )}
        {waiverType === 'faab' && (
          <li>
            When teams claim the same player, the highest FAAB bid wins. Tap the ? by your budget for more.
          </li>
        )}
        <li>
          Your claims wait on your roster until they process. You can change or cancel them before then.
        </li>
        <li>
          Roster full? Choose who to drop with the add. Depending on the league&rsquo;s rules, a dropped
          player can spend time on waivers before anyone can add him freely.
        </li>
        <li>New players start on your bench: set your lineup to play them.</li>
      </ul>
      <HelpLinks
        links={[
          [teamPath(leagueId, 'lineup'), 'Lineup', 'start the players you add.'],
          [leagueTabPath(leagueId, 'players'), 'Players', 'research everyone, owned or not.'],
          can(props, 'propose_trade') && [
            teamPath(leagueId, 'trades'),
            'Trades',
            'get a player another team owns.'
          ],
          rulesLink(leagueId, props.commissioner, 'waiver days, roster size, and add limits.')
        ]}
      />
    </InfoPopover>
  );
}

/** League › Players: what each player's availability means, and the sorts. */
export function PlayersHelp() {
  const props = useHelpContext();
  const { leagueId } = props;
  return (
    <InfoPopover
      label="How do I read this list?"
      title="Players help"
      icon="info"
      testId="players-help"
      width="w-80 sm:w-96"
    >
      <HelpHeading first>Every player in the NFL, for this league</HelpHeading>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <strong>Free agent</strong>: nobody has him. Add him now.
        </li>
        <li>
          <strong>Waivers</strong>: put in a claim. Claims settle when waivers run, and the best claim wins.
        </li>
        <li>
          A <strong>team&rsquo;s name</strong>: he&rsquo;s on that roster. Offer them a trade for him.
        </li>
        <li>
          Sort by <strong>Projected this week</strong> for help now, or <strong>Rest of season</strong> for
          the long run. <strong>Trending</strong> shows who managers in other leagues are adding or dropping
          today.
        </li>
        <li>Tap a name for his stats, schedule, and news.</li>
      </ul>
      <HelpLinks
        links={[
          [teamPath(leagueId, 'moves'), 'Roster & moves', 'add or claim with your roster beside you.'],
          can(props, 'propose_trade') && [teamPath(leagueId, 'trades'), 'Trades', 'see your offers.'],
          rulesLink(leagueId, props.commissioner, 'how players score in this league.')
        ]}
      />
    </InfoPopover>
  );
}

/** My Team › Trades: offers, counters, review, and the deadline. */
export function TradesHelp() {
  const props = useHelpContext();
  const { leagueId } = props;
  return (
    <InfoPopover
      label="How trades work"
      showLabel
      align="end"
      title="Trades help"
      icon="info"
      testId="trades-help"
      width="w-80 sm:w-96"
    >
      <HelpHeading first>Making a trade</HelpHeading>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          Under <strong>Propose a trade</strong>, pick a team, then the players you send and the ones you
          want. The preview checks the trade is legal and shows how it changes each team&rsquo;s projected
          lineup.
        </li>
        <li>If a trade would leave a roster too big, you choose who to drop.</li>
        <li>
          The other manager can accept, reject, or <strong>counter</strong> with changes. AI managers answer
          too. An offer expires if nobody answers in time.
        </li>
        <li>
          An accepted trade can wait in <strong>League review</strong> before players switch teams. Depending
          on the league&rsquo;s rules, other managers vote on it or the commissioner reviews it, and enough
          vetoes cancel it.
        </li>
        <li>Trading closes for the season at the trade deadline.</li>
      </ul>
      <HelpLinks
        links={[
          [teamPath(leagueId, 'teams'), 'Other teams', 'browse every roster and start an offer from it.'],
          [leagueTabPath(leagueId, 'players'), 'Players', 'find out who owns whom.'],
          [teamPath(leagueId, 'moves'), 'Roster & moves', 'add a free agent instead.'],
          rulesLink(leagueId, props.commissioner, 'the review, veto votes, and the deadline.')
        ]}
      />
    </InfoPopover>
  );
}

/** My Team › Matchup: head to head, win probability, live scores, and finals. */
export function MatchupHelp() {
  const props = useHelpContext();
  const { leagueId } = props;
  return (
    <InfoPopover
      label="How matchups work"
      showLabel
      align="end"
      title="Matchup help"
      icon="info"
      testId="matchup-help"
      width="w-80 sm:w-96"
    >
      <HelpHeading first>Your week, head to head</HelpHeading>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          Each week you play one team. The team whose <strong>starters</strong> score more wins; bench points
          don&rsquo;t count.
        </li>
        <li>
          <strong>Win probability</strong> is each team&rsquo;s chance from its projections, updated as the
          games are played.
        </li>
        <li>Scores update live during games, and the scoring log shows each play&rsquo;s points.</li>
        <li>
          Scores can shift a little after the games while stats are corrected. The result counts once the week
          is final.
        </li>
        <li>Each win or loss goes on your record in the standings.</li>
      </ul>
      <HelpLinks
        links={[
          [teamPath(leagueId, 'lineup'), 'Lineup', 'change who starts before their games kick off.'],
          [leagueTabPath(leagueId, 'scoreboard'), 'Scoreboard', 'every matchup in the league this week.'],
          [leagueTabPath(leagueId, 'standings'), 'Standings', 'where your record puts you.'],
          rulesLink(leagueId, props.commissioner, 'how each stat scores.')
        ]}
      />
    </InfoPopover>
  );
}

/** League › Standings: the columns, and how ties and playoff spots are decided. */
export function StandingsHelp() {
  const props = useHelpContext();
  const { leagueId } = props;
  return (
    <InfoPopover
      label="How are standings decided?"
      title="Standings help"
      icon="info"
      testId="standings-help"
      width="w-80 sm:w-96"
    >
      <HelpHeading first>Reading the table</HelpHeading>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <strong>Record</strong> is wins, losses, and ties. Teams rank by win percentage.
        </li>
        <li>
          <strong>PF</strong> (points for) is everything your starters have scored; <strong>PA</strong>{' '}
          (points against) is what your opponents scored against you.
        </li>
        <li>
          <strong>Streak</strong> is your current run: W3 means three wins in a row.
        </li>
        <li>Teams with the same record are split by points for or head to head, as the league is set up.</li>
        <li>The top teams when the regular season ends make the playoffs.</li>
      </ul>
      <HelpLinks
        links={[
          [leagueTabPath(leagueId, 'playoffs'), 'Playoffs', 'the bracket and who is in.'],
          [leagueTabPath(leagueId, 'scoreboard'), 'Scoreboard', "this week's games."],
          rulesLink(leagueId, props.commissioner, 'playoff spots and the tiebreaker.')
        ]}
      />
    </InfoPopover>
  );
}

/** League › Playoffs: seeding, byes, and how a round is won. */
export function PlayoffsHelp() {
  const props = useHelpContext();
  const { leagueId } = props;
  return (
    <InfoPopover
      label="How the playoffs work"
      showLabel
      align="end"
      title="Playoffs help"
      icon="info"
      testId="playoffs-help"
      width="w-80 sm:w-96"
    >
      <HelpHeading first>Win and advance</HelpHeading>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          When the regular season ends, the top teams in the standings are seeded into the bracket, 1 being
          the best.
        </li>
        <li>The top seeds may get a bye, skipping the first round.</li>
        <li>
          Each round is one week&rsquo;s matchup. The winner advances; in a tie, the better seed does. Win the
          final to take the title.
        </li>
        <li>Set your lineup every week: playoff weeks score the same way as the regular season.</li>
      </ul>
      <HelpLinks
        links={[
          [leagueTabPath(leagueId, 'standings'), 'Standings', 'the race for a spot.'],
          [teamPath(leagueId, 'matchup'), 'My matchup', "this week's game."],
          rulesLink(leagueId, props.commissioner, 'how many teams get in, and byes.')
        ]}
      />
    </InfoPopover>
  );
}
