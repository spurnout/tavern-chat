# Track C — Web: Wave 4 Federation UI, Modals, Routes

## Critical / High

**[BUG] `approve()` in `AdminFederationPage` swallows errors silently.** `apps/web/src/routes/admin-federation-page.tsx:43–46`. The function is `async` and calls `await api(...)` + `await refresh()`, but its invocation site is `onClick={() => void onApprove(p.id)}` and the function body has no try/catch. Any API error (403 Forbidden, network drop) is silently swallowed. `revoke` and dead-letter `retryJob`/`discardJob` all have try/catch; `approve` is the odd one out.

**[BUG] `revoke()` in `ServerInvitesPanel` has no confirmation guard.** `apps/web/src/components/ServerInvitesPanel.tsx:155–165`. The Trash2 button calls `void revoke(r.id)` directly with no confirmation. RevokePeerModal (f8b2fd3) was added specifically to prevent this class of problem; same pattern should apply here. Use `ConfirmDialog`.

**[BUG] `window.confirm()` still present in non-federated components.** `apps/web/src/components/VoiceRoom.tsx:457` and `apps/web/src/components/Whiteboard.tsx:175`. f8b2fd3 was about removing `window.prompt`/`window.confirm`. These two survivors are in high-traffic paths (breakout promotion, whiteboard clear). They block the event loop, break in sandboxed iframes, and violate the design system.

**[SEC] Federated invite `host` param flows into API call without client-side allowlist.** `apps/web/src/routes/invite-page.tsx:40` and `apps/web/src/components/FederatedInvitePreviewModal.tsx:58,83`. `host` comes from `?host=` in the URL, passes to `previewFederatedInvite(host, code)` and then `acceptFederatedInvite(code, host)`. The server is the authoritative validator, but the client sends whatever the URL contains. Needs server-side confirmation that `host` is validated against the known peers list before any outbound request.

**[SEC] `preview.inviterRemoteUserId` rendered as display text without truncation.** `apps/web/src/components/FederatedInvitePreviewModal.tsx:109`. React text-escapes, so direct XSS is blocked. But a peer could craft a 500-character ID that overflows the modal. Cap with `slice(0, 64)`.

## Medium

**[BUG] `AuditTab` loads all entries in a single unbounded fetch.** `apps/web/src/components/moderation/AuditTab.tsx:22`. `api('/servers/:id/audit-log')` with no `limit` query parameter. Add `limit=200` cap at the call site.

**[BUG] `ReportsTab` missing `serverId` dependency in `useEffect`.** `apps/web/src/components/moderation/ReportsTab.tsx:48–51`. `refresh` captures `serverId` but is redefined on every render. `useEffect` lists `[]` with an eslint-disable comment. Reusing for a different `serverId` shows stale data. Fix: `useCallback` on `refresh` with `[serverId]` dep.

**[PERF] `MemberSidebar` renders all members without virtualization.** `apps/web/src/components/MemberSidebar.tsx:38`. Fetches `/servers/:id/members` (all members). For 100-500 members this is sluggish.

**[BUG] Federated invite accept: no synchronous double-click guard.** `apps/web/src/components/FederatedInvitePreviewModal.tsx:80`. `if (!preview || accepting) return` then `setAccepting(true)` — but React batching means both clicks read `accepting = false`. Add `useRef` synchronous guard.

**[BUG] Federated accept: modal closes BEFORE navigate succeeds.** `apps/web/src/components/FederatedInvitePreviewModal.tsx:88–99`. On success, `onOpenChange(false)` fires before `navigate(...)`. If `navigate` throws, modal is closed, user stuck on invite page with no feedback.

**[BUG] `ServerInvitesPanel.create()` multi-tab race.** `apps/web/src/components/ServerInvitesPanel.tsx:125–152`. Optimistic prepend; two tabs creating simultaneously each show only their own.

**[STYLE] `AdminFederationPage`: `approve()` no loading feedback.** `apps/web/src/routes/admin-federation-page.tsx:43–46`. Button stays interactive during the API call, allowing rapid double-clicks.

## Low / Nits

**[STYLE] No shared Zod schema used in any `*Modal.tsx` form.** Zero modal files import from `@tavern/shared` for validation. `AddPeerModal` host field uses `host.includes('.')` which passes `foo.` and `.bar`.

**[DOC] `FederatedInvitePreviewModal` shows raw `inviterRemoteUserId`.** `apps/web/src/components/FederatedInvitePreviewModal.tsx:109`. Show display name if available.

**[?] Qualified mention profile fetch fires on hover-open, gated by `data || loading` guard.** `apps/web/src/components/MessageContent.tsx:179–193`. The 100-mention-DoS concern is NOT present. No issue.

**[PERF] `AuditTab` client-side filter runs over full unvirtualized list on every keystroke.** Combined with the unbounded fetch above.

## Notes

- All `*Modal.tsx` use `@radix-ui/react-dialog` via shared `Modal.tsx`. Focus trap and Escape-close handled by Radix.
- No remaining `window.prompt(` calls in `apps/web/src`. Two `window.confirm(` survivors (HIGH above).
- `SearchPage` hard `limit: 30` + 2-char minimum input. No virtualization concern.
- `DmsPage` DM list bounded by realistic thread count.
- `RevokePeerModal` correctly blocks dismiss while `busy=true`.
