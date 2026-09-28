import { useCallback, useEffect, useState } from 'react';

export interface Loaded<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  /** Load again, keeping the current data on screen until the new data arrives. */
  reload: () => void;
}

/**
 * Runs `load` on mount and whenever `key` changes; the latest call wins. With `pollMs` it loads
 * again on that interval (live scores), keeping the data on screen in between.
 */
export function useLoad<T>(load: () => Promise<T>, key: string, pollMs?: number): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let current = true;
    setLoading(true);
    load().then(
      (value) => {
        if (!current) return;
        setData(value);
        setError(null);
        setLoading(false);
      },
      (reason: unknown) => {
        if (!current) return;
        setError(reason);
        setLoading(false);
      }
    );
    return () => {
      current = false;
    };
    // `load` is a fresh closure every render; `key` and `generation` decide when to run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, generation]);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);

  useEffect(() => {
    if (pollMs === undefined) return undefined;
    const timer = setInterval(reload, pollMs);
    return () => clearInterval(timer);
  }, [pollMs, reload]);

  return { data, error, loading, reload };
}
