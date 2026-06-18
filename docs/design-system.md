# Design system

The canonical design system for Tavern lives in **[`design-system.html`](./design-system.html)**. Open it in a browser — it's authored as a self-contained HTML document so the swatches, surface ramps, and accent strips render in place.

This Markdown file exists so the design system is grep-discoverable from the docs index.

## What's in `design-system.html`

- **For Claude Code** — read order, workflow, what the system does and does not cover.
- **Principles** — four ideas that shape every decision.
- **Foundations** — Colour (surface ramp + foregrounds + accents + tints), Type, Layout & spacing, Motion, Sound, Voice & copy, Accessibility (contrast pairings, focus rules, keyboard map, ARIA, color-blind safety).
- **Components** — AppShell, ServerRail, ChannelSidebar, MemberSidebar, MessageList & Message, MessageComposer, ReactionBar, TypingIndicator, Modal & form atoms, the Create… modals, ReportDialog, NotificationInbox, VoiceRoom, VoiceSideChat, AttachmentView, AuthGate, TavernLogo.
- **Surfaces** — Onboarding & auth (register / login / bootstrap) and the product routes (app-home, server-home, channel-page, voice-page, search-page, campaigns-page, games-page, moderation-page, server-settings-page).
- **Open follow-ups** — backend, integration, and product items the visual layer is ready for.

## Hard rules

- Use the semantic Tailwind tokens — `bg-canvas`, `bg-sunken`, `bg-surface`, `text-fg`, `text-fg-muted`, `border-subtle`, `bg-ember`, `bg-tint-ember`, etc.
- The old `tavern-*` Tailwind classes were removed in the design-system migration. ESLint blocks any reintroduction.
- Use the motion tokens — `--t-base` + `--ease-decel` for enter, `--t-base` + `--ease-accel` for exit. The `transition-base` utility wires both of those into a `transition-all` shorthand. Named transitions (`fade`, `lift`, `tint`, `morph`, `swipe`, `dismiss`, `pulse`, `clatter`, `bars`) are specified in [`design-system.html`](./design-system.html) and will land as utility classes in a follow-up — until then, compose them by hand from the motion tokens.
- Match the voice. Tavern, room, member, "pull up a chair." Sentence case, always.

See `CLAUDE.md` at the repo root for the broader project conventions.
