# Track H — infra, scripts, e2e, tests, config

## Critical / High

**[SEC] LiveKit ships a known dev key/secret pair committed to the repo.** `infra/livekit/livekit.yaml:43`. `devkey: devsecret-change-me` — public secret in git history. Any operator who deploys LiveKit without rotating it allows anyone to self-sign valid LiveKit JWTs (token bypass, arbitrary room access). File ships as live config in the `livekit` Docker profile; no generation step replaces it (unlike `garage-config.mjs` for garage.toml). API config accepts `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` as optional but nothing enforces match with yaml. Fix: add `scripts/livekit-config.mjs` parallel to garage-config, or startup check in API refusing to issue tokens when key matches placeholder.

**[SEC] Verify `infra/garage/garage.toml` is gitignored.** `infra/garage/garage.toml:27,41,42` — has hardcoded RPC secret, admin token, metrics token. If tracked, these are in git history. The `garage-config.mjs` regeneration protection is bypassed if the file is committed. **Action: run `git ls-files infra/garage/garage.toml` to confirm.**

**[SEC] Federation env vars missing from `.env.example`.** `FEDERATION_ENABLED`, `FEDERATION_PRESENCE_ENABLED`, `TAVERN_DATA_KEY` absent from `.env.example`. `TAVERN_DATA_KEY` is required in prod when `FEDERATION_ENABLED=true`; no documented path to set it.

**[PERF/BUG] Worker has no healthcheck in compose; no `EXPOSE`/`HEALTHCHECK` in Dockerfile.** `infra/docker/docker-compose.yml:178-207`, `apps/worker/Dockerfile`. Stuck worker (BullMQ connection loss, unhandled rejection) won't be detected. `restart: on-failure` only fires on non-zero exit.

**[SEC] `@typescript-eslint/no-floating-promises` not enabled.** `eslint.config.mjs`. Catches async whose rejections are silently swallowed — common source of crashes in Fastify handlers and BullMQ processors. Requires `parserOptions.project` for type-aware linting. Add as `'warn'` with project path configured.

## Medium

**[STYLE] HSTS `stsPreload: false` in Traefik dynamic config.** `infra/traefik/dynamic.yml:40`. `stsIncludeSubdomains: true` but `stsPreload: false`. Preload won't work without `preload` directive.

**[DOC] Traefik / nginx contradict each other on CSP ownership.** `infra/traefik/dynamic.yml:32-34` says CSP left to upstream nginx; nginx (per prior review) says Traefik owns HSTS+CSP. Actual Traefik config has no CSP header — gap for Traefik-only deployments. Resolution: add CSP to dynamic.yml, OR fix the comment to say nginx upstream is required.

**[STYLE] `livekit/livekit-server:latest` image pinned to `:latest`.** `infra/docker/docker-compose.yml:232`. All other images pinned. Pin LiveKit to specific version.

**[DOC] `scripts/migrate-tokens.mjs` is legacy.** Migration done; ESLint rule enforces. Not referenced in package.json scripts. Flag for deletion or add "Migration complete — historical reference only" header.

**[STYLE/PERF] No combined CI target in root `package.json`.** No `"ci": "pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm build"`. Each step runnable individually; no single chain.

**[SEC] `OIDC_AUTO_LINK_BY_EMAIL=true` default documented in `.env.example:199`.** Comment accurately describes risk. Default should be `false` with note that single-IdP can enable.

**[PERF] Caddyfile (federation testbed) does not forward `X-Forwarded-*` headers.** `infra/docker/federation/Caddyfile`. Caddy v2.6+ forwards by default, but no explicit `header_up` / `trusted_proxies`. If API's `TRUST_PROXY` requires header, Caddy version bump could break IP attribution silently.

## Low / nits

**[STYLE] `eslint.config.mjs` ignores all `*.config.{js,cjs,mjs,ts}`.** `eslint.config.mjs:15`. `with-env.mjs`, `garage-bootstrap.mjs`, vite/playwright configs all excluded.

**[STYLE] `@typescript-eslint/no-explicit-any` and `react-hooks/exhaustive-deps` are `warn`, not `error`.** `eslint.config.mjs:35,48`. Promote to `error` if codebase is currently clean.

**[STYLE] Worker Dockerfile lacks `EXPOSE`.** Minor; add `# no inbound port` comment.

**[DOC] `gen-certs.sh` uses RSA-2048 for leaf, RSA-4096 for CA — inconsistent.** `infra/docker/federation/gen-certs.sh:17`. Fine for testbed; consider ECDSA P-256.

**[DOC] No unit tests for `link-preview-service.ts` (SSRF) or `oidc-service.ts` (email collision).** Pass 1 added these fixes; neither has dedicated test. Propose: SSRF test rejecting `http://127.0.0.1/`, `http://169.254.169.254/`, `file://`; OIDC test for `OIDC_AUTO_LINK_BY_EMAIL=false` path.

**[DOC] `federation-peering.spec.ts` E2E is a stub.** `e2e/tests/federation-peering.spec.ts:15`. Body is `expect(true).toBe(true)` behind `FEDERATION_E2E=1` gate. Implement a real scenario.

**[DOC] `tsconfig.base.json` has `skipLibCheck: true` with no rationale comment.** Common suppression; add explicit note.

## Notes

- Pass 1 fixes verified: `garage-bootstrap.mjs` has `assertSafeArgValues` + `assertDevOnly`. `garage-config.mjs` refuses fallback to committed dev values in non-dev. `with-env.mjs` has shell-metachar check on `cmd`.
- `garage.toml` git-ignore status is the most urgent verification.
- `garage-config.mjs` has no arg-validation equivalent — doesn't shell out, uses `readFileSync`/`writeFileSync` string replacement; no arg-injection surface.
- Dice parser adversarial coverage is solid in `packages/shared/test/dice.test.ts`.
- Federation replay protection tested: `test-integration/federation-inbound.test.ts:620` covers double-POST → 409 with nonce dedup.
