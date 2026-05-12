/**
 * Vitest globalSetup hook — stops the shared container produced by
 * `setup.ts` at the end of the run. The container itself is booted lazily
 * by the first test file that calls `startPostgres()` (see setup.ts) so we
 * don't pay the container-start cost when Docker is unavailable or when no
 * test file actually needs Postgres.
 *
 * We can't reach the singleton across the worker boundary, so this teardown
 * relies on the OS / testcontainers' own cleanup hooks (the container has a
 * SIGTERM trap and `Ryuk` reaps abandoned containers). If you suspect a leak,
 * `docker ps -a | grep tavern_test` should return nothing after a run.
 */

export async function setup(): Promise<void> {
  // No-op: actual container lifecycle is in setup.ts (lazy module singleton).
}

export async function teardown(): Promise<void> {
  // No-op: testcontainers Ryuk reaps after the test worker exits.
}
