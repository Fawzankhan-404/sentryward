import { useEffect, useState } from "react"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { ForgeRepo, SavedRepo } from "@/features/forge/api"

export type LlmProviderName = "anthropic" | "openai" | "google" | "ollama"
export type ReviewTrigger = "manual" | "published" | "all"
export type SummaryTrigger = "manual" | "published"
export type HighLevelSummaryPlacement = "description" | "walkthrough"
export type VerifyMode = "off" | "blocking" | "all"

// A partial review config; mirrors server/src/review/config/schema.ts.
export interface ConfigOverride {
  profile?: string
  llm?: {
    model?: string
    fallbackModels?: string[]
    temperature?: number
    maxTokens?: number
    contextBudget?: number | null
    // A live reference to a connection saved in Settings > API keys.
    connection?: LlmProviderName | null
    // Legacy endpoint fields are accepted until the setting is saved again.
    baseUrl?: string | null
    endpointKey?: LlmProviderName | null
  }
  review?: {
    categories?: string[]
    severityFloor?: string
    blockOn?: string
    maxFindings?: number
    maxChunks?: number
    minConfidence?: number
    requireEvidence?: boolean
    suppressIgnored?: boolean
    fullFile?: boolean
    committableSuggestions?: boolean
    disableCache?: boolean
    fileContext?: boolean
    verify?: VerifyMode
  }
  output?: {
    walkthrough?: boolean
    postInline?: boolean
    postSummary?: boolean
    postCheck?: boolean
    resolveFixedThreads?: boolean
    reviewStats?: boolean
    agentPrompts?: boolean
    agentPromptAll?: boolean
    blastRadiusLabel?: boolean
    effortLabel?: boolean
    sequenceDiagrams?: boolean
    estimateEffort?: boolean
    assessLinkedIssues?: boolean
    relatedIssues?: boolean
    highLevelSummary?: boolean
    highLevelSummaryPlacement?: HighLevelSummaryPlacement
    highLevelSummaryInstructions?: string
  }
  triggers?: {
    review?: ReviewTrigger
    reviewOnPush?: boolean
    summary?: SummaryTrigger
    command?: boolean
    abortOnClose?: boolean
    ignoreTitles?: string[]
    skipAuthors?: string[]
    skipLabels?: string[]
    skipSourceBranches?: string[]
    skipTargetBranches?: string[]
    // Legacy, replaced by `review`: still read so older settings show what they mean.
    onPush?: boolean
    drafts?: boolean
  }
  ignorePaths?: string[]
  instructions?: string
  languageInstructions?: Record<string, string>
  [key: string]: unknown
}

export interface EffectiveConfig {
  profile: string
  llm: {
    model: string
    fallbackModels: string[]
    temperature: number
    maxTokens: number
    // null derives the prompt budget from the model's context window.
    contextBudget: number | null
    // The saved connection used for all model calls. Null is unconfigured.
    connection: LlmProviderName | null
    // One endpoint for every model call; null means each provider's official API.
    baseUrl: string | null
    // The stored key sent to baseUrl; null sends each model's own provider key.
    endpointKey: LlmProviderName | null
  }
  review: {
    categories: string[]
    severityFloor: string
    blockOn: string
    maxFindings: number
    maxChunks: number
    minConfidence: number
    requireEvidence: boolean
    suppressIgnored: boolean
    fullFile: boolean
    committableSuggestions: boolean
    disableCache: boolean
    fileContext: boolean
    verify: VerifyMode
  }
  output: {
    walkthrough: boolean
    postInline: boolean
    postSummary: boolean
    postCheck: boolean
    resolveFixedThreads: boolean
    reviewStats: boolean
    agentPrompts: boolean
    agentPromptAll: boolean
    blastRadiusLabel: boolean
    effortLabel: boolean
    sequenceDiagrams: boolean
    estimateEffort: boolean
    assessLinkedIssues: boolean
    relatedIssues: boolean
    highLevelSummary: boolean
    highLevelSummaryPlacement: HighLevelSummaryPlacement
    highLevelSummaryInstructions: string
  }
  triggers: {
    review: ReviewTrigger
    reviewOnPush: boolean
    summary: SummaryTrigger
    command: boolean
    abortOnClose: boolean
    ignoreTitles: string[]
    skipAuthors: string[]
    skipLabels: string[]
    skipSourceBranches: string[]
    skipTargetBranches: string[]
    onPush: boolean
    drafts: boolean
  }
  ignorePaths: string[]
  instructions: string
  languageInstructions: Record<string, string>
}

// What a review of a repository's default branch would run with.
export interface ResolvedConfig {
  ref: string
  repoFile: string | null
  warnings: string[]
  sources: Record<string, string>
  config: EffectiveConfig
}

// The saved global config and what it resolves to before any repository.
export interface GlobalConfig {
  settings: ConfigOverride
  warnings: string[]
  sources: Record<string, string>
  config: EffectiveConfig
}

export interface ConfigSchema {
  defaults: EffectiveConfig
  // Each profile's preset, applied directly above the defaults.
  profiles: Record<string, ConfigOverride>
  severities: string[]
  categories: string[]
}

export function useConfigSchema() {
  return useQuery({
    queryKey: ["config-schema"],
    queryFn: () => api<ConfigSchema>("/config/schema"),
    staleTime: Infinity,
  })
}

export function useGlobalConfig() {
  return useQuery({
    queryKey: ["global-config"],
    queryFn: () => api<GlobalConfig>("/config/global"),
  })
}

export function useSaveGlobalConfig() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (settings: ConfigOverride) =>
      api<GlobalConfig>("/config/global", { method: "PUT", body: JSON.stringify({ settings }) }),
    onSuccess: (data) => {
      queryClient.setQueryData(["global-config"], data)
      // Every repository's effective config sits on top of the global one.
      queryClient.invalidateQueries({ queryKey: ["repo-config"] })
    },
  })
}

export function useRepoConfig(repoId: string | null) {
  return useQuery({
    queryKey: ["repo-config", repoId],
    queryFn: () => api<ResolvedConfig>(`/repos/${repoId}/config`),
    enabled: Boolean(repoId),
  })
}

export function useSaveRepoSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ repoId, settings }: { repoId: string; settings: ConfigOverride }) =>
      api<{ repo: SavedRepo }>(`/repos/${repoId}`, { method: "PATCH", body: JSON.stringify({ settings }) }),
    onSuccess: (_data, { repoId }) => {
      queryClient.invalidateQueries({ queryKey: ["repos"] })
      queryClient.invalidateQueries({ queryKey: ["repo-config", repoId] })
    },
  })
}

export function useSetFollowGlobal() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ repo, followGlobal }: { repo: ForgeRepo; followGlobal: boolean }) =>
      api<{ repo: SavedRepo }>(`/repos/${repo.id}`, { method: "PATCH", body: JSON.stringify({ followGlobal }) }),
    onSuccess: (_data, { repo }) => {
      queryClient.invalidateQueries({ queryKey: ["repos"] })
      queryClient.invalidateQueries({ queryKey: ["repo-config", repo.id] })
    },
  })
}

export type ForgeProvider = "github" | "gitlab"

export interface PreviewDiffLine {
  type: "add" | "context"
  oldLine: number | null
  newLine: number
  text: string
}

// What a review of the server's sample change would post with some settings;
// mirrors server/src/review/preview/preview.ts.
export interface PreviewPublication {
  provider: ForgeProvider
  pr: {
    title: string
    number: number
    author: string
    sourceBranch: string
    targetBranch: string
    labels: string[]
    // The description after publishing, with the high-level summary when it goes there.
    description: string
  }
  status: { state: "pending" | "success" | "failure" | "error"; description: string } | null
  summaryComment: string | null
  walkthroughComment: string | null
  inline: { path: string; startLine: number; endLine: number; body: string; diff: PreviewDiffLine[] }[]
}

export interface PreviewRequest {
  provider: ForgeProvider
  base: ConfigOverride
  settings: ConfigOverride
}

// The value once it has stopped changing for `delay` ms.
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return settled
}

// Re-rendered as the form changes, a little after typing stops; the previous
// preview stays up while the next one loads. `body` is null while the form
// cannot be previewed (invalid values, or nothing inherited yet).
export function useConfigPreview(body: PreviewRequest | null) {
  const queryClient = useQueryClient()
  const key = body ? JSON.stringify(body) : null
  const settled = useDebounced(key, 300)
  return useQuery({
    queryKey: ["config-preview", settled],
    queryFn: () => api<PreviewPublication>("/config/preview", { method: "POST", body: settled! }),
    enabled: settled !== null,
    // While the next preview loads, or the form cannot be previewed, show the
    // last one, even if the preview was unmounted in between (switching tabs).
    placeholderData: (previous) => {
      if (previous) return keepPreviousData(previous)
      const latest = queryClient
        .getQueryCache()
        .findAll({ queryKey: ["config-preview"] })
        .filter((query) => query.state.data !== undefined)
        .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)[0]
      return latest?.state.data as PreviewPublication | undefined
    },
    staleTime: Infinity,
  })
}
