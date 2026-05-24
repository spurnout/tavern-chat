# Track G — packages/* (shared, db, media, federation)

## Critical / High

**[SEC] `ALLOW_UNSCANNED_UPLOADS` defaults to `true` in both api and worker configs.** `apps/api/src/config.ts:72`, `apps/worker/src/config.ts:17`. Production guard fires only when `NODE_ENV=production` AND `ALLOW_UNSCANNED_UPLOADS=true` AND `CLAMAV_HOST` unset. Operator who sets `NODE_ENV=production` with unreachable `CLAMAV_HOST` still launches and passes uploads through unscanned once the socket fails. Default itself is `'true'`. Fix: change default to `'false'` in both configs.

**[BUG] `dice/template.ts:86` — `stat.value` injected verbatim into dice notation without validation.** `packages/shared/src/dice/template.ts:86`. When `opts.system === 'generic'`, template expander replaces `{stats:label}` with `stat.value` directly (raw string from character sheet). Length check in `parseDiceNotation` is on the **template** string, not the **expanded** string. Template `"{stats:atk}"` (11 chars) can expand to an arbitrarily long dice expression. Fix: validate expanded string length before `parseDiceNotation`.

**[SEC] `local.ts` — `putObject` writes files with default OS umask (typically 0644) instead of 0600.** `packages/media/src/storage/local.ts:177`. `writeFileSync(target, body)` uses process umask. On shared systems, group-readable. Fix: `writeFileSync(target, body, { mode: 0o600 })`. Streaming path (`acceptUpload` via `createWriteStream`) same gap.

## Medium

**[BUG] `scanner.ts` — single timeout covers connect + transfer; no inactivity timeout between chunks.** `packages/media/src/scanner.ts:54-59`. `timeoutMs` (default 30s) starts before TCP connect. For large files, fires during transfer rather than reset per chunk. If clamd stalls mid-stream, `sock.write()` doesn't error — promise hangs until single deadline. Use `sock.setTimeout()` for inactivity.

**[BUG] `scanner.ts` — empty clamd response resolves as `{clean: false}` without `reject`.** `packages/media/src/scanner.ts:111-119`. Empty response (network issue, version mismatch) → `clean: false` with no signature. Calling worker treats as dirty file and quarantines. Safe-side failure but silent false-quarantines. Detect empty-response and reject so caller can fall back to `allowUnscanned`.

**[BUG] `User.remoteInstanceId` has no `@@index` in the `User` model.** `packages/db/prisma/schema.prisma` (User). `RemoteUser` has `@@index([remoteInstanceId])` (line 2479) but `User` does not. Querying `User` by `remoteInstanceId` (peer revocation, finding all users from instance) does sequential scan. Add index.

**[PERF] `local.ts:getPartialObject` reads entire file to return `length` bytes.** `packages/media/src/storage/local.ts:165-167`. `const buf = await readFile(...)` then `buf.subarray(0, length)`. 200MB video → 200MB into memory for 16-byte magic-byte sniff. Use `fs.open` + `fs.read` with bounded buffer.

**[BUG] `s3.ts` — no multipart-upload abort on cancellation.** `packages/media/src/storage/s3.ts`. Large objects use multipart internally. Cancellation leaves orphaned parts billable. Application-level fix: document bucket lifecycle rule for `AbortIncompleteMultipartUpload`. Not mentioned in deployment.md or production-hardening.md.

**[BUG] `dice/template.ts:86` — injected stat values cause confusing parse errors exposing sheet content.** `packages/shared/src/dice/template.ts:86`. `"1d6 kh 1 + garbage"` → `DiceParseError` text contains stat content. Sanitise stat values (digits + `+-` only) before substitution.

**[?] `canonical-json.ts` — `undefined` inside arrays → `null` (line 31); `undefined` inside object values → omitted (line 36).** `packages/federation/src/canonical-json.ts:31,36`. Intentional/JCS-correct. Subtle API contract: callers building envelopes must normalize `undefined` to `null` before canonicalize, not rely on key omission. Document in JSDoc + callers.

## Low / Nits

**[STYLE] `slash/registry.ts` no collision detection between built-in and plugin commands.** `packages/shared/src/slash/registry.ts`. Static constant today — no plugin registration API exists. If one is added later, make first-vs-last-wins policy explicit.

**[DOC] `npc-generator.ts` output is fixed 7-field `GeneratedNpc` — no unbounded output.** Clean.

**[DOC] `at-rest.ts` nonce reuse audit — clean.** Two callers in `federation/src` (`user-keys.ts:56`, `federation-keys.ts:58`); both `encryptAtRest` once with unique plaintext.

**[DOC] `permissions.ts` bit-64 empty gap is safe.** `PERMISSION_ALL` OR of defined flags; highest bit 62 (ADMINISTRATOR). Unused bits 51-61 zero. `Decimal(20,0)` round-trip safe up to `2^63-1`.

**[DOC] `migration 20260522220000_schema_drift_repair` is idempotent.** `IF NOT EXISTS` on all `ADD COLUMN` / `CREATE INDEX`. `DO $$ … IF NOT EXISTS` for FK constraints. `ALTER ENUM … ADD VALUE IF NOT EXISTS`. Safe to replay.
