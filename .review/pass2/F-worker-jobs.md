# Track F — Worker, Jobs, Schedulers

## Critical / High

**[SEC] REDIS_URL logged at INFO level on startup.** `apps/worker/src/index.ts:58`. `log.info({ redis: cfg.REDIS_URL }, 'tavern worker starting');` — full connection string can carry credentials (`redis://:password@host:port`). Any log aggregator retains password in plaintext indefinitely. Redact to hostname only.

**[BUG] `federation-envelope-retention` deletes without LIMIT — full-table scan + exclusive lock risk.** `apps/worker/src/index.ts:177-180`. `prisma.federationEnvelopeLog.deleteMany({ where: { receivedAt: { lt: cutoff } } })` issues a single `DELETE` with no `LIMIT`. On a busy instance that missed several daily sweeps this grows to millions of rows; Postgres holds row-level locks for the duration, WAL amplification stalls federation replication. Audit-retention job (`index.ts:119-122`) same shape. Fix: loop with `LIMIT 5000` until count === 0, yielding between batches.

**[BUG] `expired-custom-status` has an N+1 query inside the fan-out loop.** `apps/worker/src/index.ts:148-174`. Runs every 5 min. For each expired user, separate `serverMember.findMany` inside loop. 100 expired users = 101 DB round trips. Fix: single join via Prisma include.

**[BUG] Maintenance jobs have no `attempts` / `backoff`.** `apps/worker/src/index.ts:205-239`. All four `maintenanceQueue.add(...)` calls omit retry config. BullMQ default `attempts: 1` — single transient DB hiccup marks job failed permanently until next cron tick. `removeOnFail: false` keeps it in queue but never retried. Add `attempts: 3, backoff: { type: 'exponential', delay: 30_000 }`.

## Medium

**[BUG] No shutdown timeout guard — `worker.close()` can block indefinitely.** `apps/worker/src/index.ts:249-267`. `shutdown()` `Promise.all`s the closes with no deadline. Hung ClamAV scan keeps process alive past Docker's `stop_grace_period`, causing SIGKILL and BullMQ lock loss. Wrap with `Promise.race([closeAll(), sleep(8_000).then(() => process.exit(1))])`.

**[BUG] `RedisQueueClient.close()` calls `connection.disconnect()` (fire-and-forget), not `connection.quit()`.** `apps/api/src/services/queues.ts:291-295`. Worker shutdown correctly uses `connection.quit()` to flush pending commands. API-side `RedisQueueClient.close()` uses `disconnect()` — drops socket immediately, potentially abandoning in-flight `queue.add`.

**[PERF] No Postgres connection-limit tuning.** Both api + worker create `PrismaClient` with default pool. Worker runs 4+4 concurrent jobs. Two worker replicas + one api replica ≈ 30 connections. Document `?connection_limit=5` in worker DATABASE_URL.

**[BUG] Worker container has no healthcheck in docker-compose.** `infra/docker/docker-compose.yml:178-207`. api/web have `healthcheck`; worker does not. Wedged worker (Redis subscription failure with live event loop) appears healthy. Add Redis ping check.

**[?] Push-notification dispatcher referenced in route comment but does not exist.** `apps/api/src/routes/push.ts:18-20`. Comment says dispatcher lives in `apps/worker/src/push-dispatcher.ts` — file does not exist. Either planned/incomplete feature or regression. Subscriptions stored but never dispatched.

## Low / nits

**[STYLE] `mail.console` log path includes full email body (including reset/invite links).** `apps/api/src/services/mail-service.ts:67-79`. Comment acknowledges this is for dev — but should be `NODE_ENV !== 'production'`-gated, with prod fallback to `{ to, subject }`.

**[DOC] `scheduler.ts` 24h recovery window not surfaced in deployment docs.** `apps/api/src/services/scheduler.ts:143-155`. Items scheduled 25h+ out + process restart within window → silently missed.

**[STYLE] `removeOnFail: false` on maintenance jobs accumulates failed-job entries forever.** `apps/worker/src/index.ts:208,213,224,237`. Use `removeOnFail: { count: 10 }` to keep a small tail.

## Notes

- Pass 1 fix verified. `federation-outbox-worker.ts:129` — `?? Infinity` in place. Exhaustion logic sound.
- Idempotency of age-cutoff deletes is correct. Cutoff from `Date.now()`; second run sees nothing older.
- No raw user content, passwords, tokens logged in worker. Outbox logs include `peerInstanceId`, `eventType`, `messageId` — no payloads. Only credential concern is REDIS_URL.
- No push/mail worker in `apps/worker`. Mail is synchronous in API. Push dispatch is a stub.
