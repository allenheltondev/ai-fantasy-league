import { useEffect, useRef } from 'react';
import { usePrefersReducedMotion } from './reducedMotion';

/** A pick or a weekly win gets a burst; a playoff or title win gets the big show. */
export type ConfettiSize = 'burst' | 'big';

const SETTINGS = {
  burst: { count: 90, durationMs: 1800 },
  big: { count: 240, durationMs: 3400 }
} as const;

/** Brand tokens (rgb triplets), read at fire time so dark mode gets its own ramp. */
const TOKENS = ['--primary-500', '--success-500', '--warning-400', '--primary-300', '--error-500'];

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number;
  angle: number;
  size: number;
  color: string;
}

function palette(): string[] {
  const style = getComputedStyle(document.documentElement);
  const colors = TOKENS.map((t) => style.getPropertyValue(t).trim())
    .filter(Boolean)
    .map((rgb) => `rgb(${rgb})`);
  return colors.length > 0 ? colors : ['#219eff', '#14b8a6', '#fb923c'];
}

function launch(size: ConfettiSize, width: number, height: number): Piece[] {
  const colors = palette();
  const { count } = SETTINGS[size];
  // A burst rises from the lower middle; the big show fires from both bottom corners.
  const origins =
    size === 'burst'
      ? [{ x: width / 2, y: height * 0.7, aim: -Math.PI / 2 }]
      : [
          { x: 0, y: height, aim: -Math.PI / 3 },
          { x: width, y: height, aim: (-2 * Math.PI) / 3 }
        ];
  return Array.from({ length: count }, (_, i) => {
    const origin = origins[i % origins.length]!;
    const angle = origin.aim + (Math.random() - 0.5) * (size === 'burst' ? 1.6 : 0.9);
    const speed = (size === 'burst' ? 9 : 16) * (0.55 + Math.random() * 0.6);
    return {
      x: origin.x,
      y: origin.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      spin: (Math.random() - 0.5) * 0.3,
      angle: Math.random() * Math.PI,
      size: 6 + Math.random() * 6,
      color: colors[i % colors.length]!
    };
  });
}

/**
 * A one-shot confetti burst on a full-window canvas. It never takes input (pointer-events: none),
 * never loops, and removes nothing from layout (fixed position). Under reduced motion it renders
 * nothing at all. Remount it (change its `key`) to fire again.
 */
export function Confetti({ size = 'burst', onDone }: { size?: ConfettiSize; onDone?: () => void }) {
  const reduced = usePrefersReducedMotion();
  const canvas = useRef<HTMLCanvasElement>(null);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d') ?? null;
    if (reduced || el === null || ctx === null) return undefined;
    const ratio = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    el.width = width * ratio;
    el.height = height * ratio;
    ctx.scale(ratio, ratio);
    const pieces = launch(size, width, height);
    const { durationMs } = SETTINGS[size];
    let frame = 0;
    let start: number | null = null;
    const draw = (now: number) => {
      start ??= now;
      const elapsed = now - start;
      ctx.clearRect(0, 0, width, height);
      ctx.globalAlpha = Math.max(0, 1 - Math.max(0, elapsed - durationMs * 0.6) / (durationMs * 0.4));
      for (const p of pieces) {
        p.vy += 0.32;
        p.vx *= 0.985;
        p.vy *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.angle += p.spin;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      }
      if (elapsed < durationMs) frame = requestAnimationFrame(draw);
      else {
        ctx.clearRect(0, 0, width, height);
        done.current?.();
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [reduced, size]);

  if (reduced) return null;
  return (
    <canvas
      ref={canvas}
      aria-hidden="true"
      data-testid="confetti"
      data-size={size}
      className="pointer-events-none fixed inset-0 z-50 h-full w-full"
    />
  );
}
