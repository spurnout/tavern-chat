# Native setup (no Docker)

Tavern's only required external service is **PostgreSQL 16+**. Everything
else is optional and falls back to an in-process or on-disk equivalent.

| Service  | Required? | Native install if you want it |
|----------|-----------|------------------------------|
| Postgres | yes       | see below                    |
| Redis    | no        | Memurai (Windows) / `redis-server` (mac/linux) |
| Garage (S3) | no    | `garage -c garage.toml server` (single Rust binary) |
| ClamAV   | no        | clamav.net Windows installer / `apt install clamav-daemon` |
| LiveKit  | no        | github.com/livekit/livekit/releases (single binary) |

What "no" means in practice:

- **No Redis** → gateway uses an in-process EventEmitter (single replica
  only); upload pipeline runs in the API process; the worker daemon exits
  immediately because there's nothing for it to do.
- **No object storage** → files written to `./data/storage/<bucket>/<key>`,
  served back through the API at `/api/_local-files/...`.
- **No ClamAV** → upload virus scan is skipped; magic-byte checks and
  extension blocking still run.
- **No LiveKit** → voice/video routes return HTTP 503; chat/dice/handouts
  all keep working.

## Postgres

> Tavern uses the `pg_trgm` extension for full-text message search. It ships
> with stock Postgres 16+; the migration enables it automatically. If your
> distribution splits out `postgresql-contrib`, install that alongside the
> base package.

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

## Optional: Garage (S3-compatible object storage)

Defaults to `local` mode in `.env.example`, so you don't need this unless
you want to exercise the S3 path.

[Garage](https://garagehq.deuxfleurs.fr/) is AGPL-3.0, written in Rust,
ships as a single binary, and is designed for self-hosted deployments
exactly like Tavern's. Or you can point Tavern at any other S3-compatible
service (AWS, Cloudflare R2, Backblaze B2, …) — same env vars.

1. Download the binary for your OS from
   <https://garagehq.deuxfleurs.fr/download/>.
2. Copy [`infra/garage/garage.toml.example`](../infra/garage/garage.toml.example)
   to a working directory as `garage.toml` and **regenerate the three secrets**
   at the top of the file (`rpc_secret`, `admin_token`, `metrics_token`) — the
   values in the example are dev-only. (The non-example file is git-ignored
   and produced at runtime by `scripts/garage-config.mjs` for docker mode; for
   native mode you maintain your own.)

   ```bash
   node -e "const c=require('crypto'); \
     console.log('rpc_secret=' + c.randomBytes(32).toString('hex')); \
     console.log('admin_token=' + c.randomBytes(32).toString('base64')); \
     console.log('metrics_token=' + c.randomBytes(32).toString('base64'));"
   ```

3. Start the server:

   ```bash
   garage -c ./garage.toml server
   ```

4. Bootstrap the cluster (one-time). Equivalent commands to what
   `pnpm garage:bootstrap` runs in docker mode:

   ```bash
   NODE_ID=$(garage node id -q | head -1 | cut -d'@' -f1)
   garage layout assign -z dc1 -c 1G "$NODE_ID"
   garage layout apply --version 1
   garage key import --yes -n tavern-key tavernkey tavern-dev-secret
   garage bucket create tavern-media
   garage bucket create tavern-quarantine
   garage bucket allow --read --write --owner tavern-media --key tavern-key
   garage bucket allow --read --write --owner tavern-quarantine --key tavern-key
   ```

5. Set in `.env`:

   ```
   STORAGE_BACKEND=s3
   S3_ENDPOINT=http://localhost:3900
   S3_ACCESS_KEY=tavernkey
   S3_SECRET_KEY=tavern-dev-secret
   ```

   (Note: native Garage listens on port 3900 by default. The docker
   compose file in this repo exposes that on host port 9000 for
   convenience. Pick whichever endpoint matches your install.)

   Public attachment reads go through the API's
   `/api/_attachments/<bucket>/<key>` proxy — no anonymous bucket policy
   needed.

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
