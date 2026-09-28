import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { AgentAvatar, avatarCells, hashSeed } from './AgentAvatar';
import { ApiErrorAlert, errorText } from './ApiErrorAlert';
import { ConfirmButton } from './ConfirmButton';

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
