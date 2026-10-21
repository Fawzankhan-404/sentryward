import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { Severity } from "@/features/reviews/types"
import type {
  FindingCategory,
  FindingDetail,
  FindingKind,
  FindingRow,
  FindingSortKey,
  FindingState,
  FindingStats,
  IgnoreReason,
} from "./types"

export interface FindingPage {
  findings: FindingRow[]
  total: number
  page: number
  limit: number
}

export interface FindingQuery {
  repoId?: string
  state?: FindingState
  ignoreReason?: IgnoreReason
  severity?: Severity
  category?: FindingCategory
  kind?: FindingKind
  q?: string
  sort?: FindingSortKey
  dir?: "asc" | "desc"
  page?: number
  limit?: number
}

// Only set params go into the URL, in a fixed order so query keys and stubs
// stay predictable.
function findingSearch(params: FindingQuery) {
  const search = new URLSearchParams()
  for (const key of ["repoId", "state", "ignoreReason", "severity", "category", "kind", "q", "sort", "dir", "page", "limit"] as const) {
    if (params[key]) search.set(key, String(params[key]))
  }
  return search.toString()
}

export function useFindings(params: FindingQuery = {}) {
  const query = findingSearch(params)
  return useQuery({
    queryKey: ["findings", params],
    queryFn: () => api<FindingPage>(`/findings${query ? `?${query}` : ""}`),
    // Keep the current page on screen while the next one loads.
    placeholderData: keepPreviousData,
  })
}

// Under the "findings" key, so ignoring or reopening one refreshes the cards too.
// Workspace-wide unless a repository is given.
export function useFindingStats(repoId?: string) {
  const query = findingSearch({ repoId })
  return useQuery({
    queryKey: ["findings", "stats", repoId ?? null],
    queryFn: () => api<FindingStats>(`/findings/stats${query ? `?${query}` : ""}`),
  })
}

// Under the "findings" key, so ignoring or reopening refreshes an open sheet too.
export function useFinding(id: string | null) {
  return useQuery({
    queryKey: ["findings", "detail", id],
    queryFn: () => api<FindingDetail>(`/findings/${id}`),
    enabled: id !== null,
  })
}

export type FindingStateChange =
  | { id: string; state: "open" }
  | { id: string; state: "ignored"; reason: IgnoreReason; note?: string }

export function useSetFindingState() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...change }: FindingStateChange) =>
      api<{ finding: FindingRow }>(`/findings/${id}`, { method: "PATCH", body: JSON.stringify(change) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["findings"] }),
  })
}
