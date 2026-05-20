/**
 * @tavern/federation — primitives shared between the API process and the
 * background worker. Holds:
 *
 *   - ed25519 / canonical-json / at-rest helpers
 *   - FederationKeyStore (instance keypair)
 *   - UserKeyStore (per-user keypair)
 *   - buildTwoLayerMessageEnvelope / verifyTwoLayerMessageEnvelope
 *   - assertValidPeerHost (SSRF guard)
 *   - dispatchOutboxJob (the actual outbound POST)
 *
 * The api re-exports each symbol at its old path (apps/api/src/lib/*,
 * apps/api/src/services/*) so existing test files and call sites compile
 * without churn. New code should prefer this import root.
 */

export { canonicalize } from './canonical-json.js';
export {
  generateKeyPair,
  sign,
  verify,
  exportPublicKeyRaw,
  publicKeyFromRaw,
  exportPrivateKeyPkcs8,
  privateKeyFromPkcs8,
  type Ed25519Pair,
} from './ed25519.js';
export { encryptAtRest, decryptAtRest } from './at-rest.js';
export {
  FederationKeyStore,
  type FederationKeyStoreOptions,
} from './federation-keys.js';
export {
  UserKeyStore,
  type UserKeyStoreOptions,
  type LoadedUserKey,
} from './user-keys.js';
export {
  buildTwoLayerMessageEnvelope,
  verifyTwoLayerMessageEnvelope,
  type TwoLayerSignedEnvelope,
  type BuildTwoLayerInput,
  type TwoLayerVerifyInput,
  type TwoLayerVerifyResult,
} from './federation-message-signing.js';
export { assertValidPeerHost } from './ssrf-guard.js';
export {
  dispatchOutboxJob,
  FederationOutboxPermanentError,
  type FederationOutboxJob,
  type DispatcherDeps,
} from './outbox-dispatcher.js';
