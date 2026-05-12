/**
 * Object storage abstraction.
 *
 * Tavern uses two backends, picked at construction time:
 *
 *   S3StorageBackend    — Garage / any S3-compatible store. Real presigned
 *                          PUT URLs go directly to the storage host; GETs are
 *                          proxied via the API at `/api/_attachments/...`.
 *   LocalStorageBackend — files written to a directory on disk; "presigned"
 *                          URLs are short-lived tokens pointing back at the
 *                          API, which streams the body to disk.
 *
 * The pipeline (`runScanJob`) only depends on this interface — it doesn't
 * care which backend is in use.
 */

export * from './types.js';
export { S3StorageBackend } from './s3.js';
export { LocalStorageBackend } from './local.js';
