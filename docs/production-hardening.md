# Production hardening checklist

Before exposing a Tavern instance to anyone other than yourself, walk through
this list. Items are ordered by impact.

> Tavern can run two ways:
>
> 1. **All-native**: just Postgres, plus the api/worker/web Node processes.
>    Storage on disk, queues in-process, gateway in-process. Single replica.
>    Suitable for personal / small-group instances.
> 2. **With Redis + S3 + (optional) ClamAV + LiveKit**: scales horizontally,
>    media is in object storage, scans run on a real ClamAV daemon.
>    Suitable for community-size instances.
>
> Both paths share most of this list. Items only relevant to path 2 are
> marked **(scaled)**.

## Secrets

- [ ] `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` are 48+ random hex bytes,
      generated with `openssl rand -hex 48`. **Different from each other.**
- [ ] `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` are freshly generated
      (`docker run --rm livekit/livekit-cli generate-keys`). Match between
      `LIVEKIT_*` env vars and `infra/livekit/livekit.yaml`'s `keys:` block.
- [ ] MinIO `S3_ACCESS_KEY` / `S3_SECRET_KEY` are not the dev defaults.
- [ ] Postgres password is not the dev default.
- [ ] `.env` is `chmod 600`.
- [ ] No secrets are baked into the docker images. Use `docker compose --env-file`
      or a secrets store; do not `COPY .env`.

## Network

- [ ] HTTPS terminates at Traefik (or another reverse proxy). The API listens
      on the internal docker network, not on the public IP.
- [ ] WebSocket upgrades on `/gateway` are forwarded with appropriate timeouts
      (≥ 60s, larger than `HEARTBEAT_INTERVAL_MS`).
- [ ] LiveKit UDP port `7882` is open from clients to the host.
      It cannot be proxied; it must reach the LiveKit container directly.
- [ ] MinIO console (`:9001`) is **not** exposed to the public.
- [ ] Postgres / Redis / ClamAV are not exposed beyond the docker network.

## Storage

- [ ] `tavern-media` and `tavern-quarantine` are separate buckets.
- [ ] The quarantine bucket has read access locked down to API service
      identities only — clients should never get a signed URL for it.
- [ ] Daily off-host backups of `tavern-media` are configured (e.g. mc mirror
      to Backblaze B2, restic, or a second MinIO instance).
- [ ] Object lifecycle: orphaned `pending` attachments older than ~24h are
      deleted nightly. This isn't built; do it via a cron + mc.

## Database

- [ ] `pg_dump` runs nightly, ships off-host, restore is tested at least once
      a quarter.
- [ ] Connection pool size matches your replica count × per-process pool.
      Default Prisma pool is 10 — tune if you run multiple API replicas.
- [ ] Prisma migrations run via `prisma migrate deploy` in deployment, not
      `migrate dev` (which is interactive).

## Trust & safety

- [ ] `ALLOW_PUBLIC_REGISTRATION=false`. Use invites.
- [ ] `ALLOW_UNSCANNED_UPLOADS=false`. ClamAV must run before promoting an
      attachment to `ready`.
- [ ] `BLOCK_EXECUTABLE_UPLOADS=true`, `BLOCK_ARCHIVE_UPLOADS=true` unless
      you have a specific need for a community to share archives.
- [ ] `STRIP_IMAGE_METADATA=true`.
- [ ] At least one user has `isInstanceAdmin = true` and an MFA-protected
      email (Tavern itself doesn't ship MFA — protect it via your IdP if
      that's a hard requirement).
- [ ] Operators have practiced the CSAM workflow once: receive report,
      quarantine, lock account, file a CyberTipline report. See `docs/safety.md`.

## Realtime / scaling

- [ ] If running >1 API replica, `REDIS_URL` is configured. The gateway
      auto-promotes to Redis pub/sub on startup and falls back to in-process
      with a warning if Redis is unreachable.
- [ ] Sticky sessions are NOT required — clients reconnect cleanly across
      replicas. (Verify by killing one API replica during a chat.)
- [ ] Worker has at least one replica. Two for availability.
- [ ] `BullMQ` failed jobs don't accumulate — operator alerts on
      `tavern.upload.scan` queue depth > N for > 5 minutes.

## Logging & observability

- [ ] API and worker logs ship to your log aggregator (pino-pretty is dev only;
      production should use the default JSON output).
- [ ] Audit log retention policy is documented.
- [ ] LiveKit logs are captured but not stored beyond what your privacy
      policy allows.

## Browser / CSP

Tavern's frontend is a Vite SPA served as static files. When fronting it:

- [ ] Set a strict `Content-Security-Policy` that allows: `'self'` for scripts
      and styles, the API origin for `connect-src`, the LiveKit origin for
      `connect-src` (ws/wss), and your MinIO public origin for `img-src`
      / `media-src`.
- [ ] Set `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
      `Referrer-Policy: strict-origin-when-cross-origin`, and
      `Cross-Origin-Opener-Policy: same-origin`.
- [ ] Cookies aren't currently used for auth; tokens live in `localStorage`.
      If you change that, set `Secure; HttpOnly; SameSite=Lax`.

## Updates

- [ ] Stay on supported Node 22 LTS.
- [ ] Watch for upstream advisories: pino, fastify, prisma, sharp, livekit,
      minio, ffmpeg.
- [ ] Reapply Prisma migrations and re-seed in a staging environment before
      pushing to production.

## Out of scope (read this before assuming it works)

- Tavern does **not** implement password reset email flows. If a user forgets
  their password, an instance admin must reset the `passwordHash` directly.
- There is **no** built-in MFA/SSO. Front the instance with a SSO proxy
  (Authelia, oauth2-proxy) if you need MFA.
- There is **no** ToS / privacy policy / age-gate UI. Add your own as a
  static landing page if your jurisdiction requires it.
- No GDPR data-export or right-to-erasure tooling. The schema makes this
  straightforward to build (delete cascades exist for the user → owned-rows
  graph) but it isn't packaged.
