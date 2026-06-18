import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';

const STORAGE_KEY = 'tavern:voice-side-chat-width';
const DEFAULT_WIDTH = 400;
const MIN_WIDTH = 320;
/** Keep at least this much room for the left pane (the voice grid). */
const GRID_RESERVE = 360;
const KEY_STEP = 24;

function readStored(): number {
  if (typeof window === 'undefined') return DEFAULT_WIDTH;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= MIN_WIDTH ? n : DEFAULT_WIDTH;
}

export interface ResizablePane {
  /** Current width of the right pane, in px. */
  width: number;
  min: number;
  max: number;
  /** Attach to the split container so the max width can be measured from it. */
  containerRef: RefObject<HTMLDivElement>;
  /** Spread onto the divider element (WAI-ARIA window-splitter pattern). */
  separatorProps: {
    role: 'separator';
    'aria-orientation': 'vertical';
    'aria-valuenow': number;
    'aria-valuemin': number;
    'aria-valuemax': number;
    tabIndex: number;
    onPointerDown: (e: ReactPointerEvent) => void;
    onKeyDown: (e: ReactKeyboardEvent) => void;
  };
}

/**
 * Drag-to-resize state for a right-hand pane (the voice room's side chat).
 * Persists the chosen width to localStorage and re-clamps on window resize so
 * the left pane (voice grid) always keeps at least GRID_RESERVE px. Keyboard
 * accessible: focus the separator and use Arrow / Home / End.
 */
export function useResizablePane(): ResizablePane {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>(readStored);
  const [max, setMax] = useState<number>(800);

  const computeMax = useCallback((): number => {
    const c = containerRef.current;
    return c ? Math.max(MIN_WIDTH, c.clientWidth - GRID_RESERVE) : 800;
  }, []);

  useEffect(() => {
    function recompute(): void {
      const m = computeMax();
      setMax(m);
      setWidth((w) => Math.min(Math.max(w, MIN_WIDTH), m));
    }
    recompute();
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
  }, [computeMax]);

  const persist = useCallback((w: number): void => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(Math.round(w)));
    } catch {
      /* ignore storage errors (quota / privacy mode) */
    }
  }, []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent): void => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;
      const m = computeMax();
      const move = (ev: PointerEvent): void => {
        // Pane sits on the right, so dragging left (clientX decreasing) grows it.
        setWidth(Math.min(Math.max(startWidth - (ev.clientX - startX), MIN_WIDTH), m));
      };
      const up = (ev: PointerEvent): void => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        persist(Math.min(Math.max(startWidth - (ev.clientX - startX), MIN_WIDTH), m));
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    },
    [width, computeMax, persist],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent): void => {
      const m = computeMax();
      let next: number | null = null;
      if (e.key === 'ArrowLeft') next = width + KEY_STEP;
      else if (e.key === 'ArrowRight') next = width - KEY_STEP;
      else if (e.key === 'Home') next = MIN_WIDTH;
      else if (e.key === 'End') next = m;
      if (next === null) return;
      e.preventDefault();
      const clamped = Math.min(Math.max(next, MIN_WIDTH), m);
      setWidth(clamped);
      persist(clamped);
    },
    [width, computeMax, persist],
  );

  return {
    width,
    min: MIN_WIDTH,
    max,
    containerRef,
    separatorProps: {
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-valuenow': Math.round(width),
      'aria-valuemin': MIN_WIDTH,
      'aria-valuemax': Math.round(max),
      tabIndex: 0,
      onPointerDown,
      onKeyDown,
    },
  };
}
