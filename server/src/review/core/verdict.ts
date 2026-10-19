import type { Finding, ReviewStatus, Verdict } from "./models.ts";
import { atLeast, severityRank, type Severity } from "./severity.ts";

// A finding the review could not stand behind (unproven, or left uncertain by
// verification) never blocks, whatever blockOn is: at "minor" or "info" its
// demoted severity alone would still reach the floor. Tool findings block only
// when the repo opted in (review.toolFindingsBlock): an analyzer's own check
// already fails or passes on the forge, so by default the review does not
// count it twice.
export function isBlocking(finding: Finding, blockOn: Severity, toolsBlock = true): boolean {
  if (finding.source === "tool" && !toolsBlock) return false;
  return finding.kind !== "verification_needed" && atLeast(finding.severity, blockOn);
}

// The findings that reach the blocking floor, worst first. The one predicate
// behind the verdict, the summary's blocking section and the commit status.
export function blockingFindings(findings: Finding[], blockOn: Severity, toolsBlock = true): Finding[] {
  return findings
    .filter((finding) => isBlocking(finding, blockOn, toolsBlock))
    .sort(
      (a, b) =>
        severityRank(b.severity) - severityRank(a.severity) ||
        b.confidence - a.confidence ||
        a.file.localeCompare(b.file) ||
        a.startLine - b.startLine,
    );
}

// Blocking findings block whatever else happened. Without them, only a review
// that covered everything it set out to may pass: a partial or failed review's
// silence means nothing.
export function verdictFor(
  status: ReviewStatus,
  findings: Finding[],
  blockOn: Severity,
  toolsBlock = true,
): Verdict {
  if (blockingFindings(findings, blockOn, toolsBlock).length > 0) return "blocked";
  return status === "completed" ? "pass" : "error";
}
