# Infrastructure, Scripts & Documentation Review

> Scope: Tavern repo at `F:\code\chat`, branch `main`. Review covers
> `infra/`, `scripts/`, root config (`.env.example`, `.dockerignore`,
> `.gitignore`, `package.json`, workspace package.jsons), Dockerfiles,
> `apps/web/nginx.conf`, and every file in `docs/`. Source code in
> `apps/` and `packages/` was read for cross-checking but is not the
> primary target of this review.

## Summary

Tavern's infra is in good shape for "dev defaults are sensible, prod
deployment is one or two scripted commands away." However, several
production-relevant gaps need attention:

- **Documentation drift is large.** `docs/api.md` and `docs/permissions.md`
  are noticeably out of sync with the implemented routes / flag table.
  Multiple `POST` endpoint paths in `docs/api.md` don't match the code
  (sessions, notes, handouts, role assignment) — copy-pasting from the
  docs to drive the API will fail. `docs/permissions.md` skips ~12 of the
  41 bitflags entirely and doesn't carry the bit-position table.
- **A licence file is missing** while `package.json` and `README.md` both
  declare MIT. This is a CRITICAL legal gap for an open-source project.
- **`docs/deployment.md` is stale** relative to the current Docker/Garage
  scripts (refers to `docker compose up -d` instead of `pnpm docker:up:full`,
  miscategorises Redis as required, doesn't mention `pnpm garage:bootstrap`).
- **`docs/native-setup.md` instructs operators to edit a git-ignored file**
  (`infra/garage/garage.toml`, which is materialised by a script and not
  the canonical template).
- **Traefik dynamic config has a port bug** (`tavern-web:3000` — the nginx
  container listens on 80) and ships no security headers middleware.
- **LiveKit RTC port range mismatch:** `livekit.yaml` advertises UDP
  50000-50100, but compose only exposes UDP 7882 — clients won't be able
  to negotiate UDP media.
- **`docker-compose.yml` `restart: unless-stopped` on the worker will
  loop-restart it when `REDIS_URL` is unset** (the worker is designed to
  early-exit in that case).
- **No CI/CD, no `LICENSE`, no `SECURITY.md`, no `CODE_OF_CONDUCT.md`,
  no `CONTRIBUTING.md`, no pre-commit hooks, no Renovate/Dependabot.**

About 40 findings below. Critical: 4. High: 13. Medium: 16. Low: 8.

---

## Critical Findings

### [INF-001] No LICENSE file despite MIT declaration

- **Severity:** CRITICAL
- **File:** `F:\code\chat\package.json:7` (`"license": "MIT"`), `F:\code\chat\README.md:144` (`License: MIT.`)
- **Issue:** Both `package.json` and `README.md` declare MIT, but there is
  no `LICENSE` / `LICENSE.md` / `LICENSE.txt` at the repository root. For
  an open-source project this leaves redistributors with no clear grant.
  pnpm publishing, GitHub's licence detection, and most CI/CD scanners
  expect a top-level file.
- **Fix:** Add `LICENSE` at the repo root with the canonical MIT text and
  the copyright year/holder.

### [INF-002] `docker compose` instructions in `docs/deployment.md` will not bring the apps up

- **Severity:** CRITICAL
- **File:** `F:\code\chat\docs\deployment.md:42-52`
- **Issue:** The deployment guide says:
  ```
  docker compose up -d
  docker compose --profile livekit up -d
  docker compose run --rm api pnpm db:migrate
  ```
  None of this works against `infra/docker/docker-compose.yml` as written.
  (a) The api/worker/web/migrate services live under the `apps` profile,
  so a plain `docker compose up` will only start postgres, redis, garage,
  and clamav. (b) There's no `pnpm db:migrate` script in the api image —
  migrations run via the one-shot `migrate` service or `prisma migrate
  deploy` against `packages/db`. (c) No reference to the wrapper script
  `pnpm docker:up:full` which is the canonical full-stack command, no
  mention of `pnpm garage:bootstrap` which is mandatory after the first
  Garage volume create.
- **Fix:** Rewrite the production section to track the actual wrappers
  in `package.json`: `pnpm docker:up:full` (or the explicit
  `docker compose -f infra/docker/docker-compose.yml --profile apps
  --profile livekit up -d --build`), followed by `pnpm garage:bootstrap`,
  followed by health checks. Document that the `migrate` service runs
  automatically as a dependency of api/worker.

### [INF-003] `docs/native-setup.md` instructs editing a git-ignored materialised file

- **Severity:** CRITICAL
- **File:** `F:\code\chat\docs\native-setup.md:114-118`
- **Issue:** Step 2 of the native Garage section says "Copy
  `infra/garage/garage.toml` to a working directory and regenerate the
  three secrets at the top of the file." But `infra/garage/garage.toml`
  is git-ignored (see `.gitignore:35`) and is materialised by
  `scripts/garage-config.mjs` from `garage.toml.example`. On a fresh
  checkout the file doesn't exist; new contributors will fail at this
  step. The example file (`garage.toml.example`) is what they should be
  copying.
- **Fix:** Update the doc to refer to `infra/garage/garage.toml.example`
  as the template. Mention that `pnpm garage:config` (or
  `node scripts/garage-config.mjs`) materialises a dev copy with fresh
  random secrets; for native (non-docker) Garage, copy the example
  manually.

### [INF-004] Traefik dynamic config points web service at port 3000; container listens on 80

- **Severity:** CRITICAL
- **File:** `F:\code\chat\infra\traefik\dynamic.yml:31`
- **Issue:** The web loadBalancer is configured as
  `http://tavern-web:3000`. The web Dockerfile exposes port 80
  (`apps/web/Dockerfile:40`) and the nginx config listens on `80`
  (`apps/web/nginx.conf:14`). Anyone deploying with the example Traefik
  config will get connection-refused on the web route.
- **Fix:** Change `http://tavern-web:3000` to `http://tavern-web:80` (or
  `http://tavern-web`).

---

## High Findings

### [INF-005] LiveKit UDP RTC port range mismatch between config and compose

- **Severity:** HIGH
- **File:** `F:\code\chat\infra\livekit\livekit.yaml:14-15`, `F:\code\chat\infra\docker\docker-compose.yml:230`
- **Issue:** `livekit.yaml` configures `port_range_start: 50000` /
  `port_range_end: 50100` for media. The compose file only exposes
  `7882/udp` to the host. With `use_external_ip: false` and no port
  forwarding for 50000-50100/udp, clients won't be able to negotiate
  UDP media — they'll either time out or fall back to TURN/TCP at 7881
  (slow path). The `deployment.md` and `traefik/README.md` both
  reinforce UDP 7882 as the only port needed.
- **Fix:** Either expose `50000-50100/udp` in compose, or set
  `port_range_start: 7882` and `port_range_end: 7882` in `livekit.yaml`
  (single-port mode), or use TURN/`use_external_ip: true` so LiveKit
  rewrites SDP to a routable IP. The first is the standard pattern.

### [INF-006] Worker has `restart: unless-stopped` but exits cleanly when REDIS_URL is unset

- **Severity:** HIGH
- **File:** `F:\code\chat\infra\docker\docker-compose.yml:179`, `F:\code\chat\apps\worker\src\index.ts:30-36`
- **Issue:** The worker process is designed to exit immediately with code
  0 when `REDIS_URL` is blank, since the api runs the upload pipeline
  in-process in that mode. With `restart: unless-stopped` in compose,
  Docker will keep restarting the worker container in a busy loop. In
  the `pnpm docker:up:full` configuration `REDIS_URL` is set via env
  overrides, so this only bites when an operator unsets `REDIS_URL` in
  `.env` and then brings the apps profile up.
- **Fix:** Either (a) keep the worker container alive when there's
  nothing to do (`process.exit` ⇒ sleep loop), or (b) change the worker
  restart policy to `on-failure` so a clean exit is honoured. Option (b)
  is the more honest signal.

### [INF-007] API `depends_on garage: condition: service_started` ignores `garage` healthcheck

- **Severity:** HIGH
- **File:** `F:\code\chat\infra\docker\docker-compose.yml:161-162`, `:194-195`
- **Issue:** Both api and worker use `condition: service_started` for
  the garage dependency, even though the garage service defines a
  proper `healthcheck`. With `service_started`, Docker considers garage
  "up" as soon as the container starts — well before `garage status`
  returns OK. On a cold cluster the api may receive an upload before
  garage is reachable and fail the storage init.
- **Fix:** Change both api and worker `garage` depends_on to
  `condition: service_healthy` for parity with postgres/redis.

### [INF-008] `apps/api/Dockerfile` runtime stage doesn't pin a non-root user uid + tini exec

- **Severity:** HIGH
- **File:** `F:\code\chat\apps\api\Dockerfile:82-95`
- **Issue:** The runtime stage runs as `USER node` (uid 1000), which is
  fine, but tini is invoked as `ENTRYPOINT ["/sbin/tini", "--"]` from
  the unprivileged `node` user — when the container is started by an
  orchestrator that lowers caps further, this combination works only by
  luck of `/sbin/tini`'s permissions. More importantly, the deployed
  tree is `chown node:node`, which makes the runtime image immutable for
  the `node` user but doesn't address a Defence-in-Depth question: what
  happens if Prisma generates files at runtime? Today, `pnpm exec`
  attempts a deps check that fails on read-only fs (the Dockerfile
  comment alludes to this). This is fine in practice but isn't asserted
  in tests.
- **Fix:** Add a healthcheck on the worker (a simple TCP self-ping or a
  BullMQ queue ping), document that `/sbin/tini` is owned by root and
  +x for all, and consider running migrations + Prisma generate at
  build-time only so the runtime fs can be marked `readOnlyRootFilesystem`
  in Kubernetes deployments.

### [DOC-001] `docs/api.md` — many routes missing or path-mismatched

- **Severity:** HIGH
- **File:** `F:\code\chat\docs\api.md`
- **Issue:** Cross-referenced against `apps/api/src/routes/*.ts`, the
  current docs file has:
  - **Wrong path:** `PUT /members/:userId/roles` documented; actual is
    `PUT /api/servers/:serverId/members/:userId/roles`
    (`roles.ts:119`).
  - **Wrong path:** `POST /campaigns/:id/sessions` documented; actual
    is `POST /api/sessions` with `campaignId` in body
    (`sessions.ts:69`).
  - **Wrong path:** `POST /campaigns/:id/notes` documented; actual is
    `POST /api/notes` with `campaignId` in body (`notes.ts:68`).
  - **Wrong path:** `POST /campaigns/:id/handouts` documented; actual
    is `POST /api/handouts` with `campaignId` in body (`handouts.ts:79`).
  - **Missing entirely:** the bootstrap-status / bootstrap auth routes
    (`/api/auth/bootstrap-status`, `/api/auth/bootstrap`,
    `auth.ts:37-52`).
  - **Missing entirely:** invites (`POST /api/invites`,
    `DELETE /api/invites/:id`, `POST /api/invites/:code/join`,
    `invites.ts:47-157`).
  - **Missing entirely:** reactions (`PUT /api/messages/:id/reactions/:emoji`,
    `DELETE /api/messages/:id/reactions/:emoji`, `reactions.ts:15-49`).
  - **Missing entirely:** custom emojis (`GET / POST /api/servers/:serverId/emojis`,
    `DELETE /api/emojis/:id`, `emojis.ts:42-90`).
  - **Missing entirely:** `GET /api/channels/:id` (`channels.ts:77`).
  - **Missing entirely:** `GET /api/servers/:id/members` (`servers.ts:164`).
  - **Missing entirely:** `POST /api/channels/:id/typing` (`typing.ts:17`).
  - **Missing entirely:** `GET /api/servers/:serverId/search`
    (`search.ts:31`).
  - **Missing entirely:** `GET /api/channels/:id/dice` (`dice.ts:104`).
  - **Missing entirely:** `POST /api/attachments/:id/waveform`
    (`uploads.ts:141`).
  - **Missing entirely:** `PATCH /api/notes/:id`, `DELETE /api/notes/:id`
    (`notes.ts:91, 114`).
  - **Missing entirely:** `PATCH /api/handouts/:id` (`handouts.ts:112`).
  - **Missing entirely:** `PATCH /api/board-games/:id`,
    `DELETE /api/board-games/:id` (`board-games.ts:112, 137`).
  - **Missing entirely:** `PATCH /api/game-nights/:id`,
    `GET /api/game-nights/:id/candidates`,
    `POST /api/game-nights/:id/votes`,
    `PUT /api/game-nights/:id/rsvp` (game-nights.ts — only candidates
    POST and night POST are partially mentioned).
  - **Missing entirely:** the local-files and S3 attachment proxy routes
    (`/api/_local-uploads/:token`, `/api/_local-files/:bucket/:key`,
    `/api/_attachments/:bucket/:key`) — these are public surface even
    though gated by URL-secrecy and worth documenting.
  - **Missing entirely:** `GET /healthz` and `GET /api/instance`
    (`apps/api/src/app.ts:86-101`).
- **Fix:** Re-derive the route inventory from `apps/api/src/routes/`.
  Listing the path-mismatches as bugs (and fixing one direction or the
  other) before re-writing is safest — the body-vs-URL convention
  inconsistency between `notes`/`handouts`/`sessions` (body-driven) and
  `campaigns`/`channels` (URL-driven) is itself a small API smell that
  may be worth raising as an architectural cleanup.

### [DOC-002] `docs/permissions.md` doesn't enumerate the bit-position table

- **Severity:** HIGH
- **File:** `F:\code\chat\docs\permissions.md`, `F:\code\chat\packages\shared\src\permissions.ts`
- **Issue:** The doc lists permission flag *names* by category but never
  shows the bit position assigned to each flag. The wire format example
  shows `"permissions": "1099511627775"` — a 40-bit value — without
  saying which 40 bits are set. The serialized form is operationally
  important (database migrations rely on a `(role.permissions | 1n <<
  N)` style update; see the comment in `permissions.md:80-82`). Without
  the bit-position table operators cannot safely write or read raw SQL
  for permission management.
- **Fix:** Add a table mapping each flag to its bit position:
  ```
  | Flag                  | Bit |
  | --------------------- | --- |
  | VIEW_CHANNEL          | 0   |
  | SEND_MESSAGES         | 1   |
  ...
  | ADMINISTRATOR         | 62  |
  ```
  Derived directly from `packages/shared/src/permissions.ts:18-85`.

### [DOC-003] `docs/permissions.md` summary list is missing flags present in code

- **Severity:** HIGH
- **File:** `F:\code\chat\docs\permissions.md:12-29`, `F:\code\chat\packages\shared\src\permissions.ts:18-85`
- **Issue:** The bullet list of flags in permissions.md is missing or
  inconsistent with the `Permission` enum in the source of truth. Both
  the file and the source agree on the categories, but the doc's bullet
  list does not enumerate flags such as `ADMINISTRATOR` (line 84) as a
  flag (it's mentioned but not in any category), and there is no
  explanation of the bit gap (49 → 62) that future flags will fit into.
- **Fix:** Reconcile the list with `PermissionFlags` array, note that
  `ADMINISTRATOR = 1n << 62n` reserves the top bit for an "always wins"
  flag and that 50-61 is reserved for future expansion.

### [INF-009] No CI workflow directory; pre-commit hooks absent

- **Severity:** HIGH
- **File:** Repository root — no `.github/workflows/`, no `.husky/`, no
  `lefthook.yml`, no Renovate / Dependabot config.
- **Issue:** Despite a complete suite of `pnpm typecheck`, `pnpm lint`,
  `pnpm test`, `pnpm test:integration`, `pnpm test:e2e` scripts and a
  rich docs roadmap declaring tests as "Built" (`docs/roadmap.md`), no
  CI runs them on push or PR. There's no automated dep-update bot.
  This means it's easy for `pnpm test` to silently regress as features
  land, and supply-chain updates ship by hand.
- **Fix:** Add `.github/workflows/ci.yml` running `typecheck`, `lint`,
  `test`, plus a Postgres-services job running `test:integration`. Add
  a Dependabot config (`.github/dependabot.yml`) for npm + docker
  images. Husky + lint-staged is optional but recommended for the
  pre-commit lint+format pass.

### [INF-010] `.env.example` is missing several configurable knobs

- **Severity:** HIGH
- **File:** `F:\code\chat\.env.example`
- **Issue:** Variables read by the code but not present in the example:
  - `LOG_LEVEL` — read by `apps/worker/src/index.ts:23`; never
    documented.
  - `WEB_PORT` — referenced in `README.md:74` and `CLAUDE.md`; never
    listed in `.env.example`.
  - `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`, `GARAGE_METRICS_TOKEN`
    — required for non-dev `garage-config.mjs` runs (see
    `scripts/garage-config.mjs:54-66`); not documented.
  - No rate-limit knobs — currently hard-coded to 300/min globally in
    `apps/api/src/app.ts:64`, 5/5min for `/auth/bootstrap`, 10/min for
    register, 20/min for login, 60/min for typing, etc. None of these
    are configurable, which is a hardening blocker for high-traffic
    self-hosters.
  - No body-size knob — `bodyLimit: 2 * 1024 * 1024` is hardcoded in
    `apps/api/src/app.ts:53`, but nginx is 25MB and local-upload route
    is 256MB. Operators on big-handout instances would want this knob.
  - No DB pool tuning (Prisma's `connection_limit` is left at default).
  - No audit-log retention knob.
- **Fix:** Add the missing variables to `.env.example`, then wire those
  not yet wired (the rate-limit / body-size knobs) into
  `apps/api/src/config.ts`.

### [INF-011] No SECURITY.md, CODE_OF_CONDUCT.md, or CONTRIBUTING.md

- **Severity:** HIGH
- **File:** Repository root.
- **Issue:** For an open-source security-sensitive (trust & safety)
  project with a public-facing README and an explicit threat model
  (`docs/safety.md`), there is no `SECURITY.md` describing how to
  report a vulnerability privately. There's also no `CODE_OF_CONDUCT.md`
  or `CONTRIBUTING.md`. GitHub's `Security` tab shows nothing.
- **Fix:** Add `SECURITY.md` with a private disclosure email or GitHub
  Security Advisory link. Add `CODE_OF_CONDUCT.md` (Contributor Covenant
  or similar) and `CONTRIBUTING.md` referencing the dev commands in
  `CLAUDE.md`.

### [INF-012] `docs/deployment.md` says Redis is required; README says it's optional

- **Severity:** HIGH
- **File:** `F:\code\chat\docs\deployment.md:11`, `F:\code\chat\README.md:45-49`
- **Issue:** The deployment table marks Redis as required (`yes`), but
  the README, `docs/native-setup.md`, and `docs/production-hardening.md`
  consistently describe Redis as optional (single-replica deployments
  use in-process pub/sub). The api boots fine without Redis (see
  `apps/api/src/config.ts:19` — `optionalString`). This is misleading
  for first-time deployers.
- **Fix:** Mark Redis as "optional (required for multi-replica)" in
  `deployment.md`.

### [INF-013] Garage config materialisation rewrites the example into a `chmod 644` file with secrets

- **Severity:** HIGH
- **File:** `F:\code\chat\scripts\garage-config.mjs:81`
- **Issue:** `writeFileSync(TARGET, materialized, { encoding: 'utf-8' })`
  doesn't pass a `mode`. On Unix it defaults to `0666 & ~umask`, so on
  a standard `umask 022` it ends up `rw-r--r--`. The dev secret is
  technically not high-value on a developer laptop, but production
  bootstraps with operator-provided `GARAGE_RPC_SECRET` /
  `GARAGE_ADMIN_TOKEN` / `GARAGE_METRICS_TOKEN` will land secrets in a
  world-readable file. Same concern applies to `scripts/ensure-env.mjs`
  generating `.env` without `mode: 0o600`.
- **Fix:** Pass `mode: 0o600` to both `writeFileSync` calls
  (`ensure-env.mjs:52`, `garage-config.mjs:81`). Document this in the
  production-hardening checklist (which already mentions `chmod 600
  .env`).

### [DOC-004] `docs/roadmap.md` Phase 0 says "Docker Compose (postgres, redis, garage, clamav, livekit profile)" but compose now has apps profile too

- **Severity:** HIGH
- **File:** `F:\code\chat\docs\roadmap.md:17`
- **Issue:** The roadmap's Phase 0 row about Docker Compose lists only
  the infra services. As of the recent additions there's now a full
  `apps` profile with api/worker/web/migrate (and per-app Dockerfiles).
  The roadmap also doesn't mention `pnpm garage:bootstrap` or the
  Garage-replaces-MinIO swap as Phase 0 additions.
- **Fix:** Update Phase 0 to read "Docker Compose with infra + apps +
  livekit profiles; per-app Dockerfiles; Garage S3 backend with
  `pnpm garage:bootstrap` helper."

---

## Medium Findings

### [INF-014] Traefik dynamic.yml exposes API + WS via `Host && PathPrefix` without security headers middleware

- **Severity:** MEDIUM
- **File:** `F:\code\chat\infra\traefik\dynamic.yml`
- **Issue:** The example Traefik config has no `headers` middleware
  applying HSTS, frame-deny, referrer-policy, or a CSP. The nginx fallback
  config has a few of these (`apps/web/nginx.conf:76-78`) but only the
  ones served by nginx itself — anything routed through `/api/*` or
  `/gateway` directly via Traefik (in the production stack) bypasses
  the nginx defaults. The `production-hardening.md:101-105` checklist
  asks operators to set these themselves; the example config should
  ship a middleware that satisfies that checklist.
- **Fix:** Add a `headers-tavern` middleware to dynamic.yml with HSTS
  (≥1 year), `frameDeny: true`, `contentTypeNosniff: true`,
  `referrerPolicy: strict-origin-when-cross-origin`, and a base CSP
  string. Wire it via `middlewares: ["headers-tavern@file"]` on each
  router.

### [INF-015] nginx.conf has no gzip or brotli pre-compression for `/assets/*`

- **Severity:** MEDIUM
- **File:** `F:\code\chat\apps\web\nginx.conf`
- **Issue:** Vite's production build emits hashed JS+CSS that compresses
  well (the README cites ~1 MB JS / 19.9 KB CSS uncompressed). nginx
  doesn't enable `gzip` or `brotli_static` in this config; clients
  downloading the SPA pay the full uncompressed size on each cache miss.
  No pre-compressed `.gz` / `.br` artifacts are produced by the Vite
  build, so even adding `gzip on; gzip_types ...` would only do
  on-the-fly compression (acceptable for dev, wasteful at scale).
- **Fix:** Add `gzip on; gzip_static on; gzip_types text/css
  application/javascript application/json image/svg+xml;` to the server
  block. Optionally produce `.gz`/`.br` siblings via a Vite plugin
  (`vite-plugin-compression`) so nginx can serve them directly.

### [INF-016] nginx.conf has no CSP / HSTS headers; production-hardening.md says operators must add them

- **Severity:** MEDIUM
- **File:** `F:\code\chat\apps\web\nginx.conf:75-78`
- **Issue:** Only `X-Content-Type-Options`, `X-Frame-Options`, and
  `Referrer-Policy` are set. No `Strict-Transport-Security` (because
  nginx is inside docker on plain HTTP — Traefik is expected to add
  HSTS, but this isn't documented inside the nginx config). No CSP.
  `production-hardening.md` puts the burden on the deployer to add CSP,
  which is reasonable for the strict-self pattern Tavern uses, but the
  nginx.conf should at minimum carry a TODO comment naming the headers
  that get added at the proxy layer.
- **Fix:** Add a comment block at the top of the nginx.conf naming the
  CSP / HSTS / COOP headers that should be applied at the reverse-proxy
  layer (Traefik), with a pointer to `production-hardening.md`.

### [INF-017] API `bodyLimit` (2MB), nginx `client_max_body_size` (25MB), local-upload route `bodyLimit` (256MB) — three inconsistent caps

- **Severity:** MEDIUM
- **File:** `F:\code\chat\apps\api\src\app.ts:53`, `F:\code\chat\apps\web\nginx.conf:21`, `F:\code\chat\apps\api\src\routes\local-files.ts:66`
- **Issue:** Three different body caps for related surfaces:
  - Fastify global: 2MB. Affects JSON bodies (`POST /api/messages`,
    etc.) — fine, until someone pastes a 3MB handout body.
  - nginx upstream: 25MB. Matches `UPLOAD_LIMITS.MAX_IMAGE_BYTES` but
    not `MAX_VIDEO_BYTES` (200MB) or `MAX_AUDIO_BYTES` (50MB).
  - local-uploads PUT route: 256MB. The actual upload landing zone.
  None of these are env-driven; tuning one for a deployment means a
  multi-file patch. The nginx 25MB cap will silently reject video
  uploads that the api would otherwise accept.
- **Fix:** Either lift nginx to 256MB (matching the local-uploads cap)
  or document explicitly that storage-backed uploads bypass the API
  body limit entirely (PUTs go to the storage backend). Add a single
  `MAX_UPLOAD_BYTES` env var driving both the nginx config (templated)
  and the Fastify route.

### [INF-018] `scripts/ensure-env.mjs` JWT secret generation is fine but uses 48 bytes hex (96 hex chars) — config requires ≥32 chars

- **Severity:** MEDIUM
- **File:** `F:\code\chat\scripts\ensure-env.mjs:48`, `F:\code\chat\apps\api\src\config.ts:21-22`
- **Issue:** `randomBytes(48).toString('hex')` produces 96 hex characters,
  which is well above the 32-char minimum in
  `JWT_ACCESS_SECRET: z.string().min(32)`. The strength is correct but
  the constant is over-spec'd vs the documented minimum. Also note that
  `replace()` (not `replaceAll()`) is used; since the two placeholders
  are distinct strings, this works, but is brittle if a future template
  adds another occurrence of the same string.
- **Fix:** Either reduce the constant to 32 bytes (≥64 hex chars, still
  comfortably above the threshold) or document why 48 bytes was chosen.
  Switch to `String.prototype.replaceAll` for safety.

### [INF-019] `scripts/garage-bootstrap.mjs` 60s health-wait may be too short on cold storage

- **Severity:** MEDIUM
- **File:** `F:\code\chat\scripts\garage-bootstrap.mjs:111`
- **Issue:** `const deadline = Date.now() + 60_000;` — 60 seconds. Garage
  takes ~5 seconds on hot caches but can take longer on cold tmpfs /
  slow disks (e.g. macOS Docker Desktop). On a CI host with disk
  pressure this can fail spuriously.
- **Fix:** Bump to 180s and log progress every 30s. Make it env-tunable
  (`GARAGE_BOOTSTRAP_TIMEOUT_S`).

### [INF-020] `scripts/garage-bootstrap.mjs` anonymous-read fallback is a "warn but continue" — frontend will get 403 silently

- **Severity:** MEDIUM
- **File:** `F:\code\chat\scripts\garage-bootstrap.mjs:181-199`
- **Issue:** If both `bucket allow --read` and `bucket website --allow`
  fail, the script prints a `WARN — could not enable anonymous reads`
  and exits 0. With the new `/api/_attachments/` proxy in
  `apps/api/src/routes/attachments.ts`, anonymous reads are no longer
  required for correctness — but the warning text still says "the
  frontend will get 403 on direct S3 GETs" which is now obsolete and
  misleading. Operators reading the warning will spend time debugging
  a non-bug.
- **Fix:** Update the warn copy to reflect the proxy. Better: remove
  the anonymous-read attempt entirely since the api proxy handles all
  attachment reads (`docs/docker-setup.md:92-99` already documents this).

### [INF-021] `.dockerignore` strips `*.md` but the api Dockerfile copies the whole `apps/` and `packages/` tree which contains the docs path indirectly

- **Severity:** MEDIUM
- **File:** `F:\code\chat\.dockerignore:47-48`
- **Issue:** `*.md` is excluded but `!packages/*/README.md` is preserved.
  However, `docs/` is excluded outright at line 46, while the Dockerfiles
  `COPY apps apps` (which doesn't include `docs/`). The negation pattern
  is correct, but the `docs` line is redundant given `apps` and
  `packages` are the only copied trees. The pattern `*.md` won't help
  in practice since no `.md` files exist at the workspace root that are
  copied. There's no actual bug, but the rules are convoluted.
- **Fix:** Simplify: remove the `*.md` and `!packages/*/README.md`
  rules. They don't currently prevent anything.

### [INF-022] `apps/web/Dockerfile` runtime stage runs as root (nginx default)

- **Severity:** MEDIUM
- **File:** `F:\code\chat\apps\web\Dockerfile:37-41`
- **Issue:** `FROM nginx:alpine` and no `USER` directive. nginx's master
  process runs as root by default so it can bind to :80; the workers
  drop to `nginx`. This is the upstream default and is fine; just worth
  flagging that the container has root inside it. The deployment doc
  doesn't mention this nor the `nginx-unprivileged` alternative.
- **Fix:** Consider switching to `nginxinc/nginx-unprivileged:alpine`
  (which listens on :8080 and runs entirely as a non-root user). If you
  keep `nginx:alpine`, mention in `production-hardening.md` that the
  web container does have root, and the implication is mitigated by
  the read-only fs of `/etc/nginx` and `/usr/share/nginx/html`.

### [INF-023] Docker resource limits absent

- **Severity:** MEDIUM
- **File:** `F:\code\chat\infra\docker\docker-compose.yml`
- **Issue:** No `deploy.resources.limits` or compose-v2 equivalent
  (`mem_limit`, `cpus`) on any service. On a multi-tenant host an
  api crash-loop or worker memory leak will starve postgres/garage of
  RAM and take the whole stack down.
- **Fix:** Add reasonable memory caps per service. `postgres: 1G,
  redis: 512M, garage: 1G, clamav: 2G (signatures), api: 1G, worker:
  1G, web: 128M, migrate: 512M, livekit: 1G`. Document the rationale
  in `docs/production-hardening.md`.

### [DOC-005] `docs/deployment.md` "Operational notes" — "The Gateway is sticky-ish" contradicts production-hardening's "Sticky sessions are NOT required"

- **Severity:** MEDIUM
- **File:** `F:\code\chat\docs\deployment.md:81-82`, `F:\code\chat\docs\production-hardening.md:80-81`
- **Issue:** Deployment doc says the gateway "is sticky-ish" — implying
  some affinity. Production-hardening says "Sticky sessions are NOT
  required — clients reconnect cleanly across replicas." The actual
  code (`apps/api/src/gateway/index.ts`) implements RESUME with a
  per-session buffer, so reconnects bridge a small replica change but
  cross-replica RESUME needs Redis (broker is in-process by default).
  The two docs contradict each other.
- **Fix:** Pick one truth, document the multi-replica caveat (Redis
  broker required), update both files.

### [DOC-006] `docs/docker-setup.md` "Common gotchas" doesn't mention the `service_started` vs `service_healthy` race

- **Severity:** MEDIUM
- **File:** `F:\code\chat\docs\docker-setup.md:101-118`
- **Issue:** Operators who run `pnpm docker:up:full` and immediately get
  api upload failures (because garage is `started` but not `healthy`
  yet) will have no documented troubleshooting path. The gotchas section
  covers ClamAV signatures and Garage bootstrapping but not this race.
- **Fix:** Add a bullet describing how to spot the race (api logs show
  garage init error on startup) and the workaround (`docker compose
  restart api`).

### [DOC-007] `docs/docker-setup.md` says `docker compose down -v` is the wipe command; doesn't mention that the apps profile must be specified

- **Severity:** MEDIUM
- **File:** `F:\code\chat\docs\docker-setup.md:130-133`
- **Issue:** The wipe command shown is
  `docker compose -f infra/docker/docker-compose.yml --profile apps
  --profile livekit down -v` — correct. But the surrounding text says
  "After a `-v` wipe, re-run `pnpm garage:bootstrap`" which assumes the
  garage volume was wiped. With `down -v` against a `--profile`
  filter, only services in the named profiles plus their volumes are
  affected — and the global `volumes:` section of the compose file lists
  the Garage volumes outside any profile, so they DO get wiped. OK in
  practice. Just confusing to a reader.
- **Fix:** Spell out which volumes survive vs get wiped under each
  command.

### [DOC-008] `docs/architecture.md` ASCII diagram has ClamAV after worker but before Garage; in reality scan reads from Garage and writes back

- **Severity:** MEDIUM
- **File:** `F:\code\chat\docs\architecture.md:33-43`
- **Issue:** The diagram shows worker → ClamAV → Garage. In the actual
  flow (described correctly in `docs/architecture.md:62-66`), worker
  reads from Garage, sends INSTREAM to ClamAV, writes status back to
  Postgres, optionally moves the object to the quarantine bucket. The
  arrows in the diagram suggest a linear pipeline rather than the
  fan-out it actually is.
- **Fix:** Redraw with worker as the centre of the post-upload pipeline,
  with arrows to ClamAV (scan request) and Garage (read + write).

### [DOC-009] `docs/architecture.md` "Realtime events carry sequence numbers" is true but doesn't mention the per-session buffer caveat

- **Severity:** MEDIUM
- **File:** `F:\code\chat\docs\architecture.md:79-80`
- **Issue:** The doc says sequence numbers let clients re-sync; doesn't
  mention that the buffer is per-session (in-process) so a process
  restart drops the buffer. The gateway emits `INVALID_SESSION (op 9)`
  in that case (see `apps/api/src/gateway/index.ts:18`). Worth saying.
- **Fix:** Add a sentence: "Buffers are per-process; a restart triggers
  `INVALID_SESSION` and a fresh IDENTIFY."

### [DOC-010] `README.md` `pnpm docker:up:all` description is wrong

- **Severity:** MEDIUM
- **File:** `F:\code\chat\README.md:95-98`
- **Issue:** README says: "`pnpm docker:up:all` — infra only (postgres
  + redis + garage + clamav + livekit)". The script is actually
  `node scripts/garage-config.mjs && docker compose ... --profile
  livekit up -d` (package.json:38). It includes LiveKit, so "infra
  only" is misleading — the LiveKit profile is enabled. The plain
  `pnpm docker:up` is the infra-only command.
- **Fix:** Rewrite the bullet to read: "`pnpm docker:up` — infra only
  (postgres + redis + garage + clamav). `pnpm docker:up:all` adds
  LiveKit. Pair either with `pnpm dev` on the host for fast iteration."

### [INF-024] `infra/garage/garage.toml.example` committed dev secrets aren't truly random across forks; bootstrap could fingerprint

- **Severity:** MEDIUM
- **File:** `F:\code\chat\infra\garage\garage.toml.example:27,41,42`
- **Issue:** Committing dev secrets that get pattern-replaced is the
  right pattern (and the script enforces NODE_ENV gating), but each
  installation's first `pnpm docker:up` writes the same-shaped
  config to disk with different secrets. The committed dev values are
  effectively constants. Anyone with read access to a dev environment
  before `garage-config.mjs` runs sees the same constants every time.
  The script does generate fresh secrets in dev, but the *window*
  between checkout and first up could leak them. Low risk on a dev
  laptop, but worth documenting.
- **Fix:** Add a `git-attributes` rule scrubbing those values from the
  log, or just delete the dev defaults entirely and require the script
  to run before docker:up succeeds (the README already chains them).

---

## Low Findings

### [INF-025] `apps/api/Dockerfile` and `apps/worker/Dockerfile` pin pnpm to `9.12.3` while root package.json also pins `9.12.3` — keep them in sync

- **Severity:** LOW
- **File:** `F:\code\chat\apps\api\Dockerfile:24`, `F:\code\chat\apps\worker\Dockerfile:14`, `F:\code\chat\apps\web\Dockerfile:16`, `F:\code\chat\package.json:7`
- **Issue:** Three Dockerfiles + the root manifest hardcode pnpm
  version. Bumping pnpm means touching four files.
- **Fix:** Either (a) read pnpm version from `packageManager` field via
  `ARG PNPM_VERSION` + a script that parses package.json, or (b) just
  document the requirement in `CONTRIBUTING.md` once it exists.

### [INF-026] `.gitignore` doesn't ignore `e2e/walkthrough-frames/*.png` source files separately, but does ignore the dir — fine, just verbose

- **Severity:** LOW
- **File:** `F:\code\chat\.gitignore:23`
- **Issue:** Nit — the gitignore is verbose for walkthrough artifacts.
  Not a bug.
- **Fix:** Optional: collapse `e2e/walkthrough-*` to a single pattern.

### [INF-027] `apps/web/Dockerfile` doesn't apply a healthcheck — but compose adds one

- **Severity:** LOW
- **File:** `F:\code\chat\apps\web\Dockerfile`
- **Issue:** Best practice is to ship a `HEALTHCHECK` instruction in the
  image so it works outside compose. Compose does add one
  (`wget /healthz`), so this is consistent for the as-shipped stack.
- **Fix:** Add `HEALTHCHECK CMD wget -q -O /dev/null
  http://127.0.0.1/healthz || exit 1` to the Dockerfile.

### [INF-028] Compose volumes have no explicit driver / driver_opts; default `local` is fine but uncontrolled

- **Severity:** LOW
- **File:** `F:\code\chat\infra\docker\docker-compose.yml:234-239`
- **Issue:** `volumes: tavern_postgres: {}` — empty mapping. On Linux
  hosts these end up under `/var/lib/docker/volumes/tavern_postgres/`.
  Operators wanting to relocate must use `docker volume create
  --opt device=...` and then reference an external volume. Not a bug,
  just a doc gap.
- **Fix:** Add a comment block in compose describing volume relocation.

### [DOC-011] `docs/walkthrough.md` `pnpm docker:up` won't bring up the full app — but `pnpm dev` after is what the user wants

- **Severity:** LOW
- **File:** `F:\code\chat\docs\walkthrough.md:60-66`
- **Issue:** The walkthrough run steps say `pnpm docker:up` then
  `pnpm db:migrate` then `pnpm db:seed`, then `pnpm dev`. This works
  for the dev path, but `pnpm db:migrate` will fail if Postgres isn't
  reachable, and on a fresh checkout `pnpm dev` will run
  `ensure-env.mjs` first — flow's OK, just worth re-ordering: install,
  copy env, start docker infra, migrate, seed, dev.
- **Fix:** Re-order to: `pnpm install` → `pnpm docker:up` → wait for
  postgres healthy → `pnpm db:generate && pnpm db:migrate && pnpm
  db:seed` → `pnpm dev`.

### [DOC-012] `docs/safety.md` references `voice_messages` as reportable but no UI surface for that exists yet

- **Severity:** LOW
- **File:** `F:\code\chat\docs\safety.md:48-55`
- **Issue:** Voice message attachments are reportable (any attachment
  is reportable), so technically correct, but the doc lists them as a
  separate category alongside "attachments" — confusing.
- **Fix:** Either fold voice_messages into "attachments" or note that
  voice_messages are a sub-kind of attachment.

### [DOC-013] `docs/roadmap.md` Phase 6 says "Built (`docs/production-hardening.md`)" but production-hardening.md still has unfinished items

- **Severity:** LOW
- **File:** `F:\code\chat\docs\roadmap.md:101`, `F:\code\chat\docs\production-hardening.md:50`
- **Issue:** The hardening doc says "Object lifecycle: orphaned `pending`
  attachments older than ~24h are deleted nightly. **This isn't built;
  do it via a cron + mc.**" Roadmap marks "Production hardening
  checklist" as Built — accurate as far as "checklist exists" but the
  *checklist* item is unbuilt and operators have to roll their own.
- **Fix:** Either build the cleanup job (a small BullMQ scheduled job
  that DELETEs orphaned pending Attachment rows and the corresponding
  storage objects) or call it out in `roadmap.md` honest gaps.

### [INF-029] `infra/traefik/traefik.yml` ACME http-01 challenge stored at `/letsencrypt/acme.json` — but no volume mount in example

- **Severity:** LOW
- **File:** `F:\code\chat\infra\traefik\traefik.yml:26-30`
- **Issue:** ACME storage path is given but the README doesn't show the
  volume mount needed for it to persist across container restarts. New
  Traefik users may re-issue certs on every restart and hit Let's
  Encrypt rate limits.
- **Fix:** Add a snippet in `infra/traefik/README.md` showing the
  `volumes:` mount and `chmod 600` requirement for `acme.json`.

---

## Documentation Drift (per doc)

### `docs/api.md`
**Missing routes (verified against `apps/api/src/routes/*.ts`):**
- `GET /api/auth/bootstrap-status`, `POST /api/auth/bootstrap` (auth.ts)
- `POST /api/invites`, `DELETE /api/invites/:id`, `POST /api/invites/:code/join` (invites.ts)
- `PUT /api/messages/:id/reactions/:emoji`, `DELETE /api/messages/:id/reactions/:emoji` (reactions.ts)
- `GET /api/servers/:serverId/emojis`, `POST /api/servers/:serverId/emojis`, `DELETE /api/emojis/:id` (emojis.ts)
- `GET /api/channels/:id` (channels.ts)
- `GET /api/servers/:id/members` (servers.ts)
- `POST /api/channels/:id/typing` (typing.ts)
- `GET /api/servers/:serverId/search` (search.ts)
- `GET /api/channels/:id/dice` (dice.ts)
- `POST /api/attachments/:id/waveform` (uploads.ts)
- `PATCH /api/notes/:id`, `DELETE /api/notes/:id` (notes.ts)
- `PATCH /api/handouts/:id` (handouts.ts)
- `PATCH /api/board-games/:id`, `DELETE /api/board-games/:id` (board-games.ts)
- `PATCH /api/game-nights/:id`, `GET /api/game-nights/:id/candidates`, `POST /api/game-nights/:id/votes`, `PUT /api/game-nights/:id/rsvp` (game-nights.ts)
- `GET /api/_local-files/:bucket/:key`, `PUT /api/_local-uploads/:token` (local-files.ts)
- `GET /api/_attachments/:bucket/:key` (attachments.ts)
- `GET /healthz`, `GET /api/instance` (app.ts)

**Wrong path documented:**
- `PUT /members/:userId/roles` — actual: `PUT /api/servers/:serverId/members/:userId/roles`
- `POST /campaigns/:id/sessions` — actual: `POST /api/sessions` (body.campaignId)
- `POST /campaigns/:id/notes` — actual: `POST /api/notes` (body.campaignId)
- `POST /campaigns/:id/handouts` — actual: `POST /api/handouts` (body.campaignId)

**Stale / understated:**
- The "Tabletop" table omits more than it includes — only 11 of ~16 tabletop endpoints listed.
- No reference to rate-limit configuration despite per-route `config: { rateLimit }` overrides in code.

### `docs/permissions.md`
- No bit-position table — every flag is named but the reader can't map
  to/from bit positions without opening the source.
- Reserved bit gap (50-61) and `ADMINISTRATOR = bit 62` not called out.
- Wire format example shows a magic value (`"1099511627775"`) without
  decoding it.
- `Default @everyone bundle` list doesn't quite match
  `PERMISSION_DEFAULT_EVERYONE` in code — the doc says
  "CONNECT_VOICE, SPEAK_VOICE, ENABLE_CAMERA, STREAM_SCREEN, and
  USE_VAD" but the code also adds `ATTACH_FILES`, `EMBED_LINKS`,
  `ADD_REACTIONS`, `USE_EXTERNAL_EMOJIS`, `SEND_VOICE_MESSAGES`,
  `ROLL_DICE`, `REPORT_CONTENT`. The doc text says "basic chat rights
  plus voice/camera/screenshare" without enumerating which.

### `docs/architecture.md`
- Diagram suggests linear worker → ClamAV → Garage; reality is fan-out
  with worker as the orchestrator.
- No mention of the new `/api/_attachments/` proxy that breaks the
  "browser PUTs the bytes directly to S3" simplification in the data
  flow section (the proxy is for GET, not PUT, but still worth a line).
- No section on the Trust & Safety Core surface, despite the README
  emphasising it.
- No section on the multi-replica / Redis-broker promotion that the
  rest of the docs reference.

### `docs/deployment.md`
- Marks Redis as `yes` required; README/production-hardening say
  optional.
- `docker compose up -d` instructions don't engage the `apps` profile.
- No mention of `pnpm garage:bootstrap`.
- No mention of `pnpm docker:up:full` shortcut.
- "The Gateway is sticky-ish" contradicts production-hardening.md's
  "Sticky sessions are NOT required."
- Backup section doesn't mention Garage's role-based replication or
  the AGPL implications of self-modifying Garage.

### `docs/docker-setup.md`
- `pnpm docker:up` description says it includes redis + garage +
  clamav, which is right, but doesn't mention that the LIVEKIT profile
  must be added separately for voice rooms (it does, just rated low).
- "Common gotchas" doesn't include the `service_started` vs
  `service_healthy` race for first-cold-boot uploads.

### `docs/native-setup.md`
- **Critical:** Step instructing to copy `infra/garage/garage.toml`
  (git-ignored, materialised file) rather than `garage.toml.example`.
- The `garage layout assign` command uses backticks in shell-substitution
  style (`NODE_ID=$(garage node id ...)`), which works in bash/zsh but
  not PowerShell — the doc is otherwise PowerShell-friendly.
- No mention of `GARAGE_RPC_SECRET` / `GARAGE_ADMIN_TOKEN` /
  `GARAGE_METRICS_TOKEN` env vars for non-dev runs.

### `docs/production-hardening.md`
- Marks `Object lifecycle: orphaned pending attachments older than ~24h
  are deleted nightly. This isn't built; do it via a cron + mc.` —
  honest but the cleanup is implementable as a BullMQ scheduled job
  inside the worker. Roadmap calls Phase 6 "Built" with no caveat.
- CSP guidance is good but doesn't reference the nginx.conf already
  setting `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`.
- Worker availability bullet says "Two for availability" — without
  mentioning that BullMQ workers auto-distribute jobs (no need for
  active/standby) and that Postgres advisory locks aren't used.

### `docs/safety.md`
- "voice_messages" listed as a separate reportable kind in the bullet
  list; in code the report `targetType` enum includes `attachment`
  (which voice messages are) — minor.
- The `lock_account` action lists 30-day default lock; this matches
  `moderation.ts:160` but isn't documented as configurable.

### `docs/tabletop.md`
- `POST /game-nights/:id/candidates` referenced but the canonical-doc
  problem in api.md applies here too.
- No reference to dice notation `r<n>` (reroll) or `!` (explode) — the
  parser may or may not support them; if it doesn't, the doc is fine
  as-is.

### `docs/roadmap.md`
- Phase 0: "Docker Compose (postgres, redis, garage, clamav, livekit
  profile)" — out of date; the apps profile + per-app Dockerfiles + the
  bootstrap script are not listed.
- Phase 6: "Production hardening checklist | Built
  (`docs/production-hardening.md`)" — the file exists but contains
  unfinished items (see safety.md drift).
- "Verified results (current commit): `pnpm test` — **44/44** (36
  shared + 8 API)" — should be re-run; recent changes (auth bootstrap,
  voice schemas test added per gitstatus) may have shifted counts.

### `docs/walkthrough.md`
- The first run steps don't tell the user to copy `.env.example` to
  `.env` (although `pnpm ensure-env` runs via the predev hook); minor
  doc clarification.

---

## Configuration Gaps

### `.env.example` — missing vars

These are read or referenced in code but not in the example file:
- `LOG_LEVEL` (worker uses; default `info`).
- `WEB_PORT` (referenced in README + CLAUDE.md).
- `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`, `GARAGE_METRICS_TOKEN`
  (required by `scripts/garage-config.mjs` outside dev).
- Rate-limit knobs (global 300/min, per-route varies — all hardcoded).
- Body-size knob (Fastify 2MB, nginx 25MB).
- DB pool size (Prisma default 10 — should be tunable in prod).
- Audit log retention (no env var; no cron).
- `API_RATE_LIMIT_*`, `MAX_UPLOAD_BYTES` — would need new code + env
  wiring.

### `.dockerignore` — sound

Mostly correct. The `*.md` + `!packages/*/README.md` rules are
convoluted but not broken. Recommend simplifying (see INF-021).

### `.gitignore` — sound

Properly ignores: `.env`, `infra/garage/garage.toml`,
`node_modules/`, `dist/`, `coverage/`, e2e artifacts, prisma dev.db.
Tracks: `.env.example`, `garage.toml.example`, prisma migrations.

### Root `package.json`

- pnpm `9.12.3` pinned across all surfaces. Good.
- `engines.node >= 22.0.0`. Good.
- `predev` hook order is correct: `ensure-env` runs before `dev`.
- No `pre-commit` script registered. Husky absent.
- No `prepare` script (Husky would need it).
- `scripts.test` is `pnpm -r test` — runs across all workspaces.
  Acceptable.

### Workspace `package.json` audit

- `apps/api`: Fastify v5, Prisma v5, BullMQ v5, ioredis v5 — consistent
  major versions across apps.
- `apps/worker`: same versions as api. Good.
- `apps/web`: React 18.3.1, TanStack Router 1.79, Vite 5.4.10, Tailwind
  3.4.14, Radix UI matching versions — consistent.
- `packages/media`: depends on `minio@^8.0.2` and `sharp@^0.33.5`. No
  version drift.
- All workspace packages share `typescript@^5.6.3`, `vitest@^2.1.4` —
  good.
- `@types/node@^22.9.0` declared only at root + media. Other apps
  inherit transitively, which works but is fragile.

### Workspace `tsconfig.base.json`

Not inspected in detail; observed compile chain via Dockerfile
(`tsc -b && vite build` in web; `tsc` in api).

---

## Positive Notes

- **`scripts/ensure-env.mjs` is excellent.** Cross-platform, pure
  Node, idempotent, sub-100ms cold start, with sensible messaging.
- **`scripts/garage-config.mjs` correctly gates dev-secret fallback by
  `NODE_ENV`.** Production paths must supply env vars or the script
  fails loudly — exactly right.
- **`scripts/garage-bootstrap.mjs` is defensive.** Handles re-runs,
  detects Docker-unreachable, treats anonymous-read failure as a warn
  rather than a hard fail.
- **Dockerfiles use multi-stage with proper pnpm fetch caching.** The
  `--mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store`
  trick is correctly applied. `pnpm deploy --prod` produces a clean
  runtime tree.
- **`apps/api/Dockerfile` re-generates Prisma client into `/deploy`
  using the dev-deps CLI from `/app`.** The comment block explaining
  why is the kind of thing you only write after debugging it.
- **`apps/web/nginx.conf` SPA fallback is correct,** assets get
  `immutable` cache, `index.html` gets `no-store`, WS timeouts at
  3600s.
- **`docker-compose.yml` binds everything to `127.0.0.1`,** consistent
  with the dev/LAN safety goal stated in the file header.
- **`apps/api/src/app.ts:165-189` validates `ALLOWED_ORIGINS` at
  startup** and refuses `*` (which would silently widen CORS with
  credentials). This is the correct pattern.
- **The `LocalStorageBackend` mirrors S3 presigned-PUT semantics** so
  storage backend swaps are pure env config.
- **CLAUDE.md is genuinely useful** and references the design-system
  HTML as the source of truth for UI work — pragmatic.
- **`docs/safety.md` is honest** about what Tavern does and does not
  do. Not over-promising.
- **The `Trust & Safety Core`** branding is consistent across README,
  safety.md, and config (`TRUST_SAFETY_CORE_ENABLED`).
- **`docs/roadmap.md` reads like reality** — "Phase X built" with
  test counts and the "Honest gaps" section. More projects should
  write this.
