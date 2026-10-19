import { z } from "zod";
import { categorySchema, effortSchema, evidenceSchema, kindSchema, severitySchema } from "./severity.ts";

// The intermediate representation every forge produces and every later stage
// reads. Line numbers are new-file coordinates everywhere; only publishers
// translate them into a forge's position payload.

export const forgeProviderSchema = z.enum(["github", "gitlab"]);
export type ForgeProvider = z.infer<typeof forgeProviderSchema>;

export const hunkSchema = z.object({
  oldStart: z.number().int().min(0),
  oldLines: z.number().int().min(0),
  newStart: z.number().int().min(0),
  newLines: z.number().int().min(0),
  header: z.string(),
  content: z.string(),
  // New-file lines this hunk adds; the only lines a finding may target unless
  // the review allows context lines.
  addedLines: z.array(z.number().int().positive()),
  // New-file line to its position in the file's patch (1 = the line below the
  // first @@). Covers added and context lines; a line missing here cannot carry
  // an inline comment.
  newLineToPosition: z.record(z.string(), z.number().int().positive()),
  // New-file line to old-file line for unchanged context lines. GitLab needs
  // both to anchor a comment on a line the change did not touch.
  contextOldLines: z.record(z.string(), z.number().int().positive()),
});
export type Hunk = z.infer<typeof hunkSchema>;

export const changeTypeSchema = z.enum(["added", "modified", "deleted", "renamed"]);
export type ChangeType = z.infer<typeof changeTypeSchema>;

export const changedFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  changeType: changeTypeSchema,
  language: z.string().optional(),
  isBinary: z.boolean(),
  // The forge withheld the patch (too large, or truncated); the file changed but
  // there is nothing to anchor against.
  patchUnavailable: z.boolean(),
  hunks: z.array(hunkSchema),
});
export type ChangedFile = z.infer<typeof changedFileSchema>;

export const forgeRefSchema = z.object({
  provider: forgeProviderSchema,
  host: z.string(),
  project: z.string(),
  number: z.number().int().positive(),
  baseSha: z.string(),
  startSha: z.string(),
  headSha: z.string(),
  webUrl: z.string().optional(),
});
export type ForgeRef = z.infer<typeof forgeRefSchema>;

export const changeSetSchema = z.object({
  forgeRef: forgeRefSchema,
  title: z.string(),
  description: z.string(),
  baseRef: z.string().optional(),
  headRef: z.string().optional(),
  isDraft: z.boolean(),
  // Login of whoever opened the change, and its labels, for the skip lists.
  author: z.string().optional(),
  labels: z.array(z.string()).optional(),
  files: z.array(changedFileSchema),
});
export type ChangeSet = z.infer<typeof changeSetSchema>;

export function diffPosition(file: ChangedFile, newLine: number): number | undefined {
  for (const hunk of file.hunks) {
    const position = hunk.newLineToPosition[String(newLine)];
    if (position !== undefined) {
      return position;
    }
  }
  return undefined;
}

export function isAddedLine(file: ChangedFile, newLine: number): boolean {
  return file.hunks.some((hunk) => hunk.addedLines.includes(newLine));
}

// ---------------------------------------------------------------------------
// Review result. Stored as JSONB on the job and rendered by every surface.
// ---------------------------------------------------------------------------

export const RESULT_SCHEMA_VERSION = 1;

export const bucketSchema = z.enum(["actionable", "outside_diff", "nitpick", "requirement_gap"]);
export type Bucket = z.infer<typeof bucketSchema>;

export const findingSchema = z.object({
  file: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  severity: severitySchema,
  category: categorySchema,
  kind: kindSchema,
  effort: effortSchema,
  title: z.string(),
  body: z.string(),
  // Verbatim replacement for startLine..endLine.
  suggestion: z.string().optional(),
  confidence: z.number().min(0).max(1),
  evidence: evidenceSchema,
  evidenceNote: z.string(),
  evidenceFiles: z.array(z.string()),
  source: z.enum(["llm", "static", "rule"]),
  ruleId: z.string().optional(),
  fingerprint: z.string(),
  // Decided once by core/buckets.ts so no surface can disagree about it.
  bucket: bucketSchema,
});
export type Finding = z.infer<typeof findingSchema>;

export const omissionReasonSchema = z.enum([
  "ignored",
  "binary",
  "deleted",
  "patch_unavailable",
  "too_large",
  "budget",
  "chunk_failed",
]);
export type OmissionReason = z.infer<typeof omissionReasonSchema>;

export const omissionSchema = z.object({
  path: z.string(),
  reason: omissionReasonSchema,
  detail: z.string().optional(),
});
export type Omission = z.infer<typeof omissionSchema>;

export const llmUsageSchema = z.object({
  purpose: z.enum(["review", "walkthrough", "verify"]),
  model: z.string(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  latencyMs: z.number().int().min(0),
  chunk: z.number().int().positive().optional(),
});
export type LlmUsage = z.infer<typeof llmUsageSchema>;

// An issue as the forge reports it. `ref` is how the model and the rendered
// comment name it, e.g. "#12".
export const issueRefSchema = z.object({
  ref: z.string(),
  title: z.string(),
  url: z.string().optional(),
  state: z.enum(["open", "closed"]),
});
export type IssueRef = z.infer<typeof issueRefSchema>;

// What the walkthrough reads about an issue; the body is never stored.
export type IssueContext = IssueRef & { body: string };

// A finding this team previously dismissed (false_positive/intentional), fed
// back into the review so the model does not report it again. The note is the
// user's own text and is treated as untrusted in the prompt.
export type RejectedFinding = { title: string; category: string; file: string; note?: string };

export const issueAssessmentSchema = z.enum(["addressed", "partial", "not_addressed", "unclear"]);
export type IssueAssessment = z.infer<typeof issueAssessmentSchema>;

export const walkthroughSchema = z.object({
  overview: z.string(),
  fileSummaries: z.array(z.object({ path: z.string(), summary: z.string() })),
  labels: z.array(z.string()),
  estimatedEffort: z.number().int().min(1).max(5),
  // Optional: results stored before it existed have none.
  blastRadius: z.enum(["small", "medium", "large"]).optional(),
  // Optional parts, each present only when its setting was on.
  sequenceDiagram: z.string().optional(),
  highLevelSummary: z.string().optional(),
  linkedIssues: z
    .array(issueRefSchema.extend({ assessment: issueAssessmentSchema, note: z.string() }))
    .optional(),
  relatedIssues: z.array(issueRefSchema.extend({ reason: z.string() })).optional(),
});
export type Walkthrough = z.infer<typeof walkthroughSchema>;

export const reviewStatusSchema = z.enum(["completed", "partial", "failed"]);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

export const verdictSchema = z.enum(["pass", "blocked", "error"]);
export type Verdict = z.infer<typeof verdictSchema>;

export const reviewResultSchema = z.object({
  schemaVersion: z.literal(RESULT_SCHEMA_VERSION),
  status: reviewStatusSchema,
  // Why the review is partial or failed.
  errors: z.array(z.string()),
  // Non-fatal: an ignored config file, a failed walkthrough.
  warnings: z.array(z.string()),
  change: forgeRefSchema.extend({
    title: z.string(),
    baseRef: z.string().optional(),
    headRef: z.string().optional(),
    isDraft: z.boolean(),
  }),
  files: z.array(
    z.object({
      path: z.string(),
      previousPath: z.string().optional(),
      changeType: changeTypeSchema,
      additions: z.number().int().min(0),
      deletions: z.number().int().min(0),
    }),
  ),
  findings: z.array(findingSchema),
  walkthrough: walkthroughSchema.optional(),
  // Set when only the files changed since an earlier completed review were
  // reviewed (worker/incremental.ts). `files` are the paths reviewed again;
  // `carried` counts the findings kept from that review for the other files.
  incremental: z
    .object({
      fromSha: z.string(),
      toSha: z.string(),
      files: z.array(z.string()),
      carried: z.number().int().min(0),
    })
    .optional(),
  coverage: z.object({
    reviewedFiles: z.array(z.string()),
    omissions: z.array(omissionSchema),
    passes: z.number().int().min(0),
  }),
  validation: z.object({
    // Reason to how many model findings it removed.
    dropped: z.record(z.string(), z.number().int().min(0)),
    demoted: z.number().int().min(0),
  }),
  usage: z.array(llmUsageSchema),
  verdict: z.object({
    verdict: verdictSchema,
    blockOn: severitySchema,
    blocking: z.array(z.string()),
  }),
  startedAt: z.string(),
  finishedAt: z.string(),
});
export type ReviewResult = z.infer<typeof reviewResultSchema>;
