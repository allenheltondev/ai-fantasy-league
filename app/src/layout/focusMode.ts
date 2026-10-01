import { useCallback, useState } from 'react';

/**
 * Focus mode: the side nav folded away so the page (a draft board, a live matchup) gets the whole
 * screen. Remembered per browser; storage can be unavailable, and then it lasts until you reload.
 */
export const FOCUS_MODE_KEY = 'aff:focusMode';

export function readFocusMode(): boolean {
  try {
    return localStorage.getItem(FOCUS_MODE_KEY) === 'on';
  } catch {
    return false;
  }
}

function writeFocusMode(on: boolean): void {
  try {
    if (on) localStorage.setItem(FOCUS_MODE_KEY, 'on');
    else localStorage.removeItem(FOCUS_MODE_KEY);
  } catch {
    // Blocked storage only means the nav comes back on the next visit.
  }
}

export function useFocusMode(): [boolean, (on: boolean) => void] {
  const [focus, setFocus] = useState(readFocusMode);
  const set = useCallback((on: boolean) => {
    writeFocusMode(on);
    setFocus(on);
  }, []);
  return [focus, set];
}
