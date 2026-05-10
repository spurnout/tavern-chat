# Deployment

This guide covers self-hosting Tavern. Tavern is designed to run anywhere
Docker runs — a home server, a VPS, or a small cluster.

## Components

| Service   | Purpose                              | Required? |
|-----------|--------------------------------------|-----------|
| Postgres  | Durable state                        | yes       |
| Redis     | Pub/sub + BullMQ queues              | yes       |
| MinIO     | Object storage (uploads + quarantine)| yes       |
| ClamAV    | Virus scanning of uploads            | yes (recommended) |
| LiveKit   | Audio/video media routing            | optional (Phase 3) |
| API       | Fastify HTTP + WS gateway            | yes       |
| Worker    | BullMQ background jobs               | yes       |
| Web       | Vite/React frontend (static build)   | yes       |
| Traefik   | Reverse proxy + TLS                  | recommended |

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
   openssl rand -base64 32       # MinIO secret key
   ```

4. Copy `.env.example` to `.env`, fill in real values, restrict perms (`chmod 600 .env`).
5. Bring up the stack:

   ```bash
   docker compose up -d
   docker compose --profile livekit up -d   # if using voice/video
   ```

6. Run migrations and seed:

   ```bash
   docker compose run --rm api pnpm db:migrate
   docker compose run --rm api pnpm db:seed
   ```

7. Front it with Traefik (see [`infra/traefik/README.md`](../infra/traefik/README.md)).

## Networking

Required:

- **HTTPS 443** — frontend + REST + WebSocket gateway.
- **UDP 7882** — LiveKit TURN/UDP. Must be reachable by clients directly. UDP
  cannot be proxied through Traefik.

Optional:

- TCP 7881 — LiveKit TCP fallback (slow path; only used when UDP is blocked).
- TCP 9001 — MinIO console. Do not expose publicly.

## Backups

- **Postgres**: daily `pg_dump` to off-host storage. Test restores quarterly.
- **MinIO**: replicate `tavern-media` and `tavern-quarantine` buckets to a
  cold-storage target (e.g. another MinIO, Backblaze B2, etc.). The quarantine
  bucket should *never* be served to the public.
- **Redis**: not authoritative for any state; lost queues are acceptable in
  exchange for fast restarts.

## Operational notes

- The API and Worker are stateless. Run multiple replicas behind Traefik.
- The Gateway is sticky-ish: clients reconnect cleanly, but you'll lose
  in-flight typing notifications during restarts.
- Long-running uploads pin a small Redis queue. Monitor BullMQ.
- ClamAV can take several minutes to fetch its initial signature database;
  the first job after a fresh container will fail with `SCANNER_UNAVAILABLE`.
- Rotate `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` periodically. All
  existing sessions become invalid.
