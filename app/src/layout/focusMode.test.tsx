import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { renderApp, signInAs } from '../test/render';
import { FOCUS_MODE_KEY, readFocusMode } from './focusMode';

const ALICE = { sub: 'u1', email: 'alice@example.com', given_name: 'Alice' };

const sideNav = () => document.querySelector('.app-nav');

describe('focus mode', () => {
  afterEach(() => localStorage.removeItem(FOCUS_MODE_KEY));

  it('folds the side nav away, keeps the bell in reach, and brings the nav back', async () => {
    signInAs(ALICE);
    renderApp('/leagues/L1/draft');
    await userEvent.click(await screen.findByRole('button', { name: 'Hide menu (focus mode)' }));

    expect(sideNav()).toBeNull();
    expect(screen.getByTestId('focus-bar')).toContainElement(screen.getByTestId('notification-bell'));
    expect(readFocusMode()).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Show menu' }));
    expect(sideNav()).not.toBeNull();
    expect(screen.queryByTestId('focus-bar')).not.toBeInTheDocument();
    expect(readFocusMode()).toBe(false);
  });

  it('is remembered across visits', async () => {
    localStorage.setItem(FOCUS_MODE_KEY, 'on');
    signInAs(ALICE);
    renderApp('/leagues/L1/home');
    expect(await screen.findByTestId('focus-bar')).toBeInTheDocument();
    expect(sideNav()).toBeNull();
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
      expect(sideNav()).not.toBeNull();
      expect(screen.queryByTestId('focus-bar')).not.toBeInTheDocument();
      expect(screen.queryByTestId('hide-nav')).not.toBeInTheDocument();
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
