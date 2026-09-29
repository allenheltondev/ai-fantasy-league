import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatchupData, MatchupOutlook } from '../../api/types';
import { fakeApi, state } from '../../test/fakeApi';
import { renderApp, signInAs } from '../../test/render';

const ALICE = { sub: 'alice', email: 'alice@example.com', given_name: 'Alice' };
const ref = (id: string, name: string, position = 'WR') => ({ id, name, team: 'KC', position });

const noMatchup: MatchupData = { week: 1, teamId: 'team-1', matchup: null, lineups: null };

function outlook(extra: Partial<MatchupOutlook> = {}): MatchupOutlook {
  return {
    week: 1,
    teamId: 'team-1',
    status: 'in_progress',
    you: {
      teamId: 'team-1',
      teamName: "Alice's Team",
      currentPoints: 22.4,
      projectedPoints: 104.26,
      remainingPoints: 81.86,
      playersYetToPlay: 6,
      playersInProgress: 2,
      winProbability: 0.624
    },
    opponent: {
      teamId: 'team-2',
      teamName: 'Robots',
      currentPoints: 10,
      projectedPoints: 97.5,
      remainingPoints: 87.5,
      playersYetToPlay: 8,
      playersInProgress: 0,
      winProbability: 0.376
    },
    insights: {
      startersOut: [{ player: ref('cmc', 'Christian McCaffrey', 'RB'), slot: 'RB', reason: 'out' }],
      emptySlots: [
        { slot: 'TE', missing: 1 },
        { slot: 'K', missing: 1 }
      ],
      benchUpgrades: [
        {
          player: ref('lamb', 'CeeDee Lamb'),
          replaces: ref('arsb', 'Amon-Ra St. Brown'),
          slot: 'WR',
          gain: 12
        },
        { player: ref('kelce', 'Travis Kelce', 'TE'), replaces: null, slot: 'TE', gain: 9 }
      ],
      lockedPlayers: [ref('mahomes', 'Patrick Mahomes', 'QB')],
      currentProjectedPoints: 90,
      optimalProjectedPoints: 111
    },
    ...extra
  };
}

function open(getMatchupOutlook: () => Promise<MatchupOutlook>) {
  const api = fakeApi({
    getLeagueState: vi.fn(async () => state({ phase: 'regular_season', week: 1 })),
    getMatchup: vi.fn(async () => noMatchup),
    getMatchupOutlook: vi.fn(getMatchupOutlook)
  });
  renderApp('/leagues/L1/matchup', undefined, api);
  return api;
}

beforeEach(() => signInAs(ALICE));

describe('MatchupOutlookPanel', () => {
  it('shows the win probability, what is still to come, and lineup advice', async () => {
    const api = open(async () => outlook());
    const panel = await screen.findByRole('region', { name: 'Outlook' });
    expect(within(panel).getByTestId('win-probability')).toHaveTextContent(
      '62% to win · projected 104.3 to 97.5'
    );
    // Who is playing moved to the score bar (#193); the outlook keeps what is still to come.
    expect(within(panel).getByText('81.9 more points expected to come.')).toBeInTheDocument();
    expect(within(panel).queryByText(/yet to play/)).not.toBeInTheDocument();
    const advice = within(panel)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(advice).toEqual([
      'Christian McCaffrey (RB) is ruled out: bench him.',
      'Start CeeDee Lamb over Amon-Ra St. Brown at WR (+12.0).',
      'Start Travis Kelce in the empty TE slot (+9.0).',
      'Your K slot is empty.'
    ]);
    expect(api.getMatchupOutlook).toHaveBeenCalledWith('L1');
  });

  it('says when the lineup is set and there is no opponent', async () => {
    open(async () =>
      outlook({
        opponent: null,
        you: { ...outlook().you, winProbability: null, currentPoints: 0, playersInProgress: 0 },
        insights: {
          startersOut: [{ player: ref('walker', 'Kenneth Walker', 'RB'), slot: 'RB', reason: 'bye' }],
          emptySlots: [],
          benchUpgrades: [],
          lockedPlayers: [ref('a', 'A'), ref('b', 'B')],
          currentProjectedPoints: 100,
          optimalProjectedPoints: 100
        }
      })
    );
    const panel = await screen.findByRole('region', { name: 'Outlook' });
    expect(within(panel).getByText('No opponent this week · projected 104.3')).toBeInTheDocument();
    expect(within(panel).getByText('Kenneth Walker (RB) is on bye: bench him.')).toBeInTheDocument();
    expect(within(panel).queryByText(/expected to come/)).not.toBeInTheDocument();
  });

  it('says when the lineup is already set', async () => {
    open(async () =>
      outlook({
        insights: {
          startersOut: [],
          emptySlots: [],
          benchUpgrades: [],
          lockedPlayers: [],
          currentProjectedPoints: 100,
          optimalProjectedPoints: 100
        }
      })
    );
    expect(await screen.findByText('Your lineup looks set.')).toBeInTheDocument();
  });

  it('renders nothing when the outlook cannot load', async () => {
    open(async () => {
      throw new Error('down');
    });
    expect(await screen.findByText('No matchup in week 1')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Outlook' })).not.toBeInTheDocument();
  });
});
