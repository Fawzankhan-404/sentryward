# Changelog

All notable changes to Sentryward are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While Sentryward is pre-1.0, minor versions may include breaking changes.

## [Unreleased]

### Added

- Replies on Sentryward's inline comments get a response in the thread.
  `/sentryward ignore false-positive|intentional [note]` ignores the finding
  with that reason and note, as the dashboard does, and is acknowledged; any
  other reply is answered once, briefly, by the review model from the finding
  and its code, with the reply passed as untrusted data. Only people who can
  push are answered, the bot never answers itself, and at most 10 replies per
  PR/MR per hour are acted on. Turned off with `triggers.replies` or the new
  "Respond to replies" switch. GitHub needs the **Pull request review
  comment** webhook event (added to new per-repository hooks; add it to the
  GitHub App's events). Replies are queued in a new `thread_replies` table and
  answered by the worker; requires a database migration.
- GitLab can be connected through OAuth ("Connect with GitLab") as well as
  with an access token, on GitLab.com or one self-hosted instance per
  deployment, configured with `GITLAB_OAUTH_HOST`, `GITLAB_OAUTH_CLIENT_ID`
  and `GITLAB_OAUTH_CLIENT_SECRET`. The flow uses PKCE and a single-use state.
  The access and refresh tokens are stored encrypted, and the access token is
  refreshed shortly before it expires, one refresh at a time per connection
  since GitLab rotates the refresh token on each use. If GitLab refuses a
  refresh, the connection shows as inactive and reviews fail asking you to
  reconnect. An OAuth connection posts as the person who signed in. Backed by
  `GET /api/connections/gitlab/oauth/start` and
  `GET /api/connections/gitlab/oauth/callback`; requires a database migration.
- The findings page breaks the false-positive rate down by category, severity
  and model, so it shows where reviews are noisy. Groups with fewer than 5
  findings are hidden, and groups at 30% or more link to the setting that would
  quiet them (the reviewed categories, the minimum confidence or severity
  floor, or the model), scoped to the repository selected on the page. The
  model is the one whose review pass raised each finding, now stored on the
  finding (existing rows are backfilled from their last run where it used a
  single model) and kept as it was once a finding is ignored, so a dismissal
  never moves to a later model. Served as `falsePositivesBy` on
  `GET /api/findings/stats`.
- A "Test model" action on each LLM connection runs one minimal generation
  against a chosen model with the stored credential, through the same path a
  review uses, and reports the response time and token usage or why it failed
  (rejected key, model not served, host unreachable, or a reply reviews cannot
  parse). The secret stays on the server. Backed by
  `POST /api/settings/api-keys/:provider/test`.
- `output.walkthrough_labels` and `output.walkthrough_blast_radius` (on by
  default, "Show labels in the summary" and "Show blast radius in the summary"
  on the Display tab) hide the labels and blast radius segments of the
  walkthrough's meta line in the summary comment and the copied markdown,
  without dropping the rest of the walkthrough. The native PR/MR labels
  (`output.blast_radius_label`, `output.effort_label`) are unaffected.
- `output.finding_counts` (on by default, "Show finding counts" on the
  Display tab) turns off the findings-count line under the verdict in the
  summary comment and the copied markdown, without dropping the rest of the
  comment.
- Static analysis results already on the forge are reported as findings,
  marked with the analyzer's name: check run annotations on GitHub (including
  CodeQL), and Code Quality and SAST reports from the head pipeline on GitLab.
  Only results on lines the change added are kept. They pass the same
  category, severity floor, dismissal and finding-limit rules as model
  findings, and where the model reported the same problem its finding is kept.
  `review.tool_findings` (on by default) turns this off, and
  `review.tool_findings_block` (off by default) lets them fail the verdict. The
  GitHub App needs the Checks (read) permission; without it, or when a report
  cannot be read, the review continues with a warning.

- Reviews triggered by a push are incremental: only files the new commits
  touched since the last completed review are reviewed again (each with its
  whole PR/MR diff), and that review's findings on the other files are carried
  over, so they stay open, still count toward the verdict and are not posted
  again. The summary comment names the reviewed commit range. A force push or
  rebase, a partial or failed last review, a comparison the forge cannot
  answer, and manual or `/sentryward review` requests all get a full review.
  `triggers.full_review_on_push` (off by default) reviews the whole change on
  every push instead.
- Review passes see the code around the diff, not just the hunks: the
  enclosing function or class and the imports of each changed file, the
  definitions of functions the diff calls, and call sites of the functions it
  changes, read at the head revision. Context only uses budget the diff left,
  never causes an omission, and a failed read only adds a warning.
  `review.file_context` (on by default) turns it off.
- Findings dismissed as a false positive or as intentional are no longer
  reported again on the same PR/MR, including after verification demotes a
  finding onto a dismissed one. Recent dismissals from the repository are also
  listed in the review prompt (bounded, and treated as untrusted text) so the
  same false positive is less likely on later PRs. "Fix later" and "not
  specified" dismissals are not used. `review.suppress_ignored` (on by default)
  turns it off, from the dashboard or `.sentryward.yaml`.
- When a change is split into several review passes, every pass gets a
  bounded list of all reviewable files with their change type, line counts and
  the walkthrough's one-line summary, so problems spanning files in different
  passes are visible. In that case the walkthrough runs before the passes
  instead of alongside them; if it fails, the passes still get the file list.
- An evaluation harness for review quality (`npm run eval` in `server/`): a
  corpus of 21 small changes in TypeScript, Python and Go with expected
  findings and known traps, reviewed with a real model and scored by file and
  line overlap. Reports precision, recall, false positives per case, tokens and
  cost to a JSON file so runs can be compared. Not part of `npm test` or CI.
  Single-pass reviews are unchanged.

### Fixed

- Secrets stored under a previous `ENCRYPTION_KEY` no longer cause raw crypto
  errors or 500s. API keys are still listed, shown as "Unreadable" with a
  "Re-enter key" badge, and checking or listing models for one returns a 409
  asking to re-enter it. Forge connections with an unreadable token show as
  revoked and ask to be reconnected. A review that needs an unreadable key
  fails with a message saying where to re-enter it. A repository whose webhook
  secret cannot be read rejects deliveries with the usual 401 and logs a
  warning; disabling and enabling the repository registers a fresh secret.

- A long-running review is no longer falsely requeued and eventually marked
  `failed` with "Worker stopped responding". The worker now refreshes a job's
  lock on a heartbeat while it runs (`WORKER_HEARTBEAT_INTERVAL_MS`), so
  stale-lock recovery only reclaims a worker that has actually gone silent, not
  a slow-but-healthy run that crossed `WORKER_LOCK_TIMEOUT_MS`; the server
  refuses to start when the heartbeat is not below the lock timeout.
  `WORKER_MAX_RUN_MS` (30 minutes by default) caps how long a review may take:
  a run past it is failed with an accurate reason and its concurrency slot is
  freed, so one stuck job cannot stall the worker. A run that loses its job,
  to that cap or to stale-lock recovery, stops and publishes nothing more, so a
  retried review is no longer posted twice.

- Reviews through a self-hosted LLM gateway behind a proxy (such as Cloudflare)
  no longer fail with an empty-message `AI_APICallError`. The proxied model path
  now streams the response instead of waiting for the whole completion, so a
  long generation keeps the connection active and does not trip the proxy's
  origin timeout (e.g. Cloudflare's 524). Behaviour on the official provider
  APIs is unchanged.

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
