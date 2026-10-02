import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { NflTeamLink } from './NflTeamLink';

describe('NflTeamLink', () => {
  it("links to the team's page inside a league", () => {
    render(
      <MemoryRouter>
        <NflTeamLink team="SF" leagueId="L 1" />
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: 'SF' })).toHaveAttribute(
      'href',
      '/leagues/L%201/league/players/nfl/SF'
    );
  });

  it('is plain text for a free agent, outside a league, or outside a router', () => {
    render(
      <>
        <MemoryRouter>
          <NflTeamLink team={null} leagueId="L1" />
          <NflTeamLink team="KC" leagueId="" />
          <NflTeamLink team="BUF" leagueId={null} />
        </MemoryRouter>
        <NflTeamLink team="DAL" leagueId="L1">
          Dallas
        </NflTeamLink>
      </>
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    for (const text of ['FA', 'KC', 'BUF', 'Dallas']) expect(screen.getByText(text)).toBeInTheDocument();
  });
});
