import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Input } from '@readysetcloud/ui';
import { parseJoinCode } from '../../lib/joinCode';

/** "Join a league": a button that opens a one-field form for the code a commissioner shared. */
export function JoinByCode({ variant = 'secondary' }: { variant?: 'primary' | 'secondary' }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | undefined>();

  if (!open) {
    return (
      <Button variant={variant} onClick={() => setOpen(true)}>
        Join a league
      </Button>
    );
  }

  return (
    <form
      className="flex flex-wrap items-start gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const code = parseJoinCode(text);
        if (code === null) {
          setError('A join code is 6 letters and numbers, like K7M-Q2X.');
          return;
        }
        navigate(`/join/${code}`);
      }}
    >
      <div className="w-44">
        <Input
          label="Join code"
          autoFocus
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={12}
          placeholder="K7M-Q2X"
          className="font-mono uppercase tracking-widest"
          value={text}
          error={error}
          onChange={(e) => {
            setText(e.target.value);
            setError(undefined);
          }}
        />
      </div>
      <Button type="submit" variant="primary" className="mt-6">
        Find league
      </Button>
      <Button type="button" variant="ghost" className="mt-6" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}
