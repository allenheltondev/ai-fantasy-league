import { useCallback, useState } from 'react';

/**
 * The draft room's "you're up" chime (#170): muted by default, remembered per browser. A short
 * two-note tone made with Web Audio, so there is no file to ship; browsers that block audio (or
 * have no Web Audio) stay silent.
 */

const KEY = 'fantasy:draft-sound';

function readEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

function writeEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, 'on');
    else localStorage.removeItem(KEY);
  } catch {
    // Blocked storage: the setting lasts for this visit only.
  }
}

type AudioContextCtor = new () => AudioContext;

/** Plays the chime once. Never throws. */
export function playChime(): void {
  try {
    const Ctor = (window.AudioContext ??
      (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext) as
      AudioContextCtor | undefined;
    if (Ctor === undefined) return;
    const ctx = new Ctor();
    const start = ctx.currentTime;
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const at = start + i * 0.16;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.32);
    });
    setTimeout(() => void ctx.close().catch(() => undefined), 800);
  } catch {
    // No audio here; the visual cue still shows.
  }
}

export interface DraftSound {
  enabled: boolean;
  toggle(): void;
  /** Chimes when the sound is on. */
  play(): void;
}

export function useDraftSound(play: () => void = playChime): DraftSound {
  const [enabled, setEnabled] = useState(readEnabled);
  const toggle = useCallback(() => {
    setEnabled((on) => {
      writeEnabled(!on);
      return !on;
    });
  }, []);
  const chime = useCallback(() => {
    if (enabled) play();
  }, [enabled, play]);
  return { enabled, toggle, play: chime };
}
