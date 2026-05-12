# Docker setup (optional)

Tavern's no-Docker quickstart in [`README.md`](../README.md) is the path
of least resistance. This doc covers two container modes:

| Command | What runs in docker | When to use |
|---|---|---|
| `pnpm docker:up`      | infra only — postgres, redis, garage, clamav        | Inner-loop development with `pnpm dev` on the host |
| `pnpm docker:up:all`  | infra + LiveKit (compose profile)                   | Same as above, plus voice/video |
| `pnpm docker:up:full` | infra + LiveKit + **api, worker, web** (fully self-contained) | Production-shaped self-hosting; smoke testing the prod image |

The full-stack mode is what you'd deploy on a home server or VPS. The
infra-only mode pairs with `pnpm dev` for faster iteration.

## Bring up the stack

```bash
pnpm docker:up                  # postgres + redis + garage + clamav
pnpm docker:up:all              # adds LiveKit
pnpm docker:up:full             # adds api + worker + web (builds images on first run)
pnpm garage:bootstrap           # one-time: apply Garage layout, import dev key, create buckets
```

The first-time bootstrap is idempotent — safe to re-run. It can be skipped
on subsequent boots since the Garage data volume persists across container
restarts.

Confirm everything is healthy:

```bash
docker ps
```

You should see `tavern-postgres`, `tavern-redis`, `tavern-garage`,
`tavern-clamav`, and (with the `:all` variant) `tavern-livekit`.

## Why Garage (and not MinIO)?

Garage is an AGPL-3.0 S3-compatible object store from Deuxfleurs, designed
for self-hosted, low-resource, geo-distributed deployments. We swapped it in
for MinIO when the latter started pulling features out of its community
edition. Tavern only talks to it over the S3 wire protocol, so switching to
AWS S3, Cloudflare R2, Backblaze B2, or any other S3-compatible service is
just `.env` config — no code change.

The Garage server config lives in
[`infra/garage/garage.toml`](../infra/garage/garage.toml). The RPC and admin
secrets in there are **dev-only**; regenerate them for any deployment.

## Switch Tavern to use the containers

Edit `.env`:

```
DATABASE_URL=postgresql://tavern:tavern-dev@localhost:5432/tavern
REDIS_URL=redis://localhost:6379

STORAGE_BACKEND=s3
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=tavernkey
S3_SECRET_KEY=tavern-dev-secret

CLAMAV_HOST=localhost

LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=devsecret-change-me
```

(All of these match the defaults in `infra/docker/docker-compose.yml`.
Garage requires `S3_ACCESS_KEY` to be at least 8 characters, which is why
the dev value is `tavernkey` rather than just `tavern`. Generate fresh
LiveKit + S3 keys for anything beyond local dev.)

Restart the dev process:

```bash
pnpm dev
```

You'll see the config summary now reads:

```
storage:  s3 (http://localhost:9000)
redis:    redis://localhost:6379
clamav:   localhost:3310
livekit:  ws://localhost:7880
```

## How attachments are served

Tavern serves attachment downloads through the API at
`/api/_attachments/:bucket/:key`. The API streams from the S3 backend with
authenticated calls — the bucket is never exposed publicly. Same threat
model as `/api/_local-files/` in no-Docker mode (URL secrecy + metadata
gating), but the underlying storage can scale to anything S3-compatible.

This matters because Garage v2.3 doesn't support anonymous S3 API reads —
the proxy is what makes that a non-issue.

## Common gotchas

- **Port 5432 collision**. If you have a native Postgres listening, the
  docker postgres container can't bind. Stop one or the other:
  `Stop-Service postgresql-x64-16` on Windows / `brew services stop postgresql@16`
  on macOS. (Or just skip the docker postgres and point `.env`'s
  `DATABASE_URL` at your native install — Tavern doesn't care.)
- **ClamAV first-boot**. Fresh container takes 5–10 minutes to download
  signatures. Until then, scans return "scanner unavailable" and any
  attachment processed in that window goes to `failed` unless
  `ALLOW_UNSCANNED_UPLOADS=true`.
- **Garage bootstrap**. `pnpm garage:bootstrap` must run once after the
  first `pnpm docker:up`. It imports the dev access key and creates the
  two buckets. Skipping it means uploads will 403 with "Access key not
  found". Re-running it after a `docker compose down -v` (which wipes
  Garage's volume) is necessary.
- **Key ID length**. Garage rejects `S3_ACCESS_KEY` values under 8 chars;
  if you change the dev default, keep it ≥ 8 characters.
- **`service_started` vs `service_healthy`** (DOC-006). The api / worker
  containers depend on `garage: service_healthy`, so they don't start until
  garage's own healthcheck passes. If you see them sitting in "Created"
  state for a minute or two after `pnpm docker:up:full`, that's expected —
  garage takes a moment to assign its layout on a fresh volume.

## Tear down

```bash
pnpm docker:down
```

This stops and removes the containers (including the `apps` profile, so
`tavern-api`, `tavern-worker`, and `tavern-web` come down too). Volumes
(`tavern_postgres`, `tavern_redis`, `tavern_garage_meta`,
`tavern_garage_data`, `tavern_clamav_db`) persist across runs. To wipe data:

```bash
docker compose -f infra/docker/docker-compose.yml --profile apps --profile livekit down -v
```

After a `-v` wipe, re-run `pnpm garage:bootstrap` to recreate the dev key
and buckets.

## Full-stack (`pnpm docker:up:full`) details

This mode brings up four extra services on top of the infra stack:

- `tavern-migrate` — a one-shot container that runs `prisma migrate deploy`
  against the postgres service and exits. The api and worker depend on it
  completing successfully before they start.
- `tavern-api` — Fastify HTTP + WebSocket gateway. Exposed on host `:3001`
  (same as native dev) so direct access still works.
- `tavern-worker` — BullMQ background processor.
- `tavern-web` — nginx-alpine serving the Vite production build at host
  `:3030`. nginx proxies `/api/*` and `/gateway` to the api service over
  the docker network, so the browser only ever sees one origin — no CORS.

Open **http://localhost:3030** and the app talks to the api transparently.

Images are built from per-app Dockerfiles:

- [`apps/api/Dockerfile`](../apps/api/Dockerfile)
- [`apps/worker/Dockerfile`](../apps/worker/Dockerfile)
- [`apps/web/Dockerfile`](../apps/web/Dockerfile)

To rebuild only (without bringing the stack up):

```bash
pnpm docker:build
```

The api and worker images use `tsx` as the runtime command rather than
`node dist/index.js`. Workspace packages (`@tavern/shared`, `@tavern/db`,
`@tavern/media`) export TypeScript source via `main: ./src/index.ts`;
shipping `tsx` in the runtime image avoids needing to also build + publish
those packages separately. Cost is ~100ms at cold start.

### Apps-mode environment overrides

Inside containers the apps need service-DNS hostnames, not `localhost`. The
compose file loads `.env` via `env_file: ../../.env` for base config (JWT
secrets, S3 creds, feature flags) and then overrides per-service:

| Variable           | Value in apps-mode                                                         |
|--------------------|----------------------------------------------------------------------------|
| `DATABASE_URL`     | `postgresql://tavern:tavern-dev@postgres:5432/tavern`                      |
| `REDIS_URL`        | `redis://redis:6379`                                                       |
| `S3_ENDPOINT`      | `http://garage:3900`                                                       |
| `CLAMAV_HOST`      | `clamav`                                                                   |
| `PUBLIC_BASE_URL`  | `http://localhost:3030` (so presigned upload URLs route via nginx)         |
| `API_BASE_URL`     | `http://api:3001` (worker → api internal)                                  |

Native dev mode keeps the `localhost:*` values from `.env`. Both modes can
coexist on the same machine, just not on the same ports — pick one inner-loop
flavour.
