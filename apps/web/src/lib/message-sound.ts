import type { Message } from '@tavern/shared';
import { useAuth } from './auth.js';
import { useRealtime } from './store.js';
import { useNotificationSettings } from './notification-settings.js';
import { playSound } from './sound.js';

/**
 * Decide whether (and what) sound to play for a freshly-arrived message,
 * then play it. Called from the gateway MESSAGE_CREATE dispatch handler.
 *
 * The gate ladder, in order — first `false` wins and we play nothing:
 *
 *   1. Dice roll fast-path: if it's our own roll, play `roll` and exit.
 *      Other people's rolls fall through to the regular chat path (no
 *      special bell).
 *   2. Don't notify on our own messages.
 *   3. Don't notify if global sound is off.
 *   4. Don't notify if our presence isn't `active` (idle / DND / offline
 *      should be quiet — the user told us so).
 *   5. Don't notify if we're in a voice room and chat-sounds-during-voice
 *      is disabled.
 *   6. Don't notify if we're focused on this channel and "only when
 *      unfocused" is on (i.e. they're staring at the message).
 *   7. Apply per-tavern overrides:
 *        - `muteAll`: nothing plays, unless this is a mention AND
 *          `mentionsOverrideMute` is on.
 *        - Otherwise check `muteMessages` / `muteMentions` for the kind.
 *
 * Mention detection is a textual `@username` (case-insensitive) match
 * against our own handle. There's no formal mention schema in the wire
 * format yet; this is the practical proxy.
 */
export function maybePlayMessageSound(msg: Message): void {
  const auth = useAuth.getState();
  const me = auth.me;
  if (!me) return;

  // Roll fast-path (our own roll → confirmation bell, regardless of where
  // it lands — server channel or DM).
  if (msg.type === 'dice_roll' && msg.authorId === me.id) {
    if (useNotificationSettings.getState().global.soundEnabled) {
      playSound('roll');
    }
    return;
  }

  // No self-notify.
  if (msg.authorId === me.id) return;

  const settings = useNotificationSettings.getState().global;
  if (!settings.soundEnabled) return;

  const rt = useRealtime.getState();
  const myPresence = rt.presenceByUserId[me.id] ?? me.presence ?? 'offline';
  if (myPresence !== 'active') return;

  // In a voice call?
  if (rt.currentVoice && !settings.chatSoundsWhileInVoice) return;

  // DM message: gate by "currently viewing this DM thread?" + global
  // rules. No per-thread mute in v1.
  if (msg.dmChannelId) {
    if (
      settings.playOnlyWhenUnfocused &&
      rt.isAppFocused &&
      rt.activeDmChannelId === msg.dmChannelId
    ) {
      return;
    }
    playSound('dm');
    return;
  }

  // From here down: it's a server-channel message. Server-flavored
  // routing — channelId is guaranteed non-null by the schema invariant
  // (exactly one of channelId / dmChannelId is set).
  if (
    settings.playOnlyWhenUnfocused &&
    rt.isAppFocused &&
    rt.activeChannelId === msg.channelId
  ) {
    return;
  }

  const isMention = looksLikeMention(msg.content, me.username);
  const tavern = msg.serverId
    ? useNotificationSettings.getState().perTavern[msg.serverId]
    : undefined;
  const muteAll = tavern?.muteAll ?? false;
  const muteMessages = tavern?.muteMessages ?? false;
  const muteMentions = tavern?.muteMentions ?? false;

  if (isMention) {
    if (muteMentions) return;
    if (muteAll && !settings.mentionsOverrideMute) return;
    playSound('mention');
    return;
  }

  if (muteAll || muteMessages) return;
  playSound('message');
}

const WORD_BOUNDARY = /[\w_]/;

/**
 * Loose @username detection. Looks for `@` followed immediately by the
 * caller's username, with a non-word character (or start/end of string)
 * on either side so `@alice` doesn't match inside `email@alice.com`.
 *
 * Lowercase comparison so it matches casual typing.
 */
function looksLikeMention(content: string, username: string): boolean {
  if (!content || !username) return false;
  const needle = '@' + username.toLowerCase();
  const haystack = content.toLowerCase();
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return false;
    const before = idx > 0 ? (haystack[idx - 1] ?? '') : '';
    const after = haystack[idx + needle.length] ?? '';
    if (!WORD_BOUNDARY.test(before) && !WORD_BOUNDARY.test(after)) {
      return true;
    }
    from = idx + 1;
  }
  return false;
}
