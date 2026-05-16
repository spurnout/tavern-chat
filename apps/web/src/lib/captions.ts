/**
 * Wave 3 #33 — Live captions.
 *
 * Thin wrapper around the browser's `SpeechRecognition` API. Chromium browsers
 * (Chrome, Edge, Brave, Opera) expose `webkitSpeechRecognition`; Safari
 * exposes `SpeechRecognition` directly. Firefox does not implement either.
 *
 * Consumers feature-detect via `captionsSupported()` and hide the toggle
 * gracefully when the API isn't there. No server-side ML inference is
 * required — recognition runs in the browser's speech subsystem (which is
 * cloud-backed in Chrome, on-device in Safari).
 */

export interface CaptionResult {
  /** The transcript text from the current utterance. */
  text: string;
  /** True once the engine commits the line (no further interim edits). */
  isFinal: boolean;
}

export interface CaptionEngine {
  start(): void;
  stop(): void;
  /** True once `start()` has resolved and the engine is listening. */
  isListening(): boolean;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionResultLikeEvent) => void) | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionResultLikeEvent {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

function getCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function captionsSupported(): boolean {
  return getCtor() !== null;
}

/**
 * Create a caption engine bound to the user's mic. Calls `onResult` with each
 * interim + final transcript chunk; calls `onError` with the engine's error
 * code (`no-speech`, `audio-capture`, `not-allowed`, ...).
 *
 * The browser engines stop when the speaker pauses for ~5s; we auto-restart
 * the engine until the consumer calls `stop()` so a long pause doesn't kill
 * the session.
 */
export function createCaptionEngine(opts: {
  lang?: string;
  onResult: (r: CaptionResult) => void;
  onError?: (err: string) => void;
}): CaptionEngine {
  const Ctor = getCtor();
  if (!Ctor) {
    return {
      start: () => undefined,
      stop: () => undefined,
      isListening: () => false,
    };
  }
  let listening = false;
  let stopRequested = false;
  let instance: SpeechRecognitionInstance | null = null;

  const make = (): SpeechRecognitionInstance => {
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = opts.lang ?? navigator.language ?? 'en-US';
    r.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result || result.length === 0) continue;
        const first = result[0];
        if (!first) continue;
        opts.onResult({
          text: first.transcript.trim(),
          isFinal: !!result.isFinal,
        });
      }
    };
    r.onerror = (event) => {
      // `no-speech` is common — the engine just gave up waiting. Don't bubble.
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      opts.onError?.(event.error);
    };
    r.onend = () => {
      listening = false;
      if (!stopRequested) {
        // Auto-restart so a long pause doesn't kill the session.
        try {
          instance?.start();
          listening = true;
        } catch {
          // start() throws if already started — safe to ignore.
        }
      }
    };
    return r;
  };

  return {
    start(): void {
      if (listening) return;
      stopRequested = false;
      instance = make();
      try {
        instance.start();
        listening = true;
      } catch (err) {
        opts.onError?.(err instanceof Error ? err.message : 'start failed');
      }
    },
    stop(): void {
      stopRequested = true;
      if (instance) {
        try {
          instance.stop();
        } catch {
          // ignore
        }
      }
      listening = false;
    },
    isListening(): boolean {
      return listening;
    },
  };
}
