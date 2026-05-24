# Track A — Web: Voice, Composer, Service Worker

## Critical / High

**[BUG] RecordingControls has no unmount cleanup: AudioContext and MediaRecorder are leaked if the host leaves mid-recording.** `apps/web/src/components/RecordingControls.tsx:46-191`. The component stores an active `MediaRecorder` in `recorderRef` and an `AudioContext` in `audioCtxRef`, but there is no `useEffect` cleanup that tears them down on unmount. If the host presses "Leave" while `phase === 'recording'`, VoiceRoom unmounts RecordingControls, the MediaRecorder keeps running in the background, all mixed audio tracks stay captured, and the AudioContext stays open — the browser shows a persistent audio-capture indicator and the recording blob is never uploaded. The fix is a cleanup effect that calls `recorder.stop()` and `audioCtx.close()` when the component unmounts mid-recording, mirroring the pattern MessageComposer uses at `MessageComposer.tsx:106-134`.

**[BUG] MessageComposer leaks object URLs for pending attachments on unmount.** `apps/web/src/components/MessageComposer.tsx:43,106-134`. The cleanup effect at line 106 tears down the MediaRecorder and its stream on unmount, but it does not revoke the preview blob URLs in `pending` state. `pending` items accumulate `previewUrl` strings created with `URL.createObjectURL` (line 241). If the user navigates away without sending, none of those object URLs are revoked, causing a memory leak for the lifetime of the page. The `send()` path (line 189) and `removePending()` (line 264) both call `revokeObjectURL`, but the unmount path has no equivalent. The cleanup effect should iterate `pending` and revoke each `previewUrl`.

**[BUG] VoiceRoom breakout effect has a duplicate dependency (`me`) causing unnecessary re-subscriptions.** `apps/web/src/components/VoiceRoom.tsx:496`. The deps array is `[room, me?.id, channelId, me]`. Both `me?.id` and `me` are listed; `me` is the full auth object from the store, so any field update on the user object (e.g., avatar, displayName) tears down and re-registers the `onBreakoutOpen` / `onBreakoutClose` listeners unnecessarily. During the brief gap between `offOpen()` and the new subscription, a BREAKOUT_OPEN event would be silently dropped. The dep array should be `[room, me?.id, channelId]`.

**[BUG] VoiceRoom's `stateTimer` debounce fires after unmount on fast leave.** `apps/web/src/components/VoiceRoom.tsx:235-239,438`. The cleanup at line 438 clears `stateTimer.current`, but the `setTimeout` callback at line 239 calls `api('/voice/state', ...)` synchronously with no `mounted` guard. If the component is unmounted more than 200 ms after the last `reportVoiceState` call, the `stateTimer.current` value was set to `null` internally (line 238) before the cleanup ran, so `clearTimeout` is a no-op and the POST fires on an unmounted component. The `mounted` flag used elsewhere in the join effect should be checked inside the debounce callback too.

## Medium

**[BUG] `notificationclick` URL-match is fragile.** `apps/web/public/sw.js:111`. The handler uses `w.url.includes(url)` where `url` is the notification's payload URL. A short URL component could match an unrelated open window. `w.url === url` or `w.url.startsWith(url)` would be more correct.

**[BUG] LiveCaptions `setTimeout` for clearing `localLine` is not cancelled on cleanup.** `apps/web/src/components/LiveCaptions.tsx:71-73`. `setTimeout(() => setLocalLine(''), 800)` is scheduled, but its handle is never stored and the return of the `useEffect` does not cancel it. If `enabled` flips to `false` or the component unmounts within that 800 ms window, the timer fires and calls `setLocalLine('')` on a stale closure.

**[BUG] `RecordingControls.start()` posts to `/recording/start` AFTER beginning the MediaRecorder.** `apps/web/src/components/RecordingControls.tsx:149-150`. `recorder.start(1000)` begins capturing at line 149, then the `/recording/start` API call is awaited at line 150. If the API fails, the recorder is already running and the catch block calls `setPhase('idle')` but does not stop the recorder or close the AudioContext. The order should be swapped, or the catch block should explicitly stop the recorder.

**[PERF] WatchPartyPanel polls every 5 seconds unconditionally while a voice room is open.** `apps/web/src/components/WatchPartyPanel.tsx:64`. The `setInterval(refresh, 5000)` fires regardless of whether a watch party is active. When `party === null` (the common case), polls `/voice/:channelId/watch-party` every 5 seconds for the entire voice session. Polling should pause when `party === null`.

**[SEC] `notificationclick` handler trusts `event.notification.data.url` without validation.** `apps/web/public/sw.js:108`. The `url` is passed directly to `self.clients.openWindow(url)`. The handler should validate that `url` starts with `self.location.origin` before calling `openWindow`.

**[?] nginx `location = /index.html` block: confirm parent + inner blocks match.** `apps/web/nginx.conf:91-97`. On inspection the security headers match. The comment promises "keep in sync" but there is no automated check — worth a human-tracked TODO.

## Low / Nits

**[STYLE] Duplicate `me` in breakout deps causes ESLint `react-hooks/exhaustive-deps` to be silently satisfied for the wrong reason.** `apps/web/src/components/VoiceRoom.tsx:496`.

**[DOC] `sw.js` comment says "Wave 3 #27 — offline queue: … SW drains them on sync events"** but there is no `sync` event listener in the file. `apps/web/public/sw.js:14-17`.

## Notes

- `api-client.ts` 401 refresh loop is re-entrancy-safe: `refreshInflight` coalesces concurrent 401 callers (lines 140-163).
- `body: undefined` vs `'{}'`: the client correctly omits `Content-Type` and sets `body: undefined` when `opts.body` is `undefined` (lines 92-102). 685d214 fix sticks.
- LiveKit `Room` event handlers registered inside the join `useEffect` are torn down correctly via `connectedRoom.disconnect()`.
- Captions `useEffect` in `LiveCaptions.tsx` cleanly calls `engine.stop()` on teardown.
- `ScreenShareTile` fullscreen effect correctly removes the `fullscreenchange` listener on cleanup.
