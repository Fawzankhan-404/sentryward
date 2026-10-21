import type { z } from "zod";
import type { ForgeConnection, Repository } from "../../generated/prisma/client.ts";
import type { ForgeAccount, ForgeAdapter, ForgeHooks, ForgePublisher } from "../../review/forge/types.ts";

export type Forge = ForgeAdapter & ForgePublisher & ForgeHooks;

export type RepoWithConnection = Repository & { connection: ForgeConnection };

export interface WebhookState {
  active: boolean;
  error?: string;
}

export interface WebhookOutcome {
  status?: number;
  body: Record<string, unknown>;
}

export type HeaderReader = (name: string) => string | undefined;

// How one forge plugs into connecting, API access and webhooks. See
// review/forge/providers.ts for the checklist to add a forge.
export interface ProviderDefinition {
  adapterFor(connection: ForgeConnection): Forge;
  // Proves the stored credentials still work; throws ForgeError when the forge
  // refuses them.
  checkCredentials(connection: ForgeConnection): Promise<void>;
  // Connecting with a host and a token the user pastes in.
  tokenConnect?: {
    schema: z.ZodType<{ host: string; token: string }, unknown>;
    account(host: string, token: string): Promise<ForgeAccount>;
  };
  // Whether this server has a browser connect flow configured for the forge
  // (GitHub App install, GitLab OAuth).
  appAvailable?(): boolean;
  // The webhook state when this connection's events arrive through an app, or
  // null when Sentryward registers a hook on each repository instead.
  appWebhook?(connection: ForgeConnection): WebhookState | null;
  // A hook Sentryward registered on one repository.
  repoWebhook: {
    verify(header: HeaderReader, raw: Buffer, secret: string): boolean;
    handle(repo: RepoWithConnection, header: HeaderReader, raw: Buffer): Promise<WebhookOutcome>;
  };
}
