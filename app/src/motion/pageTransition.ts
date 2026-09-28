import type { MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { prefersReducedMotion } from './reducedMotion';

type WithViewTransitions = Document & { startViewTransition?: (update: () => void) => unknown };

/** True when the browser can cross-fade between pages itself (the View Transitions API). */
export function supportsViewTransitions(): boolean {
  return typeof (document as WithViewTransitions).startViewTransition === 'function';
}

/**
 * A link click handler that runs the navigation inside a view transition, so the page cross-fades
 * instead of snapping. Modified clicks (new tab, etc.), reduced motion, and browsers without the API
 * fall through to the plain link; those browsers get the CSS enter animation (`motion-page`) instead.
 */
export function transitionClick(navigate: () => void) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      prefersReducedMotion() ||
      !supportsViewTransitions()
    ) {
      return;
    }
    event.preventDefault();
    (document as WithViewTransitions).startViewTransition!(() => flushSync(navigate));
  };
}
