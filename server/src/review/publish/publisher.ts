import type { Config } from "../config/schema.ts";
import type { ChangeSet, ReviewResult } from "../core/models.ts";
import type { ForgePublisher, PostedComment } from "../forge/types.ts";
import { WALKTHROUGH_MARKER, withDescriptionSummary } from "../core/markers.ts";
import { descriptionSummaryBlock, toMarkdown, walkthroughMarkdown, walkthroughOptions } from "../render/markdown.ts";
import { inlineComments } from "./inline.ts";
import { labelChanges } from "./labels.ts";
import { commitStatus } from "./status.ts";

export interface PublishInput {
  publisher: ForgePublisher;
  changeSet: ChangeSet;
  result: ReviewResult;
  config: Config;
  // Fingerprints already posted on this change, from the database.
  postedFingerprints: Set<string>;
  // Threads to resolve, or reopen (threadOperations): this run's transitions
  // plus earlier updates that failed.
  resolvedFingerprints?: string[];
  reopenedFingerprints?: string[];
  // Where the commit status links: the review in the dashboard.
  targetUrl?: string;
}

export interface Publication {
  inlinePosted: PostedComment[];
  inlineSkipped: number;
  inlineFailed: { fingerprint: string; error: string }[];
  summaryCommentId: string | null;
  statusState: string | null;
  // Where the walkthrough went, when it was published. Older rows may say
  // "description", from before it moved into the review comment.
  walkthroughLocation?: "description" | "comment" | null;
  labels?: string[];
  // Inline threads this run resolved or reopened, by fingerprint.
  threadsResolved?: string[];
  threadsReopened?: string[];
  // Threads that could not be moved; they are retried on the next run.
  threadsFailed?: string[];
  errors: string[];
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Inline comments, the summary and the commit status are published
// independently: one failing never stops the others, and each failure is
// recorded rather than thrown.
export async function publishReview(input: PublishInput): Promise<Publication> {
  const { publisher, changeSet, result, config } = input;
  const ref = changeSet.forgeRef;
  const publication: Publication = {
    inlinePosted: [],
    inlineSkipped: 0,
    inlineFailed: [],
    summaryCommentId: null,
    statusState: null,
    walkthroughLocation: null,
    labels: [],
    threadsResolved: [],
    threadsReopened: [],
    threadsFailed: [],
    errors: [],
  };
  const placement = summaryPlacement(config, result);

  // The summary goes first so it sits at the top of the conversation, above
  // the inline comments, even when no progress comment was posted.
  if (placement.summary !== null) {
    try {
      publication.summaryCommentId = await publisher.upsertSummaryComment(ref, placement.summary);
      if (placement.walkthrough) publication.walkthroughLocation = "comment";
    } catch (err) {
      publication.errors.push(`Summary comment failed: ${message(err)}`);
    }
  }

  if (placement.walkthroughComment !== null) {
    try {
      await publisher.upsertComment(ref, WALKTHROUGH_MARKER, placement.walkthroughComment);
      publication.walkthroughLocation = "comment";
    } catch (err) {
      publication.errors.push(`Summary comment failed: ${message(err)}`);
    }
  }

  if (config.output.postInline) {
    try {
      // The forge's own markers cover a database row that was never written.
      const onForge = await publisher.listPostedFingerprints(ref).catch(() => new Set<string>());
      const posted = new Set([...input.postedFingerprints, ...onForge]);
      const comments = inlineComments(result.findings, changeSet, ref.provider, posted, {
        agentPrompt: config.output.agentPrompts,
      });
      publication.inlineSkipped = result.findings.filter((f) => f.bucket === "actionable" && posted.has(f.fingerprint)).length;
      const outcome = await publisher.postInlineComments(ref, comments);
      publication.inlinePosted = outcome.posted;
      publication.inlineFailed = outcome.failed;
      if (outcome.failed.length) {
        publication.errors.push(`${outcome.failed.length} inline comment(s) could not be posted`);
      }
    } catch (err) {
      publication.errors.push(`Inline comments failed: ${message(err)}`);
    }
  }

  // Threads follow the findings table: only what this run resolved or brought
  // back is touched, so a thread someone resolved or reopened by hand stays so.
  if (resolvesThreads(config)) {
    const steps = [
      { prints: input.resolvedFingerprints ?? [], resolved: true, verb: "resolved" },
      { prints: input.reopenedFingerprints ?? [], resolved: false, verb: "reopened" },
    ] as const;
    for (const step of steps) {
      if (step.prints.length === 0) continue;
      try {
        const outcome = await publisher.setThreadsResolved(ref, step.prints, step.resolved);
        if (step.resolved) publication.threadsResolved = outcome.updated;
        else publication.threadsReopened = outcome.updated;
        if (outcome.failed.length) {
          publication.threadsFailed!.push(...outcome.failed.map((f) => f.fingerprint));
          publication.errors.push(`${outcome.failed.length} inline thread(s) could not be ${step.verb}`);
        }
      } catch (err) {
        publication.threadsFailed!.push(...step.prints);
        publication.errors.push(`Inline threads could not be ${step.verb}: ${message(err)}`);
      }
    }
  }

  // The high-level summary, when it goes in the description, plus
  // housekeeping for changes an earlier version wrote the walkthrough into.
  // Adapters skip the write when nothing changed. Only a summary this run
  // meant to write counts as a failure: a token that cannot edit the PR/MR
  // body must not mark every review partial.
  const summary = descriptionSummary(config, result);
  await publisher.updateDescription(ref, (description) => withDescriptionSummary(description, summary)).catch((err: unknown) => {
    if (summary) publication.errors.push(`Description summary failed: ${message(err)}`);
  });

  if (result.walkthrough) {
    const { add, remove } = labelChanges(result.walkthrough, config.output);
    if (add.length || remove.length) {
      try {
        await publisher.setLabels(ref, add, remove);
        publication.labels = add;
      } catch (err) {
        publication.errors.push(`Labels failed: ${message(err)}`);
      }
    }
  }

  if (config.output.postCheck) {
    const status = commitStatus(result, input.targetUrl);
    try {
      await publisher.setCommitStatus(ref, status);
      publication.statusState = status.state;
    } catch (err) {
      publication.errors.push(`Commit status failed: ${message(err)}`);
    }
  }

  return publication;
}

export interface SummaryPlacement {
  // The review comment's body, or null when it is turned off.
  summary: string | null;
  // The walkthrough as rendered on its own; empty when the review has none.
  walkthrough: string;
  // A comment of its own for the walkthrough, only while the review comment
  // is off; otherwise the walkthrough opens the review comment.
  walkthroughComment: string | null;
}

// One comment per review. Shared with the preview so the two cannot disagree.
export function summaryPlacement(config: Config, result: ReviewResult): SummaryPlacement {
  const options = walkthroughOptions(config.output);
  const walkthrough = walkthroughMarkdown(result, options);
  const { postSummary, reviewStats, agentPromptAll } = config.output;
  return {
    summary: postSummary
      ? toMarkdown(result, { walkthrough: true, stats: reviewStats, agentPrompt: agentPromptAll, ...options })
      : null,
    walkthrough,
    walkthroughComment: !postSummary && walkthrough ? `${walkthrough}\n${WALKTHROUGH_MARKER}\n` : null,
  };
}

// The block for the description: the summary to write, "" to remove an old
// one (the setting is off or the summary moved into the walkthrough), or null
// to leave whatever is there (this run produced none).
export function descriptionSummary(config: Config, result: ReviewResult): string | null {
  const { walkthrough, highLevelSummary, highLevelSummaryPlacement } = config.output;
  if (!walkthrough || !highLevelSummary || highLevelSummaryPlacement !== "description") return "";
  return descriptionSummaryBlock(result) || null;
}

// Threads hang off inline comments, so resolving them needs both switches.
export function resolvesThreads(config: Config): boolean {
  return config.output.postInline && config.output.resolveFixedThreads;
}

export function publishes(config: Config): boolean {
  const { output } = config;
  return (
    output.postInline ||
    output.postSummary ||
    output.postCheck ||
    output.walkthrough ||
    output.blastRadiusLabel ||
    output.effortLabel
  );
}
