# Voice room chat without joining — design

- **Date:** 2026-06-21
- **Status:** Approved (design)
- **Surface:** `apps/web` sidebar + room page
- **Scope:** Frontend only. No API, schema, or route additions.

## Summary

Let people read and post in a voice room's text chat **without joining the voice
call**. Hovering a voice room in the sidebar reveals a chat icon; clicking it
opens that room's chat in the main content area, exactly like opening a text
room. This is Discord parity ("voice channel text chat").

Clicking the voice room's **name** still pulls up a chair (joins the call) —
that behavior is unchanged.

## Background — most of this already exists

Exploration confirmed the feature is small because the foundation is already in
place:

- **Side chat already exists.** [`VoiceSideChat.tsx`](../../../apps/web/src/components/VoiceSideChat.tsx)
  renders a full `MessageList` + `MessageComposer` for a voice room. It is shown
  today only when you are *in* the call (mounted alongside `VoiceRoom` in
  `app-shell.tsx`).
- **Backend is channel-type-agnostic.** Messages are stored by `channelId` with
  no type gate. `GET`/`POST /channels/:id/messages` already work for a `voice`
  channel, gated by the normal `READ_MESSAGE_HISTORY` / `SEND_MESSAGES`
  permissions.
- **The room page is already generic.** [`channel-page.tsx`](../../../apps/web/src/routes/channel-page.tsx)
  renders chat for *any* `channelId` and contains no voice/LiveKit logic.
  Navigating to the text-room route with a voice room's id already shows its chat
  with zero voice connection.
- **The only voice-specific click today** is the room name, a `<Link>` to
  `/app/servers/$serverId/voice/$channelId` ([`app-shell.tsx`](../../../apps/web/src/routes/app-shell.tsx)
  `SidebarChannelLink`, lines 677–714), which joins the call.

So the work is: add an entry point (the hover icon) that routes to the existing
text-room view, plus light polish so a voice room's chat view reads correctly.

## User-facing behavior

1. In the sidebar, hovering a voice room reveals a chat icon at the right edge of
   the row (pointer devices). On touch devices, where there is no hover, the icon
   is persistently visible.
2. Clicking the icon navigates to `/app/servers/$serverId/channels/$channelId`
   for that voice room — the chat opens in the main area. **No LiveKit/voice
   connection is established.**
3. The chat view's header shows a voice icon (not the text-room `#`) and a
   **"Pull up a chair"** button that enters the actual voice call (navigates to
   the voice route).
4. Posting/reading obey existing permissions; the server enforces access when the
   chat loads.

## Design

### 1. Sidebar — hover chat icon
`SidebarChannelLink` voice branch in [`app-shell.tsx`](../../../apps/web/src/routes/app-shell.tsx) (~677–714).

- The voice row is currently a single `<Link>` (the whole row joins on click).
  Restructure so the name `<Link>` and a new chat-icon `<Link>` are **siblings**
  inside a `group` wrapper — the icon must not be nested in the join link, so its
  click never triggers a voice join.
- Chat icon: `MessageCircle` (already imported), `size={14}`, in a `<Link>` to
  `/app/servers/$serverId/channels/$channelId`.
- Reveal pattern mirrors the existing hover-action convention used elsewhere
  (e.g. `MessageList`): `opacity-0 group-hover:opacity-100`, button styling
  `rounded p-1 text-fg-muted hover:bg-raised`. Add a touch fallback so the icon
  stays visible where hover is unavailable (`@media (hover: none)`).
- Accessibility: `aria-label="Open room chat"`, `title="Open chat"`.
- Visible on **every** voice room the user can already see (confirmed decision).
  Server-side `READ_MESSAGE_HISTORY` still governs whether the chat actually
  loads.
- Active/highlight state: opening a voice room's chat highlights it via the
  normal channels-route matching, same as text rooms.

### 2. Room page — coherent voice-room chat view
[`channel-page.tsx`](../../../apps/web/src/routes/channel-page.tsx).

- Header currently hardcodes a `Hash` icon. When `channel.type === 'voice'`, show
  a voice-appropriate icon (`Volume2`) instead, so the view doesn't read as a
  text room.
- Add a **"Pull up a chair"** button in the header (voice rooms only) that
  navigates to `/app/servers/$serverId/voice/$channelId` to enter the call. Use
  the established Tavern phrasing — never "Join". Match the look of existing
  header actions (ghost/secondary button in the `ml-auto` cluster).
- Keep everything else (`MessageList`, `TypingIndicator`, `MessageComposer`,
  members sidebar) as-is.

### 3. Backend / routing / data
No changes. Reuses the existing text-room route and type-agnostic message
endpoints.

## Decisions (confirmed)

- **Chat opens in the main content area** (Discord-style), not a slide-out panel.
- **Include the "Pull up a chair" button** in the voice-room chat header.
- **Show the icon to anyone who can see the room**; rely on server-side
  permission enforcement for the actual chat load.
- **Button copy follows Tavern voice** — "Pull up a chair", per the design
  system's Voice & copy rules and existing usage.

## Out of scope (YAGNI)

- Changing what clicking the room **name** does (still joins voice).
- A new "viewing without joining" banner/badge beyond the header icon + button.
- Permission-gating the sidebar icon render (deferred; server enforces access).
- Unread/mention badges on voice rooms.
- Any mobile-specific voice chat sheet/redesign.
- Backend, schema, or new routes.

## Testing

**Implemented (unit, runnable now — `pnpm --filter @tavern/web test`):**

- `VoiceRoomChatLink` opens the room **chat** route (`/channels/$channelId`), not
  the voice route — the property that guarantees "no join".
  (`VoiceRoomChatLink.test.tsx`)
- `PullUpAChairButton` routes **into** the call (`/voice/$channelId`).
  (`PullUpAChairButton.test.tsx`)

  These pin the route targets — the crux of the feature (chat-without-join vs.
  join) and the thing most likely to regress.

**Follow-up (needs the running dev stack — Postgres + seed; not runnable on the
current box):**

- E2E (Playwright): hover a voice room → click the chat icon → chat loads in the
  main area with **no LiveKit connection** → send a message → "Pull up a chair"
  routes into the call. Belongs in `e2e/tests/` next to `golden-path.spec.ts`.
- Negative render cases (text room shows no chat icon; text-room header shows no
  voice affordances). Cheap once the sidebar link is testable in isolation, but
  `SidebarChannelLink` is currently an internal of `app-shell.tsx`.

## Risks / edge cases

- **Click isolation:** the chat icon must be a sibling of the join `<Link>`, not a
  descendant, so navigation is unambiguous. Verify no overlay/stacking lets a
  stray click hit the join link.
- **Touch reachability:** without the touch fallback, mobile users couldn't reach
  the icon at all — the `@media (hover: none)` persistent state covers this.
- **Header layout:** the added button shares the `ml-auto` cluster with Pins /
  settings / members toggle; confirm it doesn't crowd narrow widths.

## Files touched

- `apps/web/src/components/VoiceRoomChatLink.tsx` (new) + `.test.tsx` — the
  sidebar hover chat link (extracted so it's testable and keeps `app-shell.tsx`
  from growing).
- `apps/web/src/components/PullUpAChairButton.tsx` (new) + `.test.tsx` — the
  voice-entry CTA.
- `apps/web/src/routes/app-shell.tsx` — `SidebarChannelLink` voice branch now
  hosts the chat link as a hover-revealed sibling of the join link, with the
  row's hover/active background + `group` on a wrapper.
- `apps/web/src/routes/channel-page.tsx` — voice-aware header icon + "Pull up a
  chair" button.
