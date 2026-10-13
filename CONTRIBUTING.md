# Contributing to Sentryward

Sentryward is pre-1.0. Start with a focused bug report or feature proposal
before substantial changes. For questions and ideas, start a
[discussion](https://github.com/rdlugs/sentryward/discussions) explaining what you
tried and what you need. Follow the [code of conduct](CODE_OF_CONDUCT.md).
Report vulnerabilities privately using [SECURITY.md](SECURITY.md).

## Development

Install Docker with Compose, clone the repository, and follow the
[getting started instructions](README.md#getting-started). No forge or model keys
are needed for automated tests. Tests stub forge requests and model calls.

Read [CLAUDE.md](CLAUDE.md) for architecture, project conventions, and testing
helpers, and [AGENTS.md](AGENTS.md) before using a coding agent. The client is a
React SPA, the API is Express, the review engine lives in `server/src/review`, and
the worker shares the server codebase. Keep controllers thin and scope data
access to its owner. Generated shadcn components should be edited sparingly.

Source is mounted into the containers. Rebuild after dependency changes and
include the corresponding lockfile. Keep secrets and personal repository data
out of patches, logs, screenshots, and fixtures.

## Required checks

With Docker services running:

```sh
docker compose exec -T server npm test
docker compose exec -T server npm run typecheck
docker compose exec -T client npm test
docker compose exec -T client npm run typecheck
docker compose exec -T client npm run lint
docker compose exec -T client npm run build
```

Server tests apply existing migrations to the separate `sentryward_test` database.
Never point `TEST_DATABASE_URL` at a database containing data you need to keep.
Client tests use jsdom. Add focused regression coverage for behavior changes;
use existing fetch and model stubs rather than real external services.

For a schema change, edit the Prisma schema and generate a named migration inside
Docker as documented in [database changes](README.md#database-changes). Include
the migration in the proposal and explain compatibility and data consequences.
Do not rewrite migrations already applied by other contributors.

## Pull requests

- Explain the concrete problem and resulting behavior, linking the relevant issue.
- Keep the patch focused, follow surrounding code style, and update affected docs.
- Record checks run and disclose any failures or checks you could not run.
- Preserve third-party notices. Submit only code and assets you have permission to
  contribute under the project's [MIT license](LICENSE).
- Add a line under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for user-visible changes.

GitHub Actions repeats the required checks in Docker for pull requests and pushes
to `main`, using disposable development credentials. A passing client build
verifies the frontend output; it does not certify a production deployment.

Maintainers can use the [release checklist](docs/RELEASE_CHECKLIST.md) for
verification results, audit findings, and the remaining publication steps.
