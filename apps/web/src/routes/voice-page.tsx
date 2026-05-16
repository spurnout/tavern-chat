import { useEffect } from 'react';
import { useParams } from '@tanstack/react-router';
import { useRealtime } from '../lib/store.js';

/**
 * Thin placeholder route. The actual VoiceRoom lives one level up in
 * AppShell and is gated on the global `currentVoice` state so the LiveKit
 * session survives navigation to other channels. This page just publishes
 * the user's intent to be in this voice room; AppShell does the rest.
 */
export function VoicePage(): JSX.Element {
  const { serverId, channelId } = useParams({ strict: false }) as {
    serverId?: string;
    channelId?: string;
  };
  const channel = useRealtime((s) => {
    if (!channelId || !serverId) return null;
    return (s.channelsByServer[serverId] ?? []).find((c) => c.id === channelId) ?? null;
  });
  const setCurrentVoice = useRealtime((s) => s.setCurrentVoice);

  useEffect(() => {
    if (!serverId || !channelId) return;
    setCurrentVoice({
      serverId,
      channelId,
      channelName: channel?.name ?? 'voice',
    });
    // Intentionally not clearing on unmount — voice persists across
    // navigation. Hangup (in VoiceRoom) is the only thing that clears it.
  }, [serverId, channelId, channel?.name, setCurrentVoice]);

  if (!serverId || !channelId) {
    return <div className="grid h-full place-items-center">Pick a voice room.</div>;
  }

  // The real UI is the persistent VoiceRoom rendered by AppShell on top of
  // this route's content area. We keep a placeholder for the brief moment
  // before the room mounts.
  return <div className="grid h-full place-items-center text-fg-muted">Joining voice…</div>;
}
