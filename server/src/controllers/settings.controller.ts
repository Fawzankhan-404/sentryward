import type { Request, Response } from "express";
import { env } from "../config/env.ts";
import { DecryptError, decrypt, encrypt } from "../lib/crypto.ts";
import { HttpError } from "../lib/httpError.ts";
import { hashPassword, verifyPassword } from "../lib/password.ts";
import { prisma } from "../lib/prisma.ts";
import { PROVIDERS, type ProviderName } from "../review/llm/providers.ts";
import {
  LlmConnectionError,
  listLlmModels,
  normalizeBaseUrl,
  verifyLlmConnection,
  type LlmConnectionStatus,
} from "../services/llmConnection.ts";
import {
  apiKeyParamsSchema,
  changePasswordSchema,
  deleteAccountSchema,
  saveApiKeySchema,
  updateProfileSchema,
} from "../schemas/settings.schema.ts";
import { assertAnotherAdminRemains } from "../services/admins.ts";
import { assertEmailAvailable, emailTaken, isUniqueViolation } from "../services/users.ts";
import { releaseWorkspaces } from "../services/workspaces.ts";
import { clearAuthCookie, publicUser } from "./auth.controller.ts";

const SERVER_KEYS: Record<ProviderName, boolean> = {
  anthropic: Boolean(env.ANTHROPIC_API_KEY),
  openai: Boolean(env.OPENAI_API_KEY),
  google: Boolean(env.GOOGLE_GENERATIVE_AI_API_KEY),
  ollama: false,
};

async function requirePassword(userId: string, password: string, field: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new HttpError(401, "Not authenticated");
  }
  if (!(await verifyPassword(user.passwordHash, password))) {
    throw new HttpError(400, "Validation failed", { [field]: ["Password is incorrect"] });
  }
  return user;
}

// Only the last four characters ever leave the server, so the user can tell keys apart.
// A key written under another ENCRYPTION_KEY is still listed, flagged, so it
// can be replaced or removed rather than failing the whole list.
function publicKey(
  provider: ProviderName,
  stored?: { encryptedKey: string | null; baseUrl: string | null; updatedAt: Date },
) {
  let last4: string | null = null;
  let undecryptable = false;
  if (stored?.encryptedKey) {
    try {
      last4 = decrypt(stored.encryptedKey).slice(-4);
    } catch (error) {
      if (!(error instanceof DecryptError)) throw error;
      undecryptable = true;
    }
  }
  return {
    provider,
    stored: Boolean(stored),
    last4,
    undecryptable,
    baseUrl: stored?.baseUrl ?? null,
    updatedAt: stored?.updatedAt ?? null,
    serverDefault: SERVER_KEYS[provider],
  };
}

export async function updateProfile(req: Request, res: Response) {
  const data = updateProfileSchema.parse(req.body);

  if (data.email) {
    await assertEmailAvailable(prisma, data.email, req.userId!);
  }

  try {
    const user = await prisma.user.update({ where: { id: req.userId }, data, select: publicUser });
    res.json({ user });
  } catch (error) {
    // Another account claimed the email between the check and the update.
    if (isUniqueViolation(error)) {
      throw emailTaken();
    }
    throw error;
  }
}

export async function changePassword(req: Request, res: Response) {
  const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
  await requirePassword(req.userId!, currentPassword, "currentPassword");
  await prisma.user.update({
    where: { id: req.userId },
    data: { passwordHash: await hashPassword(newPassword) },
  });
  res.status(204).end();
}

// A conflict rather than a 500: the row exists, but only re-entering it helps.
function storedApiKey(credential: { encryptedKey: string | null }): string | undefined {
  if (!credential.encryptedKey) return undefined;
  try {
    return decrypt(credential.encryptedKey);
  } catch (error) {
    if (error instanceof DecryptError) {
      throw new HttpError(409, "The stored key can't be decrypted; re-enter it");
    }
    throw error;
  }
}

export async function listApiKeys(req: Request, res: Response) {
  const stored = await prisma.llmCredential.findMany({ where: { workspaceId: req.workspaceId } });
  const byProvider = new Map(stored.map((credential) => [credential.provider, credential]));
  res.json({ keys: PROVIDERS.map((provider) => publicKey(provider, byProvider.get(provider))) });
}

// The stored secret stays server-side while the provider confirms whether it
// still accepts the credential. Provider outages are distinct from rejection.
export async function apiKeyStatus(req: Request, res: Response) {
  const { provider } = apiKeyParamsSchema.parse(req.params);
  const credential = await prisma.llmCredential.findUnique({
    where: { workspaceId_provider: { workspaceId: req.workspaceId!, provider } },
  });
  if (!credential) {
    throw new HttpError(404, "No key stored for this provider");
  }

  const apiKey = storedApiKey(credential);
  let status: LlmConnectionStatus;
  try {
    await verifyLlmConnection(provider, apiKey, credential.baseUrl ?? undefined);
    status = "active";
  } catch (error) {
    status = error instanceof LlmConnectionError && error.connectionStatus === "revoked" ? "revoked" : "unreachable";
  }
  res.json({ status });
}

// Feeds the model picker; a host that rejects the key or is down answers with
// the same 400 as saving, and the picker falls back to free text.
export async function apiKeyModels(req: Request, res: Response) {
  const { provider } = apiKeyParamsSchema.parse(req.params);
  const credential = await prisma.llmCredential.findUnique({
    where: { workspaceId_provider: { workspaceId: req.workspaceId!, provider } },
  });
  if (!credential) {
    throw new HttpError(404, "No key stored for this provider");
  }

  const models = await listLlmModels(provider, storedApiKey(credential), credential.baseUrl ?? undefined);
  res.json({ models });
}

export async function saveApiKey(req: Request, res: Response) {
  const { provider } = apiKeyParamsSchema.parse(req.params);
  const input = saveApiKeySchema.parse(req.body);
  const apiKey = input.apiKey || undefined;
  if (provider !== "ollama" && (!apiKey || apiKey.length < 8)) {
    throw new HttpError(400, "Validation failed", { apiKey: ["That does not look like an API key"] });
  }
  if (provider === "ollama" && !input.baseUrl) {
    throw new HttpError(400, "Validation failed", { baseUrl: ["Ollama requires an API base URL"] });
  }

  const baseUrl = input.baseUrl ? normalizeBaseUrl(input.baseUrl) : undefined;
  await verifyLlmConnection(provider, apiKey, baseUrl);
  const workspaceId = req.workspaceId!;
  const encryptedKey = apiKey ? encrypt(apiKey) : null;
  const credential = await prisma.llmCredential.upsert({
    where: { workspaceId_provider: { workspaceId, provider } },
    create: { workspaceId, provider, encryptedKey, baseUrl },
    update: { encryptedKey, baseUrl: baseUrl ?? null },
  });
  res.json({ key: publicKey(provider, credential) });
}

export async function deleteApiKey(req: Request, res: Response) {
  const { provider } = apiKeyParamsSchema.parse(req.params);
  const { count } = await prisma.llmCredential.deleteMany({ where: { workspaceId: req.workspaceId, provider } });
  if (count === 0) {
    throw new HttpError(404, "No key stored for this provider");
  }
  res.status(204).end();
}

// The personal workspace (connections, repositories, reviews, keys) cascades
// from the user row. The last admin can only leave once nobody else is left to
// administer, and team workspaces they own need another owner first.
export async function deleteAccount(req: Request, res: Response) {
  const { password } = deleteAccountSchema.parse(req.body);
  const user = await requirePassword(req.userId!, password, "password");
  await prisma.$transaction(async (tx) => {
    if (user.role === "admin" && (await tx.user.count()) > 1) {
      await assertAnotherAdminRemains(tx, user.id);
    }
    await releaseWorkspaces(tx, user.id, { promoteSuccessor: false });
    await tx.user.delete({ where: { id: user.id } });
  });
  clearAuthCookie(res);
  res.status(204).end();
}
