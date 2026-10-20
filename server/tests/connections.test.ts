import request from "supertest";
import jwt from "jsonwebtoken";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.ts";
import { env } from "../src/config/env.ts";
import { decrypt, encrypt } from "../src/lib/crypto.ts";
import { prisma } from "../src/lib/prisma.ts";
import { fetchStub } from "./helpers/fetchStub.ts";
import { encryptWithOtherKey } from "./helpers/foreignKey.ts";
import { createTeam, createUser } from "./helpers/users.ts";

let cookie: string;
let userId: string;
let workspaceId: string;

beforeEach(async () => {
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  ({ cookie, user: { id: userId }, workspace: { id: workspaceId } } = await createUser());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("POST /api/connections/gitlab", () => {
  it("validates the token, stores it encrypted and never returns it", async () => {
    const { fetch, calls } = fetchStub([{ url: /gitlab\.acme\.com\/api\/v4\/user$/, body: { username: "dev" } }]);
    vi.stubGlobal("fetch", fetch);

    const res = await request(app)
      .post("/api/connections/gitlab")
      .set("Cookie", cookie)
      .send({ host: "https://gitlab.acme.com/", token: "glpat-secret" });

    expect(res.status).toBe(201);
    expect(res.body.connection).toMatchObject({ provider: "gitlab", host: "gitlab.acme.com", accountLogin: "dev" });
    expect(JSON.stringify(res.body)).not.toContain("glpat-secret");
    expect(calls[0]!.headers["private-token"]).toBe("glpat-secret");

    const stored = await prisma.forgeConnection.findFirstOrThrow({ where: { workspaceId } });
    expect(stored.encryptedToken).not.toContain("glpat-secret");
    expect(decrypt(stored.encryptedToken!)).toBe("glpat-secret");
  });

  it("updates the token when the same account reconnects", async () => {
    vi.stubGlobal("fetch", fetchStub([{ url: /\/user$/, body: { username: "dev" } }]).fetch);

    await request(app).post("/api/connections/gitlab").set("Cookie", cookie).send({ token: "one" });
    const res = await request(app).post("/api/connections/gitlab").set("Cookie", cookie).send({ token: "two" });

    expect(res.status).toBe(200);
    const stored = await prisma.forgeConnection.findMany({ where: { workspaceId } });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.host).toBe("gitlab.com");
    expect(decrypt(stored[0]!.encryptedToken!)).toBe("two");
  });

  it("rejects a token GitLab refuses", async () => {
    vi.stubGlobal("fetch", fetchStub([{ url: /\/user$/, status: 401, body: { message: "401 Unauthorized" } }]).fetch);

    const res = await request(app).post("/api/connections/gitlab").set("Cookie", cookie).send({ token: "bad" });

    expect(res.status).toBe(400);
    expect(await prisma.forgeConnection.count()).toBe(0);
  });

  it("returns field errors for a bad host and missing token", async () => {
    const res = await request(app)
      .post("/api/connections/gitlab")
      .set("Cookie", cookie)
      .send({ host: "gitlab.com/group" });

    expect(res.status).toBe(400);
    expect(Object.keys(res.body.errors)).toEqual(expect.arrayContaining(["host", "token"]));
  });

  it("requires authentication", async () => {
    const res = await request(app).post("/api/connections/gitlab").send({ token: "x" });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/connections/github", () => {
  it("validates an Enterprise Server token against /api/v3 and stores it encrypted", async () => {
    const { fetch, calls } = fetchStub([{ url: /ghe\.acme\.com\/api\/v3\/user$/, body: { login: "dev" } }]);
    vi.stubGlobal("fetch", fetch);

    const res = await request(app)
      .post("/api/connections/github")
      .set("Cookie", cookie)
      .send({ host: "https://ghe.acme.com/", token: "ghp-secret" });

    expect(res.status).toBe(201);
    expect(res.body.connection).toMatchObject({ provider: "github", kind: "token", host: "ghe.acme.com", accountLogin: "dev" });
    expect(JSON.stringify(res.body)).not.toContain("ghp-secret");
    expect(calls[0]!.headers.authorization).toBe("Bearer ghp-secret");

    const stored = await prisma.forgeConnection.findFirstOrThrow({ where: { workspaceId } });
    expect(decrypt(stored.encryptedToken!)).toBe("ghp-secret");
  });

  it("updates the token when the same account reconnects", async () => {
    vi.stubGlobal("fetch", fetchStub([{ url: /\/user$/, body: { login: "dev" } }]).fetch);

    const send = (token: string) =>
      request(app).post("/api/connections/github").set("Cookie", cookie).send({ host: "ghe.acme.com", token });
    await send("one");
    const res = await send("two");

    expect(res.status).toBe(200);
    const stored = await prisma.forgeConnection.findMany({ where: { workspaceId } });
    expect(stored).toHaveLength(1);
    expect(decrypt(stored[0]!.encryptedToken!)).toBe("two");
  });

  it("rejects a token GitHub refuses", async () => {
    vi.stubGlobal("fetch", fetchStub([{ url: /\/user$/, status: 401, body: { message: "Bad credentials" } }]).fetch);

    const res = await request(app)
      .post("/api/connections/github")
      .set("Cookie", cookie)
      .send({ host: "ghe.acme.com", token: "bad" });

    expect(res.status).toBe(400);
    expect(await prisma.forgeConnection.count()).toBe(0);
  });

  it("sends github.com to the GitHub App and requires a host", async () => {
    const dotcom = await request(app)
      .post("/api/connections/github")
      .set("Cookie", cookie)
      .send({ host: "github.com", token: "x" });
    const missing = await request(app).post("/api/connections/github").set("Cookie", cookie).send({ token: "x" });

    expect(dotcom.status).toBe(400);
    expect(Object.keys(dotcom.body.errors)).toEqual(["host"]);
    expect(missing.status).toBe(400);
    expect(Object.keys(missing.body.errors)).toContain("host");
  });
});

describe("POST /api/connections/:provider", () => {
  it("404s for a provider Sentryward does not know", async () => {
    const res = await request(app).post("/api/connections/bitbucket").set("Cookie", cookie).send({ token: "x" });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/connections", () => {
  it("lists only the caller's connections without secrets", async () => {
    const other = await createUser("other@example.com");
    await prisma.forgeConnection.createMany({
      data: [
        { workspaceId, createdById: userId, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "me", encryptedToken: "v1.x" },
        { workspaceId: other.workspace.id, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "them" },
      ],
    });

    const mine = await prisma.forgeConnection.findFirstOrThrow({ where: { workspaceId } });
    const repo = { connectionId: mine.id, provider: "gitlab", host: "gitlab.com", defaultBranch: "main" } as const;
    await prisma.repository.createMany({
      data: [
        { ...repo, externalId: "1", fullPath: "me/on", enabled: true },
        { ...repo, externalId: "2", fullPath: "me/off", enabled: false },
      ],
    });

    const res = await request(app).get("/api/connections").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.availableApps).toEqual(["github"]);
    expect(res.body.connections).toHaveLength(1);
    expect(res.body.connections[0]).toMatchObject({
      accountLogin: "me",
      createdBy: { name: "Dev", email: "dev@example.com" },
      repositoryCount: 1,
    });
    expect(res.body.connections[0].encryptedToken).toBeUndefined();
  });
});

describe("GET /api/connections/:id/status", () => {
  const gitlabConnection = (owner = workspaceId) =>
    prisma.forgeConnection.create({
      data: {
        workspaceId: owner,
        provider: "gitlab",
        host: "gitlab.com",
        kind: "token",
        accountLogin: "me",
        encryptedToken: encrypt("glpat-x"),
      },
    });

  const statusFor = async (id: string) =>
    (await request(app).get(`/api/connections/${id}/status`).set("Cookie", cookie)).body.status;

  it("reports a token the forge accepts as active", async () => {
    const connection = await gitlabConnection();
    vi.stubGlobal("fetch", fetchStub([{ url: /gitlab\.com\/api\/v4\/user$/, body: { username: "me" } }]).fetch);

    expect(await statusFor(connection.id)).toBe("active");
  });

  it("reports a refused token as revoked", async () => {
    const connection = await gitlabConnection();
    vi.stubGlobal("fetch", fetchStub([{ url: /gitlab\.com\/api\/v4\/user$/, status: 401 }]).fetch);

    expect(await statusFor(connection.id)).toBe("revoked");
  });

  it("reports a token this server can no longer decrypt as revoked", async () => {
    const connection = await gitlabConnection();
    await prisma.forgeConnection.update({
      where: { id: connection.id },
      data: { encryptedToken: encryptWithOtherKey("glpat-x") },
    });
    vi.stubGlobal("fetch", fetchStub([]).fetch);

    expect(await statusFor(connection.id)).toBe("revoked");
  });

  it("reports a failing forge as unreachable", async () => {
    const connection = await gitlabConnection();
    vi.stubGlobal("fetch", fetchStub([{ url: /gitlab\.com\/api\/v4\/user$/, status: 500 }]).fetch);

    expect(await statusFor(connection.id)).toBe("unreachable");
  });

  it("reports an uninstalled GitHub App as revoked", async () => {
    const connection = await prisma.forgeConnection.create({
      data: { workspaceId, provider: "github", host: "github.com", kind: "github_app", installationId: "55", accountLogin: "acme" },
    });
    vi.stubGlobal("fetch", fetchStub([{ url: /api\.github\.com\/app\/installations\/55$/, status: 404 }]).fetch);

    expect(await statusFor(connection.id)).toBe("revoked");
  });

  it("404s on someone else's connection and requires authentication", async () => {
    const other = await createUser("other@example.com");
    const theirs = await gitlabConnection(other.workspace.id);

    expect((await request(app).get(`/api/connections/${theirs.id}/status`).set("Cookie", cookie)).status).toBe(404);
    expect((await request(app).get(`/api/connections/${theirs.id}/status`)).status).toBe(401);
  });
});

describe("GET /api/connections/:id", () => {
  it("returns the connection with its enabled repositories and recent reviews", async () => {
    const connection = await prisma.forgeConnection.create({
      data: {
        workspaceId,
        provider: "gitlab",
        host: "gitlab.com",
        kind: "token",
        accountLogin: "me",
        encryptedToken: encrypt("glpat-x"),
      },
    });
    const repo = (fullPath: string, extra = {}) =>
      prisma.repository.create({
        data: {
          connectionId: connection.id,
          provider: "gitlab",
          host: "gitlab.com",
          fullPath,
          externalId: fullPath,
          defaultBranch: "main",
          ...extra,
        },
      });
    const hooked = await repo("acme/api", { enabled: true, webhookId: "9" });
    await repo("acme/web", { enabled: true });
    await repo("acme/old");
    for (let number = 1; number <= 6; number++) {
      await prisma.reviewJob.create({
        data: {
          repositoryId: hooked.id,
          number,
          headSha: "h",
          trigger: "manual",
          createdAt: new Date(Date.UTC(2026, 0, number)),
        },
      });
    }

    const res = await request(app).get(`/api/connections/${connection.id}`).set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.connection).toMatchObject({ id: connection.id, accountLogin: "me", installationId: null });
    expect(res.body.connection.encryptedToken).toBeUndefined();
    expect(res.body.repositories).toEqual([
      {
        id: hooked.id,
        fullPath: "acme/api",
        defaultBranch: "main",
        webUrl: "https://gitlab.com/acme/api",
        webhook: { active: true },
      },
      expect.objectContaining({ fullPath: "acme/web", webhook: { active: false } }),
    ]);
    expect(res.body.repositories[0].webhookId).toBeUndefined();
    expect(res.body.reviews.total).toBe(6);
    expect(res.body.reviews.recent.map((review: { number: number }) => review.number)).toEqual([6, 5, 4, 3, 2]);
    expect(res.body.reviews.recent[0].repository).toEqual({ fullPath: "acme/api", provider: "gitlab" });
  });

  it("404s on someone else's connection and requires authentication", async () => {
    const other = await createUser("other@example.com");
    const theirs = await prisma.forgeConnection.create({
      data: { workspaceId: other.workspace.id, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "them" },
    });

    expect((await request(app).get(`/api/connections/${theirs.id}`).set("Cookie", cookie)).status).toBe(404);
    expect((await request(app).get(`/api/connections/${theirs.id}`)).status).toBe(401);
  });
});

describe("DELETE /api/connections/:id", () => {
  it("deletes the caller's connection and 404s on someone else's", async () => {
    const other = await createUser("other@example.com");
    const mine = await prisma.forgeConnection.create({
      data: { workspaceId, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "me" },
    });
    const theirs = await prisma.forgeConnection.create({
      data: { workspaceId: other.workspace.id, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "them" },
    });

    expect((await request(app).delete(`/api/connections/${theirs.id}`).set("Cookie", cookie)).status).toBe(404);
    expect((await request(app).delete(`/api/connections/${mine.id}`).set("Cookie", cookie)).status).toBe(204);
    expect(await prisma.forgeConnection.count()).toBe(1);
  });
});

describe("GitHub App installation", () => {
  const state = (sub: string, purpose = "github-install", stateWorkspace = workspaceId) =>
    jwt.sign({ sub, purpose, workspaceId: stateWorkspace }, env.JWT_SECRET, { expiresIn: "10m" });

  const githubRoutes = (installationIds: number[]) => [
    { method: "POST", url: /github\.com\/login\/oauth\/access_token$/, body: { access_token: "user-tok" } },
    { url: /api\.github\.com\/user\/installations/, body: { installations: installationIds.map((id) => ({ id })) } },
    { url: /api\.github\.com\/app\/installations\/55$/, body: { id: 55, account: { login: "acme" } } },
  ];

  it("redirects to the app's install page with a signed state", async () => {
    const res = await request(app).get("/api/connections/github/install").set("Cookie", cookie);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location!);
    expect(location.origin + location.pathname).toBe("https://github.com/apps/sentryward-test/installations/new");
    expect(jwt.verify(location.searchParams.get("state")!, env.JWT_SECRET)).toMatchObject({ sub: userId, workspaceId });
  });

  it("saves the installation when the OAuth user can access it", async () => {
    vi.stubGlobal("fetch", fetchStub(githubRoutes([55])).fetch);

    const res = await request(app)
      .get(`/api/connections/github/callback?installation_id=55&setup_action=install&code=c&state=${state(userId)}`)
      .set("Cookie", cookie);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${env.CLIENT_ORIGIN}/repositories?tab=installation&connected=github`);
    expect(await prisma.forgeConnection.findFirst({ where: { workspaceId } })).toMatchObject({
      provider: "github",
      kind: "github_app",
      installationId: "55",
      accountLogin: "acme",
    });
  });

  it("refuses the callback when the user is no longer an admin of the workspace in the state", async () => {
    const team = await createTeam(userId, "Acme");
    await prisma.membership.updateMany({ where: { workspaceId: team.id }, data: { role: "member" } });
    vi.stubGlobal("fetch", fetchStub(githubRoutes([55])).fetch);

    const res = await request(app)
      .get(`/api/connections/github/callback?installation_id=55&code=c&state=${state(userId, "github-install", team.id)}`)
      .set("Cookie", cookie);

    expect(res.headers.location).toContain("error=github_install_failed");
    expect(await prisma.forgeConnection.count()).toBe(0);
  });

  it("stores the installation in the workspace it was started for", async () => {
    const team = await createTeam(userId, "Acme");
    vi.stubGlobal("fetch", fetchStub(githubRoutes([55])).fetch);

    await request(app)
      .get(`/api/connections/github/callback?installation_id=55&code=c&state=${state(userId, "github-install", team.id)}`)
      .set("Cookie", cookie);

    expect(await prisma.forgeConnection.findFirstOrThrow()).toMatchObject({ workspaceId: team.id, createdById: userId });
  });

  it("refuses an installation the OAuth user cannot see", async () => {
    vi.stubGlobal("fetch", fetchStub(githubRoutes([1, 2])).fetch);

    const res = await request(app)
      .get(`/api/connections/github/callback?installation_id=55&code=c&state=${state(userId)}`)
      .set("Cookie", cookie);

    expect(res.headers.location).toContain("error=github_install_forbidden");
    expect(await prisma.forgeConnection.count()).toBe(0);
  });

  it("refuses a state issued to another user", async () => {
    const other = await createUser("other@example.com");
    vi.stubGlobal("fetch", fetchStub(githubRoutes([55])).fetch);

    const res = await request(app)
      .get(`/api/connections/github/callback?installation_id=55&code=c&state=${state(other.user.id)}`)
      .set("Cookie", cookie);

    expect(res.headers.location).toContain("error=github_install_failed");
    expect(await prisma.forgeConnection.count()).toBe(0);
  });

  it("reports an installation awaiting org approval", async () => {
    const res = await request(app)
      .get(`/api/connections/github/callback?setup_action=request&state=${state(userId)}`)
      .set("Cookie", cookie);

    expect(res.headers.location).toContain("error=github_pending_approval");
  });
});
