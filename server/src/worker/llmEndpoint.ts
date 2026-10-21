import type { Config } from "../review/config/schema.ts";
import { missingKeys, type ApiKeys, type Endpoint, type ProviderBaseUrls } from "../review/llm/providers.ts";
import type { StoredLlmConnections } from "../services/llm.ts";

export interface LlmCredentials {
  keys: ApiKeys;
  baseUrls: ProviderBaseUrls;
  connections: StoredLlmConnections;
}

export interface ResolvedLlm {
  keys: ApiKeys;
  baseUrls: ProviderBaseUrls;
  endpoint: Endpoint | undefined;
  // The configured fallbacks that have a key; the rest are named in warnings.
  fallbackModels: string[];
  warnings: string[];
}

// Where the models a job will call are reached, and with which keys. Throws
// before anything is posted when a model the job needs cannot be called; only
// the `models` passed are checked, so a model for a pass that is off never
// fails the job.
export function resolveLlm(config: Config, models: string[], credentials: LlmCredentials): ResolvedLlm {
  const { keys, baseUrls, connections } = credentials;
  const { connection, baseUrl, endpointKey } = config.llm;
  let endpoint: Endpoint | undefined;
  if (connection) {
    const selected = connections[connection];
    if (!selected) {
      throw new Error(`The selected ${connection} LLM connection no longer exists: configure it in settings`);
    }
    if (selected.baseUrl) {
      endpoint = { baseUrl: selected.baseUrl, apiKey: selected.apiKey };
    } else {
      const incompatible = [...models, ...config.llm.fallbackModels].find(
        (model) => model.split("/")[0] !== connection,
      );
      if (incompatible) {
        throw new Error(
          `The ${connection} LLM connection uses its official API and cannot run model ${incompatible}`,
        );
      }
    }
  } else if (baseUrl) {
    // Compatibility for settings saved before connections were referenced live.
    if (endpointKey && !keys[endpointKey]) {
      throw new Error(`No API key for ${endpointKey}: store one in settings or configure it on the server`);
    }
    endpoint = { baseUrl, apiKey: endpointKey ? keys[endpointKey] : undefined };
  } else {
    throw new Error("No LLM connection selected: choose one in Configuration > LLM Config");
  }
  const unkeyed = models.find((model) => missingKeys([model], keys, endpoint, baseUrls).length > 0);
  if (unkeyed) {
    const provider = unkeyed.split("/")[0];
    throw new Error(`No API key for ${provider}: store one in settings or configure it on the server`);
  }
  const warnings: string[] = [];
  const fallbackModels = config.llm.fallbackModels.filter((model) => {
    const usable = missingKeys([model], keys, endpoint, baseUrls).length === 0;
    if (!usable) warnings.push(`Fallback model ${model} skipped: no API key for its provider`);
    return usable;
  });
  return { keys, baseUrls, endpoint, fallbackModels, warnings };
}
