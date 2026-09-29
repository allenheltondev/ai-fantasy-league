import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PlayerHeadshot, TeamLogo } from './PlayerHeadshot';

const CHASE = { id: '7564', name: "Ja'Marr Chase", team: 'CIN', position: 'WR' };

const image = (container: HTMLElement) => container.querySelector('img');

describe('PlayerHeadshot', () => {
  it('is a lazy, fixed-size, decorative picture of the player', () => {
    const { container } = render(<PlayerHeadshot player={CHASE} size={28} />);
    const img = image(container);
    expect(img).toHaveAttribute('src', 'https://sleepercdn.com/content/nfl/players/thumb/7564.jpg');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');
    expect(img).toHaveAttribute('width', '28');
    expect(img).toHaveAttribute('height', '28');
    // The name is always beside it, so it is hidden from assistive tech and has no alt text.
    expect(img).toHaveAttribute('alt', '');
    expect(container.querySelector('[data-headshot]')).toHaveAttribute('aria-hidden', 'true');
  });

  it('loads eagerly when it is always on screen, and uses the full size for a large picture', () => {
    const { container } = render(<PlayerHeadshot player={CHASE} size={64} eager />);
    expect(image(container)).toHaveAttribute('loading', 'eager');
    expect(image(container)).toHaveAttribute('src', 'https://sleepercdn.com/content/nfl/players/7564.jpg');
  });

  it('falls back to his initials once when the picture will not load', () => {
    const { container } = render(<PlayerHeadshot player={CHASE} />);
    fireEvent.error(image(container)!);
    expect(image(container)).toBeNull();
    expect(screen.getByText('JC')).toBeInTheDocument();
    // No retry: a second error, or a rerender, leaves the fallback in place.
    fireEvent.error(container.firstElementChild!);
    expect(image(container)).toBeNull();
  });

  it('tries again for a different player', () => {
    const { container, rerender } = render(<PlayerHeadshot player={CHASE} />);
    fireEvent.error(image(container)!);
    rerender(<PlayerHeadshot player={{ ...CHASE, id: '9', name: 'CeeDee Lamb' }} />);
    expect(image(container)).toHaveAttribute('src', expect.stringContaining('/thumb/9.jpg'));
  });

  it('shows the team logo for a defense, and its team when the logo fails', () => {
    const def = { id: 'PHI', name: 'Philadelphia Eagles', team: 'PHI', position: 'DEF' };
    const { container } = render(<PlayerHeadshot player={def} />);
    expect(image(container)).toHaveAttribute('src', 'https://sleepercdn.com/images/team_logos/nfl/phi.png');
    fireEvent.error(image(container)!);
    expect(screen.getByText('PHI')).toBeInTheDocument();
  });

  it('shows initials when there is no picture to ask for', () => {
    const { container } = render(<PlayerHeadshot player={{ ...CHASE, id: '' }} />);
    expect(image(container)).toBeNull();
    expect(screen.getByText('JC')).toBeInTheDocument();
    const nameless = render(<PlayerHeadshot player={{ ...CHASE, id: '', name: '--' }} />);
    expect(nameless.getByText('?')).toBeInTheDocument();
    const def = render(<PlayerHeadshot player={{ id: '?', name: 'Defense', team: null, position: 'DEF' }} />);
    expect(def.getByText('DEF')).toBeInTheDocument();
  });
});

describe('TeamLogo', () => {
  it('is a lazy, fixed-size logo, decorative beside the team text', () => {
    const { container } = render(<TeamLogo team="CIN" size={18} />);
    const img = image(container);
    expect(img).toHaveAttribute('src', 'https://sleepercdn.com/images/team_logos/nfl/cin.png');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('width', '18');
    expect(img).toHaveAttribute('alt', '');
  });

  it('is named when it stands in for the team, and eager when asked', () => {
    const { container } = render(<TeamLogo team="CIN" label eager />);
    expect(image(container)).toHaveAttribute('alt', 'CIN');
    expect(image(container)).toHaveAttribute('loading', 'eager');
  });

  it('renders nothing for a free agent, or once the logo fails', () => {
    const none = render(<TeamLogo team={null} />);
    expect(none.container).toBeEmptyDOMElement();
    const { container } = render(<TeamLogo team="CIN" />);
    fireEvent.error(image(container)!);
    expect(container).toBeEmptyDOMElement();
  });
});
