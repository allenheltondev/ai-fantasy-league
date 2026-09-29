import { describe, expect, it } from 'vitest';
import { headshotUrl, teamLogoUrl } from './sleeperAssets';

describe('Sleeper asset urls', () => {
  it('builds a thumb or full headshot from the Sleeper player id', () => {
    const player = { id: '4046', position: 'QB', team: 'KC' };
    expect(headshotUrl(player)).toBe('https://sleepercdn.com/content/nfl/players/thumb/4046.jpg');
    expect(headshotUrl(player, 'full')).toBe('https://sleepercdn.com/content/nfl/players/4046.jpg');
  });

  it('gives a team defense its team logo, and nothing when there is no team to show', () => {
    expect(headshotUrl({ id: 'PHI', position: 'DEF', team: 'PHI' })).toBe(
      'https://sleepercdn.com/images/team_logos/nfl/phi.png'
    );
    expect(headshotUrl({ id: 'PHI', position: 'DEF', team: null })).toBe(
      'https://sleepercdn.com/images/team_logos/nfl/phi.png'
    );
    expect(headshotUrl({ id: '?', position: 'DEF', team: null })).toBeNull();
  });

  it('refuses ids that could change the path', () => {
    expect(headshotUrl({ id: '../x', position: 'WR', team: 'KC' })).toBeNull();
    expect(headshotUrl({ id: '', position: 'WR', team: 'KC' })).toBeNull();
  });

  it('lowercases the team code, and has no logo for a free agent', () => {
    expect(teamLogoUrl('KC')).toBe('https://sleepercdn.com/images/team_logos/nfl/kc.png');
    expect(teamLogoUrl(' Phi ')).toBe('https://sleepercdn.com/images/team_logos/nfl/phi.png');
    expect(teamLogoUrl(null)).toBeNull();
    expect(teamLogoUrl(undefined)).toBeNull();
    expect(teamLogoUrl('')).toBeNull();
    expect(teamLogoUrl('../etc')).toBeNull();
  });
});
