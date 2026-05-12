# Frontend Review - Tavern apps/web

**Date:** 2026-05-11
**Scope:** apps/web/src/**/*.{ts,tsx} (~38 files), vite.config.ts, styles.css, tailwind.config.js
**Reference:** docs/design-system.html

---

## CRITICAL

### [FE-01] Production source maps ship full TypeScript to every browser
**File:** apps/web/vite.config.ts:29
**Risk:** Any user opening DevTools can read unminified TypeScript source including internal
comments, API path structures, token field names, and business logic. Significant
information-disclosure for a self-hosted app where the attacker may be an untrusted member.

Current:  build: { outDir: 'dist', sourcemap: true }
Fix:      build: { outDir: 'dist', sourcemap: 'hidden' }

The 'hidden' setting writes .map files alongside bundles but omits the sourceMappingURL comment
so browsers never load them. CI can archive maps for crash symbolication without shipping them.

### [FE-02] JWT refresh token stored in localStorage - full XSS exfiltration vector
**File:** apps/web/src/lib/api-client.ts:24-25
**Risk:** localStorage is synchronously readable by any script on the page. A stored XSS
(unsanitized content in a future rich-text feature, or a malicious supply-chain package)
silently exfiltrates both the access token and the long-lived refresh token, granting permanent
account takeover until the user explicitly signs out.

Current:
  localStorage.setItem(TokenStore.ACCESS, tokens.accessToken);
  localStorage.setItem(TokenStore.REFRESH, tokens.refreshToken);  // exfiltrated by any XSS

Fix: Store the refresh token in an httpOnly SameSite=Strict cookie set by the API.
Keep the access token only in a module-level variable (memory). localStorage may hold
at most the access-token expiry timestamp so the app knows when to refresh proactively.

---

## HIGH

### [FE-03] AppShell useEffect: stale closure over params.serverId and navigate
**File:** apps/web/src/routes/app-shell.tsx:45-60
**Risk:** The effect runs once on mount with deps [] capturing params.serverId at mount time.
If the user lands on /app without a serverId and then navigates, the auto-redirect logic uses
the stale initial value. The eslint-disable comment on line 59 is suppressing a real bug.

Fix: use a ref to record whether auto-navigation has already fired:

  const autoNavigatedRef = useRef(false);
  useEffect(() => {
    if (autoNavigatedRef.current || params.serverId) return;
    api('/servers').then((list) => {
      if (list[0] && !autoNavigatedRef.current) {
        autoNavigatedRef.current = true;
        void navigate({ to: '/app/servers/$serverId', params: { serverId: list[0].id } });
      }
    }).catch(() => setBootstrapError('Could not load dens.'));
  }, [params.serverId, navigate]);

### [FE-04] VoiceRoom: stale reportVoiceState closure in join-effect event handlers
**File:** apps/web/src/components/VoiceRoom.tsx:127-153
**Risk:** reportVoiceState is memoised with [channelId]. The join effect captures the instance
at invocation. When channelId changes the old room fires LocalTrackUnpublished during disconnect;
the !mounted guard prevents React state updates but the voice-state POST can still fire with the
old channelId if the debounce buffer timer has not cleared. Move state-reporting logic inside
the effect scope, keyed off the channelId the effect captured, to eliminate the ambiguity.

### [FE-05] toggleMic has no error handling - throws silently on hardware failure
**File:** apps/web/src/components/VoiceRoom.tsx:205-211
**Risk:** toggleCamera wraps its LiveKit call in try/catch and calls setError. toggleMic does
not. A permission-revoked or hardware error propagates as an unhandled promise rejection
invisible to the user, leaving mute state inconsistent between UI and hardware.

Current:
  async function toggleMic(): Promise<void> {
    if (!room) return;
    const next = !muted;
    setMuted(next);                                            // optimistic, never rolled back
    reportVoiceState({ selfMute: next });
    await room.localParticipant.setMicrophoneEnabled(!next);  // throws silently
  }

Fix - mirror toggleCamera:
  async function toggleMic(): Promise<void> {
    if (!room) return;
    try {
      await room.localParticipant.setMicrophoneEnabled(!muted);
      setMuted(!muted);
      reportVoiceState({ selfMute: !muted });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not toggle microphone.');
    }
  }

### [FE-06] MessageComposer: active MediaRecorder not stopped on component unmount
**File:** apps/web/src/components/MessageComposer.tsx:113-160
**Risk:** If the user is recording and navigates away, the component unmounts with no cleanup
calling recording.stop(). The MediaRecorder keeps the microphone open indefinitely (browser
mic-in-use indicator stays lit). The mountedRef only guards setError - it does not release the
hardware. The MediaStream tracks are stopped only inside recorder.onstop, which never fires
without an explicit .stop() call.

Fix - add a cleanup effect alongside the existing mountedRef effect:

  useEffect(() => {
    return () => {
      if (recording) recording.stop(); // fires onstop -> stops tracks
    };
  }, [recording]);

### [FE-07] MessageList: unconditional scroll-to-bottom snaps user off history
**File:** apps/web/src/components/MessageList.tsx:50-54
**Risk:** Every WebSocket message increments sorted.length, triggering
el.scrollTop = el.scrollHeight unconditionally. A user reading history is forcibly yanked
to the bottom on every incoming message.

Fix:
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [sorted.length]);

### [FE-08] MessageList: useMemo(() => messages, [messages]) is a complete no-op
**File:** apps/web/src/components/MessageList.tsx:41
The identity transform provides zero memoization benefit and creates misleading indirection
suggesting a sort step that does not exist. Delete the memo and use messages directly.
Add a real sort transform only if needed.

### [FE-09] AttachmentView: fetch failure leaves 'attachment loading...' indefinitely
**File:** apps/web/src/components/AttachmentView.tsx:55
When /attachments/:id fails (network, 404, 403), att stays null and the placeholder is shown
forever. No error state, no retry affordance. Silent data loss from the user's perspective.

Fix:
  const [fetchError, setFetchError] = useState(false);
  .catch(() => { if (!cancelled) setFetchError(true); });
  if (fetchError) {
    return <span className="text-xs text-danger">Could not load attachment.</span>;
  }

### [FE-10] MemberSidebar: error indistinguishable from empty list, no loading state
**File:** apps/web/src/components/MemberSidebar.tsx:14
When the API call fails, members stays [] and the UI shows "No members yet." which is factually
wrong. No loading indicator shown during the in-flight request. Add loading and error states.

### [FE-11] ReactionBar: PUT/DELETE failures completely silent
**File:** apps/web/src/components/ReactionBar.tsx:14-16
When a reaction toggle fails (rate-limit, network error), the user sees nothing. The WebSocket
push that would confirm the change will not arrive because the request failed. The UI appears to
accept the action but server state is unchanged. Add inline feedback.

### [FE-12] server-settings-page: window.prompt() used for emoji name input
**File:** apps/web/src/routes/server-settings-page.tsx:416
window.prompt() is blocking, unthemeable, and breaks in sandboxed iframes. Cannot be driven by
Playwright without page.on('dialog'). Violates design system modal patterns. Replace with an
inline text field + confirm button inside the existing settings panel.

### [FE-13] confirm() used for destructive actions in four locations
**Files:** server-settings-page.tsx:179,437; campaigns-page.tsx:399; MessageList.tsx:172
window.confirm() is sandboxed-context-incompatible, triggers Chrome's "Prevent additional
dialogs" checkbox after repeated calls, and is inaccessible. Replace all four with Radix
AlertDialog (already a transitive dependency) or the project's own Modal component.

### [FE-14] @tanstack/react-query installed and bootstrapped but never used
**File:** apps/web/src/main.tsx:4,8-15
QueryClient + QueryClientProvider add approximately 47 KB (minified+gzip) to the initial
bundle. No useQuery, useMutation, or useInfiniteQuery call exists anywhere in the codebase.
Remove the dependency, or migrate the existing api() + useState patterns to React Query which
would also resolve FE-09, FE-10, and FE-23 for free.

---

## MEDIUM

### [FE-15] SearchPage: in-flight requests not cancelled on fast typing
**File:** apps/web/src/routes/search-page.tsx:17-38
The debounce timer cancels correctly but once the timer fires and api() is in-flight there is
no AbortController. On slow connections, results for an earlier query can overwrite the current
results. Fix: pass an AbortSignal to api() and abort it in the cleanup return.

### [FE-16] ReportDialog: setTimeout(props.onClose, 1500) not cleaned up on unmount
**File:** apps/web/src/components/ReportDialog.tsx:49
If the dialog's parent unmounts before 1.5 s elapses, props.onClose() fires on a stale closure
and may call setState on an unmounted component or trigger an unexpected route change.
Store the timeout ID and cancel it in a cleanup effect.

### [FE-17] Emoji upload uses magic 800 ms setTimeout to wait for worker processing
**File:** apps/web/src/routes/server-settings-page.tsx:423-424
await new Promise((r) => setTimeout(r, 800)) is a fixed-delay polling substitute. On a slow
worker the emoji will not be ready; on a fast one you wait unnecessarily. Poll
GET /attachments/:id until status === 'ready', or handle the attachment:ready WebSocket event.

### [FE-18] Toggle component defined inside SafetyPolicyPanel render function
**File:** apps/web/src/routes/server-settings-page.tsx:526-549
A component defined inside another component's render function is recreated on every render.
React sees a new component type each time and fully unmounts and remounts all Toggle instances,
losing focus, firing layout, and resetting any internal state. Extract Toggle to module scope.

### [FE-19] TypingIndicator shows raw UUID prefix instead of display name
**File:** apps/web/src/components/TypingIndicator.tsx:30-33
others[0]!.slice(0, 8) produces a hex UUID fragment like "01hzx7a4" as the displayed name.
Add a displayNameByUserId map to the realtime store so the indicator can resolve
"Alice is typing..." rather than "01hzx7a4 is typing...".

### [FE-20] AppHome renders internal Phase 0 scaffolding copy to all users
**File:** apps/web/src/routes/app-home.tsx:10-14
"this Phase 0 build confirms auth and the app shell are wired correctly" is internal developer
copy visible to every authenticated user. Replace before any production deployment.

### [FE-21] All route components synchronously imported - no code splitting
**File:** apps/web/src/router.tsx:8-21
All 11 page components are statically imported. The entire application parses at startup.
CampaignsPage (624 lines), ServerSettingsPage (550+ lines), GamesPage (500+ lines) are inlined
into the initial chunk. Wrap heavy pages with React.lazy + Suspense for route-level splitting
and reduced time-to-interactive.

### [FE-22] MessageList delete uses confirm() and alert() for error feedback
**File:** apps/web/src/components/MessageList.tsx:172-174
Same confirm() issue as FE-13. alert() additionally halts the JS event loop and is untestable.
Replace with an inline error banner or toast notification.

### [FE-23] Channel fetch failures show "..." indefinitely with no error state
**Files:** apps/web/src/routes/channel-page.tsx:30-35; apps/web/src/routes/app-shell.tsx:57,66
Both fetch on mount with .catch(() => undefined). On failure the channel header shows "..."
indefinitely and the sidebar shows no channels. Neither communicates the failure to the user.

### [FE-24] MessageComposer: no client-side file size or MIME type validation
**File:** apps/web/src/components/MessageComposer.tsx:92-105
Files are passed to uploadFile without checking file.size or file.type. A user attempting to
upload a 4 GB file wastes bandwidth and only receives an error after the server rejects the
presigned PUT.

Fix - add before uploadFile:
  const MAX_BYTES = 100 * 1024 * 1024; // match server config
  if (file.size > MAX_BYTES) {
    setError(file.name + ' is too large (max 100 MB).');
    continue;
  }

### [FE-25] VoiceRoom: mic state set optimistically before awaiting LiveKit
**File:** apps/web/src/components/VoiceRoom.tsx:207-210
setMuted(next) and reportVoiceState({ selfMute: next }) fire before setMicrophoneEnabled
resolves. If the LiveKit call throws (see FE-05), the UI and server reflect the wrong mute
state with no rollback. Move state updates after the await, or roll back in the catch.

---

## LOW

### [FE-26] TavernLogo SVG background #0c0a09 mismatches --bg-canvas
**File:** apps/web/src/components/TavernLogo.tsx:8
#0c0a09 is visibly darker than --bg-canvas (oklch(0.165 0.010 60) approximately #15110d).
On the login page the logo creates a visible colour discontinuity. Fix: use
style={{ fill: 'var(--bg-canvas)' }} on the background rect.

### [FE-27] SidebarChannelLink calls a hook inside a map() render
**File:** apps/web/src/routes/app-shell.tsx:370
useAnyScreenSharing(isVoice ? channel.id : null) is called for every channel inside .map().
Passing null is not the same as skipping the hook call. While this hook handles null gracefully
today, the pattern violates the spirit of the rules-of-hooks constraint. Extract voice channel
rows to a VoiceChannelLink component that calls the hook unconditionally.

### [FE-28] VoiceRoom: bg-black/40 and bg-overlay/80 used inconsistently for overlays
**File:** apps/web/src/components/VoiceRoom.tsx:494,588 vs 596,605
Participant name bars use bg-black/40 (raw black with opacity) while control buttons use
bg-overlay/80 (semantic token). Standardise on bg-overlay/80 throughout the voice room.

### [FE-29] Modal.tsx and ReportDialog.tsx both use bg-black/60 for dialog scrims
**Files:** Modal.tsx:28; ReportDialog.tsx:60; app-shell.tsx:125
All three use raw bg-black/60. Migrate to bg-overlay/80 or introduce a dedicated bg-scrim
semantic token so all modal backdrops are controlled in one place.

### [FE-30] campaigns-page.tsx: 4x exhaustive-deps suppressions and 624-line file
**File:** apps/web/src/routes/campaigns-page.tsx
624 lines approaches the 800-line CLAUDE.md project limit. Each eslint-disable suppression
hides a potential stale-closure risk. Extract CampaignForm, NotePanel, and SessionLog into
their own files, fixing dependency arrays naturally in the process.

### [FE-31] Waveform in AttachmentView uses array index as React key
**File:** apps/web/src/components/AttachmentView.tsx:144
key={i} is safe here (waveform bars are immutable and never reordered) but triggers the lint
rule. Switch to key={i + '-' + v} to suppress cleanly.

---

## Design-System Violations

| Location | Violation | Severity |
|---|---|---|
| VoiceRoom.tsx:494,588 | bg-black/40 on tile overlays - use bg-overlay/80 | LOW |
| app-shell.tsx:125 | bg-black/60 on mobile drawer backdrop - use bg-overlay/80 | LOW |
| ReportDialog.tsx:60, Modal.tsx:28 | bg-black/60 on dialog scrim - use bg-overlay/80 | LOW |
| TavernLogo.tsx:8 | Raw hex #0c0a09 mismatches --bg-canvas (see FE-26) | LOW |
| TavernLogo.tsx:11-15 | Raw hex #f97316, #fbbf24 - intentional brand colours | NOTE |

Zero tavern-* class references found. Zero bg-zinc-*, bg-gray-*, bg-slate-* non-semantic
utilities found in JSX or CSS. All transitions use transition-base (maps to var(--t-base) +
var(--ease-decel)). The design-system migration is complete on these axes.

---

## Voice / Copy Audit

Grepped all *.tsx files for: "server", "channel", "join server", "join channel",
"join voice", "join room".

**Result: No user-facing copy violations found.**

All occurrences of "server" and "channel" appear in route path strings, API endpoint paths,
TypeScript type/prop names, and import paths - not in visible UI copy. User-facing copy
consistently uses Tavern vocabulary: den, room, voice room, member, "pull up a chair".

---

## Silent Error Catches (.catch(() => undefined))

11 total occurrences assessed by risk:

| File | Line | Endpoint | Risk | Verdict |
|---|---|---|---|---|
| app-shell.tsx | 57 | GET /servers | HIGH - blank sidebar, no feedback | Fix (FE-23) |
| app-shell.tsx | 66 | GET /servers/:id/channels | HIGH - empty channel list | Fix (FE-23) |
| MessageList.tsx | 32 | GET /channels/:id/messages | MEDIUM - error invisible | Add error state |
| AttachmentView.tsx | 55 | GET /attachments/:id | HIGH - perpetual spinner | Fix (FE-09) |
| MemberSidebar.tsx | 14 | GET /servers/:id/members | HIGH - wrong empty state | Fix (FE-10) |
| ReactionBar.tsx | 14 | DELETE /reactions/:emoji | MEDIUM - silent failure | Add feedback |
| ReactionBar.tsx | 16 | PUT /reactions/:emoji | MEDIUM - silent failure | Add feedback |
| MessageComposer.tsx | 88 | POST /channels/:id/typing | LOW - advisory ping | OK |
| VoiceRoom.tsx | 94 | POST /voice/state | LOW - coalesced ping | OK |
| VoiceRoom.tsx | 265 | POST /voice/leave | LOW - cleanup; LiveKit durable | OK |
| channel-page.tsx | 34 | GET /channels/:id | MEDIUM - header shows "..." forever | Add error state |

---

## Positive Notes

- **Zustand store** (lib/store.ts): All mutations use immutable spread. applyVoiceState
  two-pass eviction is correct. No in-place mutation found anywhere in the codebase.
- **Gateway client** (lib/gateway-client.ts): Exponential backoff, heartbeat cleanup, and
  proper lifecycle management are correctly implemented.
- **Modal** (components/Modal.tsx): Correct Radix Dialog usage. Focus trap, Escape,
  return-focus, and portal rendering are delegated to Radix. No hand-rolled focus management.
- **Skip link**: Present and correct in AppShell (lines 81-86). First tab stop, visible on
  focus, jumps to #main-content.
- **VoiceRoom track lifecycle**: Both ParticipantCameraTile and ScreenShareTile depend on
  publication.track (not the publication object) so post-reconnect track replacement correctly
  triggers a re-attach.
- **AttachmentView LRU cache**: Module-level LRU with 500-entry cap is sensible. Two-phase read
  (peek in useState initializer, bump recency in effect) avoids a redundant fetch on cache hit.
- **Design-system migration**: Complete. Zero tavern-* class references. Zero non-semantic
  bg-zinc-*/bg-gray-*/bg-slate-* utilities in JSX or CSS.

---

## Review Summary

| Severity | Count | Status |
|---|---|---|
| CRITICAL | 2 | block |
| HIGH | 12 | warn |
| MEDIUM | 11 | warn |
| LOW | 6 | note |
| Total | 31 | |

**Verdict: BLOCK - 2 CRITICAL issues must be resolved before any production deployment.**

FE-01 (sourcemap: true) is a one-line config fix. FE-02 (refresh token in localStorage)
requires an API-side change to issue the refresh token as an httpOnly SameSite=Strict cookie
and a client-side refactor of TokenStore to keep only the expiry timestamp in localStorage.
Of the HIGH findings, the most impactful are the active MediaRecorder stream leak on unmount
(FE-06), the unconditional scroll-snap that breaks history reading (FE-07), and the four
.catch(() => undefined) calls that silently mask fetch failures with misleading empty states
(FE-09, FE-10, FE-23). The dead @tanstack/react-query dependency (FE-14) wastes approximately
47 KB of bundle and should be removed until the library is actually used. The confirm()/prompt()
usages (FE-12, FE-13) degrade UX and testability continuously and should be addressed before
the first beta. None of the MEDIUM or LOW findings are release blockers individually.
