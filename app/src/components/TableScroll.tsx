import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A wide table that scrolls sideways inside its own box on a narrow screen instead of pushing the
 * page wider (#138). While there is more to either side, that edge shows a soft shadow, so it is
 * plain the table goes on; the box is then also a focusable, named region, so a keyboard can
 * scroll it too.
 */
export function TableScroll({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    resize?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      resize?.disconnect();
    };
  }, []);
  const scrolls = edges.left || edges.right;
  return (
    <div className="relative min-w-0" data-testid="table-scroll" data-scrolls={scrolls}>
      <div
        ref={ref}
        className="relative overflow-x-auto overscroll-x-contain"
        {...(scrolls ? { role: 'region', 'aria-label': `${label} (scrolls sideways)`, tabIndex: 0 } : {})}
      >
        {children}
      </div>
      {edges.left && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-foreground/15 to-transparent"
        />
      )}
      {edges.right && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-foreground/15 to-transparent"
        />
      )}
    </div>
  );
}
