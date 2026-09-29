import { useEffect, useId, useRef, useState } from 'react';

/**
 * A plain-language note on FAAB (free agent acquisition budget), tucked behind a small
 * question-mark icon so it stays out of the way until asked for. Closes on Escape or an outside tap.
 */
export function FaabExplainer({ remaining }: { remaining?: number | null }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const panelId = useId();

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
    <span ref={root} className="relative inline-block align-middle" data-testid="faab-explainer">
      <button
        type="button"
        aria-label="What is FAAB?"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-muted-foreground hover:text-primary-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500"
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
          <circle cx="12" cy="12" r="10" />
          <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4" />
          <path d="M12 17.5h.01" />
        </svg>
      </button>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-label="About FAAB"
          className="absolute left-0 top-full z-30 w-72 max-w-[calc(100vw-2rem)] space-y-1 rounded-lg border border-border bg-surface p-3 text-sm font-normal text-foreground shadow-lg"
        >
          <p>
            FAAB is your free agent budget: play money, not real money. Every team gets the same amount for
            the season{remaining != null && <> (you have ${remaining} left)</>}.
          </p>
          <p>
            Players on waivers cost a bid. Highest bid wins, and only the winner pays. Ties go to waiver
            priority. Players who are already free agents cost $0: add them any time.
          </p>
        </div>
      )}
    </span>
  );
}
