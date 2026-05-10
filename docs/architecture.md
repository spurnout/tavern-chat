# Architecture

Tavern follows a service split inspired by Discord:

- **REST API** — durable resources (auth, servers, channels, messages, uploads,
  campaigns, board games, moderation). Owned by `apps/api`.
- **WebSocket Gateway** — realtime fanout of state changes. Implemented inside
  `apps/api` at `/gateway`.
- **Realtime media** — voice/video rooms run on **LiveKit**. The API only
  issues short-lived join tokens; the browser talks to LiveKit directly.
- **Background workers** — BullMQ + Redis, in `apps/worker`. Owns the upload
  pipeline (validate → scan → finalize), media post-processing (sharp /
  ffprobe / waveform), and scheduled maintenance.

```
┌────────┐  fetch / WS    ┌──────────────┐
│ web    │ ──────────────▶│  api         │
│ (Vite) │                 │  Fastify     │
└────────┘                 │  + Gateway   │
     │                     └──────┬───────┘
     │                            │ Prisma
     │                            ▼
     │                     ┌──────────────┐
     │                     │ Postgres     │
     │                     └──────────────┘
     │                            ▲
     │   LiveKit ws/RTC          │ BullMQ
     ▼                            │
┌──────────┐  audio/video  ┌──────┴───────┐
│ LiveKit  │ ◀────────────▶│ worker       │
└──────────┘                │ (BullMQ)     │
                             └──────┬───────┘
                                    │ scan
                                    ▼
                             ┌──────────────┐
                             │ ClamAV       │
                             └──────────────┘
                              │
                              ▼
                        ┌──────────────┐
                        │ MinIO        │
                        └──────────────┘
```

## Why this split?

- **REST + WS over the same Fastify instance** keeps deployment simple. Only
  one TLS endpoint to expose, only one auth path. The gateway sub-mounts at
  `/gateway` and shares the JWT verification code.
- **LiveKit handles media so we don't.** Audio/video routing, NACK, jitter
  buffering, and TURN are all hard problems. LiveKit is open-source, runs
  self-hosted, and we only have to manage tokens.
- **Workers off the request path.** Upload validation and ClamAV scanning are
  slow and untrusted. We do them in BullMQ jobs and let the API stay snappy.

## Data flow: posting a message with an image

1. Browser uploads image: `POST /api/uploads` returns presigned PUT URL.
2. Browser PUTs the bytes directly to MinIO.
3. Browser calls `POST /api/uploads/:id/complete`.
4. API enqueues `tavern.upload.validate` and `tavern.upload.scan` jobs.
5. Worker validates magic bytes / ClamAV scans the object. On success it
   records `status = ready`, generates a thumbnail, optional waveform.
6. Browser sends `POST /api/messages` referencing the attachment id. The API
   refuses to attach anything not in `ready`/`uploaded` state.
7. The Gateway broadcasts `MESSAGE_CREATE` to every connected member with
   `VIEW_CHANNEL` permission for that channel.

## Hot-path correctness rules

- **Permissions are computed from authoritative state at every check.** We do
  not trust JWT-embedded role claims — roles change too often.
- **Hidden channels never appear in API responses or Gateway dispatches.** The
  permission resolver runs *before* serialization and the gateway broadcaster
  filters per-recipient.
- **Quarantined attachments do not produce thumbnails or public URLs.** They
  live in a separate bucket with restrictive ACLs.
- **Realtime events carry sequence numbers** so clients can detect drops and
  re-sync via REST.

## See also

- [permissions.md](permissions.md)
- [api.md](api.md)
- [safety.md](safety.md)
- [tabletop.md](tabletop.md)
- [deployment.md](deployment.md)
- [roadmap.md](roadmap.md)
