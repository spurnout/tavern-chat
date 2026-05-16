/**
 * Wave 3 batch 7 — voice-room event bus.
 *
 * Lightweight pub/sub for gateway events that need to drive UI inside
 * VoiceRoom and its descendants. Compared to the store-based dispatch in
 * `realtime.ts`, these payloads are transient (a one-shot redirect for
 * breakouts, a one-shot consent prompt for recording) and don't deserve
 * to live in the persistent zustand store.
 *
 * `realtime.ts` is the single subscriber to the WebSocket; it re-emits
 * each relevant event through the helpers below, and any component can
 * subscribe via the `onX(...)` registration. Returns the unsubscribe.
 */

type Listener<T> = (data: T) => void;

// ---------- Breakouts (#29) ---------------------------------------------

export interface BreakoutOpenPayload {
  parentChannelId: string;
  endsAt: string | null;
  groups: Array<{ id: string; name: string; livekitRoom: string; members: string[] }>;
}

export interface BreakoutClosePayload {
  parentChannelId: string;
}

const breakoutOpenListeners = new Set<Listener<BreakoutOpenPayload>>();
const breakoutCloseListeners = new Set<Listener<BreakoutClosePayload>>();

export function onBreakoutOpen(fn: Listener<BreakoutOpenPayload>): () => void {
  breakoutOpenListeners.add(fn);
  return () => {
    breakoutOpenListeners.delete(fn);
  };
}

export function emitBreakoutOpen(p: BreakoutOpenPayload): void {
  for (const fn of breakoutOpenListeners) fn(p);
}

export function onBreakoutClose(fn: Listener<BreakoutClosePayload>): () => void {
  breakoutCloseListeners.add(fn);
  return () => {
    breakoutCloseListeners.delete(fn);
  };
}

export function emitBreakoutClose(p: BreakoutClosePayload): void {
  for (const fn of breakoutCloseListeners) fn(p);
}

// ---------- Recording with consent (#32) --------------------------------

export interface RecordingConsentRequestPayload {
  channelId: string;
  proposerUserId: string;
  proposedAt: number;
}

export interface RecordingConsentUpdatePayload {
  channelId: string;
  userId: string;
  consent: boolean;
  at: number;
}

export interface RecordingStartedPayload {
  channelId: string;
  recorderUserId: string;
  startedAt: number;
}

export interface RecordingStoppedPayload {
  channelId: string;
  recordingId: string;
  endedAt: string;
}

const consentReqListeners = new Set<Listener<RecordingConsentRequestPayload>>();
const consentUpdListeners = new Set<Listener<RecordingConsentUpdatePayload>>();
const startedListeners = new Set<Listener<RecordingStartedPayload>>();
const stoppedListeners = new Set<Listener<RecordingStoppedPayload>>();

export function onRecordingConsentRequest(
  fn: Listener<RecordingConsentRequestPayload>,
): () => void {
  consentReqListeners.add(fn);
  return () => {
    consentReqListeners.delete(fn);
  };
}

export function emitRecordingConsentRequest(p: RecordingConsentRequestPayload): void {
  for (const fn of consentReqListeners) fn(p);
}

export function onRecordingConsentUpdate(
  fn: Listener<RecordingConsentUpdatePayload>,
): () => void {
  consentUpdListeners.add(fn);
  return () => {
    consentUpdListeners.delete(fn);
  };
}

export function emitRecordingConsentUpdate(p: RecordingConsentUpdatePayload): void {
  for (const fn of consentUpdListeners) fn(p);
}

export function onRecordingStarted(fn: Listener<RecordingStartedPayload>): () => void {
  startedListeners.add(fn);
  return () => {
    startedListeners.delete(fn);
  };
}

export function emitRecordingStarted(p: RecordingStartedPayload): void {
  for (const fn of startedListeners) fn(p);
}

export function onRecordingStopped(fn: Listener<RecordingStoppedPayload>): () => void {
  stoppedListeners.add(fn);
  return () => {
    stoppedListeners.delete(fn);
  };
}

export function emitRecordingStopped(p: RecordingStoppedPayload): void {
  for (const fn of stoppedListeners) fn(p);
}

// ---------- Whiteboard (#34) --------------------------------------------

export interface WhiteboardStrokePayload {
  channelId: string;
  stroke: {
    id: string;
    points: Array<[number, number]>;
    color: string;
    width: number;
    kind: 'pen' | 'eraser';
  };
  by: string;
}

export interface WhiteboardClearPayload {
  channelId: string;
  by: string;
}

const strokeListeners = new Set<Listener<WhiteboardStrokePayload>>();
const clearListeners = new Set<Listener<WhiteboardClearPayload>>();

export function onWhiteboardStroke(fn: Listener<WhiteboardStrokePayload>): () => void {
  strokeListeners.add(fn);
  return () => {
    strokeListeners.delete(fn);
  };
}

export function emitWhiteboardStroke(p: WhiteboardStrokePayload): void {
  for (const fn of strokeListeners) fn(p);
}

export function onWhiteboardClear(fn: Listener<WhiteboardClearPayload>): () => void {
  clearListeners.add(fn);
  return () => {
    clearListeners.delete(fn);
  };
}

export function emitWhiteboardClear(p: WhiteboardClearPayload): void {
  for (const fn of clearListeners) fn(p);
}
