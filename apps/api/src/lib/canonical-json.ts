// Moved to @tavern/federation so the background worker can share the same
// canonical-JSON implementation. This shim keeps existing imports working —
// new code should prefer importing from '@tavern/federation' directly.
export { canonicalize } from '@tavern/federation';
