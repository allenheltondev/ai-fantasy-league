import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockReducedMotion } from '../test/reducedMotion';
import { AnimatedNumber, DeltaFloater } from './AnimatedNumber';
import { hasCelebrated, markCelebrated, useCelebrateOnce } from './celebration';
import { Confetti } from './Confetti';
import { LoadingSkeleton, stagger, useTitleBadge } from './decor';
import { supportsViewTransitions, transitionClick } from './pageTransition';
import { prefersReducedMotion, usePrefersReducedMotion } from './reducedMotion';
import { useArrivals } from './useArrivals';
import { easeOutCubic, useCountUp } from './useCountUp';

const FRAME_TIMERS = ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'] as const;

let motion: ReturnType<typeof mockReducedMotion>;
beforeEach(() => {
  motion = mockReducedMotion(false);
});
afterEach(() => {
  motion.restore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('usePrefersReducedMotion', () => {
  it('follows the OS setting live', () => {
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
    act(() => motion.set(true));
    expect(result.current).toBe(true);
    expect(prefersReducedMotion()).toBe(true);
  });

  it('reads false where matchMedia is missing', () => {
    const original = window.matchMedia;
    // @ts-expect-error: simulating an environment without matchMedia
    delete window.matchMedia;
    try {
      expect(prefersReducedMotion()).toBe(false);
      expect(renderHook(() => usePrefersReducedMotion()).result.current).toBe(false);
    } finally {
      window.matchMedia = original;
    }
  });
});

describe('useCountUp', () => {
  it('shows the first value as is, then eases to each new value and lands on it exactly', () => {
    vi.useFakeTimers({ toFake: [...FRAME_TIMERS] });
    const { result, rerender } = renderHook(({ target }) => useCountUp(target, 500), {
      initialProps: { target: 10 }
    });
    expect(result.current).toBe(10);
    rerender({ target: 40.5 });
    act(() => void vi.advanceTimersByTime(100));
    expect(result.current).toBeGreaterThan(10);
    expect(result.current).toBeLessThan(40.5);
    act(() => void vi.advanceTimersByTime(600));
    expect(result.current).toBe(40.5);

    // Counting down works the same way.
    rerender({ target: 12 });
    act(() => void vi.advanceTimersByTime(100));
    expect(result.current).toBeLessThan(40.5);
    expect(result.current).toBeGreaterThan(12);
    act(() => void vi.advanceTimersByTime(600));
    expect(result.current).toBe(12);
  });

  it('jumps straight to the new value under reduced motion', () => {
    motion.set(true);
    vi.useFakeTimers({ toFake: [...FRAME_TIMERS] });
    const { result, rerender } = renderHook(({ target }) => useCountUp(target), {
      initialProps: { target: 10 }
    });
    rerender({ target: 99 });
    expect(result.current).toBe(99);
  });

  it('eases out', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});

describe('AnimatedNumber and DeltaFloater', () => {
  it('flashes green up and red down, and floats the change over a player', () => {
    vi.useFakeTimers({ toFake: [...FRAME_TIMERS] });
    const { rerender } = render(
      <>
        <AnimatedNumber data-testid="n" value={10} />
        <DeltaFloater value={4} />
      </>
    );
    expect(screen.getByTestId('n')).toHaveTextContent('10.00');
    expect(screen.getByTestId('n')).not.toHaveAttribute('data-flash');
    expect(screen.queryByTestId('delta-floater')).not.toBeInTheDocument();

    rerender(
      <>
        <AnimatedNumber data-testid="n" value={16} />
        <DeltaFloater value={10} />
      </>
    );
    expect(screen.getByTestId('n')).toHaveAttribute('data-flash', 'up');
    expect(screen.getByTestId('n')).toHaveClass('motion-flash-up');
    expect(screen.getByTestId('delta-floater')).toHaveTextContent('+6.0');
    expect(screen.getByTestId('delta-floater')).toHaveClass('text-success-700');
    act(() => void vi.advanceTimersByTime(2000));
    expect(screen.getByTestId('n')).toHaveTextContent('16.00');
    expect(screen.queryByTestId('delta-floater')).not.toBeInTheDocument();

    rerender(
      <>
        <AnimatedNumber data-testid="n" value={14} />
        <DeltaFloater value={8} />
      </>
    );
    expect(screen.getByTestId('n')).toHaveAttribute('data-flash', 'down');
    expect(screen.getByTestId('delta-floater')).toHaveTextContent('-2.0');
    expect(screen.getByTestId('delta-floater')).toHaveClass('text-error-700');

    // No floater when points go from nothing to something (the first stat of the game).
    rerender(
      <>
        <AnimatedNumber data-testid="n" value={14} />
        <DeltaFloater value={null} />
      </>
    );
    act(() => void vi.advanceTimersByTime(2000));
    rerender(
      <>
        <AnimatedNumber data-testid="n" value={14} />
        <DeltaFloater value={3} />
      </>
    );
    expect(screen.queryByTestId('delta-floater')).not.toBeInTheDocument();
  });
});

describe('Confetti', () => {
  function fakeContext() {
    return {
      scale: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      fillRect: vi.fn(),
      globalAlpha: 1,
      fillStyle: ''
    };
  }

  it('draws a one-shot burst that ends and reports it', () => {
    vi.useFakeTimers({ toFake: [...FRAME_TIMERS] });
    const ctx = fakeContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D
    );
    document.documentElement.style.setProperty('--primary-500', '33 158 255');
    const onDone = vi.fn();
    render(<Confetti onDone={onDone} />);
    const canvas = screen.getByTestId('confetti');
    expect(canvas).toHaveAttribute('aria-hidden', 'true');
    expect(canvas).toHaveClass('pointer-events-none');
    act(() => void vi.advanceTimersByTime(500));
    expect(ctx.fillRect).toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(2000));
    expect(onDone).toHaveBeenCalledOnce();
    document.documentElement.style.removeProperty('--primary-500');
  });

  it('fires the big show from both corners, with fallback colors when tokens are missing', () => {
    vi.useFakeTimers({ toFake: [...FRAME_TIMERS] });
    const ctx = fakeContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D
    );
    const ratio = vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(0);
    render(<Confetti size="big" />);
    expect(screen.getByTestId('confetti')).toHaveAttribute('data-size', 'big');
    act(() => void vi.advanceTimersByTime(4000));
    expect(ctx.scale).toHaveBeenCalledWith(1, 1);
    expect(ctx.fillStyle).toMatch(/^#|^rgb/);
    ratio.mockRestore();
  });

  it('renders nothing under reduced motion', () => {
    motion.set(true);
    render(<Confetti size="big" />);
    expect(screen.queryByTestId('confetti')).not.toBeInTheDocument();
  });

  it('does nothing without a 2d context', () => {
    render(<Confetti />);
    expect(screen.getByTestId('confetti')).toBeInTheDocument();
  });
});

describe('celebrate once', () => {
  it('celebrates a key the first time only, across visits', () => {
    const first = renderHook(({ key }) => useCelebrateOnce(key), { initialProps: { key: 'win:L1:m1' } });
    expect(first.result.current).toBe(true);
    // It stays up for the rest of this visit.
    first.rerender({ key: 'win:L1:m1' });
    expect(first.result.current).toBe(true);
    first.unmount();

    const again = renderHook(() => useCelebrateOnce('win:L1:m1'));
    expect(again.result.current).toBe(false);
    expect(hasCelebrated('win:L1:m1')).toBe(true);
  });

  it('has nothing to celebrate without a key', () => {
    expect(renderHook(() => useCelebrateOnce(null)).result.current).toBe(false);
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(hasCelebrated('x')).toBe(false);
    expect(() => markCelebrated('x')).not.toThrow();
    expect(renderHook(() => useCelebrateOnce('x')).result.current).toBe(true);
  });
});

describe('useArrivals', () => {
  it('flags only keys that arrive after the first load', () => {
    const { result, rerender } = renderHook(({ keys }) => useArrivals(keys), {
      initialProps: { keys: null as string[] | null }
    });
    expect(result.current('1')).toBe(false);
    rerender({ keys: ['1', '2'] });
    expect(result.current('1')).toBe(false);
    rerender({ keys: ['1', '2', '3'] });
    expect(result.current('2')).toBe(false);
    expect(result.current('3')).toBe(true);
  });
});

describe('decor', () => {
  it('prefixes the tab title while active and restores it', () => {
    document.title = 'Fantasy';
    const { rerender, unmount } = renderHook(({ on }) => useTitleBadge(on, 'Your pick!'), {
      initialProps: { on: false }
    });
    expect(document.title).toBe('Fantasy');
    rerender({ on: true });
    expect(document.title).toBe('Your pick! · Fantasy');
    unmount();
    expect(document.title).toBe('Fantasy');
  });

  it('staggers the first rows and caps the delay', () => {
    expect(stagger(2).style).toEqual({ '--motion-i': 2 });
    expect(stagger(40).style).toEqual({ '--motion-i': 10 });
    expect(stagger(0).className).toBe('motion-stagger');
  });

  it('keeps the loading label readable', () => {
    render(<LoadingSkeleton label="Loading standings…" rows={2} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading standings…');
  });
});

describe('page transitions', () => {
  function click(handler: ReturnType<typeof transitionClick>, init: MouseEventInit = {}) {
    const a = document.createElement('a');
    document.body.append(a);
    let prevented = false;
    a.addEventListener('click', (e) => {
      handler(e as unknown as Parameters<typeof handler>[0]);
      prevented = e.defaultPrevented;
    });
    fireEvent.click(a, init);
    a.remove();
    return prevented;
  }

  it('runs the navigation inside a view transition when the browser has one', () => {
    const start = vi.fn((update: () => void) => update());
    Object.defineProperty(document, 'startViewTransition', { value: start, configurable: true });
    try {
      expect(supportsViewTransitions()).toBe(true);
      const navigate = vi.fn();
      expect(click(transitionClick(navigate))).toBe(true);
      expect(start).toHaveBeenCalledOnce();
      expect(navigate).toHaveBeenCalledOnce();

      // New-tab clicks and reduced motion fall through to the plain link.
      expect(click(transitionClick(navigate), { metaKey: true })).toBe(false);
      motion.set(true);
      expect(click(transitionClick(navigate))).toBe(false);
      expect(navigate).toHaveBeenCalledOnce();
    } finally {
      Reflect.deleteProperty(document, 'startViewTransition');
    }
  });

  it('leaves the link alone without the API', () => {
    expect(supportsViewTransitions()).toBe(false);
    const navigate = vi.fn();
    expect(click(transitionClick(navigate))).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
