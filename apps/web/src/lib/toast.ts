/**
 * Tiny toast / inline-error helper used by the error-UX wave (FE-09..11,
 * FE-22..24). We keep this dependency-free: a single Zustand-style store
 * with imperative `toast.error(message)` / `toast.success(message)` helpers,
 * a `<Toaster />` consumer mounted near the app root, and auto-dismissal.
 *
 * Why not Radix Toast or similar? The Tavern design system uses Radix Dialog
 * for the existing modals and we don't want to add another dependency for a
 * 60-line problem. If we ever need stacking / focus-management more
 * sophisticated than this, swapping in Radix Toast is a localized change.
 */
import { useSyncExternalStore } from 'react';

export type ToastKind = 'error' | 'success' | 'info';

export interface ToastEntry {
  id: number;
  kind: ToastKind;
  message: string;
}

const DEFAULT_TTL_MS = 5_000;

const listeners = new Set<() => void>();
let toasts: ReadonlyArray<ToastEntry> = [];
let nextId = 1;

function emit(): void {
  for (const fn of listeners) fn();
}

function add(kind: ToastKind, message: string): number {
  const id = nextId++;
  toasts = [...toasts, { id, kind, message }];
  emit();
  setTimeout(() => dismiss(id), DEFAULT_TTL_MS);
  return id;
}

export function dismiss(id: number): void {
  const next = toasts.filter((t) => t.id !== id);
  if (next.length !== toasts.length) {
    toasts = next;
    emit();
  }
}

export const toast = {
  error: (message: string): number => add('error', message),
  success: (message: string): number => add('success', message),
  info: (message: string): number => add('info', message),
};

export function useToasts(): ReadonlyArray<ToastEntry> {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => toasts,
    () => toasts,
  );
}
