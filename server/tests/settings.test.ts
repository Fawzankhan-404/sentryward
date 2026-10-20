import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.ts";
import { decrypt, encrypt } from "../src/lib/crypto.ts";
import { hashPassword } from "../src/lib/password.ts";
import { prisma } from "../src/lib/prisma.ts";
import { apiKeysFor, llmCredentialsFor } from "../src/services/llm.ts";
import { encryptWithOtherKey } from "./helpers/foreignKey.ts";
import { createUser } from "./helpers/users.ts";

const PASSWORD = "correct-horse";

let cookie: string;
let userId: string;
let workspaceId: string;

beforeEach(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const body = String(input).includes("generativelanguage") ? { models: [] } : { data: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  ({ cookie, user: { id: userId }, workspace: { id: workspaceId } } = await createUser());
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(PASSWORD) } });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma.$disconnect();
});

describe("authentication", () => {
  it.each([
    ["patch", "/api/settings/profile"],
    ["put", "/api/settings/password"],
    ["get", "/api/settings/api-keys"],
    ["get", "/api/settings/api-keys/anthropic/status"],
    ["get", "/api/settings/api-keys/anthropic/models"],
    ["put", "/api/settings/api-keys/anthropic"],
    ["delete", "/api/settings/api-keys/anthropic"],
    ["delete", "/api/settings/account"],
  ] as const)("%s %s requires a session", async (method, path) => {
    const res = await request(app)[method](path).send({});
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/settings/profile", () => {
  it("updates the name and email", async () => {
    const res = await request(app)
      .patch("/api/settings/profile")
      .set("Cookie", cookie)
      .send({ name: "Ada", email: " Ada@Example.com " });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: userId, name: "Ada", email: "ada@example.com" });
    expect(res.body.user.passwordHash).toBeUndefined();

    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(me.body.user).toMatchObject({ name: "Ada", email: "ada@example.com" });
  });

  it("keeps the current email when it is sent unchanged", async () => {
    const res = await request(app)
      .patch("/api/settings/profile")
      .set("Cookie", cookie)
      .send({ name: "Dev", email: "dev@example.com" });
    expect(res.status).toBe(200);
  });

  it("refuses an email another account uses", async () => {
    await createUser("taken@example.com");
    const res = await request(app)
      .patch("/api/settings/profile")
      .set("Cookie", cookie)
      .send({ email: "taken@example.com" });

    expect(res.status).toBe(409);
    expect(res.body.errors.email).toBeDefined();
  });

  it("validates the input", async () => {
    const res = await request(app).patch("/api/settings/profile").set("Cookie", cookie).send({ email: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.errors.email).toBeDefined();
  });
});

describe("PUT /api/settings/password", () => {
  it("rejects a wrong current password", async () => {
    const res = await request(app)
      .put("/api/settings/password")
      .set("Cookie", cookie)
      .send({ currentPassword: "wrong", newPassword: "new-password", confirmPassword: "new-password" });

    expect(res.status).toBe(400);
    expect(res.body.errors.currentPassword).toEqual(["Password is incorrect"]);
  });

  it("requires the confirmation to match", async () => {
    const res = await request(app)
      .put("/api/settings/password")
      .set("Cookie", cookie)
      .send({ currentPassword: PASSWORD, newPassword: "new-password", confirmPassword: "other" });

    expect(res.status).toBe(400);
    expect(res.body.errors.confirmPassword).toBeDefined();
  });

  it("changes the password used to log in", async () => {
    const res = await request(app)
      .put("/api/settings/password")
      .set("Cookie", cookie)
      .send({ currentPassword: PASSWORD, newPassword: "new-password", confirmPassword: "new-password" });
    expect(res.status).toBe(204);

    const oldLogin = await request(app).post("/api/auth/login").send({ email: "dev@example.com", password: PASSWORD });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: "dev@example.com", password: "new-password" });
    expect(newLogin.status).toBe(200);
  });
});

describe("/api/settings/api-keys", () => {
  it("lists every provider, stored or not", async () => {
    const res = await request(app).get("/api/settings/api-keys").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.keys.map((key: { provider: string }) => key.provider)).toEqual([
      "anthropic",
      "openai",
      "google",
      "ollama",
    ]);
    expect(res.body.keys[0]).toMatchObject({ stored: false, last4: null });
  });

  it("stores a key encrypted and only returns its last four characters", async () => {
    const res = await request(app)
      .put("/api/settings/api-keys/anthropic")
      .set("Cookie", cookie)
      .send({ apiKey: "sk-ant-secret-1234" });

    expect(res.status).toBe(200);
    expect(res.body.key).toMatchObject({ provider: "anthropic", stored: true, last4: "1234" });
    expect(JSON.stringify(res.body)).not.toContain("secret");

    const stored = await prisma.llmCredential.findFirstOrThrow({ where: { workspaceId } });
    expect(stored.encryptedKey).not.toContain("secret");
    expect(decrypt(stored.encryptedKey!)).toBe("sk-ant-secret-1234");
    expect((await apiKeysFor(workspaceId)).anthropic).toBe("sk-ant-secret-1234");

    const list = await request(app).get("/api/settings/api-keys").set("Cookie", cookie);
    expect(JSON.stringify(list.body)).not.toContain("secret");
    expect(list.body.keys[0]).toMatchObject({ stored: true, last4: "1234" });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toBe("https://api.anthropic.com/v1/models");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("sk-ant-secret-1234");
  });

  it("verifies and stores a normalized custom host", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(app)
      .put("/api/settings/api-keys/openai")
      .set("Cookie", cookie)
      .send({ apiKey: "router-secret", baseUrl: "http://router.test/v1/" });

    expect(res.status).toBe(200);
    expect(res.body.key).toMatchObject({ provider: "openai", baseUrl: "http://router.test/v1" });
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://router.test/v1/models");
    const stored = await prisma.llmCredential.findFirstOrThrow({ where: { workspaceId } });
    expect(stored.baseUrl).toBe("http://router.test/v1");
  });

  it("stores a verified Ollama host without an API key", async () => {
    const res = await request(app)
      .put("/api/settings/api-keys/ollama")
      .set("Cookie", cookie)
      .send({ baseUrl: "http://host.docker.internal:11434/v1" });

    expect(res.status).toBe(200);
    expect(res.body.key).toMatchObject({ provider: "ollama", stored: true, last4: null });
    const stored = await prisma.llmCredential.findFirstOrThrow({ where: { workspaceId } });
    expect(stored).toMatchObject({ provider: "ollama", encryptedKey: null });
    expect(await llmCredentialsFor(workspaceId)).toEqual({
      keys: {},
      baseUrls: { ollama: "http://host.docker.internal:11434/v1" },
      connections: { ollama: { apiKey: undefined, baseUrl: "http://host.docker.internal:11434/v1" } },
    });
  });

  it("does not persist a credential when the connection check fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));

    const res = await request(app)
      .put("/api/settings/api-keys/openai")
      .set("Cookie", cookie)
      .send({ apiKey: "invalid-key" });

    expect(res.status).toBe(400);
    expect(res.body.errors.apiKey).toEqual(["The API host rejected this key"]);
    expect(await prisma.llmCredential.count({ where: { workspaceId } })).toBe(0);
  });

  it("replaces an existing key", async () => {
    await request(app).put("/api/settings/api-keys/openai").set("Cookie", cookie).send({ apiKey: "sk-first-0001" });
    await request(app).put("/api/settings/api-keys/openai").set("Cookie", cookie).send({ apiKey: "sk-second-0002" });

    const stored = await prisma.llmCredential.findMany({ where: { workspaceId } });
    expect(stored).toHaveLength(1);
    expect(decrypt(stored[0]!.encryptedKey!)).toBe("sk-second-0002");
  });

  it("rejects an unknown provider", async () => {
    const res = await request(app)
      .put("/api/settings/api-keys/mistral")
      .set("Cookie", cookie)
      .send({ apiKey: "sk-whatever-123" });
    expect(res.status).toBe(400);
  });

  it("removes a key", async () => {
    await request(app).put("/api/settings/api-keys/google").set("Cookie", cookie).send({ apiKey: "AIza-key-9999" });

    const res = await request(app).delete("/api/settings/api-keys/google").set("Cookie", cookie);
    expect(res.status).toBe(204);
    expect(await prisma.llmCredential.count({ where: { workspaceId } })).toBe(0);

    const again = await request(app).delete("/api/settings/api-keys/google").set("Cookie", cookie);
    expect(again.status).toBe(404);
  });

  it("never touches another user's keys", async () => {
    const other = await createUser("other@example.com");
    await request(app)
      .put("/api/settings/api-keys/anthropic")
      .set("Cookie", other.cookie)
      .send({ apiKey: "sk-other-5555" });

    const res = await request(app).delete("/api/settings/api-keys/anthropic").set("Cookie", cookie);
    expect(res.status).toBe(404);
    expect(await prisma.llmCredential.count({ where: { workspaceId: other.workspace.id } })).toBe(1);
  });
});

describe("a key saved under another ENCRYPTION_KEY", () => {
  beforeEach(async () => {
    await prisma.llmCredential.create({
      data: { workspaceId, provider: "anthropic", encryptedKey: encryptWithOtherKey("sk-ant-old-1234") },
    });
    await prisma.llmCredential.create({
      data: { workspaceId, provider: "openai", encryptedKey: encrypt("sk-openai-5678") },
    });
  });

  it("is listed as unreadable without failing the other keys", async () => {
    const res = await request(app).get("/api/settings/api-keys").set("Cookie", cookie);

    expect(res.status).toBe(200);
    const byProvider = Object.fromEntries(res.body.keys.map((key: { provider: string }) => [key.provider, key]));
    expect(byProvider.anthropic).toMatchObject({ stored: true, last4: null, undecryptable: true });
    expect(byProvider.openai).toMatchObject({ stored: true, last4: "5678", undecryptable: false });
  });

  it("answers status and model requests with a 409", async () => {
    for (const path of ["status", "models"]) {
      const res = await request(app).get(`/api/settings/api-keys/anthropic/${path}`).set("Cookie", cookie);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/can't be decrypted/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("can be replaced or removed", async () => {
    const replaced = await request(app)
      .put("/api/settings/api-keys/anthropic")
      .set("Cookie", cookie)
      .send({ apiKey: "sk-ant-new-9999" });
    expect(replaced.status).toBe(200);
    expect(replaced.body.key).toMatchObject({ last4: "9999", undecryptable: false });

    expect((await request(app).delete("/api/settings/api-keys/anthropic").set("Cookie", cookie)).status).toBe(204);
  });

  it("fails a review's credential lookup with a readable message", async () => {
    await expect(llmCredentialsFor(workspaceId)).rejects.toThrow(
      "The stored anthropic API key can't be decrypted; re-enter it in Settings > API keys",
    );
  });
});

describe("GET /api/settings/api-keys/:provider/status", () => {
  async function storeCredential() {
    await prisma.llmCredential.create({
      data: { workspaceId, provider: "anthropic", encryptedKey: encrypt("sk-ant-secret-1234") },
    });
  }

  it("reports an accepted credential as active without exposing it", async () => {
    await storeCredential();

    const res = await request(app).get("/api/settings/api-keys/anthropic/status").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "active" });
    expect(JSON.stringify(res.body)).not.toContain("secret");
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toBe("https://api.anthropic.com/v1/models");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("sk-ant-secret-1234");
  });

  it.each([401, 403])("reports a credential rejected with %s as revoked", async (responseStatus) => {
    await storeCredential();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: responseStatus })));

    const res = await request(app).get("/api/settings/api-keys/anthropic/status").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "revoked" });
  });

  it.each([
    ["provider error", async () => new Response("{}", { status: 500 })],
    ["unsupported response", async () => new Response("{}", { status: 200 })],
    ["network failure", async () => Promise.reject(new Error("offline"))],
  ])("reports %s as unreachable", async (_case, response) => {
    await storeCredential();
    vi.stubGlobal("fetch", vi.fn(response));

    const res = await request(app).get("/api/settings/api-keys/anthropic/status").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "unreachable" });
  });

  it("returns 404 for a provider without a stored credential", async () => {
    const res = await request(app).get("/api/settings/api-keys/anthropic/status").set("Cookie", cookie);

    expect(res.status).toBe(404);
  });

  it("does not check another user's credential", async () => {
    const other = await createUser("other@example.com");
    await prisma.llmCredential.create({
      data: { workspaceId: other.workspace.id, provider: "anthropic", encryptedKey: encrypt("sk-ant-other-1234") },
    });

    const res = await request(app).get("/api/settings/api-keys/anthropic/status").set("Cookie", cookie);

    expect(res.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an unknown provider", async () => {
    const res = await request(app).get("/api/settings/api-keys/mistral/status").set("Cookie", cookie);

    expect(res.status).toBe(400);
  });
});

describe("GET /api/settings/api-keys/:provider/models", () => {
  function hostReturns(body: unknown, status = 200) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
  }

  it("lists the connection's models prefixed with its provider, without exposing the key", async () => {
    await prisma.llmCredential.create({
      data: { workspaceId, provider: "anthropic", encryptedKey: encrypt("sk-ant-secret-1234") },
    });
    hostReturns({ data: [{ id: "claude-sonnet-5-5" }, { id: "claude-haiku-4-5" }, { id: "claude-sonnet-5-5" }] });

    const res = await request(app).get("/api/settings/api-keys/anthropic/models").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ models: ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-5-5"] });
    expect(JSON.stringify(res.body)).not.toContain("secret");
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("sk-ant-secret-1234");
  });

  it("keeps only Gemini models that generate content", async () => {
    await prisma.llmCredential.create({ data: { workspaceId, provider: "google", encryptedKey: encrypt("AIza-key-9999") } });
    hostReturns({
      models: [
        { name: "models/gemini-3-pro", supportedGenerationMethods: ["generateContent", "countTokens"] },
        { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
      ],
    });

    const res = await request(app).get("/api/settings/api-keys/google/models").set("Cookie", cookie);

    expect(res.body).toEqual({ models: ["google/gemini-3-pro"] });
  });

  it("drops OpenAI's non-chat models from its official API but not from a proxy", async () => {
    const data = [{ id: "gpt-5" }, { id: "text-embedding-3-large" }, { id: "whisper-1" }];
    await prisma.llmCredential.create({ data: { workspaceId, provider: "openai", encryptedKey: encrypt("sk-openai-1234") } });
    hostReturns({ data });

    const official = await request(app).get("/api/settings/api-keys/openai/models").set("Cookie", cookie);
    expect(official.body).toEqual({ models: ["openai/gpt-5"] });

    await prisma.llmCredential.update({
      where: { workspaceId_provider: { workspaceId, provider: "openai" } },
      data: { baseUrl: "https://proxy.example.com/v1" },
    });
    const proxied = await request(app).get("/api/settings/api-keys/openai/models").set("Cookie", cookie);
    expect(proxied.body.models).toHaveLength(3);
    expect(String(vi.mocked(fetch).mock.calls[1]![0])).toBe("https://proxy.example.com/v1/models");
  });

  it("answers 400 when the host rejects the key", async () => {
    await prisma.llmCredential.create({
      data: { workspaceId, provider: "anthropic", encryptedKey: encrypt("sk-ant-secret-1234") },
    });
    hostReturns({}, 401);

    const res = await request(app).get("/api/settings/api-keys/anthropic/models").set("Cookie", cookie);

    expect(res.status).toBe(400);
  });

  it("returns 404 without a stored credential, including another user's", async () => {
    const other = await createUser("other@example.com");
    await prisma.llmCredential.create({
      data: { workspaceId: other.workspace.id, provider: "anthropic", encryptedKey: encrypt("sk-ant-other-1234") },
    });

    const res = await request(app).get("/api/settings/api-keys/anthropic/models").set("Cookie", cookie);

    expect(res.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/settings/account", () => {
  it("requires the password", async () => {
    const res = await request(app).delete("/api/settings/account").set("Cookie", cookie).send({ password: "wrong" });

    expect(res.status).toBe(400);
    expect(res.body.errors.password).toBeDefined();
    expect(await prisma.user.count({ where: { id: userId } })).toBe(1);
  });

  it("deletes the user with everything they own and signs them out", async () => {
    await prisma.llmCredential.create({ data: { workspaceId, provider: "anthropic", encryptedKey: "x" } });
    await prisma.forgeConnection.create({
      data: { workspaceId, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "dev" },
    });

    const res = await request(app).delete("/api/settings/account").set("Cookie", cookie).send({ password: PASSWORD });

    expect(res.status).toBe(204);
    expect(res.headers["set-cookie"]?.[0]).toMatch(/sentryward_token=;/);
    expect(await prisma.user.count({ where: { id: userId } })).toBe(0);
    expect(await prisma.llmCredential.count({ where: { workspaceId } })).toBe(0);
    expect(await prisma.forgeConnection.count({ where: { workspaceId } })).toBe(0);

    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(401);
  });

  it("refuses to delete the last admin while other users remain", async () => {
    await prisma.user.update({ where: { id: userId }, data: { role: "admin" } });
    await createUser("member@example.com");

    const res = await request(app).delete("/api/settings/account").set("Cookie", cookie).send({ password: PASSWORD });

    expect(res.status).toBe(409);
    expect(await prisma.user.count({ where: { id: userId } })).toBe(1);
  });

  it("lets the last admin delete their account when they are the only user", async () => {
    await prisma.user.update({ where: { id: userId }, data: { role: "admin" } });

    const res = await request(app).delete("/api/settings/account").set("Cookie", cookie).send({ password: PASSWORD });

    expect(res.status).toBe(204);
  });
});
