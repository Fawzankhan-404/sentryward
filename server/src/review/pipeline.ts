import type { Config } from "./config/schema.ts";
import { verdictFor, blockingFindings } from "./core/verdict.ts";
import {
  RESULT_SCHEMA_VERSION,
  type ChangeSet,
  type Finding,
  type LlmUsage,
  type Omission,
  type OmissionReason,
  type RejectedFinding,
  type ReviewResult,
  type ReviewStatus,
  type Walkthrough,
} from "./core/models.ts";
import { mapLimit } from "./core/mapLimit.ts";
import { contextTokenBudget, estimateTokens, diffTokenBudget } from "./context/budget.ts";
import { planChunks, type Chunk } from "./context/chunk.ts";
import { gatherContext, type ContextSource } from "./context/gather.ts";
import { classifyFiles } from "./context/ignore.ts";
import { MAX_MANIFEST_CHARS, MAX_REJECTED_CHARS, reviewSystemPrompt, type ManifestEntry } from "./llm/prompt.ts";
import type { Generate } from "./llm/providers.ts";
import { reviewChunk } from "./llm/review.ts";
import type { ModelFinding } from "./llm/schemas.ts";
import { generateWalkthrough, type WalkthroughIssues } from "./llm/walkthrough.ts";
import { compareFindings, validateFindings, type DropReason } from "./validate/validator.ts";
import { verifyFindings } from "./validate/verify.ts";

export interface ReviewDeps {
  generate: Generate;
  now?: () => Date;
  // Passes run concurrently up to this many at once.
  concurrency?: number;
  // Surrounding code for each pass, when review.fileContext is on. Absent
  // means the passes see the diff alone.
  context?: ContextSource;
}

export interface RunReviewInput {
  changeSet: ChangeSet;
  config: Config;
  // Carried into the result, e.g. an ignored repository config file.
  warnings?: string[];
  // Linked and candidate issues for the walkthrough, fetched by the caller.
  issues?: WalkthroughIssues;
  // Fingerprints this team dismissed on this change: a match is dropped before
  // it can be reported again. Fetched by the caller (see worker/runJob.ts).
  ignoredFingerprints?: ReadonlySet<string>;
  // Recent repo-wide dismissals, listed in the prompt so the model learns what
  // this team rejects. Fetched by the caller.
  rejectedFindings?: RejectedFinding[];
  // Review only these files of the change, and keep the earlier review's
  // findings on the rest (worker/incremental.ts). Absent means a full review.
  increment?: Increment;
}

export interface Increment {
  fromSha: string;
  toSha: string;
  // Paths in the change touched by commits since `fromSha`.
  paths: ReadonlySet<string>;
  // Findings from the review of `fromSha` on files outside `paths`. Those
  // files are the same at both heads, so their lines still hold.
  carried: Finding[];
}

// Omissions that mean the change was not fully reviewed. Ignored, binary and
// deleted files were never meant to be.
const INCOMPLETE: ReadonlySet<OmissionReason> = new Set([
  "budget",
  "too_large",
  "patch_unavailable",
  "chunk_failed",
]);

// The title, description, guidance and previously-rejected list are bounded but
// not counted exactly, so they get a generous fixed allowance next to the
// measured system prompt. The last term covers the rejected section (its
// MAX_REJECTED_CHARS at ~4 chars/token) so it cannot crowd out the diff.
const USER_PROMPT_ALLOWANCE = 3_000 + Math.ceil(MAX_REJECTED_CHARS / 4);
// A multi-pass review also lists the whole change in every pass, capped at
// MAX_MANIFEST_CHARS.
const MANIFEST_ALLOWANCE = Math.ceil(MAX_MANIFEST_CHARS / 4);

function lineCounts(changeSet: ChangeSet): ReviewResult["files"] {
  return changeSet.files.map((file) => {
    let additions = 0;
    let deletions = 0;
    for (const hunk of file.hunks) {
      for (const line of hunk.content.split("\n").slice(1)) {
        if (line.startsWith("+")) additions += 1;
        else if (line.startsWith("-")) deletions += 1;
      }
    }
    return {
      path: file.path,
      ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      changeType: file.changeType,
      additions,
      deletions,
    };
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// One review, start to finish, with no I/O but the model calls. Every failure
// below the top is recorded in the result rather than thrown: a failed pass
// makes the review partial, a failed walkthrough is a warning.
export async function runReview(input: RunReviewInput, deps: ReviewDeps): Promise<ReviewResult> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const { changeSet, config } = input;
  const errors: string[] = [];
  const warnings = [...(input.warnings ?? [])];
  const usage: LlmUsage[] = [];

  const { reviewable, omissions: classified } = classifyFiles(changeSet.files, config.ignorePaths);
  // An incremental review plans passes over the files changed since the last
  // review only. The rest were reviewed then and are not omissions; the
  // walkthrough and manifest still describe the whole change.
  const { increment } = input;
  const scoped = increment ? reviewable.filter((file) => increment.paths.has(file.path)) : reviewable;
  let overhead = estimateTokens(reviewSystemPrompt(config)) + USER_PROMPT_ALLOWANCE;
  let plan = planChunks(scoped, diffTokenBudget(config, overhead), config.review.maxChunks);
  // Only a change that needs several passes gets the manifest, so only then is
  // it paid for, and a single-pass review is planned exactly as before. Should
  // the smaller budget ever leave one pass, the prompt simply omits the list.
  const multiPass = plan.chunks.length > 1;
  if (multiPass) {
    overhead += MANIFEST_ALLOWANCE;
    plan = planChunks(scoped, diffTokenBudget(config, overhead), config.review.maxChunks);
  }
  const omissions: Omission[] = [...classified, ...plan.omissions];

  const walkthroughTask: Promise<Walkthrough | undefined> =
    config.output.walkthrough && reviewable.length > 0
      ? generateWalkthrough(deps.generate, changeSet, reviewable, config, input.issues).then(
          ({ walkthrough, usage: callUsage }) => {
            usage.push(callUsage);
            return walkthrough;
          },
          (err: unknown) => {
            warnings.push(`Walkthrough failed: ${errorMessage(err)}`);
            return undefined;
          },
        )
      : Promise.resolve(undefined);

  // Gathered after planning, into whatever budget each pass has left, so it
  // can never cost the diff a hunk.
  let chunks: Chunk[] = plan.chunks;
  if (config.review.fileContext && deps.context && chunks.length > 0) {
    try {
      const gathered = await gatherContext({
        chunks,
        changeSet,
        source: deps.context,
        budgetFor: (chunk) => contextTokenBudget(config, overhead, chunk.tokens),
        concurrency: deps.concurrency ?? 3,
      });
      chunks = chunks.map((chunk, index) => ({ ...chunk, context: gathered.contexts[index] ?? "" }));
      warnings.push(...gathered.warnings);
    } catch (err) {
      warnings.push(`Review context failed, the diff was reviewed without it: ${errorMessage(err)}`);
    }
  }

  // Several passes wait for the walkthrough (started above, alongside context
  // gathering) so each can be told what the files it cannot see do. A failed
  // walkthrough still leaves the file list.
  let manifest: ManifestEntry[] | undefined;
  if (multiPass) {
    const summaries = new Map(((await walkthroughTask)?.fileSummaries ?? []).map((entry) => [entry.path, entry.summary]));
    const paths = new Set(reviewable.map((file) => file.path));
    manifest = lineCounts(changeSet)
      .filter((file) => paths.has(file.path))
      .map((file) => {
        const summary = summaries.get(file.path);
        return summary ? { ...file, summary } : file;
      });
  }

  const raw: ModelFinding[] = [];
  let failedPasses = 0;
  const outcomes = await mapLimit(chunks, deps.concurrency ?? 3, async (chunk) => {
    try {
      return {
        chunk,
        review: await reviewChunk(deps.generate, changeSet, chunk, chunks.length, config, input.rejectedFindings, manifest),
      };
    } catch (err) {
      return { chunk, error: errorMessage(err) };
    }
  });
  for (const outcome of outcomes) {
    if (outcome.review) {
      raw.push(...outcome.review.findings);
      usage.push(outcome.review.usage);
      continue;
    }
    failedPasses += 1;
    errors.push(`Review pass ${outcome.chunk.index} failed: ${outcome.error}`);
    for (const part of outcome.chunk.parts) {
      omissions.push({ path: part.file.path, reason: "chunk_failed", detail: `pass ${outcome.chunk.index}` });
    }
  }
  const walkthrough = await walkthroughTask;

  // Files only count as reviewed if a pass that included them succeeded and
  // none of their hunks were left out.
  const incomplete = new Set(omissions.filter((o) => INCOMPLETE.has(o.reason)).map((o) => o.path));
  const succeeded = outcomes.filter((outcome) => outcome.review).flatMap((outcome) => outcome.chunk.parts);
  const reviewedFiles = [...new Set(succeeded.map((part) => part.file.path))].filter((path) => !incomplete.has(path));
  const validation = validateFindings(
    raw,
    changeSet,
    scoped.filter((file) => succeeded.some((part) => part.file === file)),
    config,
    input.ignoredFingerprints,
  );
  // After validation, so only findings that would be published are checked,
  // and before the verdict, so a refuted blocker cannot fail the status.
  const verified = await verifyFindings({
    findings: validation.findings,
    changeSet,
    chunks: outcomes.filter((outcome) => outcome.review).map((outcome) => outcome.chunk),
    config,
    generate: deps.generate,
    concurrency: deps.concurrency ?? 3,
    ignoredFingerprints: input.ignoredFingerprints,
  });
  usage.push(...verified.usage);
  warnings.push(...verified.warnings);
  // Carried findings join after validation and verification: they passed both
  // when first reported, and only a dismissal since then removes them. A file
  // ignored since then drops its findings too, as a full review would (the
  // worker reviews in full when ignore_paths changes, this keeps it true here).
  const fresh = new Set(verified.findings.map((finding) => finding.fingerprint));
  const reviewablePaths = new Set(reviewable.map((file) => file.path));
  const carried = (increment?.carried ?? []).filter(
    (finding) =>
      !increment?.paths.has(finding.file) &&
      reviewablePaths.has(finding.file) &&
      !fresh.has(finding.fingerprint) &&
      !input.ignoredFingerprints?.has(finding.fingerprint),
  );
  const findings = carried.length ? [...verified.findings, ...carried].sort(compareFindings) : verified.findings;
  const dropped: Partial<Record<DropReason, number>> = { ...validation.dropped };
  for (const [reason, count] of Object.entries(verified.dropped) as [DropReason, number][]) {
    dropped[reason] = (dropped[reason] ?? 0) + count;
  }

  let status: ReviewStatus = "completed";
  if (plan.chunks.length > 0 && failedPasses === plan.chunks.length) status = "failed";
  else if (omissions.some((omission) => INCOMPLETE.has(omission.reason))) status = "partial";

  const blockOn = config.review.blockOn;
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    status,
    errors,
    warnings,
    change: {
      ...changeSet.forgeRef,
      title: changeSet.title,
      ...(changeSet.baseRef ? { baseRef: changeSet.baseRef } : {}),
      ...(changeSet.headRef ? { headRef: changeSet.headRef } : {}),
      isDraft: changeSet.isDraft,
    },
    files: lineCounts(changeSet),
    findings,
    ...(walkthrough ? { walkthrough } : {}),
    ...(increment
      ? {
          incremental: {
            fromSha: increment.fromSha,
            toSha: increment.toSha,
            files: scoped.map((file) => file.path),
            carried: carried.length,
          },
        }
      : {}),
    coverage: { reviewedFiles, omissions, passes: plan.chunks.length },
    validation: { dropped, demoted: validation.demoted + verified.demoted },
    usage,
    verdict: {
      verdict: verdictFor(status, findings, blockOn),
      blockOn,
      blocking: blockingFindings(findings, blockOn).map((finding) => finding.fingerprint),
    },
    startedAt,
    finishedAt: now().toISOString(),
  };
}
