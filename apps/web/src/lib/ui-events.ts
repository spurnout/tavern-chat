/**
 * Tiny typed pub/sub for app-shell-scoped UI signals — e.g. the command palette
 * asking the shell to open a "create server" or "create channel" modal. Avoids
 * threading callback props from every distant call site, and stays type-safe
 * by funnelling through one discriminated-union event.
 */

export type UiEvent =
  | { kind: 'open-create-server' }
  | { kind: 'open-create-channel' }
  | { kind: 'open-notification-settings' };

type Listener = (e: UiEvent) => void;

const listeners = new Set<Listener>();

export function emitUi(event: UiEvent): void {
  for (const l of listeners) l(event);
}

export function onUi(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
