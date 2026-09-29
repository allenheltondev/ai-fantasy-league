import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FaabExplainer } from './FaabExplainer';

/** jsdom has no layout, so place the panel by faking its rect. */
function fakeRect(left: number, width: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const shifted = /translateX\((-?[\d.]+)px\)/.exec(this.style.transform)?.[1];
    const x = left + Number(shifted ?? 0);
    return { left: x, right: x + width, top: 0, bottom: 0, width, height: 0, x, y: 0, toJSON: () => ({}) };
  });
}

afterEach(() => vi.restoreAllMocks());

describe('FaabExplainer', () => {
  it('opens from the question-mark button and closes on Escape', async () => {
    const user = userEvent.setup();
    render(<FaabExplainer remaining={80} />);
    expect(screen.queryByRole('region', { name: 'About FAAB' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'What is FAAB?' }));
    expect(screen.getByRole('region', { name: 'About FAAB' })).toHaveTextContent('you have $80 left');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'About FAAB' })).toBeNull();
  });

  it('closes on a tap outside, stays open on a tap inside, and toggles from the button', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <FaabExplainer />
        <p>elsewhere</p>
      </div>
    );
    const button = screen.getByRole('button', { name: 'What is FAAB?' });
    await user.click(button);
    await user.click(screen.getByRole('region', { name: 'About FAAB' }));
    expect(screen.getByRole('region', { name: 'About FAAB' })).toBeInTheDocument();
    await user.click(screen.getByText('elsewhere'));
    expect(screen.queryByRole('region', { name: 'About FAAB' })).toBeNull();
    await user.click(button);
    await user.click(button);
    expect(screen.queryByRole('region', { name: 'About FAAB' })).toBeNull();
    // Other keys leave it open.
    await user.click(button);
    await user.keyboard('a');
    expect(screen.getByRole('region', { name: 'About FAAB' })).toBeInTheDocument();
  });

  it('slides left when it would run off the right edge of a phone-width screen', async () => {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(375);
    fakeRect(300, 288);
    render(<FaabExplainer />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'What is FAAB?' }));
    const panel = screen.getByRole('region', { name: 'About FAAB' });
    // 300 + 288 = 588 is past 375 - 8: shift by -(588 - 367).
    expect(panel.style.transform).toBe('translateX(-221px)');
  });

  it('slides right when it would run off the left edge', async () => {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(375);
    fakeRect(-20, 288);
    render(<FaabExplainer />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'What is FAAB?' }));
    expect(screen.getByRole('region', { name: 'About FAAB' }).style.transform).toBe('translateX(28px)');
  });

  it('stays put when it fits', async () => {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1024);
    fakeRect(100, 288);
    render(<FaabExplainer />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'What is FAAB?' }));
    expect(screen.getByRole('region', { name: 'About FAAB' }).style.transform).toBe('');
  });
});
