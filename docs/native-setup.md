# Native setup (no Docker)

Tavern's only required external service is **PostgreSQL 16+**. Everything
else is optional and falls back to an in-process or on-disk equivalent.

| Service  | Required? | Native install if you want it |
|----------|-----------|------------------------------|
| Postgres | yes       | see below                    |
| Redis    | no        | Memurai (Windows) / `redis-server` (mac/linux) |
| MinIO    | no        | `minio.exe server ./data --console-address :9001` |
| ClamAV   | no        | clamav.net Windows installer / `apt install clamav-daemon` |
| LiveKit  | no        | github.com/livekit/livekit/releases (single binary) |

What "no" means in practice:

- **No Redis** → gateway uses an in-process EventEmitter (single replica
  only); upload pipeline runs in the API process; the worker daemon exits
  immediately because there's nothing for it to do.
- **No MinIO** → files written to `./data/storage/<bucket>/<key>`, served
  back through the API at `/api/_local-files/...`.
- **No ClamAV** → upload virus scan is skipped; magic-byte checks and
  extension blocking still run.
- **No LiveKit** → voice/video routes return HTTP 503; chat/dice/handouts
  all keep working.

## Postgres

### Windows

Download the installer from <https://www.postgresql.org/download/windows/>
(the "EnterpriseDB" build). Defaults are fine. After install, the service
is named `postgresql-x64-16` and listens on `0.0.0.0:5432`.

Create role + database from a `psql` shell:

```powershell
# psql is added to PATH by the installer, or under C:\Program Files\PostgreSQL\16\bin
psql -U postgres
```

```sql
CREATE ROLE tavern WITH LOGIN PASSWORD 'tavern-dev';
CREATE DATABASE tavern OWNER tavern;
\q
```

The default `DATABASE_URL` in `.env.example` already targets this:
`postgresql://tavern:tavern-dev@localhost:5432/tavern`.

### macOS

```bash
brew install postgresql@16
brew services start postgresql@16
createuser tavern -P              # type tavern-dev when prompted
createdb tavern --owner=tavern
```

### Linux (Debian / Ubuntu)

```bash
sudo apt install postgresql-16
sudo -u postgres createuser tavern -P    # type tavern-dev when prompted
sudo -u postgres createdb tavern --owner=tavern
```

Verify:

```bash
psql 'postgresql://tavern:tavern-dev@localhost:5432/tavern' -c '\dt'
```

That should connect and print `Did not find any relations.` (correct — we
haven't run migrations yet).

## Optional: Redis

Tavern's defaults are fine without Redis. Add it only if you want to run
multiple API replicas behind a load balancer.

### Windows — Memurai

Memurai is a Windows-native, Redis-compatible server.

1. Download the installer from <https://www.memurai.com/get-memurai>
2. Install with defaults — it runs as a Windows service on port 6379
3. Set `REDIS_URL=redis://localhost:6379` in `.env`
4. Restart `pnpm dev`

The worker process now has work to do; the API switches from in-memory
queues to BullMQ; the gateway broker promotes from in-process to Redis
pub/sub on startup.

### macOS / Linux

```bash
brew install redis && brew services start redis
# or:
sudo apt install redis-server
```

## Optional: MinIO

For S3-compatible storage. Defaults to `local` mode in `.env.example`, so
you don't need this unless you want to.

1. Download the single-binary release from <https://min.io/download>
2. Run it: `minio.exe server ./minio-data --console-address :9001`
3. Set in `.env`:

   ```
   STORAGE_BACKEND=s3
   S3_ENDPOINT=http://localhost:9000
   S3_ACCESS_KEY=minioadmin
   S3_SECRET_KEY=minioadmin
   S3_PUBLIC_BASE_URL=http://localhost:9000/tavern-media
   ```

4. Tavern auto-creates `tavern-media` and `tavern-quarantine` buckets on first
   startup. For public reads you'll want to set the main bucket's anonymous
   download policy via `mc`:

   ```bash
   mc alias set local http://localhost:9000 minioadmin minioadmin
   mc anonymous set download local/tavern-media
   ```

## Optional: ClamAV

Set `CLAMAV_HOST=localhost`, `CLAMAV_PORT=3310`, install ClamAV's daemon,
let `freshclam` populate signatures (this takes a few minutes the first
time), and ensure `clamd` is listening on TCP 3310.

`ALLOW_UNSCANNED_UPLOADS=true` is the dev-mode default. If you set
`CLAMAV_HOST` but the scanner is unreachable when an upload completes,
the attachment status flips to `failed` (not just "warned"). Set
`ALLOW_UNSCANNED_UPLOADS=false` for the strictest behaviour.

## Optional: LiveKit

For voice/video rooms.

1. Download from <https://github.com/livekit/livekit/releases> — pick the
   binary for your OS. There's a Windows zip with `livekit-server.exe`.
2. Generate keys:

   ```bash
   docker run --rm livekit/livekit-cli generate-keys
   # or, with the binary unpacked: livekit-cli generate-keys
   ```

3. Save the keys, then start LiveKit:

   ```bash
   livekit-server.exe --config infra/livekit/livekit.yaml
   ```

   (Edit that yaml to use your generated keys.)

4. Set in `.env`:

   ```
   LIVEKIT_URL=ws://localhost:7880
   LIVEKIT_API_KEY=<your key>
   LIVEKIT_API_SECRET=<your secret>
   ```

UDP port 7882 must be reachable from the browser. On a single machine that
just means localhost. For LAN/internet, open the port on your firewall.
