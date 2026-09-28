import { Alert } from '@readysetcloud/ui';
import { ApiError } from '../api/client';

/** The message and the server's `fix` for an API error; the message alone for anything else. */
export function errorText(error: unknown): { message: string; fix: string | undefined } {
  if (error instanceof ApiError) return { message: error.message, fix: error.fix };
  return { message: error instanceof Error ? error.message : String(error), fix: undefined };
}

export function ApiErrorAlert({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  const { message, fix } = errorText(error);
  return (
    <Alert variant="error" role="alert">
      <p className="font-medium">{message}</p>
      {fix && <p className="text-sm">{fix}</p>}
    </Alert>
  );
}
