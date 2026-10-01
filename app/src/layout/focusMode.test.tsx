import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { renderApp, signInAs } from '../test/render';
import { FOCUS_MODE_KEY, readFocusMode } from './focusMode';

const ALICE = { sub: 'u1', email: 'alice@example.com', given_name: 'Alice' };

const sideNav = () => document.querySelector('.app-nav');

describe('focus mode', () => {
  afterEach(() => localStorage.removeItem(FOCUS_MODE_KEY));

  it('folds the rail to icons only, keeping the links and bell, and unfolds it', async () => {
    signInAs(ALICE);
    renderApp('/leagues/L1/draft');
    await userEvent.click(await screen.findByRole('button', { name: 'Collapse menu' }));

    expect(sideNav()).toHaveClass('app-nav-rail-collapsed');
    expect(sideNav()).toContainElement(screen.getByTestId('notification-bell'));
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('title', 'Home');
    expect(readFocusMode()).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Expand menu' }));
    expect(sideNav()).not.toHaveClass('app-nav-rail-collapsed');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('title');
    expect(readFocusMode()).toBe(false);
  });

  it('keeps keyboard focus on the toggle as it flips', async () => {
    signInAs(ALICE);
    renderApp('/leagues/L1/home');
    const user = userEvent.setup();
    const toggle = await screen.findByRole('button', { name: 'Collapse menu' });
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAccessibleName('Expand menu');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('is remembered across visits', async () => {
    localStorage.setItem(FOCUS_MODE_KEY, 'on');
    signInAs(ALICE);
    renderApp('/leagues/L1/home');
    expect(await screen.findByRole('button', { name: 'Expand menu' })).toBeInTheDocument();
    expect(sideNav()).toHaveClass('app-nav-rail-collapsed');
  });

  it('does not apply on a phone, where the nav is already a top bar', async () => {
    localStorage.setItem(FOCUS_MODE_KEY, 'on');
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(max-width: 640px)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    })) as unknown as typeof window.matchMedia;
    try {
      signInAs(ALICE);
      renderApp('/leagues/L1/home');
      expect(await screen.findByTestId('notification-bell')).toBeInTheDocument();
      expect(sideNav()).not.toHaveClass('app-nav-rail-collapsed');
      expect(screen.queryByTestId('nav-toggle')).not.toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
  });

  it('falls back to the nav when storage is blocked', () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error('blocked');
    };
    try {
      expect(readFocusMode()).toBe(false);
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});
