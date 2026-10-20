import { env } from "../config/env.ts";
import { DecryptError, decrypt } from "../lib/crypto.ts";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import {
  PROVIDERS,
  type ApiKeys,
  type ProviderBaseUrls,
  type ProviderName,
} from "../review/llm/providers.ts";

export type StoredLlmConnections = Partial<
  Record<ProviderName, { apiKey?: string; baseUrl?: string }>
>;

const ENV_KEYS: ApiKeys = {
  anthropic: env.ANTHROPIC_API_KEY || undefined,
  openai: env.OPENAI_API_KEY || undefined,
  google: env.GOOGLE_GENERATIVE_AI_API_KEY || undefined,
};

// A key the repository's workspace stored wins over the server-wide one, so
// its reviews bill to it.
export async function apiKeysFor(workspaceId: string): Promise<ApiKeys> {
  return (await llmCredentialsFor(workspaceId)).keys;
}

export async function requireStoredLlmConnection(workspaceId: string, provider: ProviderName) {
  const connection = await prisma.llmCredential.findUnique({
    where: { workspaceId_provider: { workspaceId, provider } },
    select: { id: true },
  });
  if (!connection) {
    throw new HttpError(400, "Validation failed", {
      connection: ["Select a connection configured in Settings > API keys"],
    });
  }
}

// The job's error is what the user reads, so a key saved under another
// ENCRYPTION_KEY says what to do instead of surfacing the GCM failure.
function decryptStoredKey(provider: ProviderName, encryptedKey: string): string {
  try {
    return decrypt(encryptedKey);
  } catch (error) {
    if (error instanceof DecryptError) {
      throw new Error(`The stored ${provider} API key can't be decrypted; re-enter it in Settings > API keys`);
    }
    throw error;
  }
}

export async function llmCredentialsFor(
  workspaceId: string,
): Promise<{ keys: ApiKeys; baseUrls: ProviderBaseUrls; connections: StoredLlmConnections }> {
  const stored = await prisma.llmCredential.findMany({ where: { workspaceId } });
  const keys: ApiKeys = { ...ENV_KEYS };
  const baseUrls: ProviderBaseUrls = {};
  const connections: StoredLlmConnections = {};
  for (const credential of stored) {
    if (PROVIDERS.includes(credential.provider as ProviderName)) {
      const provider = credential.provider as ProviderName;
      const apiKey = credential.encryptedKey ? decryptStoredKey(provider, credential.encryptedKey) : undefined;
      const baseUrl = credential.baseUrl ?? undefined;
      if (apiKey) keys[provider] = apiKey;
      if (baseUrl) baseUrls[provider] = baseUrl;
      connections[provider] = { apiKey, baseUrl };
    }
  }
  return { keys, baseUrls, connections };
}
