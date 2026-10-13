<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="client/public/sentryward-logo-dark.png">
    <img src="client/public/sentryward-logo-light.png" alt="Sentryward" width="360">
  </picture>
</h1>

<p align="center">
  <b>Self-hosted AI code review for GitHub pull requests and GitLab merge requests.</b>
</p>

<p align="center">
  <a href="https://github.com/rdlugs/sentryward/actions/workflows/ci.yml"><img src="https://github.com/rdlugs/sentryward/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/rdlugs/sentryward/releases"><img src="https://img.shields.io/github/v/release/rdlugs/sentryward?include_prereleases&label=release" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#review-configuration">Configuration</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="https://github.com/rdlugs/sentryward/discussions">Discussions</a>
</p>

Sentryward is an AI code reviewer for GitHub pull requests and GitLab merge requests.
Connect repositories, choose a model provider or Ollama, and run manual or
automatic reviews with inline findings, walkthroughs, and commit statuses. The
dashboard tracks reviews and findings across runs.

> [!WARNING]
> **Sentryward is alpha software.** Features and configuration may evolve. AI findings
> need human verification and can miss problems or report false positives.
> `docker-compose.yml` is for development; to host an instance, see [Deploying](#deploying).

## Contents

- [Highlights](#highlights)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Getting started](#getting-started): [runtime environment](#docker-runtime-environment), [users and invites](#users-and-invites), [workspaces and teams](#workspaces-and-teams), [first review](#run-your-first-review), [troubleshooting](#troubleshooting)
- [Deploying](#deploying)
- [Forge connections](#forge-connections), [publishing](#publishing-to-the-forge), [automatic reviews](#automatic-reviews)
- [Review configuration](#review-configuration): [LLM connections](#llm-connections-and-custom-endpoints), [Ollama](#ollama), [`.sentryward.yaml`](#sentrywardyaml-reference)
- [API](#api)
- [Development](#development)
- [Contributing and license](#contributing-and-license)

## Highlights

- **Self-hosted, bring your own model:** Anthropic, OpenAI, Google, a compatible
  proxy on a [custom host](#llm-connections-and-custom-endpoints), or a local
  [Ollama](#ollama) model.
- **GitHub and GitLab:** a GitHub App, plus GitLab.com or self-hosted GitLab.
- **Reviews where you work:** inline findings with suggestions, one summary
  comment, and a `sentryward/review` commit status.
- **Manual or automatic:** submit a PR/MR URL, review on webhooks, or comment
  `/sentryward review`.
- **Per-repository config:** dashboard settings, overridable by a
  [`.sentryward.yaml`](#review-configuration) in the repository.
- **Findings across runs:** a later run never posts the same finding twice.
  Ignore findings as false positives, intentional, or fix later, and track the
  false-positive rate on the dashboard.
- **Teams:** share connections, repositories, reviews and model keys in team
  workspaces, with owner, admin and member roles and one-time invite links.

## Quick start

```sh
git clone https://github.com/rdlugs/sentryward.git && cd sentryward
cp .env.example .env
# set JWT_SECRET and ENCRYPTION_KEY in .env, each with: openssl rand -hex 32
docker compose up --build
```

Open http://localhost:5173, register, then follow
[Run your first review](#run-your-first-review). The full setup is in
[Getting started](#getting-started).

## How it works

The `worker` container runs review jobs: it fetches the PR/MR, resolves the review configuration, sends the diff to the configured model in one or more passes (plus an optional walkthrough), validates the findings and stores the result on the job. Model keys come from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY`, unless the repository's workspace has stored its own. The worker polls the `review_jobs` table (claimed with `FOR UPDATE SKIP LOCKED`, so several workers can run side by side); tune it with `WORKER_POLL_INTERVAL_MS`, `WORKER_CONCURRENCY`, `WORKER_LOCK_TIMEOUT_MS` and `WORKER_MAX_ATTEMPTS`.

## Getting started

Requires Docker with Compose.

```sh
cp .env.example .env
# set JWT_SECRET and ENCRYPTION_KEY, each with: openssl rand -hex 32
# keep NODE_ENV=development for the local HTTP setup
docker compose up --build
```

The initial command builds the client and server dependency images. For subsequent
starts, use `docker compose up`. Source changes are bind-mounted into the containers
and picked up by the development watchers without rebuilding. Rebuild the images
when either `package.json` or `package-lock.json` changes.

- Web client: http://localhost:5173 (`CLIENT_HOST_PORT`)
- API: http://localhost:4000/api (`API_HOST_PORT`); the client proxies `/api` to it
- Postgres: localhost:5433 (`DB_HOST_PORT`)

If you change `CLIENT_HOST_PORT`, update `CLIENT_ORIGIN` to match.

Migrations are applied automatically when the `server` container starts.

Check startup without opening a browser:

```sh
curl --fail http://localhost:4000/api/health
```

Use your configured `API_HOST_PORT` if it differs. A ready API returns
`{"status":"ok"}`. The database lives in a persistent Docker volume; rebuilding
images does not delete it.

### Docker runtime environment

Set `NODE_ENV` in `.env`; the API and worker both use it, defaulting to
`development` when omitted or empty. Recreate affected services after changing it:

```sh
docker compose up -d server worker
```

| Value | API and worker behavior |
| ----- | ----------------------- |
| `development` | Local HTTP authentication cookies; local/private forge hosts are allowed. |
| `production` | Secure authentication cookies, and existing HTTPS/public-address checks for self-hosted forge hosts. Use an HTTPS client origin. |

`test` is reserved for automated tests; the server test script sets it explicitly.
Other values fail startup validation. `production` does not switch Docker
commands, disable watchers, build/serve the frontend, or provide HTTPS. The client
still runs Vite's development server, so do not expose this Compose setup publicly;
use the production image instead (see [Deploying](#deploying)).

### Users and invites

The first account registered on an instance becomes its **admin**, and so does
the oldest account on an install that predates roles. Admins see **Users** in the
sidebar, where they can promote or demote admins, remove users and create invite
links. An instance always keeps at least one admin. A user's personal-workspace
connections, repositories and reviews stay private to them; data in a team
workspace is shared with that team's members. Being an admin does not by itself
grant access to either.

`REGISTRATION_MODE` in `.env` controls who can create an account:

| Value | Who can register |
| ----- | ---------------- |
| `open` (default) | Anyone who can reach the client |
| `invite` | Only people with an invite link. A team invite also works here, admitting the new account and placing it in that team |
| `closed` | No new accounts; admins can still create invites, but they cannot register anyone until the mode allows it. Existing signed-in users can still accept a team invite to join a workspace |

An invite link works once and expires after 7 days. Adding an email limits the
link to that address. When `SMTP_URL` (for example
`smtp://user:pass@smtp.example.com:587`) and `MAIL_FROM` are set, the link is
also emailed; otherwise copy it from the dialog, which shows it only once.
Resending an emailed invite sends a new link and renews its expiry; the old link
stops working.

### Workspaces and teams

Every account has a private **personal workspace**. Anyone can also create a
**team workspace** from the switcher in the sidebar; its forge connections,
repositories, reviews, findings, global review config and LLM keys belong to the
team rather than to one person. The dashboard remembers the workspace you last
used.

| Role | Can |
| ---- | --- |
| `member` | View the team's data, request and rerun reviews, triage findings, leave the team |
| `admin` | Everything a member can, plus manage connections, repositories, review config and LLM keys, add and remove members, and invite people |
| `owner` | Everything an admin can, plus grant or revoke ownership, rename and delete the team |

A team always keeps at least one owner, so the last owner has to promote someone
else before leaving or deleting their account. The **Team** page (`/workspace`)
lists members, pending invites and settings. Admins can add someone who already
has an account directly (which shows them which emails are registered on the
instance) or invite anyone else with a team invite link.

### Run your first review

1. Open the client URL and register an account. The first account is the admin.
2. In **LLM Connections**, add and verify a model provider key, or configure
   [Ollama](#ollama). External providers may charge for model usage.
3. In **Configuration**, select that connection and a model available to it.
4. In **Repositories**, connect GitLab or install your configured GitHub App using
   the [forge setup](#forge-connections), then add a repository for review.
5. In **Reviews**, submit the URL of an open PR/MR on that repository. The worker
   processes it and the detail page shows results or the reason it failed.

Default publishing can post comments and statuses and update the description.
For an initial evaluation, use a test repository or disable publishing in
Configuration before running the review. Manual reviews do not require an
internet-reachable webhook URL; automatic reviews do.

See the [synthetic review output fixture](server/tests/__snapshots__/review.md)
for a rendered markdown example. It exercises presentation and is not a real
review or evidence of model accuracy.

### Troubleshooting

<details>
<summary>Common setup and review problems</summary>

- **Startup validation fails:** set a JWT secret of at least 32 characters and
  an encryption key of exactly 64 hexadecimal characters. Generate each with
  `openssl rand -hex 32`. Keep the encryption key stable for existing credentials.
- **A port is occupied:** change the corresponding host port in `.env`; changing
  the client port also requires updating `CLIENT_ORIGIN`.
- **Login fails after switching to production:** production cookies require
  HTTPS. Use `development` for the supplied local HTTP setup.
- **GitHub connection is unavailable:** configure the complete GitHub App setup,
  including OAuth installation confirmation.
- **Manual reviews work but automatic ones do not:** check webhook reachability,
  forge permissions, and trigger settings. GitLab hook creation needs Maintainer.
- **A model endpoint is unreachable:** inside Docker, `localhost` refers to the
  container. Use `host.docker.internal` for a service on the host and check its
  listen address and firewall.
- **Database tests cannot find `sentryward_test`:** the Postgres init script runs only
  when the database volume is first initialized. An older volume may need an
  operator-created test database. Do not delete a volume containing needed data.
- **A review is failed or partial:** inspect its detail page and redacted
  `docker compose logs --tail 100 server worker` output for provider, permissions,
  or publishing errors. Never post credentials or private code in an issue.

</details>

## Deploying

The production setup is one image, `ghcr.io/rdlugs/sentryward`, that runs the API,
serves the built dashboard from the same origin, and runs the review worker with
a different command. `docker-compose.prod.yml` runs it with PostgreSQL. It has no
source mounts or dev dependencies, and does not publish the database port. TLS is
left to a reverse proxy you run in front of it.

```sh
cp .env.production.example .env.production
# fill in POSTGRES_PASSWORD, JWT_SECRET, ENCRYPTION_KEY and your public URL
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

Images are published for `linux/amd64` and `linux/arm64` on each release tag.
`SENTRYWARD_VERSION` picks the tag (for example `0.1.0-alpha.3`). `latest` follows
the newest stable release only, so pin a version while Sentryward is pre-release.
To build from source instead, set `SENTRYWARD_VERSION` to a local name and run
`docker compose -f docker-compose.prod.yml --env-file .env.production build server`
before `up`.

- **Public URL:** set `CLIENT_ORIGIN` and `API_PUBLIC_URL` to the same `https://`
  URL. The GitHub App's setup URL becomes `<url>/api/connections/github/callback` and
  its webhook URL `<url>/api/webhooks/github`; GitLab webhooks use it automatically.
- **Reverse proxy:** the API listens on `127.0.0.1:4000` on the host (`API_BIND`,
  `API_HOST_PORT`). `TRUST_PROXY` (default `1`) is the number of proxies in front,
  so rate limits see client addresses; set it to match your setup. A minimal Caddy
  config, which also obtains the certificate:

  ```
  sentryward.example.com {
      reverse_proxy 127.0.0.1:4000
  }
  ```

- **Registration:** the production example defaults `REGISTRATION_MODE` to `invite`.
  The first account still registers freely and becomes the admin, so create it
  before sharing the URL.
- **Upgrades:** back up the database, change `SENTRYWARD_VERSION`, then run `pull`
  and `up -d` with the same `-f` and `--env-file` flags. The server applies
  migrations before it reports healthy, and the worker starts after it. The old
  worker finishes its in-flight reviews before exiting, and Compose waits up to
  `WORKER_STOP_GRACE_PERIOD` (default `15m`) for it, so an upgrade can pause while
  reviews complete; `stop -t <seconds>` overrides the wait.
- **Backups:** the `pgdata` volume holds everything (for example
  `docker compose -f docker-compose.prod.yml exec db pg_dump -U sentryward sentryward`).
  Back up `ENCRYPTION_KEY` separately and keep it stable: stored forge tokens and
  model keys cannot be decrypted without it.
- **Model endpoints on the host** (such as Ollama): the production file does not add
  `host.docker.internal`. Add an `extra_hosts` entry to the worker and server if you
  need it.

Read [SECURITY.md](SECURITY.md) before exposing an instance.

## Forge connections

**GitLab**: connect with a personal, project or group access token with the `api` scope and at least Developer access. Self-hosted instances work by entering their host.

**GitHub**: create a GitHub App (Settings, Developer settings, GitHub Apps) and put its details in `.env`:

- Setup URL: `http://localhost:5173/api/connections/github/callback`, with **Request user authorization (OAuth) during installation** checked. Sentryward uses that OAuth code to confirm the installing user can actually access the installation.
- Repository permissions: Pull requests (read and write), Contents (read), Commit statuses (read and write), Issues (read), Metadata (read). Issues is used for linked and related issues in the walkthrough; without it those parts are skipped with a warning.
- Copy the App ID, slug, client ID, a client secret and a generated private key into the `GITHUB_APP_*` variables.
- Webhook: URL `<API_PUBLIC_URL>/api/webhooks/github`, a secret in `GITHUB_WEBHOOK_SECRET`, and the events **Pull request**, **Issue comment** and **Installation**.

GitLab automatic reviews need a project webhook, which Sentryward registers when a repository is enabled at `API_PUBLIC_URL`. That takes **Maintainer** access; with only Developer access the repository is enabled for manual reviews and the dashboard says why automatic ones are off. GitLab must be able to reach `API_PUBLIC_URL`; for local development use a tunnel.

In production, self-hosted forge hosts must use https and resolve to public addresses.

## Publishing to the forge

When a review starts, Sentryward posts a "reviewing" summary comment and sets a pending `sentryward/review` commit status. When it finishes it publishes, each step independently:

- **Inline comments** for actionable findings only (GitHub: one review posted as `COMMENT`, never approve or request changes; GitLab: one discussion per finding). Suggestions use each forge's suggestion syntax. Each comment carries a hidden fingerprint, so a later run never posts the same finding twice, even if Sentryward's own records are lost.
- **The summary comment**, edited in place: the markdown served by `GET /api/reviews/:id/markdown`. One comment carries both what the change does (the walkthrough, when `output.walkthrough` is on) and what the review found. It ends with a line naming the commit, models and coverage, which `output.review_stats` turns off. With `output.post_summary` off, the walkthrough is posted as a comment of its own. `output.summary_location` is accepted but ignored, and a walkthrough block an earlier version wrote into the description is removed on the next review.
- **The walkthrough's optional parts**, each with its own switch: the review effort estimate (`output.estimate_effort`), a Mermaid sequence diagram of the main flow (`output.sequence_diagrams`), an assessment of how well the change addresses the issues it closes (`output.assess_linked_issues`; "fixes #12" style references on GitHub, GitLab's own closing issues on GitLab) and possibly related issues found by searching the tracker for the title's keywords (`output.related_issues`). Only issues the forge returned are ever shown.
- **The high-level summary** (`output.high_level_summary`): release notes by default, or whatever `output.high_level_summary_instructions` asks for. `output.high_level_summary_placement` puts it in the PR/MR description (the default, between hidden markers at the end, replaced on each run and never read back as the author's text) or in the walkthrough.
- **Labels**, when `output.blast_radius_label` or `output.effort_label` is on: the walkthrough's estimates as native labels such as `Large blast radius` or `10-20 Minutes`. A later run swaps a changed estimate's label. GitHub and GitLab only; on GitHub both labels and the cleanup of old description blocks use the Pull requests (write) permission.
- **The commit status**: `success` (pass), `failure` (blocked) or `error` (incomplete; GitLab shows it as `failed`), linking to the review in the dashboard. Branch protection can require it.

Turn the first three off with `output.post_inline`, `output.post_summary` and `output.post_check`, and the walkthrough with `output.walkthrough`. If publishing fails, the review is kept and the job is marked partial with the reason.

## Automatic reviews

- A PR/MR is reviewed when it opens, reopens, leaves draft or receives new commits. A commit that was already queued or reviewed is never reviewed again, so redelivered webhooks are harmless, and a newer push supersedes a review still waiting in the queue.
- Comment `/sentryward review` on a PR/MR to ask for a review of its current head. Only people who can push (GitHub owners, members and collaborators; GitLab Developer or above) can.
- `triggers.review` picks what is reviewed automatically when it opens, reopens or leaves draft: `manual` (nothing), `published` (the default, drafts skipped) or `all`. `triggers.review_on_push` decides whether new commits are reviewed again, and `triggers.command` turns `/sentryward review` off.
- `triggers.summary` limits the walkthrough in automatic reviews: `published` (the default) or `manual`, which leaves it to requested reviews.
- Automatic reviews are skipped when the title contains a phrase in `triggers.ignore_titles` (ignoring case), the author or whoever pushed is in `triggers.skip_authors`, the change carries a label in `triggers.skip_labels` (exact and case-sensitive), or the source or target branch name contains an entry of `triggers.skip_source_branches` / `triggers.skip_target_branches`. A manual review or `/sentryward review` is never skipped by these lists.
- All of this is checked by the worker with the full configuration, so a skipped review shows in the dashboard with the reason.
- Older settings keep their meaning: `triggers.on_push: false` reads as `review: manual` and `triggers.drafts: true` as `review: all`, unless the same layer sets `review`.
- Each workspace has at most `WORKER_USER_CONCURRENCY` reviews running at once (the name predates workspaces), and a repository holds at most 10 queued.
- With `triggers.abort_on_close` (the default), closing or merging a PR/MR cancels its queued reviews, and a running review stops: the worker checks the change before it starts, every 15 seconds while it runs (aborting model calls in flight) and before publishing. A cancelled review publishes nothing and closes its pending commit status as `error`. The webhook decides on queued reviews from the dashboard settings; the worker uses the full configuration, repository file included.

The worker keeps a small in-memory cache of what a commit fixes: the repository config file at the base revision and the change's diff for a given base and head. Reruns of the same head skip those forge calls; titles, descriptions, labels and state are always read fresh. `review.disable_cache` turns it off. Set in the dashboard it covers every read; set in `.sentryward.yaml` the diff is fetched again once the file has been read.

## Review configuration

Settings resolve in this order, highest first:

1. Overrides from whatever triggered the review
2. `.sentryward.yaml` (or `.sentryward.yml`; the first found wins, they are not merged) in the repository, read from the PR's **base** revision so a change cannot loosen its own review
3. Repository settings saved in the dashboard (ignored while the repository follows the global config, which is the default for new repositories)
4. The global config saved on the Configuration page, shared by all of a user's repositories
5. The selected profile: `balanced` (default), `fast`, `strict`, `security`
6. Built-in defaults

A field set explicitly in any layer beats the profile. An invalid repository file is ignored as a whole and reported as a warning; the review still runs. The file cannot hold API keys, tokens or endpoints.

### LLM connections and custom endpoints

Add and verify provider credentials in LLM Connections, then select one in Configuration > LLM. Global configuration requires a connection; a repository can inherit it or select another saved connection. The selection is a live reference, so replacing its key or changing its custom host updates every configuration that uses it.

A connection with a custom host sends every model call to that compatible proxy. The model's provider prefix still picks the request format (`openai/` uses chat completions), and the rest of the id is passed through as is, slashes and parentheses included. Without a custom host, every configured model must use the selected connection's provider.

For 9router, save its key and host under OpenAI in LLM Connections, select the OpenAI connection in Configuration > LLM, and use a model such as `openai/cx/gpt-5.6-sol(medium)`.

The worker runs in a container, where `localhost` is the container itself; `host.docker.internal` reaches a proxy running on the host.

### Ollama

Add Ollama under LLM Connections and enter its OpenAI-compatible base URL. For Ollama running on the Docker host, use `http://host.docker.internal:11434/v1`. The API key is optional. Select the Ollama connection in Configuration > LLM and use the `ollama/<model>` form, for example `ollama/qwen3`.

### `.sentryward.yaml` reference

Every key is optional. Values shown are examples, not all defaults.

<details open>
<summary>Full example</summary>

```yaml
# .sentryward.yaml - every key is optional
profile: balanced
llm:
  model: anthropic/claude-sonnet-5-5   # provider/model: anthropic, openai or google
  fallback_models: []
  temperature: 0.2
  max_tokens: 8000
review:
  categories: [security, bug, performance, logic, reliability]
  severity_floor: minor     # what is reported
  block_on: critical        # what fails the verdict and the commit status
  max_findings: 25
  max_chunks: 12
  min_confidence: 0.5
  require_evidence: true    # unproven critical/major findings are demoted
  full_file: false          # allow findings on lines the change did not touch
  committable_suggestions: true
  disable_cache: false      # fetch the diff and config file fresh on every run
output:
  walkthrough: true
  post_inline: true
  post_summary: true
  post_check: true
  review_stats: true        # the commit/models/coverage line under the summary
  agent_prompts: true       # a prompt for AI agents in each actionable inline comment
  agent_prompt_all: true    # one prompt for every finding in the summary comment
  blast_radius_label: false # e.g. "Large blast radius"
  effort_label: false       # e.g. "10-20 Minutes"
  estimate_effort: true     # review effort in the walkthrough
  sequence_diagrams: true   # Mermaid sequence diagram in the walkthrough
  assess_linked_issues: true
  related_issues: true
  high_level_summary: true
  high_level_summary_placement: description   # description | walkthrough
  high_level_summary_instructions: ""         # empty: release notes
triggers:
  review: published         # manual | published | all (drafts too)
  review_on_push: true      # review new commits pushed to an open PR/MR
  summary: published        # manual | published: walkthrough in automatic reviews
  command: true             # allow "/sentryward review" in a comment
  abort_on_close: true      # stop a review when its PR/MR is closed or merged
  ignore_titles: ["WIP"]    # title contains, ignoring case
  skip_authors: ["dependabot[bot]"]
  skip_labels: ["no-review"]          # exact, case-sensitive
  skip_source_branches: ["release/"]  # branch name contains
  skip_target_branches: []
ignore_paths: ["**/*.lock", "**/dist/**"]   # replaces the default list
instructions: "Controllers stay thin; business logic lives in services."
language_instructions:
  typescript: "Strict mode; no any."
```

</details>

## API

<details>
<summary>Endpoint reference</summary>

Endpoints that act on workspace data (connections, repositories, reviews,
findings, global config and LLM keys) read the workspace id from the
`x-sentryward-workspace` header. Without it they use the caller's personal workspace,
so scripts written before workspaces keep working. Routes under
`/api/workspaces/:id` name the workspace in the path instead.

| Method | Path                 | Description |
| ------ | -------------------- | ----------- |
| POST   | `/api/auth/register` | `{ name, email, password, confirmPassword, inviteToken? }`, sets the auth cookie; `inviteToken` is required when `REGISTRATION_MODE=invite` |
| GET    | `/api/auth/registration` | `{ mode, firstUser }`, so the register page can say whether it is usable |
| GET    | `/api/auth/invites/:token` | The invite's email, inviter and expiry, or 404 when invalid, used or expired |
| POST   | `/api/auth/invites/:token/accept` | Signed in: joins the team the invite is for and returns that workspace |
| POST   | `/api/auth/login`    | `{ email, password }`, sets the auth cookie |
| POST   | `/api/auth/logout`   | Clears the auth cookie |
| GET    | `/api/auth/me`       | Current user, or 401 |
| GET    | `/api/connections`   | The workspace's forge connections, and whether GitHub is configured |
| POST   | `/api/connections/gitlab` | `{ host?, token }`, validates the token against GitLab and stores it encrypted |
| GET    | `/api/connections/github/install?workspace=` | Redirects to the GitHub App's install page; the installation is added to that workspace |
| GET    | `/api/connections/github/callback` | GitHub's return URL after installing the app |
| DELETE | `/api/connections/:id` | Removes a connection and its repositories |
| GET    | `/api/repos?connectionId=` | Repositories the connection can see, with their enabled flag |
| POST   | `/api/repos`         | `{ connectionId, externalId }`, enables a repository for review |
| PATCH  | `/api/repos/:id`     | `{ enabled?, settings?, followGlobal? }`; `settings` replaces the saved review overrides, `followGlobal` makes the repository ignore them and use only the global config |
| GET    | `/api/repos/:id/config` | The effective review config for the default branch, where each value came from, and any repository-file warnings |
| POST   | `/api/reviews`       | `{ url }` of a pull or merge request on an enabled repository; queues a review of its current head |
| GET    | `/api/reviews?repoId=&status=&page=&limit=` | The workspace's reviews, newest first, with a summary but not the full result; returns `{ reviews, total, page, limit }` (`limit` 1-100, default 20) |
| GET    | `/api/reviews/:id`   | One review with its full result |
| GET    | `/api/reviews/:id/markdown` | The review as the markdown document that is posted to the forge |
| POST   | `/api/reviews/:id/rerun` | Queues a fresh review of the PR's latest head |
| POST   | `/api/webhooks/github` | GitHub App webhook (signed with `GITHUB_WEBHOOK_SECRET`) |
| POST   | `/api/webhooks/gitlab/:repoId` | GitLab project hook Sentryward registers per repository (token checked per repository) |
| GET    | `/api/config/schema` | Defaults, profiles, severities and categories for the settings UI |
| GET    | `/api/config/global` | The workspace's global review config, and what it resolves to with each value's source |
| PUT    | `/api/config/global` | Workspace admins: `{ settings }`, replaces the global review config; `{}` resets it |
| PUT    | `/api/settings/avatar` | Raw PNG, JPEG or WebP body (512 KB at most; the dashboard uploads a 256px JPEG); sets the caller's profile picture |
| DELETE | `/api/settings/avatar` | Removes the caller's profile picture, so their initials show again |
| GET    | `/api/users/:id/avatar` | A user's profile picture, for any signed-in user; 404 when they have none |
| GET    | `/api/admin/users`   | Admin only: every user with their role |
| PATCH  | `/api/admin/users/:id` | Admin only: `{ role: "admin" \| "member" }`; refuses to remove the last admin |
| DELETE | `/api/admin/users/:id` | Admin only: deletes another user and everything they own |
| GET    | `/api/admin/invites` | Admin only: pending invites |
| POST   | `/api/admin/invites` | Admin only: `{ email? }`; returns `{ invite, link, emailed }`, the link is shown only here |
| POST   | `/api/admin/invites/:id/resend` | Admin only: emails a new link for an email invite and renews its expiry; needs SMTP |
| DELETE | `/api/admin/invites/:id` | Admin only: revokes a pending invite |
| GET    | `/api/workspaces`    | The caller's workspaces with their role in each |
| POST   | `/api/workspaces`    | `{ name }`, creates a team workspace owned by the caller |
| PATCH  | `/api/workspaces/:id` | Owners: `{ name }`, renames a team |
| DELETE | `/api/workspaces/:id` | Owners: deletes a team and everything in it, removing Sentryward's forge hooks first |
| GET    | `/api/workspaces/:id/members` | Members with their role and join date |
| POST   | `/api/workspaces/:id/members` | Team admins: `{ email, role? }`, adds an existing account as `admin` or `member` |
| GET    | `/api/workspaces/:id/member-candidates` | Team admins: accounts not yet in the team, for the add-member picker |
| PATCH  | `/api/workspaces/:id/members/:userId` | Team admins: `{ role }`; only owners grant or revoke `owner`, and the last owner cannot be demoted |
| DELETE | `/api/workspaces/:id/members/:userId` | Team admins remove a member; any member may remove themselves to leave |
| GET    | `/api/workspaces/:id/invites` | Team admins: pending team invites |
| POST   | `/api/workspaces/:id/invites` | Team admins: `{ email?, role? }`; returns `{ invite, link, emailed }` like an instance invite |
| POST   | `/api/workspaces/:id/invites/:inviteId/resend` | Team admins: emails a new link for an email invite and renews its expiry |
| DELETE | `/api/workspaces/:id/invites/:inviteId` | Team admins: revokes a pending team invite |

Register, login, the registration mode and invite lookups are rate limited (20 requests per 15 minutes per IP).

</details>

## Development

<details>
<summary>Stack</summary>

| Layer    | Tech |
| -------- | ---- |
| Client   | Vite, React 19, TypeScript, Tailwind CSS v4, shadcn/ui, React Router, TanStack Query, react-hook-form + zod |
| API      | Express 5, TypeScript (run with tsx), Prisma 7 (`@prisma/adapter-pg`), zod, argon2id, JWT in an httpOnly cookie |
| Database | PostgreSQL 17 |

**Why PostgreSQL over MySQL**

- Real `UUID`, `TIMESTAMPTZ` and `CITEXT` types (emails are case-insensitive at the database level).
- `JSONB`, arrays, full-text search and row-level security for future cloud features.
- Transactional DDL, so a failed migration rolls back cleanly.

</details>

### Tests

```sh
docker compose exec server npm test   # API tests against the sentryward_test database
docker compose exec client npm test   # React component and routing tests
```

GitHub Actions also runs type checks, client lint, and the client production
build inside Docker. See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete checks.

### Database changes

```sh
# edit server/prisma/schema.prisma, then:
docker compose exec server npx prisma migrate dev --name <change>
```

### Project layout

```
client/   React SPA (shadcn components live in src/components/ui)
server/   Express API (src/routes, src/controllers, prisma/schema.prisma) and the review worker (src/worker)
docker/   Postgres init script (creates the test database)
```

## Contributing and license

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[code of conduct](CODE_OF_CONDUCT.md), and look for
[good first issues](https://github.com/rdlugs/sentryward/labels/good%20first%20issue).
Questions and ideas go to [Discussions](https://github.com/rdlugs/sentryward/discussions).
Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md),
which also covers deployment boundaries and how credentials are stored.
Release notes are in the [changelog](CHANGELOG.md).

Licensed under [MIT](LICENSE), with [third-party notices](THIRD_PARTY_NOTICES.md).
