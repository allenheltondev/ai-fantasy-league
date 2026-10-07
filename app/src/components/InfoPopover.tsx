import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

const EDGE = 8;

const ICONS = {
  question: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4" />
      <path d="M12 17.5h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4.5" />
      <path d="M12 8h.01" />
    </>
  )
} as const;

/**
 * A small icon button that opens a panel of plain-language help beside it, so the help stays out
 * of the way until asked for. Closes on Escape, an outside tap, or following a link inside it, and
 * slides to stay inside the viewport (the trigger can sit at either edge).
 */
export function InfoPopover(props: {
  /** The button's accessible name, as a question: "What is FAAB?". */
  label: string;
  /** Show the label beside the icon, for help that stands alone rather than beside what it explains. */
  showLabel?: boolean;
  /** The open panel's accessible name: "About FAAB". */
  title: string;
  icon?: keyof typeof ICONS;
  testId?: string;
  /** Which edge of the trigger the panel lines up with: `end` for a trigger at the right. */
  align?: 'start' | 'end';
  /** Tailwind width classes for the panel. */
  width?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // How far to slide the panel so it stays inside the viewport.
  const [shift, setShift] = useState(0);
  const panelId = useId();

  useLayoutEffect(() => {
    if (!open || panel.current === null) return;
    const rect = panel.current.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    // `rect` includes the current shift, so work from the unshifted position.
    const left = rect.left - shift;
    const right = rect.right - shift;
    if (right > width - EDGE) setShift(width - EDGE - right);
    else if (left < EDGE) setShift(EDGE - left);
    else setShift(0);
    // Measured once per open; the panel's size does not change while it is up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onPointer = (e: PointerEvent) => {
      if (root.current !== null && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  return (
    <span ref={root} className="relative inline-block align-middle" data-testid={props.testId}>
      <button
        type="button"
        aria-label={props.showLabel ? undefined : props.label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 text-muted-foreground hover:text-primary-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 ${
          props.showLabel ? 'rounded-md px-2 text-sm font-medium' : 'rounded-full'
        }`}
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {ICONS[props.icon ?? 'question']}
        </svg>
        {props.showLabel && props.label}
      </button>
      {open && (
        <div
          id={panelId}
          ref={panel}
          style={shift === 0 ? undefined : { transform: `translateX(${shift}px)` }}
          role="region"
          aria-label={props.title}
          // A link inside goes somewhere else in the app: the panel has done its job.
          onClick={(e) => (e.target as Element).closest('a') !== null && setOpen(false)}
          className={`motion-pop absolute ${props.align === 'end' ? 'right-0' : 'left-0'} top-full z-30 ${props.width ?? 'w-72'} max-w-[calc(100vw-2rem)] space-y-1 rounded-lg border border-border bg-surface p-3 text-sm font-normal text-foreground shadow-lg`}
        >
          {props.children}
        </div>
      )}
    </span>
  );
}
