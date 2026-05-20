# Federation testbed

Boots two Tavern instances behind Caddy with a local CA so HTTPS works.

## One-time setup

1. `./gen-certs.sh` — generates a local CA + per-host certs, prints two env vars.
2. Copy the printed `TAVERN_DATA_KEY_A` + `TAVERN_DATA_KEY_B` exports to your shell.
3. Add to `/etc/hosts`:

   ```
   127.0.0.1 a.tavern.local b.tavern.local
   ```

## Boot

```bash
docker compose -f infra/docker/docker-compose.federation.yml up -d
```

## Walk through the peering handshake

See `docs/federation-operations.md`.

## Teardown

```bash
docker compose -f infra/docker/docker-compose.federation.yml down -v
```
