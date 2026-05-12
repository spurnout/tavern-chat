# Security policy

Thanks for helping keep Tavern's users safe.

## Reporting a vulnerability

**Please do not file public GitHub issues for security reports.** Open a
private security advisory on the Tavern repository or email
`security@tavern.invalid` (replace with the operator-of-record address for
your fork). We aim to:

- acknowledge new reports within **3 business days**
- triage and confirm or close within **10 business days**
- ship a fix within **30 days** for High/Critical severity, or coordinate a
  longer window with the reporter if needed

When you report, please include:

- a description of the issue and its impact
- a minimal reproduction (steps, request samples, repo commit SHA)
- the version / commit you tested against
- your preferred coordination timeline

We follow [coordinated disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure):
no public disclosure until a fix is available and operators have had a
reasonable window to upgrade.

## In scope

- The Tavern API (`apps/api`)
- The Tavern Worker (`apps/worker`)
- The Tavern Web client (`apps/web`)
- Shared packages (`packages/*`)
- Default infrastructure templates (`infra/*`) — when followed verbatim

## Out of scope

- Self-hosted misconfigurations that ignore [docs/production-hardening.md](docs/production-hardening.md)
- Third-party dependencies — please report those upstream
- Social-engineering attacks on operators or contributors

## Recognition

Reporters who follow this policy are credited in the release notes for the
fix unless they ask to remain anonymous.
