import { type RefObject, useEffect, useRef } from 'react';

export const MESSAGE_STICK_THRESHOLD_PX = 120;

export interface MessageScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export interface MessageScrollSnapshot {
  scrollTop: number;
  atBottom: boolean;
}

interface UseRememberedMessageScrollOptions {
  storageKey: string;
  itemCount: number;
  totalSize: number;
  stickThresholdPx?: number;
}

const rememberedMessageScroll = new Map<string, MessageScrollSnapshot>();
const DEFAULT_BOTTOM_SNAPSHOT: MessageScrollSnapshot = { scrollTop: 0, atBottom: true };

export function messageScrollDistanceFromBottom(metrics: MessageScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight);
}

export function readMessageScrollSnapshot(
  metrics: MessageScrollMetrics,
  stickThresholdPx = MESSAGE_STICK_THRESHOLD_PX,
): MessageScrollSnapshot {
  return {
    scrollTop: Math.max(0, metrics.scrollTop),
    atBottom: messageScrollDistanceFromBottom(metrics) <= stickThresholdPx,
  };
}

export function shouldStickToMessageBottom(
  metrics: MessageScrollMetrics,
  wasAtBottom: boolean,
  stickThresholdPx = MESSAGE_STICK_THRESHOLD_PX,
): boolean {
  return wasAtBottom || readMessageScrollSnapshot(metrics, stickThresholdPx).atBottom;
}

export function resolveMessageScrollTop(
  metrics: MessageScrollMetrics,
  snapshot: MessageScrollSnapshot | undefined,
): number {
  const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  if (!snapshot || snapshot.atBottom) return maxScrollTop;
  return Math.min(Math.max(0, snapshot.scrollTop), maxScrollTop);
}

export function useRememberedMessageScroll<T extends HTMLElement>(
  scrollRef: RefObject<T>,
  {
    storageKey,
    itemCount,
    totalSize,
    stickThresholdPx = MESSAGE_STICK_THRESHOLD_PX,
  }: UseRememberedMessageScrollOptions,
): void {
  const atBottomRef = useRef(true);
  const latestSnapshotRef = useRef<MessageScrollSnapshot>(DEFAULT_BOTTOM_SNAPSHOT);
  const restoredKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const saved = rememberedMessageScroll.get(storageKey) ?? DEFAULT_BOTTOM_SNAPSHOT;
    atBottomRef.current = saved.atBottom;
    latestSnapshotRef.current = saved;
    restoredKeyRef.current = null;

    return () => {
      rememberedMessageScroll.set(storageKey, latestSnapshotRef.current);
    };
  }, [storageKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;

    const updateSnapshot = (): void => {
      const snapshot = readMessageScrollSnapshot(el, stickThresholdPx);
      atBottomRef.current = snapshot.atBottom;
      latestSnapshotRef.current = snapshot;
      rememberedMessageScroll.set(storageKey, snapshot);
    };

    el.addEventListener('scroll', updateSnapshot, { passive: true });
    return () => {
      el.removeEventListener('scroll', updateSnapshot);
    };
  }, [scrollRef, storageKey, stickThresholdPx]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || itemCount === 0 || restoredKeyRef.current === storageKey) return undefined;

    restoredKeyRef.current = storageKey;
    const saved = rememberedMessageScroll.get(storageKey);
    const shouldRestoreBottom = saved?.atBottom ?? true;
    let rafOne = 0;
    let rafTwo = 0;

    const restore = (): void => {
      el.scrollTop = resolveMessageScrollTop(el, saved);
      const snapshot = shouldRestoreBottom
        ? { scrollTop: el.scrollTop, atBottom: true }
        : readMessageScrollSnapshot(el, stickThresholdPx);
      atBottomRef.current = snapshot.atBottom;
      latestSnapshotRef.current = snapshot;
      rememberedMessageScroll.set(storageKey, snapshot);
    };

    rafOne = window.requestAnimationFrame(() => {
      rafTwo = window.requestAnimationFrame(restore);
    });

    return () => {
      window.cancelAnimationFrame(rafOne);
      window.cancelAnimationFrame(rafTwo);
    };
  }, [scrollRef, storageKey, itemCount, totalSize, stickThresholdPx]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || itemCount === 0) return undefined;
    if (!shouldStickToMessageBottom(el, atBottomRef.current, stickThresholdPx)) {
      return undefined;
    }

    let raf = 0;
    const stickToBottom = (): void => {
      el.scrollTop = resolveMessageScrollTop(el, { scrollTop: 0, atBottom: true });
      const snapshot: MessageScrollSnapshot = { scrollTop: el.scrollTop, atBottom: true };
      atBottomRef.current = true;
      latestSnapshotRef.current = snapshot;
      rememberedMessageScroll.set(storageKey, snapshot);
    };

    raf = window.requestAnimationFrame(stickToBottom);
    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [scrollRef, storageKey, itemCount, totalSize, stickThresholdPx]);
}
