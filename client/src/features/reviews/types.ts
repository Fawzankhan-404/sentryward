// Mirrors the server's review result (server/src/review/core/models.ts),
// schemaVersion 1, as served by GET /api/reviews/:id.

export type Severity = "critical" | "major" | "minor" | "info"
export type Bucket = "actionable" | "outside_diff" | "nitpick" | "requirement_gap"
export type JobStatus = "queued" | "running" | "completed" | "partial" | "failed" | "superseded" | "skipped" | "cancelled"
export type Verdict = "pass" | "blocked" | "error"
export type Provider = "github" | "gitlab"
export type Trigger = "manual" | "webhook" | "comment"
export type IssueAssessment = "addressed" | "partial" | "not_addressed" | "unclear"

export interface IssueRef {
  ref: string
  title: string
  url?: string
  state: "open" | "closed"
}

export const SEVERITIES: Severity[] = ["critical", "major", "minor", "info"]
export const BUCKET_ORDER: Bucket[] = ["actionable", "requirement_gap", "outside_diff", "nitpick"]
export const BUCKET_TITLE: Record<Bucket, string> = {
  actionable: "Actionable comments",
  requirement_gap: "Requirements not met",
  outside_diff: "Outside diff range comments",
  nitpick: "Nitpick comments",
}

export interface Finding {
  file: string
  startLine: number
  endLine: number
  severity: Severity
  category: string
  kind: string
  effort: string
  title: string
  body: string
  suggestion?: string
  confidence: number
  evidence: string
  evidenceNote: string
  evidenceFiles: string[]
  source: "llm" | "tool" | "rule"
  tool?: string
  fingerprint: string
  // The model of the review pass that raised it; absent for tool and rule
  // findings and older results.
  model?: string
  bucket: Bucket
}

export interface Omission {
  path: string
  reason: string
  detail?: string
}

export interface UsageTotals {
  calls: number
  inputTokens: number
  outputTokens: number
}

export interface ReviewSummary {
  title: string
  webUrl?: string
  total: number
  bySeverity: Partial<Record<Severity, number>>
  byBucket: Partial<Record<Bucket, number>>
  hasBlocking: boolean
  // Absent on runs stored before the digest carried token totals.
  usageTotals?: UsageTotals
}

export interface ReviewResult {
  schemaVersion: 1
  status: "completed" | "partial" | "failed"
  errors: string[]
  warnings: string[]
  change: {
    provider: Provider
    host: string
    project: string
    number: number
    baseSha: string
    headSha: string
    webUrl?: string
    title: string
    baseRef?: string
    headRef?: string
    isDraft: boolean
  }
  files: { path: string; changeType: string; additions: number; deletions: number }[]
  findings: Finding[]
  walkthrough?: {
    overview: string
    fileSummaries: { path: string; summary: string }[]
    labels: string[]
    estimatedEffort: number
    // Optional parts, present only when their settings were on.
    sequenceDiagram?: string
    highLevelSummary?: string
    linkedIssues?: (IssueRef & { assessment: IssueAssessment; note: string })[]
    relatedIssues?: (IssueRef & { reason: string })[]
  }
  coverage: { reviewedFiles: string[]; omissions: Omission[]; passes: number }
  validation: { dropped: Record<string, number>; demoted: number }
  usage: { purpose: string; model: string; inputTokens: number; outputTokens: number; latencyMs: number }[]
  usageTotals: { calls: number; inputTokens: number; outputTokens: number }
  verdict: { verdict: Verdict; blockOn: Severity; blocking: string[] }
  summary: ReviewSummary
}

export interface ReviewListItem {
  id: string
  number: number
  headSha: string
  trigger: Trigger
  status: JobStatus
  verdict: Verdict | null
  summary: ReviewSummary | null
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  repository: { id: string; provider: Provider; host: string; fullPath: string }
  // Only in the "changes" view: matching runs of this change, this one included.
  runCount?: number
}

// An open pull/merge request, as GET /api/repos/:id/changes lists it.
export interface OpenChange {
  number: number
  title: string
  author?: string
  isDraft: boolean
  headSha: string
  sourceBranch: string
  targetBranch: string
  webUrl: string
  updatedAt: string
}

export interface Publication {
  inlinePosted: { fingerprint: string; forgeCommentId: string }[]
  inlineSkipped: number
  inlineFailed: { fingerprint: string; error: string }[]
  summaryCommentId: string | null
  statusState: string | null
  errors: string[]
}

export interface ReviewDetail extends ReviewListItem {
  baseSha: string | null
  attempts: number
  result: ReviewResult | null
  publication: Publication | null
}

export interface ReviewStats {
  days: number
  runs: number
  blocked: number
  passed: number
  failed: number
  // Milliseconds from start to finish of completed runs; null when none finished.
  duration: { median: number | null; max: number | null }
  // Summed over the period; runs stored before token digests count as zero.
  tokens: UsageTotals
}

export function isActive(status: JobStatus) {
  return status === "queued" || status === "running"
}
