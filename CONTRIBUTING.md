# Contributing to Tavern

Glad you're here. Tavern is a small, focused project; the contribution path
is correspondingly lean.

## Workflow

1. Open an issue describing what you want to change before opening a PR for
   anything non-trivial. Bug fixes can skip this step.
2. Fork, branch from `main`, and open a draft PR early if it helps.
3. Make sure the gate passes locally:

   ```
   pnpm install
   pnpm db:generate
   pnpm typecheck
   pnpm lint
   pnpm test
   ```

4. Add tests for new behaviour. The test layout is documented in
   [docs/architecture.md](docs/architecture.md).
5. Update the relevant docs in `docs/` when you change user-visible
   behaviour, env vars, or the API surface.

## Code style

- TypeScript strict mode everywhere; no `any` without a justifying comment.
- Tailwind semantic tokens only — see [`docs/design-system.html`](docs/design-system.html).
- Voice & copy: "tavern" / "room" / "pull up a chair" — never
  "server" / "channel" / "join" in user-facing strings.
- Sentence case for headings, labels, and buttons.
- Don't add comments that just restate the code. Comments explain the
  non-obvious WHY.

## Commit messages

Conventional Commits with a short body. Reference any closed finding IDs
from the review (`SEC-001`, `PERM-002`, etc.) when applicable.

```
fix(auth): tighten lockout decay (SEC-006)

Counter no longer resets to zero on threshold hit; only a successful
login clears it.
```

## Pull request review

PRs need at least one approval. Larger refactors should be split into
reviewable commits.

## Code of conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). By participating you agree to
abide by it.

## Security

See [SECURITY.md](SECURITY.md). Don't open public issues for security
problems.
