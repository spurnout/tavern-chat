import { useEffect, useRef, useState } from 'react';
import { Captions, CaptionsOff } from 'lucide-react';
import { api } from '../lib/api-client.js';
import {
  captionsSupported,
  createCaptionEngine,
  type CaptionEngine,
} from '../lib/captions.js';

interface IncomingCaption {
  userId: string;
  displayName: string;
  text: string;
  isFinal: boolean;
  at: number;
}

interface Props {
  channelId: string;
  /** The caller's user id. Their own captions are NOT echoed back from the gateway. */
  userId: string;
  /** Local user's display name for outgoing caption events. */
  displayName: string;
  /** Whether captions are currently enabled (toggle from VoiceRoom controls). */
  enabled: boolean;
  /** Live caption lines pushed in by the realtime layer (other speakers). */
  remoteLines: IncomingCaption[];
}

/**
 * Wave 3 #33 — Live captions overlay.
 *
 * Renders the last few caption lines from the room and (when enabled) runs
 * the browser SpeechRecognition engine against the local mic, broadcasting
 * each chunk to the channel via /api/voice/:channelId/caption.
 *
 * Other clients receive `CAPTION_TEXT` gateway events and feed them in via
 * `remoteLines`.
 *
 * Browser support: hidden entirely when SpeechRecognition isn't available
 * (currently: Firefox).
 */
export function LiveCaptions({
  channelId,
  userId,
  displayName,
  enabled,
  remoteLines,
}: Props): JSX.Element | null {
  const [localLine, setLocalLine] = useState<string>('');
  const engineRef = useRef<CaptionEngine | null>(null);
  const supported = captionsSupported();

  useEffect(() => {
    if (!supported || !enabled) {
      engineRef.current?.stop();
      engineRef.current = null;
      setLocalLine('');
      return;
    }
    // FE-06e: track the in-flight clear-line timer so we cancel it on
    // teardown. Without this, an unmount within 800 ms of a final caption
    // setStates on an unmounted component (React 18 ignores, but the warning
    // is real signal); more importantly, an `enabled` flip-off doesn't
    // immediately blank the line.
    let clearTimer: number | null = null;
    const engine = createCaptionEngine({
      onResult: (r) => {
        setLocalLine(r.text);
        // Broadcast every chunk — interim too — so other clients see the
        // line build up in real time. The server publishes via gateway.
        void api(`/voice/${channelId}/caption`, {
          method: 'POST',
          body: { text: r.text, isFinal: r.isFinal },
        }).catch(() => undefined);
        if (r.isFinal) {
          // Clear the local line so the next utterance starts blank.
          if (clearTimer !== null) window.clearTimeout(clearTimer);
          clearTimer = window.setTimeout(() => {
            clearTimer = null;
            setLocalLine('');
          }, 800);
        }
      },
      onError: () => {
        // Silent — the user-facing toggle is the signal of "I tried to turn
        // this on". An error here usually means missing permission.
      },
    });
    engine.start();
    engineRef.current = engine;
    return () => {
      if (clearTimer !== null) window.clearTimeout(clearTimer);
      engine.stop();
      engineRef.current = null;
    };
  }, [supported, enabled, channelId]);

  if (!supported) return null;

  // Compose the rolling display: each speaker's most recent (final or
  // interim) line. Capped at 5 lines.
  const lines = composeLines(remoteLines, userId, displayName, localLine).slice(-5);
  if (lines.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Live captions"
      className="pointer-events-none absolute inset-x-4 bottom-20 z-10 mx-auto max-w-2xl rounded bg-overlay/90 px-3 py-2 text-sm text-fg shadow-lg"
    >
      {lines.map((l, i) => (
        <p key={`${l.userId}-${i}`} className="leading-snug">
          <span className="text-xs font-medium text-mead">{l.displayName}:</span>{' '}
          <span className={l.isFinal ? '' : 'opacity-80'}>{l.text}</span>
        </p>
      ))}
    </div>
  );
}

/**
 * Reusable icon-only toggle for the voice room control bar. Hidden when the
 * browser doesn't support SpeechRecognition.
 */
export function CaptionsToggleButton({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: () => void;
}): JSX.Element | null {
  if (!captionsSupported()) return null;
  return (
    <button
      type="button"
      className={enabled ? 'btn-primary' : 'btn-ghost'}
      onClick={onToggle}
      aria-pressed={enabled}
      title={enabled ? 'Stop captions' : 'Start captions'}
      aria-label={enabled ? 'Stop live captions' : 'Start live captions'}
    >
      {enabled ? <Captions size={16} /> : <CaptionsOff size={16} />}
    </button>
  );
}

interface ComposedLine {
  userId: string;
  displayName: string;
  text: string;
  isFinal: boolean;
}

function composeLines(
  remote: IncomingCaption[],
  selfId: string,
  selfName: string,
  localLine: string,
): ComposedLine[] {
  // Keep only the most recent line per speaker so a fast talker doesn't
  // crowd the panel.
  const byUser = new Map<string, ComposedLine>();
  // Sort remote by recency so the latest per-user wins.
  const sorted = [...remote].sort((a, b) => a.at - b.at);
  for (const r of sorted) {
    if (r.userId === selfId) continue;
    byUser.set(r.userId, {
      userId: r.userId,
      displayName: r.displayName,
      text: r.text,
      isFinal: r.isFinal,
    });
  }
  if (localLine) {
    byUser.set(selfId, {
      userId: selfId,
      displayName: selfName,
      text: localLine,
      isFinal: false,
    });
  }
  return Array.from(byUser.values());
}
