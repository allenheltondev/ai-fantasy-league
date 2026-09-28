import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { AgentAvatar, avatarCells, hashSeed } from './AgentAvatar';
import { ApiErrorAlert, errorText } from './ApiErrorAlert';
import { ConfirmButton } from './ConfirmButton';
import { TableScroll } from './TableScroll';

describe('AgentAvatar', () => {
  it('draws the same symmetric pattern for the same seed', () => {
    expect(hashSeed('a')).toBe(hashSeed('a'));
    expect(hashSeed('a')).not.toBe(hashSeed('b'));
    const cells = avatarCells('spreadsheet-sigma');
    expect(cells).toEqual(avatarCells('spreadsheet-sigma'));
    for (const { x, y } of cells) expect(cells).toContainEqual({ x: 4 - x, y });
    render(<AgentAvatar seed="spreadsheet-sigma" label="The Spreadsheet avatar" size={32} />);
    const img = screen.getByRole('img', { name: 'The Spreadsheet avatar' });
    expect(img).toHaveAttribute('width', '32');
    expect(img.querySelectorAll('rect')).toHaveLength(cells.length);
  });
});

describe('ApiErrorAlert', () => {
  it('shows the message and the fix of an API error', () => {
    const error = new ApiError(400, { code: 'X', message: 'Bad.', fix: 'Do better.' });
    render(<ApiErrorAlert error={error} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Bad.Do better.');
  });

  it('renders nothing without an error, and plain messages otherwise', () => {
    const { container } = render(<ApiErrorAlert error={null} />);
    expect(container).toBeEmptyDOMElement();
    expect(errorText(new Error('plain'))).toEqual({ message: 'plain', fix: undefined });
    expect(errorText('text')).toEqual({ message: 'text', fix: undefined });
    render(<ApiErrorAlert error={new ApiError(500, { code: 'Y', message: 'No fix.' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/^No fix\.$/);
  });
});

describe('ConfirmButton', () => {
  it('confirms or cancels', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmButton
        label="Remove"
        title="Remove Bob?"
        message="Sure?"
        confirmLabel="Yes"
        onConfirm={onConfirm}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Sure?')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Yes' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(screen.queryByText('Sure?')).not.toBeInTheDocument();
  });
});

describe('TableScroll', () => {
  /** jsdom lays nothing out: give the scroller the sizes a phone would. */
  function sized(el: HTMLElement, sizes: { scrollWidth: number; clientWidth: number }) {
    Object.defineProperty(el, 'scrollWidth', { configurable: true, value: sizes.scrollWidth });
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: sizes.clientWidth });
  }

  it('is a plain box while the table fits', () => {
    render(
      <TableScroll label="Standings">
        <table aria-label="Standings" />
      </TableScroll>
    );
    expect(screen.getByTestId('table-scroll')).toHaveAttribute('data-scrolls', 'false');
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('becomes a named, focusable region with edge shadows while there is more to scroll', () => {
    let resized: () => void = () => {};
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe = observe;
        disconnect = disconnect;
      }
    );
    try {
      const { container, unmount } = render(
        <TableScroll label="Seat version history">
          <table aria-label="Seat version history" />
        </TableScroll>
      );
      const scroller = container.querySelector<HTMLElement>('.overflow-x-auto')!;
      expect(observe).toHaveBeenCalledWith(scroller);
      const shadows = () => container.querySelectorAll('[aria-hidden="true"]');

      // Wider than the screen: a shadow on the right says there is more.
      sized(scroller, { scrollWidth: 600, clientWidth: 320 });
      act(() => resized());
      const region = screen.getByRole('region', { name: 'Seat version history (scrolls sideways)' });
      expect(region).toHaveAttribute('tabindex', '0');
      expect(screen.getByTestId('table-scroll')).toHaveAttribute('data-scrolls', 'true');
      expect(shadows()).toHaveLength(1);
      expect(container.querySelector('.bg-gradient-to-l')).toBeInTheDocument();

      // Halfway: both edges.
      scroller.scrollLeft = 100;
      fireEvent.scroll(scroller);
      expect(shadows()).toHaveLength(2);

      // Scrolled to the end: only the left edge.
      scroller.scrollLeft = 280;
      fireEvent.scroll(scroller);
      expect(shadows()).toHaveLength(1);
      expect(container.querySelector('.bg-gradient-to-r')).toBeInTheDocument();
      // A scroll that changes nothing keeps the state as it is.
      fireEvent.scroll(scroller);
      expect(shadows()).toHaveLength(1);

      unmount();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
