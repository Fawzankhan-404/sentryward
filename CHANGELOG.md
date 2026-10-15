# Changelog

All notable changes to Sentryward are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While Sentryward is pre-1.0, minor versions may include breaking changes.

## [Unreleased]

### Fixed

- A partial or failed review with no findings no longer shows the reassuring
  "Nothing in this change needs attention." empty state. It now says review
  coverage was incomplete, so incomplete runs are not mistaken for all-clears.

## [0.1.0] - 2026-10-13

First stable release. Sentryward remains pre-1.0; minor releases may include
breaking changes. AI findings still need human verification.

### Added

- Instance admins. The first account on an empty install becomes the admin (on
  an existing install, the oldest account does). Admins manage users from the
  **Users** page, promote or demote other admins, and create instance invites.
  An instance always keeps at least one admin.
- `REGISTRATION_MODE` (`open`, `invite` or `closed`) controls who can create an
  account. The first account is always allowed. The login page hides its
  sign-up link unless registration is open or the instance has no accounts.
- Invite links that work once and expire after 7 days, optionally limited to one
  email. Tokens are stored only as hashes. With `SMTP_URL` and `MAIL_FROM` set,
  invites are emailed, and resending one rotates its link and renews its expiry.
- Team workspaces with their own forge connections, repositories, reviews,
  findings, global review config and LLM keys. Members have an `owner`, `admin`
  or `member` role: admins manage settings and members, and only owners grant,
  revoke or hold ownership. A team always keeps at least one owner.
- Team invites, accepted by existing users or used to register a new account,
  and adding existing accounts to a team directly from a searchable picker.
- A workspace switcher in the sidebar, a **Team** page (`/workspace`) with
  members, pending invites and settings, and a **User Management** sidebar group.
- Profile pictures, shown across the dashboard and in member lists.
- A production deployment path: one image (`ghcr.io/rdlugs/sentryward`, built
  from `docker/Dockerfile`) that runs the API, serves the built dashboard and
  runs the worker; `docker-compose.prod.yml` with an unpublished database and a
  loopback-only API port for a TLS reverse proxy; `.env.production.example`; and
  a README "Deploying" section. Release tags publish the image to GHCR for
  `linux/amd64` and `linux/arm64`. The worker takes the `WORKER_*` settings
  from the env file and gets up to `WORKER_STOP_GRACE_PERIOD` (15 minutes by
  default) to finish in-flight reviews when stopped or upgraded.
- `STATIC_DIR` serves a built client from the API, and `TRUST_PROXY` sets
  Express's trusted proxy hops so rate limits see client addresses behind a
  reverse proxy.

### Changed

- Dashboard routes load on demand to reduce the initial JavaScript bundle. A
  failed route download offers a reload so the dashboard can recover after an
  upgrade.
- **Bammy is now Sentryward**, with a new logo. Every identifier changed with the
  name and there are no fallbacks:
  - the repository config file is `.sentryward.yaml` (or `.sentryward.yml`);
    rename any `.bammy.yaml`.
  - the comment command is `/sentryward review`.
  - the commit status is `sentryward/review`; update branch protection rules
    that required `bammy/review`.
  - hidden comment markers are `<!-- sentryward:... -->`, so the first review of
    a PR reviewed before the rename posts a fresh summary and inline comments
    instead of editing the old ones.
  - the session cookie is `sentryward_token`, so everyone signs in again once.
  - the Docker Compose project and default Postgres user/database are
    `sentryward`, so a local install starts with a new, empty database volume.
- Existing connections, LLM keys and global review configs move into each user's
  new personal workspace, so nothing changes for single-user installs.
- API requests choose a workspace with the `x-sentryward-workspace` header. Without
  it they act on the caller's personal workspace, so existing scripts keep
  working. The GitHub App install link takes `?workspace=` instead.
- `WORKER_USER_CONCURRENCY` now limits running reviews per workspace rather than
  per user.
- Switching workspaces clears the dashboard's cached data, so nothing from one
  team shows in another.

### Security

- Deleting an account locks the team memberships involved, so two owners leaving
  at the same moment cannot leave a team without an owner.
- Adding a team member by email, and the add-member picker, show team admins
  which emails have accounts on the instance. This is deliberate, so existing
  users can be added in one step.
- KaTeX, which Mermaid diagrams use for math, is pinned to 0.18.x for
  [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7).
  Mermaid still requires 0.16.x, so the client overrides it.

## [0.1.0-alpha.2] - 2026-10-05

### Security

- Forge requests now stay on the connection's own host. Pagination links and
  redirects that point elsewhere are refused, so a self-hosted forge can no
  longer steer the server, with its access token, to internal addresses that
  the production host check is meant to block.

### Added

- Rate limits for the API (600 requests per minute per user, or per address
  before sign-in) and for webhooks (300 per minute per address).

### Fixed

- Text containing backslashes before a pipe no longer loses characters in the
  summary comment's tables.

## [0.1.0-alpha.1] - 2026-10-05

First public alpha.

### Added

- Review engine: diff parsing, language detection, ignore globs, token-budgeted
  chunking, concurrent review passes, an optional walkthrough, finding validation,
  severity and verdict, and fingerprints that dedupe findings across runs.
- Review worker with a PostgreSQL-backed job queue, per-user concurrency limits,
  and stale-lock recovery.
- GitHub (via a GitHub App) and GitLab (including self-hosted) forge connections.
- Publishing to the forge: inline comments with suggestions, a single summary
  comment with agent prompts, and a `sentryward/review` commit status, each step
  independent.
- Review triggers: manual review by URL or from a picker of open changes, re-runs,
  webhooks, and `/sentryward review` comments.
- Layered review configuration: trigger overrides, `.sentryward.yaml` from the base
  revision, dashboard repository settings, profiles, and defaults, with per-field
  source tracking.
- Model providers Anthropic, OpenAI, and Google, plus custom endpoints and Ollama.
  LLM connections verify stored keys.
- Dashboard: home overview, reviews list, review detail with a live forge preview,
  repository and connection management, findings management, duration and
  false-positive stats, account settings, and a density setting.
- Markdown and JSON review output through the API.
- Open-source project files: MIT license, third-party notices, contributing guide,
  code of conduct, security policy, issue and pull request templates, and a
  Docker-based GitHub Actions CI workflow.

### Security

- Passwords are hashed with Argon2id. Authentication uses an httpOnly JWT cookie.
- Forge tokens, webhook secrets, and model API keys are encrypted at rest with
  AES-256-GCM.
- `NODE_ENV=production` enables secure cookies and HTTPS/public-address checks for
  self-hosted forge hosts.
- Dependency audit: server findings in the Prisma toolchain are fixed through npm
  overrides. Client findings in shadcn build tooling are accepted for this alpha
  (see [the release checklist](docs/RELEASE_CHECKLIST.md)).

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities and deployment
boundaries.

### Known limitations

- Alpha software: features, configuration, and the API may change.
- AI findings need human verification and can miss problems or report false
  positives.
- The Docker Compose setup is for development, not public production hosting.
- Registration is open, with no invitation gate.

[Unreleased]: https://github.com/rdlugs/sentryward/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/rdlugs/sentryward/compare/v0.1.0-alpha.2...v0.1.0
[0.1.0-alpha.2]: https://github.com/rdlugs/sentryward/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/rdlugs/sentryward/releases/tag/v0.1.0-alpha.1
