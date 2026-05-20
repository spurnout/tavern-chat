// Moved to @tavern/federation so the background worker can share the same
// ed25519 helpers. This shim keeps existing imports working — new code should
// prefer importing from '@tavern/federation' directly.
export {
  generateKeyPair,
  sign,
  verify,
  exportPublicKeyRaw,
  publicKeyFromRaw,
  exportPrivateKeyPkcs8,
  privateKeyFromPkcs8,
  type Ed25519Pair,
} from '@tavern/federation';
