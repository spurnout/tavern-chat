# Deployment

This guide covers self-hosting Tavern. Tavern is designed to run anywhere
Docker runs — a home server, a VPS, or a small cluster.

## Components

| Service   | Purpose                              | Required? |
|-----------|--------------------------------------|-----------|
| Postgres  | Durable state                        | yes       |
| Redis     | Pub/sub + BullMQ queues              | optional¹ |
| Garage    | S3-compatible object storage (uploads + quarantine) | optional² |
| ClamAV    | Virus scanning of uploads            | recommended |
| LiveKit   | Audio/video media routing            | optional (voice/video) |
| API       | Fastify HTTP + WS gateway            | yes       |
| Worker    | BullMQ background jobs               | optional¹ |
| Web       | Vite/React frontend (static build)   | yes       |
| Traefik   | Reverse proxy + TLS                  | recommended |

¹ **Redis + Worker are required for multi-replica deployments.** In a single-replica
deployment Tavern uses an in-process EventEmitter for gateway fanout and runs
the upload pipeline inline in the API process; the worker is then a no-op
that idles waiting for SIGTERM. See INF-006 / INF-012.

² Without Garage (or another S3-compatible store), Tavern uses the
filesystem-backed `local` storage backend and serves attachments through the
API. Suitable for personal / small-group instances; for community-size
deployments use object storage.

## Local development

See [`README.md`](../README.md). The dev stack runs on `localhost` with all
services bound to `127.0.0.1` for safety.

## Production

1. Provision a host with Docker + Docker Compose v2.
2. Copy `infra/docker/docker-compose.yml`, `infra/livekit/livekit.yaml`, and
   `infra/traefik/*.yml` to the host. Adapt domains.
3. Generate strong secrets:

   ```bash
   openssl rand -hex 48          # JWT_ACCESS_SECRET
   openssl rand -hex 48          # JWT_REFRESH_SECRET
   docker run --rm livekit/livekit-cli generate-keys   # LiveKit
   openssl rand -base64 32       # Garage S3 secret key
   ```

4. Copy `.env.example` to `.env`, fill in real values, restrict perms (`chmod 600 .env`).
5. Materialise the Garage config and bring up the stack:

   ```bash
   # Generates infra/garage/garage.toml from the .example template
   node scripts/garage-config.mjs

   # Brings up infra + apps profiles (postgres, redis, garage, clamav, api,
   # worker, web). Add --profile livekit if using voice/video.
   docker compose -f infra/docker/docker-compose.yml --profile apps up -d
   docker compose -f infra/docker/docker-compose.yml --profile apps --profile livekit up -d

   # Or, equivalently, from a checkout:
   pnpm docker:up:full
   ```

   Note: a plain `docker compose up -d` will only start the infra services
   (postgres, redis, garage, clamav). The application containers are gated
   behind the `apps` profile so that operators running the API and Worker
   natively (outside Docker) don't double-start them.

6. Bootstrap Garage (one-time per host):

   ```bash
   pnpm garage:bootstrap
   ```

7. Run migrations and seed:

   ```bash
   docker compose -f infra/docker/docker-compose.yml --profile apps run --rm api pnpm db:migrate
   docker compose -f infra/docker/docker-compose.yml --profile apps run --rm api pnpm db:seed
   ```

8. Front it with Traefik (see [`infra/traefik/README.md`](../infra/traefik/README.md)).

## Networking

Required:

- **HTTPS 443** — frontend + REST + WebSocket gateway.
- **UDP 7882** — LiveKit TURN/UDP. Must be reachable by clients directly. UDP
  cannot be proxied through Traefik.

Optional:

- TCP 7881 — LiveKit TCP fallback (slow path; only used when UDP is blocked).
- TCP 3903 — Garage admin API. Do not expose publicly.

## Backups

- **Postgres**: daily `pg_dump` to off-host storage. Test restores quarterly.
- **Object storage**: replicate `tavern-media` and `tavern-quarantine` buckets
  to a cold-storage target (e.g. another Garage cluster, Backblaze B2, restic,
  etc.). The quarantine bucket should *never* be served to the public.
- **Redis**: not authoritative for any state; lost queues are acceptable in
  exchange for fast restarts.

## Operational notes

- The API and Worker are stateless. Run multiple replicas behind Traefik.
- The Gateway does **not** require sticky sessions — clients reconnect
  cleanly across replicas via the RESUME opcode (same-replica replay) or a
  fresh IDENTIFY (cross-replica). In-flight typing notifications older than
  ~5 s may be dropped during a rolling restart. DOC-005.
- Long-running uploads pin a small Redis queue. Monitor BullMQ.
- ClamAV can take several minutes to fetch its initial signature database;
  the first job after a fresh container will fail with `SCANNER_UNAVAILABLE`.
- Rotate `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` periodically. All
  existing sessions become invalid.
