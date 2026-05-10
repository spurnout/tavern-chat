# Traefik example for Tavern

This directory holds *example* Traefik configuration for putting Tavern behind
HTTPS in self-hosted deployments. These files are **not wired into the dev
docker-compose** — they're starting points for production.

## Files

- `traefik.yml` — static config (entrypoints, providers, certs resolver)
- `dynamic.yml` — example service + router definitions for api/web/livekit
- `livekit.yml` — example WebSocket/TCP routers for LiveKit

## Adapting for production

1. Replace `tavern.example.com` with your domain everywhere.
2. Set `ALLOWED_ORIGINS` in `.env` to your real frontend origin.
3. Generate strong LiveKit keys (`docker run --rm livekit/livekit-cli generate-keys`)
   and update `infra/livekit/livekit.yaml` plus `LIVEKIT_API_KEY` /
   `LIVEKIT_API_SECRET`.
4. Open UDP `7882` on your firewall — LiveKit's TURN/UDP relay needs direct
   reachability from clients.
5. Put MinIO behind a CDN or restrict the `tavern-media` bucket to authenticated
   reads if you don't want media to be world-readable via signed URLs.
