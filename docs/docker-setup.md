# Docker setup (optional)

Tavern's no-Docker quickstart in [`README.md`](../README.md) is the path
of least resistance. This doc is for when you want to run the dev stack
in containers anyway.

## Bring up the stack

```bash
pnpm docker:up           # postgres + redis + minio + clamav
pnpm docker:up --profile livekit   # add LiveKit
```

Confirm everything is healthy:

```bash
docker ps
```

You should see `tavern-postgres`, `tavern-redis`, `tavern-minio`,
`tavern-minio-bootstrap`, `tavern-clamav`, and (with the profile)
`tavern-livekit`.

## Switch Tavern to use the containers

Edit `.env`:

```
DATABASE_URL=postgresql://tavern:tavern-dev@localhost:5432/tavern
REDIS_URL=redis://localhost:6379

STORAGE_BACKEND=s3
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=tavern
S3_SECRET_KEY=tavern-dev-secret
S3_PUBLIC_BASE_URL=http://localhost:9000/tavern-media

CLAMAV_HOST=localhost

LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=devsecret-change-me
```

(All of these match the defaults in `infra/docker/docker-compose.yml`. Generate
fresh LiveKit keys for anything beyond local dev.)

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

## Common gotchas

- **Port 5432 collision**. If you have a native Postgres listening, the
  docker postgres container can't bind. Stop one or the other:
  `Stop-Service postgresql-x64-16` on Windows / `brew services stop postgresql@16`
  on macOS.
- **ClamAV first-boot**. Fresh container takes 5–10 minutes to download
  signatures. Until then, scans return "scanner unavailable" and any
  attachment processed in that window goes to `failed` unless
  `ALLOW_UNSCANNED_UPLOADS=true`.
- **MinIO public reads**. The bootstrap container runs
  `mc anonymous set download local/tavern-media` automatically, so files
  served via `S3_PUBLIC_BASE_URL` work without auth. If you swap to a
  hosted S3 you'll need an equivalent policy or signed URLs.

## Tear down

```bash
pnpm docker:down
```

This stops and removes the containers. Volumes (`tavern_postgres`,
`tavern_redis`, `tavern_minio`, `tavern_clamav_db`) persist across runs.
To wipe data:

```bash
docker compose -f infra/docker/docker-compose.yml down -v
```
