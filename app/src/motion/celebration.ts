import { useEffect, useState } from 'react';

const PREFIX = 'fantasy:celebrated:';

/** Whether this browser already celebrated `key`. Storage that throws (private mode) counts as no. */
export function hasCelebrated(key: string): boolean {
  try {
    return localStorage.getItem(PREFIX + key) !== null;
  } catch {
    return false;
  }
}

/** Remembers that `key` was celebrated. Best effort: blocked storage only means it may show again. */
export function markCelebrated(key: string): void {
  try {
    localStorage.setItem(PREFIX + key, '1');
  } catch {
    // Storage is full or blocked; the worst case is one more celebration.
  }
}

/**
 * True the first time this browser sees `key` (a won week, a title), and false on every later
 * render and visit: it marks the key as soon as it decides to celebrate. Null means nothing to
 * celebrate yet.
 */
export function useCelebrateOnce(key: string | null): boolean {
  const [celebrating, setCelebrating] = useState<string | null>(null);
  useEffect(() => {
    if (key === null || hasCelebrated(key)) return;
    markCelebrated(key);
    setCelebrating(key);
  }, [key]);
  return key !== null && celebrating === key;
}
