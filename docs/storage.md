# Storage backends

Tavern stores user-uploaded media (images, voice messages, attachments,
export zips, server backups) through an abstract `StorageBackend`. Two
backends ship in the box; a third — "operator adapter" — is documented for
self-hosters who need to point Tavern at something more exotic.

## Built-in: local

Default. Files land under `LOCAL_STORAGE_DIR` (default `./data/storage`)
and Tavern's API serves them via authenticated routes.

```
STORAGE_BACKEND=local
LOCAL_STORAGE_DIR=./data/storage
```

Use this for native-mode dev and for single-host self-hosts that don't need
horizontal scale. The bucket structure mirrors the S3 layout (main bucket +
quarantine bucket) so a later switch to S3 is a config flip.

## Built-in: S3-compatible

Any service that speaks the S3 protocol works. That includes a much wider
set than just AWS:

| Service          | Endpoint hint                                   | Notes |
|------------------|--------------------------------------------------|-------|
| **AWS S3**       | `https://s3.<region>.amazonaws.com`             | The canonical one. |
| **Cloudflare R2**| `https://<account>.r2.cloudflarestorage.com`    | Egress-free; sign with `auto` region. |
| **Backblaze B2** | `https://s3.<region>.backblazeb2.com`           | Cheap, S3-compatible. |
| **Wasabi**       | `https://s3.<region>.wasabisys.com`             | Flat-fee pricing. |
| **DigitalOcean Spaces** | `https://<region>.digitaloceanspaces.com` | DO's S3 offering. |
| **Garage**       | (local) `http://garage:3900`                    | Tavern's docker-compose default. |
| **MinIO**        | (local) `http://minio:9000`                     | Drop-in S3 you can run yourself. |
| **SeaweedFS**    | (local) `http://seaweedfs:8333`                 | Tiered storage you can run yourself. |

Set:

```
STORAGE_BACKEND=s3
S3_ENDPOINT=...        # full URL, no trailing slash
S3_REGION=us-east-1
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
S3_BUCKET=tavern-media
S3_QUARANTINE_BUCKET=tavern-quarantine
S3_USE_SSL=true
```

The API + worker share the same config. Garage's bootstrap helper
(`scripts/garage-config.mjs`) writes the four secrets into your `.env`
on first run; for cloud S3 you fill them in manually.

## "But I want Nextcloud / Dropbox / iCloud" — the adapter pattern

Tavern only talks S3. For services that don't natively expose an S3
endpoint, run a small adapter that speaks S3 to Tavern and the target API
to the storage. Several open-source options:

- **MinIO Gateway** — was the canonical S3 ↔ Anything bridge. Deprecated
  upstream but still works for legacy installs.
- **rclone serve s3** — `rclone serve s3 --vfs-cache-mode full nextcloud:`
  exposes an `rclone` remote as an S3 endpoint Tavern can hit. Works with
  ~70 backends including Dropbox, Google Drive, Nextcloud (WebDAV),
  OneDrive, Box, pCloud, Mega, and S3-of-S3 chaining.
- **JuiceFS / Garage / SeaweedFS** — full distributed filesystems with S3
  frontends; deploy one of these in front of whatever block / object store
  you already run.

Once the adapter is running, point Tavern at it via the `STORAGE_BACKEND=s3`
config block above. From Tavern's perspective, it's just S3.

### When to NOT use an adapter

If you only need durability and aren't tied to a specific brand, the
purpose-built S3-compatible services in the table above are simpler:
B2/Wasabi for cheap warm storage, R2 if you want zero egress fees, AWS S3
if you're already in AWS.

## Future direction: native non-S3 backends

A native `StorageBackend` implementation for any single non-S3 service
(Dropbox, Nextcloud WebDAV, Google Drive) is a future addition. The
abstract `StorageBackend` class (`packages/media/src/storage/types.ts`)
defines the contract — `presignPut`, `getObject`, `putObject`,
`copyObject`, `removeObject`, `getPublicUrl`, etc. A native backend
would skip the rclone hop at the cost of one-implementation-per-service.

If you have a strong case for a specific native backend (volume of users
served, regulatory requirement, etc.), open an issue. The adapter pattern
above is the recommended path until then — it's been load-tested in
production by thousands of self-hosters and adds one easily-monitored
process to the stack.

## Operational notes

- **Bucket names** — main + quarantine are configured independently
  (`S3_BUCKET` / `S3_QUARANTINE_BUCKET`). Both must exist; the Garage
  bootstrap script creates them, the cloud-S3 path expects you to.
- **CORS** — the browser uploads to presigned URLs, so the bucket's CORS
  policy must allow `PUT` from your `ALLOWED_ORIGINS`. AWS, R2, B2 all
  expose this in their consoles.
- **Public URLs** — by default Tavern proxies reads through
  `/api/attachments/:id` so attachments stay behind auth. If you flip a
  bucket to public-read, the proxy still works; the URL just becomes a
  redirect. Best practice is keep buckets private.
- **Quarantine flow** — the ClamAV worker moves infected uploads from the
  main bucket to the quarantine bucket. Operators should retain
  quarantined objects until they've reviewed them; the moderation queue
  surfaces references back to the original attachment row.

## Migrations between backends

There's no built-in `tavern storage migrate` command yet. To move from
`local` → `s3`:

1. Stop the API + worker.
2. `aws s3 sync ./data/storage/tavern-media s3://<your-bucket>/`
   (and `tavern-quarantine` to the quarantine bucket).
3. Flip `STORAGE_BACKEND=s3` + fill in the S3_* env vars.
4. Restart. The DB rows already carry `storageBucket`/`storageKey` per
   attachment, so the references stay valid.

`s3` → `s3` (e.g. AWS → R2) is similar: copy with `aws s3 sync` or
`rclone copy`, then flip the endpoint.
