import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"

const API_KEYS_QUERY_KEY = ["settings", "api-keys"]

export type LlmProvider = "anthropic" | "openai" | "google" | "ollama"
export type LlmConnectionStatus = "active" | "revoked" | "unreachable"

// Shared with the status filter and the status badge so both read the same.
export const STATUS_LABELS: Record<LlmConnectionStatus, string> = {
  active: "Active",
  revoked: "Inactive",
  unreachable: "Unknown",
}

export interface ApiKey {
  provider: LlmProvider
  stored: boolean
  last4: string | null
  // Saved under a different server ENCRYPTION_KEY; only replacing it helps.
  undecryptable: boolean
  baseUrl: string | null
  updatedAt: string | null
  serverDefault: boolean
}

export function useApiKeys() {
  return useQuery({
    queryKey: API_KEYS_QUERY_KEY,
    queryFn: () => api<{ keys: ApiKey[] }>("/settings/api-keys"),
  })
}

function apiKeyStatusQuery(provider: LlmProvider) {
  return {
    queryKey: [...API_KEYS_QUERY_KEY, provider, "status"],
    queryFn: () => api<{ status: LlmConnectionStatus }>(`/settings/api-keys/${provider}/status`),
    staleTime: 60_000,
    retry: false,
  }
}

// Each provider is checked independently so one slow host does not delay the
// other badges. Undefined means its request is still in progress.
export function useApiKeyStatuses(keys: ApiKey[]): Partial<Record<LlmProvider, LlmConnectionStatus | undefined>> {
  return useQueries({
    queries: keys.map((key) => apiKeyStatusQuery(key.provider)),
    combine: (results) =>
      Object.fromEntries(
        results.map((result, index) => [
          keys[index]!.provider,
          result.isError ? "unreachable" : result.data?.status,
        ]),
      ),
  })
}

// Feeds the model pickers. Saving or deleting a key invalidates the api-keys
// prefix, so a changed connection lists afresh.
export function useLlmModels(provider: LlmProvider | null) {
  return useQuery({
    queryKey: [...API_KEYS_QUERY_KEY, provider, "models"],
    queryFn: () => api<{ models: string[] }>(`/settings/api-keys/${provider}/models`),
    enabled: Boolean(provider),
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export type ModelTestResult =
  | { ok: true; latencyMs: number; inputTokens: number; outputTokens: number }
  | { ok: false; reason: "revoked" | "model" | "unreachable" | "output"; message: string }

// A test changes nothing stored, so nothing is invalidated.
export function useTestLlmModel() {
  return useMutation({
    mutationFn: ({ provider, model }: { provider: LlmProvider; model: string }) =>
      api<{ result: ModelTestResult }>(`/settings/api-keys/${provider}/test`, {
        method: "POST",
        body: JSON.stringify({ model }),
      }),
  })
}

export function useSaveApiKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ provider, apiKey, baseUrl }: { provider: LlmProvider; apiKey?: string; baseUrl?: string }) =>
      api<{ key: ApiKey }>(`/settings/api-keys/${provider}`, {
        method: "PUT",
        body: JSON.stringify({ apiKey: apiKey || undefined, baseUrl }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: API_KEYS_QUERY_KEY }),
  })
}

export function useDeleteApiKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (provider: LlmProvider) => api<void>(`/settings/api-keys/${provider}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: API_KEYS_QUERY_KEY }),
  })
}
