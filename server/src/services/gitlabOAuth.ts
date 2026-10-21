import { createHash, randomBytes } from "node:crypto";
import { env } from "../config/env.ts";
import { encrypt } from "../lib/crypto.ts";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import { ForgeError } from "../review/forge/http.ts";
import { hostOrigin } from "../review/forge/types.ts";
import { decryptToken } from "./providers/token.ts";

// Publishing comments, discussions and commit statuses needs write access, and
// GitLab has no narrower scope that grants it.
const SCOPE = "api";
// Refresh a little early so a token cannot expire between the check and the
// forge call that uses it.
const REFRESH_MARGIN_MS = 2 * 60 * 1000;
const TOKEN_TIMEOUT_MS = 15_000;

// A refresh GitLab refuses (the app was revoked, the user deleted or blocked)
// can only be fixed by connecting again, like a token this server cannot decrypt.
export class ReconnectRequiredError extends HttpError {
  constructor() {
    super(409, "GitLab refused to renew this connection's access; reconnect this account");
  }
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  // Null when the instance does not expire access tokens.
  expiresAt: Date | null;
}

export function gitlabOAuthConfigured(): boolean {
  return Boolean(env.GITLAB_OAUTH_CLIENT_ID && env.GITLAB_OAUTH_CLIENT_SECRET);
}

// Through the client origin, like the GitHub App's setup URL, so the browser
// sends the session cookie with the callback.
export function gitlabRedirectUri(): string {
  return `${env.CLIENT_ORIGIN}/api/connections/gitlab/oauth/callback`;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function gitlabAuthorizeUrl(host: string, state: string, challenge: string): string {
  const params = new URLSearchParams({
    client_id: env.GITLAB_OAUTH_CLIENT_ID!,
    redirect_uri: gitlabRedirectUri(),
    response_type: "code",
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${hostOrigin(host)}/oauth/authorize?${params}`;
}

async function tokenRequest(host: string, grant: Record<string, string>): Promise<OAuthTokens> {
  const url = `${hostOrigin(host)}/oauth/token`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GITLAB_OAUTH_CLIENT_ID!,
      client_secret: env.GITLAB_OAUTH_CLIENT_SECRET!,
      redirect_uri: gitlabRedirectUri(),
      ...grant,
    }).toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!res.ok || !body.access_token || !body.refresh_token) {
    throw new ForgeError(res.ok ? 502 : res.status, `POST ${url} failed (${res.status}): ${body.error ?? "no token"}`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    // Counted from our clock rather than GitLab's created_at, so skew between
    // the two cannot make a token look fresh after it has expired.
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
  };
}

export function exchangeCode(host: string, code: string, verifier: string): Promise<OAuthTokens> {
  return tokenRequest(host, { grant_type: "authorization_code", code, code_verifier: verifier });
}

// The ForgeConnection columns that hold a token set, encrypted.
export function storedTokens(tokens: OAuthTokens) {
  return {
    encryptedToken: encrypt(tokens.accessToken),
    encryptedRefreshToken: encrypt(tokens.refreshToken),
    tokenExpiresAt: tokens.expiresAt,
  };
}

function due(connection: { tokenExpiresAt: Date | null }): boolean {
  return connection.tokenExpiresAt !== null && connection.tokenExpiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS;
}

function accessTokenOf(connection: { encryptedToken: string | null }): string {
  if (!connection.encryptedToken) {
    throw new ReconnectRequiredError();
  }
  return decryptToken(connection.encryptedToken, "GitLab");
}

// The only path that refreshes, read from the database on every call rather
// than from a connection loaded earlier. GitLab rotates the refresh token on
// each use, so two jobs (or the API and a job) refreshing the same connection
// at once would leave one holding a dead token. The row lock makes the second
// caller wait, re-read, and find the token the first one stored.
export async function gitlabAccessToken(connectionId: string): Promise<string> {
  const current = await prisma.forgeConnection.findUnique({ where: { id: connectionId } });
  if (!current) {
    throw new HttpError(404, "Connection not found");
  }
  if (!due(current)) {
    return accessTokenOf(current);
  }

  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM forge_connections WHERE id = ${connectionId}::uuid FOR UPDATE`;
      const locked = await tx.forgeConnection.findUnique({ where: { id: connectionId } });
      if (!locked) {
        throw new HttpError(404, "Connection not found");
      }
      if (!due(locked)) {
        return accessTokenOf(locked);
      }
      if (!locked.encryptedRefreshToken) {
        throw new ReconnectRequiredError();
      }
      const refreshToken = decryptToken(locked.encryptedRefreshToken, "GitLab");
      let tokens: OAuthTokens;
      try {
        tokens = await tokenRequest(locked.host, { grant_type: "refresh_token", refresh_token: refreshToken });
      } catch (err) {
        if (err instanceof ForgeError && (err.status === 400 || err.status === 401)) {
          throw new ReconnectRequiredError();
        }
        throw err;
      }
      await tx.forgeConnection.update({ where: { id: connectionId }, data: storedTokens(tokens) });
      return tokens.accessToken;
    },
    // Waiting on another caller's refresh counts against the timeout, so it
    // covers two token requests.
    { timeout: 3 * TOKEN_TIMEOUT_MS },
  );
}
