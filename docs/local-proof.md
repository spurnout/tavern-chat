# Full local proof

Use this lane when you want a single local command that proves the Docker-backed API and browser flows together:

```bash
pnpm proof:local
```

The command:

1. creates `.env` from `.env.example` when needed;
2. checks that Docker is installed and the daemon is running;
3. starts Postgres, Redis, Garage, ClamAV, and LiveKit with `pnpm docker:up:all`;
4. runs migrations and the seed;
5. runs `pnpm test:integration`;
6. starts `pnpm dev`, waits for the API and web app, then runs `pnpm test:e2e`.

If Docker is unavailable, the command prints an explicit `SKIPPED` message and exits without running integration or browser proof. This does not change the normal `pnpm test:integration` behavior on no-Docker machines; that suite still reports its own skip reason.

Useful environment overrides:

- `E2E_BASE_URL` changes the web URL used by Playwright. Default: `http://localhost:3030`.
- `WEB_PORT` changes the web port used by the readiness wait when `E2E_BASE_URL` is not set.
- `API_HEALTH_URL` changes the API health check URL. Default: `http://localhost:3001/healthz`.
- `FULL_PROOF_STARTUP_TIMEOUT_MS` changes the dev-stack readiness timeout. Default: `120000`.

This command does not shut down Docker services when it finishes. Use `pnpm docker:down` when you want to stop the supporting services.
