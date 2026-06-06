<div align="center">

# 🍺 Tavern

### A cozy hall for friends, gaming groups, and tabletop crews.

**Self-hosted. Web-first. Discord-shaped.** A community app you actually own — built for small private communities, tabletop RPG groups, and board gamers.

[![License: MIT](https://img.shields.io/badge/License-MIT-e8a838.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-22%2B-3c873a.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-9%2B-f69220.svg?logo=pnpm&logoColor=white)](https://pnpm.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16%2B-4169e1.svg?logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Federation: opt-in](https://img.shields.io/badge/Federation-opt--in-9b59b6.svg)](docs/federation.md)

[Quick start](#-quick-start) · [Features](#-features) · [Tech stack](#-tech-stack) · [Architecture](#-architecture) · [Federation](#-federation-ir20) · [Docs](#-documentation)

</div>

---

## ☕ What is Tavern?

Tavern is a **self-hosted, web-first community app** that gives you Discord-style chat, voice, and video — without giving up your data, paying a subscription, or trusting a third party with your community. It runs entirely on infrastructure **you** control.

It was built from the ground up for **gaming groups**. Alongside the usual text/voice channels, Tavern ships first-class **tabletop RPG** tooling (campaigns, sessions, safe dice, GM screens, safety tools) and **board-game** night planning (game library, scheduling, voting, RSVPs).

What makes Tavern different:

- 🏠 **Truly self-hosted** — one TLS endpoint, your database, your storage. No SaaS account required.
- 🚫 **No paid dependencies, no monetization, no public discovery** — it's your hall, not a marketplace.
- 🛡️ **Local Trust & Safety Core** — deterministic, operator-driven moderation. No AI moderation provider, no content shipped to anyone.
- 🪶 **Zero-config dev mode** — Postgres is the only hard requirement. Redis, S3 storage, ClamAV, and LiveKit are all optional, with graceful in-process / on-disk fallbacks.
- 🌐 **Opt-in federation** — connect to other Tavern instances over the documented IR20 protocol, or stay fully private. Off by default.

> **Tavern is _not_** a Discord clone, a Matrix bridge, or a public chat network. There is no server discovery, no ads, and no upsell.

---

## 📸 Screenshots

> ⚠️ The images below are **placeholders**. To swap in the real app, drop PNGs into [`docs/screenshots/`](docs/screenshots/) and replace each placeholder with the local `<img>` provided next to it — see the [screenshots guide](docs/screenshots/README.md).

<table>
  <tr>
    <td width="50%" align="center">
      <img src="https://placehold.co/1200x750/1a1714/e8a838?text=Chat+%26+Channels" alt="Chat & channels" />
      <!-- <img src="docs/screenshots/chat.png" alt="Chat & channels" /> -->
      <br /><sub><b>Chat & channels</b> — servers, categories, replies, reactions, embeds</sub>
    </td>
    <td width="50%" align="center">
      <img src="https://placehold.co/1200x750/1a1714/e8a838?text=Voice+%26+Video" alt="Voice & video rooms" />
      <!-- <img src="docs/screenshots/voice.png" alt="Voice & video rooms" /> -->
      <br /><sub><b>Voice & video</b> — active-speaker grid, screen share, stage rooms</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="https://placehold.co/1200x750/1a1714/e8a838?text=Campaign+Dashboard" alt="Tabletop campaign dashboard" />
      <!-- <img src="docs/screenshots/campaign.png" alt="Tabletop campaign dashboard" /> -->
      <br /><sub><b>Campaigns</b> — sessions, notes, handouts, RSVPs</sub>
    </td>
    <td width="50%" align="center">
      <img src="https://placehold.co/1200x750/1a1714/e8a838?text=Dice+%26+GM+Tools" alt="Dice and GM tools" />
      <!-- <img src="docs/screenshots/tabletop-tools.png" alt="Dice and GM tools" /> -->
      <br /><sub><b>Tabletop tools</b> — safe dice, GM screen, combat tracker</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="https://placehold.co/1200x750/1a1714/e8a838?text=Game+Nights" alt="Board game nights" />
      <!-- <img src="docs/screenshots/game-nights.png" alt="Board game nights" /> -->
      <br /><sub><b>Game nights</b> — board-game library, proposals, voting</sub>
    </td>
    <td width="50%" align="center">
      <img src="https://placehold.co/1200x750/1a1714/e8a838?text=Trust+%26+Safety" alt="Moderation and trust & safety" />
      <!-- <img src="docs/screenshots/moderation.png" alt="Moderation and trust & safety" /> -->
      <br /><sub><b>Trust & safety</b> — moderation queue, bulk actions, policies</sub>
    </td>
  </tr>
  <tr>
    <td width="33%" align="center">
      <img src="https://placehold.co/900x750/1a1714/e8a838?text=Onboarding" alt="Member onboarding" />
      <!-- <img src="docs/screenshots/onboarding.png" alt="Member onboarding" /> -->
      <br /><sub><b>Onboarding</b> — guided welcome screens for new members</sub>
    </td>
    <td width="33%" align="center">
      <img src="https://placehold.co/900x750/1a1714/9b59b6?text=Federation" alt="Federation" />
      <!-- <img src="docs/screenshots/federation.png" alt="Federation" /> -->
      <br /><sub><b>Federation</b> — remote members & peered Taverns (IR20)</sub>
    </td>
    <td width="33%" align="center">
      <img src="https://placehold.co/420x750/1a1714/e8a838?text=Mobile+PWA" alt="Mobile PWA" />
      <!-- <img src="docs/screenshots/mobile.png" alt="Mobile PWA" /> -->
      <br /><sub><b>Mobile PWA</b> — responsive layout, installable, push</sub>
    </td>
  </tr>
</table>

---

## ✨ Features

### 💬 Chat & messaging
- Servers → categories → **text / voice / forum** channels
- Rich message composer: replies, edits, deletes, **reactions** (built-in + custom emoji), file attachments, **voice messages** (with accurate waveforms)
- **Rich link embeds** and interactive **message components** (buttons, selects)
- Markdown with **code-block syntax highlighting** + diff rendering, `[[wikilinks]]`, spoilers, content warnings / NSFW gating
- **Realtime everything** over a WebSocket gateway — typing indicators, live reactions, presence, sequence-numbered events with auto re-sync
- **Message search** powered by Postgres `pg_trgm` (hidden-channel-aware)
- Cross-device **draft sync**, reminders & follow-ups
- **1:1 direct messages** (federated when enabled)

### 🔊 Voice, video & watch parties
- Voice/video rooms on **LiveKit** with active-speaker grid and screen sharing
- **Stage rooms** (raise hand, promote/demote), **breakout rooms**
- **Per-user audio mixer** (per-peer volume), browser-level **noise suppression**
- **Live captions** (Chromium `SpeechRecognition`), opt-in **recording with consent**
- **Watch parties**, collaborative **whiteboard**, music & ambient pads

### 🎲 Tabletop RPG toolkit
- **Campaigns** with a Game Master, players, game system, and lifecycle status
- **Sessions** — scheduling, RSVPs, agendas, recaps (broadcast live to calendars/dashboards)
- **Notes** (party-visible or GM-only) and **handouts** with attachments (maps, images)
- A **safe dice parser** (no `eval`) with dice-roll messages inline in chat
- **GM screen** (NPC roster, secret rolls), **combat tracker** overlay, **card decks**
- **Safety tools** — X-card, lines & veils, per-campaign safety boundaries
- **AI session recap** (optional, via any OpenAI-compatible endpoint you point it at)

### 🎯 Board game nights
- Board-game **library** with tags, player count, play time & complexity filters
- **Game night planner** — candidate proposals, voting, and RSVPs

### 🛡️ Trust, safety & moderation
- **Reports → queue → actions** with categories and **bulk/mass moderation**
- **Audit log** for every moderation action
- **Automod**, **raid protection**, and **verification gates** for new members
- **User blocking** and account-level controls
- **Upload hygiene** — magic-byte validation, **ClamAV** scanning, EXIF stripping, quarantine bucket with restrictive ACLs
- Configurable per-server **safety policies** + instance defaults

### 👋 Onboarding & membership
- Guided **welcome screens** and onboarding flows for new members
- **Invites** (local + federated), member roles, custom emoji management

### 🔐 Accounts & security
- JWT auth (access + refresh), **TOTP** + **WebAuthn passkeys**, **OIDC SSO**
- **Password reset via email**, **GDPR data export**, **server backup** (zip download)
- Authoritative permission resolution — roles + per-channel overwrites with deny→allow precedence; **hidden channels return 404** to avoid existence leaks

### 📱 Platform & polish
- **PWA** with Web Push notifications, mobile-responsive layout
- Accessibility pass — keyboard nav, ARIA, reduced motion
- **Importer** for Discord / Slack / Matrix JSON exports
- **Plugin SDK** manifest (`plugin.json`) for extensions
- A documented **design system** (semantic tokens, motion, voice & copy) — see [`docs/design-system.html`](docs/design-system.html)

---

## 🧱 Tech stack

| Layer | Technology |
|------|-----------|
| **Frontend** | Vite · React · TanStack Router · Tailwind · Radix primitives · Lucide icons |
| **API / Gateway** | Fastify (HTTP + WebSocket) on Node 22+ |
| **Background jobs** | BullMQ workers (uploads, scanning, media post-processing, maintenance) |
| **Database** | PostgreSQL 16+ via Prisma |
| **Realtime media** | LiveKit (self-hosted, token-issued) |
| **Object storage** | Garage (S3-compatible) — or any S3 backend, or local disk |
| **Antivirus** | ClamAV (optional) |
| **Cache / pub-sub** | Redis (optional — auto-promotes the gateway broker, falls back in-process) |
| **Federation** | Ed25519 signing · canonical-JSON envelopes · SSRF guard · at-rest encryption |
| **Tooling** | pnpm workspaces · strict TypeScript · ESLint · Prettier · Vitest · Playwright |

**Optional everything:** Postgres is the only hard requirement for development. Redis, object storage, ClamAV, and LiveKit each degrade gracefully when absent.

---

## 🏗️ Architecture

Tavern uses a Discord-inspired service split, all behind a single TLS endpoint:

```
┌────────┐  fetch / WS    ┌──────────────┐
│ web    │ ──────────────▶│  api         │
│ (Vite) │                 │  Fastify     │
└────────┘                 │  + Gateway   │
     │                     └──────┬───────┘
     │                            │ Prisma
     │                            ▼
     │                     ┌──────────────┐
     │                     │ Postgres     │
     │                     └──────────────┘
     │                            ▲
     │   LiveKit ws/RTC           │ BullMQ
     ▼                            │
┌──────────┐  audio/video  ┌──────┴───────┐
│ LiveKit  │ ◀────────────▶│ worker       │
└──────────┘                │ (BullMQ)     │
                             └──────┬───────┘
                                    │ scan
                                    ▼
                             ┌──────────────┐
                             │ ClamAV       │
                             └──────┬───────┘
                                    ▼
                             ┌──────────────┐
                             │ Garage (S3)  │
                             └──────────────┘
```

- **REST + WebSocket share one Fastify instance** — one TLS endpoint, one auth path. The gateway sub-mounts at `/gateway`.
- **LiveKit handles media so the app doesn't** — the API only issues short-lived join tokens; the browser talks to LiveKit directly.
- **Workers stay off the request path** — slow, untrusted work (upload validation, virus scanning, thumbnailing) runs in BullMQ jobs.
- **Permissions are computed from authoritative state on every check** — never trusted from JWT claims. Hidden channels never appear in responses or gateway dispatches.

More detail in [`docs/architecture.md`](docs/architecture.md).

### Repository layout

```
apps/
  api/        Fastify HTTP + WebSocket gateway
  worker/     BullMQ background workers (uploads, scanning, media)
  web/        Vite + React + TanStack Router frontend
packages/
  shared/     zod schemas, permission bitset, dice parser, ULID, errors
  db/         Prisma schema + client + seed
  media/      upload pipeline, ClamAV scanner, S3/local storage adapters
  federation/ Ed25519 + canonical-JSON + envelope signing + at-rest encryption
infra/
  docker/     docker-compose for postgres, redis, garage, clamav, livekit
  garage/     Garage S3-compatible storage config + bootstrap
  livekit/    example LiveKit config
  traefik/    example reverse proxy config (production)
docs/         architecture · api · permissions · deployment · safety · tabletop · federation · …
e2e/          Playwright suite + walkthrough scripts
```

---

## 🚀 Quick start

### Prerequisites

- **Node 22+** — `node --version`
- **pnpm 9+** — `corepack enable && corepack use pnpm@9`
- **PostgreSQL 16+** running locally

> Redis, object storage, ClamAV, and LiveKit are **optional** — Tavern uses in-process / on-disk fallbacks when they're missing.

### Run it (no Docker)

```bash
# 1. Install workspace dependencies
pnpm install

# 2. Copy env. Set JWT_ACCESS_SECRET / JWT_REFRESH_SECRET (48 hex chars each).
#    Generate strong secrets:  openssl rand -hex 48
cp .env.example .env

# 3. Create the database role + database (Postgres running locally)
psql -U postgres -c "CREATE ROLE tavern WITH LOGIN PASSWORD 'tavern-dev';"
psql -U postgres -c "CREATE DATABASE tavern OWNER tavern;"

# 4. Generate the Prisma client + apply the schema + seed
pnpm db:generate
pnpm db:migrate
pnpm db:seed        # creates admin user + DEV-INVITE invite code

# 5. Start API + worker + web in parallel
pnpm dev
```

Open **<http://localhost:3030>**. Register with the seeded `DEV-INVITE` code, or log in as `admin` / `change-me-in-dev`.

> Want a different port? `WEB_PORT=3000 pnpm dev` (also update `ALLOWED_ORIGINS` in `.env`).

On startup the API prints a config summary so you know exactly what's wired:

```
tavern config:
  storage:  local (./data/storage)
  redis:    in-process (single-replica only)
  clamav:   disabled (allowUnscanned=true)
  livekit:  disabled (voice/video routes return 503)
```

### Prefer Docker?

| Command | What you get |
|--------|--------------|
| `pnpm docker:up` | Infra only (postgres + redis + garage + clamav). Pair with `pnpm dev` on the host. |
| `pnpm docker:up:all` | Same, **plus** the LiveKit voice/video server. |
| `pnpm docker:up:full` | Full production-shaped stack — api + worker + web in containers, migrations auto-applied, one origin via nginx. Open <http://localhost:3030>. |

See [`docs/docker-setup.md`](docs/docker-setup.md) for the full picture.

---

## 🛠️ Common commands

```bash
pnpm dev                  # api + worker + web in parallel (web on :3030)
pnpm typecheck            # all workspaces
pnpm lint                 # all workspaces
pnpm test                 # unit tests
pnpm test:integration     # api integration suite (testcontainers)
pnpm test:e2e             # Playwright
pnpm walkthrough          # full app video tour (E2E + assemble)
pnpm build                # build all workspaces
pnpm db:migrate           # apply schema    ·    pnpm db:seed   # seed data
```

---

## 🌐 Federation (IR20)

Tavern supports **opt-in federation** with other Tavern instances over a small, documented protocol. It's **off by default** (`FEDERATION_ENABLED`) and strictly limited to the capabilities each side advertises.

Implemented phases:

1. 🤝 Peering handshake + capability negotiation
2. 🔑 Remote-user identity (Ed25519 per-user keys, mirrored `RemoteUser`)
3. 💬 Federated channel messages, edits, deletes, reactions
4. 📨 Federated invites + full Tavern mirroring
5. 📬 Federated 1:1 DMs (gated on the `dms` capability)
6. 🟢 Federated presence + custom status (gated on `presence` + `FEDERATION_PRESENCE_ENABLED`)

Operators keep **hard control** over which peers they trust — federation is opt-in per pair, not promiscuous. A Tavern owner can stay fully local even on a federated instance, and sensitive channels (GM-only, mod-only) can opt out individually. Voice does **not** federate yet (V2).

📖 [`docs/federation.md`](docs/federation.md) · [`docs/federation-operations.md`](docs/federation-operations.md)

---

## 🔒 Trust & safety, honestly stated

Tavern includes built-in **local** trust & safety tooling: access control, upload hygiene, reporting, quarantine, audit logs, automod, raid protection, verification gates, and configurable community policies.

Tavern **does not** claim to automatically detect all illegal content, and it uses **no AI moderation provider** — the entire moderation stack is deterministic and operator-driven by design. Operators are responsible for configuring policies appropriate to their jurisdiction and community.

📖 [`docs/safety.md`](docs/safety.md)

---

## 📚 Documentation

| Doc | What's inside |
|-----|---------------|
| [architecture.md](docs/architecture.md) | Service split, data flow, hot-path correctness rules |
| [api.md](docs/api.md) | REST + gateway reference |
| [permissions.md](docs/permissions.md) | Roles, overwrites, the permission bitset |
| [tabletop.md](docs/tabletop.md) | Campaigns, sessions, dice, GM tools |
| [safety.md](docs/safety.md) | Trust & Safety Core, moderation model |
| [federation.md](docs/federation.md) | IR20 protocol design & rollout |
| [deployment.md](docs/deployment.md) · [production-hardening.md](docs/production-hardening.md) | Self-host & hardening checklist |
| [native-setup.md](docs/native-setup.md) · [docker-setup.md](docs/docker-setup.md) | Local setup paths |
| [design-system.html](docs/design-system.html) | **Read before touching `apps/web`** — tokens, motion, voice |
| [roadmap.md](docs/roadmap.md) | Honest, feature-by-feature build status |

---

## 🤝 Contributing

Contributions are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md), follow the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), and run `pnpm typecheck && pnpm lint && pnpm test` before opening a PR. For UI changes, open [`docs/design-system.html`](docs/design-system.html) first — it's the source of truth for surfaces, tokens, and voice.

Found a security issue? See [`SECURITY.md`](SECURITY.md).

---

## 📄 License

[MIT](LICENSE) © 2026 Tavern contributors.

<div align="center">

**Pull up a chair.** 🍺

</div>
