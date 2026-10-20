import { randomBytes } from "node:crypto";
import { env } from "../config/env.ts";
import { DecryptError, decrypt, encrypt } from "../lib/crypto.ts";
import { prisma } from "../lib/prisma.ts";
import type { ForgeConnection, Repository } from "../generated/prisma/client.ts";
import { forgeName } from "../review/forge/providers.ts";
import { adapterForConnection } from "./forge.ts";
import { providerFor, type WebhookState } from "./providers/index.ts";

export type { WebhookState } from "./providers/index.ts";

export function webhookUrl(provider: string, repositoryId: string): string {
  return `${env.API_PUBLIC_URL.replace(/\/+$/, "")}/api/webhooks/${provider}/${repositoryId}`;
}

export async function ensureWebhook(repo: Repository, connection: ForgeConnection): Promise<WebhookState> {
  const appState = providerFor(connection.provider).appWebhook?.(connection);
  if (appState) return appState;
  if (repo.webhookId) return { active: true };

  const secret = randomBytes(32).toString("hex");
  try {
    const webhookId = await adapterForConnection(connection).createHook(repo, webhookUrl(repo.provider, repo.id), secret);
    await prisma.repository.update({
      where: { id: repo.id },
      data: { webhookId, encryptedWebhookSecret: encrypt(secret) },
    });
    return { active: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      active: false,
      error: `Automatic reviews are off: ${forgeName(repo.provider)} refused the webhook (${reason})`,
    };
  }
}

// Best effort: a hook left behind only delivers events Sentryward then ignores.
export async function removeWebhook(repo: Repository, connection: ForgeConnection): Promise<void> {
  if (providerFor(connection.provider).appWebhook?.(connection) || !repo.webhookId) return;
  const hookId = repo.webhookId;
  await adapterForConnection(connection)
    .deleteHook(repo, hookId)
    .catch((err: unknown) => {
      console.warn(`Could not remove ${repo.provider} hook ${hookId} from ${repo.fullPath}`, err);
    });
  await prisma.repository.update({
    where: { id: repo.id },
    data: { webhookId: null, encryptedWebhookSecret: null },
  });
}

// A secret saved under another ENCRYPTION_KEY verifies nothing, so the hook
// gets the usual 401; re-enabling the repository registers a fresh one.
export function webhookSecret(repo: Repository): string | null {
  if (!repo.encryptedWebhookSecret) return null;
  try {
    return decrypt(repo.encryptedWebhookSecret);
  } catch (error) {
    if (!(error instanceof DecryptError)) throw error;
    console.warn(`Webhook secret for ${repo.fullPath} cannot be decrypted; re-enable the repository to replace it`);
    return null;
  }
}
