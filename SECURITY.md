# Security policy

## Supported versions and private reports

Sentryward is alpha software. Security fixes target the latest code on `main`; there
are no supported stable release branches yet.

Use [GitHub private vulnerability reporting](https://github.com/rdlugs/sentryward/security/advisories/new)
to report a vulnerability. Include the affected revision, reproduction steps,
impact, and a minimal example with secrets removed. Do not open public issues or
include working credentials. Maintainers review reports and coordinate fixes and
disclosure privately. No response-time guarantee is currently offered.

Maintainers must enable private vulnerability reporting in the repository's
security settings before public release. If the private reporting link is
unavailable, do not publish exploit details in an issue.

## Deployment boundaries

`docker-compose.yml` is for development. It runs development servers, mounts
source, exposes PostgreSQL, and uses example database credentials. Do not expose
it as a production service.

The supported way to host an instance is the production image with
`docker-compose.prod.yml` (README, "Deploying"). It runs without development
servers or source mounts, does not publish the database port, binds the API to
the host's loopback interface, and defaults `REGISTRATION_MODE` to `invite`. It
does not supply HTTPS: the operator runs the TLS-terminating reverse proxy, and
remains responsible for host hardening, backups, protecting `ENCRYPTION_KEY`,
and keeping the image up to date. Set `TRUST_PROXY` to the number of proxies
actually in front of the API: a value that is too high lets clients spoof the
address that rate limits are keyed on.

`NODE_ENV=production` (the image default) enables secure authentication cookies
and existing HTTPS/public-address checks for self-hosted forge hosts. These forge checks do not prevent DNS
rebinding, and custom model endpoints are a separate trust boundary. Restrict
network egress and access to trusted operators when evaluating deployments.

## Credentials and stored data

Passwords are hashed with Argon2id. Authentication uses a seven-day JWT in an
httpOnly, SameSite=Lax cookie; production mode also sets Secure.

Saved forge tokens, webhook secrets, and model API keys are encrypted using
AES-256-GCM with `ENCRYPTION_KEY`. Encryption protects database values, not access
by the running application or an operator holding that key. Environment-provided
secrets remain environment configuration rather than encrypted database records.
Never commit `.env`, expose container environments, or attach database backups
to issues. Protect backups and the encryption key separately. Keep the key stable:
changing it without re-encrypting existing values makes them unreadable. Automated
key rotation is not provided.

The database stores account details, forge connections, repository metadata,
settings, review results, findings, publication metadata, and job errors. Results
and errors may include sensitive code or repository information. Model connection
base URLs are stored as configuration. Logs may contain upstream errors; redact
them before sharing.

## Model providers and external publishing

Reviews send code diffs and selected context, PR/MR metadata, instructions, and
optional issue context to the configured model provider or custom endpoint.
Provider calls also use the applicable API credentials. A custom endpoint receives
the credentials and payload sent to it, so configure only endpoints you trust.
Model listing and connection verification also contact those endpoints.

Provider retention and training policies depend on the service and account terms.
Sentryward cannot guarantee those policies. Ollama can keep inference local, but forge
access and any configured publishing still involve the forge.

Enabled publishing can create inline comments, summaries, labels, commit statuses,
and description updates on the forge. Review output may reveal code or other
sensitive context to people who can access the PR/MR. Review findings need human
verification and are not a security certification.

## Retention and deletion

There is no scheduled retention cleanup. Review data persists until removed
through application deletion or operator-managed database maintenance. Deleting
an account requires its password and cascades through stored connections,
repositories, review jobs, findings, and model credentials, then clears the browser
auth cookie. This does not erase backups, logs, provider-retained data, or content
already published on a forge. Remove forge app installations and webhooks at the
forge when retiring an instance or connection; do not assume database deletion
revokes external access. Previously issued JWTs are not centrally revoked.
