import type { Finding, Provider, ReviewResult, Severity } from "@/features/reviews/types"

// Mirrors the server's findings table (server/prisma/schema.prisma), as served
// by GET /api/findings.

export type FindingState = "open" | "resolved" | "ignored"
export type IgnoreReason = "false_positive" | "intentional" | "fix_later" | "not_specified"
export type FindingCategory =
  | "security"
  | "bug"
  | "performance"
  | "logic"
  | "reliability"
  | "maintainability"
  | "testing"
  | "style"
  | "docs"
export type FindingKind = "potential_issue" | "refactor_suggestion" | "nitpick" | "verification_needed" | "requirement_gap"

export interface FindingRow {
  id: string
  number: number
  state: FindingState
  title: string
  file: string
  startLine: number
  severity: Severity
  category: FindingCategory
  kind: FindingKind
  changeTitle: string
  author: string | null
  // Null once the run it came from is deleted.
  lastJobId: string | null
  firstSeenAt: string
  lastSeenAt: string
  resolvedAt: string | null
  ignoredAt: string | null
  // Set only while the finding is ignored.
  ignoreReason: IgnoreReason | null
  ignoreNote: string | null
  repository: { id: string; provider: Provider; host: string; fullPath: string }
}

export interface FindingStats {
  days: number
  open: number
  openBySeverity: Record<Severity, number>
  resolved: number
  total: number
  // Null when nothing was found in the period.
  resolutionRate: number | null
  // Open findings first seen before the period.
  staleOpen: number
  // Milliseconds, over findings resolved in the period; null when there were none.
  medianTimeToResolve: number | null
  falsePositives: number
  // Everything first seen in the period, ignored findings included.
  found: number
  falsePositiveRate: number | null
  // The same population as `found`, grouped. Only groups with findings appear.
  falsePositivesBy: {
    category: FalsePositiveRow<FindingCategory>[]
    severity: FalsePositiveRow<Severity>[]
    // The model the last run reporting the finding was configured with; null
    // when that run is gone.
    model: FalsePositiveRow<string | null>[]
  }
}

export interface FalsePositiveRow<K> {
  key: K
  found: number
  falsePositives: number
  rate: number | null
}

// GET /api/findings/:id: the row, plus the full finding and its change from the
// run that last reported it, when that run and its result are still readable.
export interface FindingDetail {
  finding: FindingRow
  detail: Finding | null
  change: ReviewResult["change"] | null
}

export type FindingSortKey = "title" | "number" | "repository" | "state" | "severity" | "category" | "kind" | "author"
