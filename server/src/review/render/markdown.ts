import { BUCKET_TITLE, SUMMARY_BUCKETS } from "../core/buckets.ts";
import type { Bucket, Finding, IssueAssessment, IssueRef, Omission, ReviewResult, Walkthrough } from "../core/models.ts";
import { SEVERITIES, type Severity } from "../core/severity.ts";
import { DESCRIPTION_SUMMARY_END, DESCRIPTION_SUMMARY_START, SUMMARY_MARKER } from "../core/markers.ts";
import { agentPromptBlock, allFindingsPrompt } from "./agentPrompt.ts";
import { summarize } from "./json.ts";

export { SUMMARY_MARKER };

// Forges fetch the image themselves, so it must be a public absolute URL.
const LOGO_URL = "https://raw.githubusercontent.com/rdlugs/sentryward/main/client/public/sentryward-32.png";

// The only place Sentryward names itself in what it posts: a small credit at the
// bottom of every comment, so the content reads as the review, not the tool.
export const BRAND_FOOTER = `<sub><img src="${LOGO_URL}" alt="" width="14" height="14" align="absmiddle"> Sentryward</sub>`;

const VERDICT_LINE = {
  pass: "✅ **Pass**",
  blocked: "⛔ **Blocked**",
  error: "⚠️ **Review incomplete**",
} as const;

// Forges render only text, so icons are emoji. The severity colours follow the
// dashboard's palette (red, orange, sky, muted) so both read the same.
export const SEVERITY_ICON: Record<Severity, string> = {
  critical: "🔴",
  major: "🟠",
  minor: "🔵",
  info: "⚪",
};

const BUCKET_ICON: Record<Bucket, string> = {
  actionable: "🛠️",
  requirement_gap: "📋",
  outside_diff: "📍",
  nitpick: "🧹",
};

const OMISSION_TEXT: Record<Omission["reason"], string> = {
  ignored: "ignored by configuration",
  binary: "binary file",
  deleted: "deleted",
  patch_unavailable: "diff not provided by the forge",
  too_large: "too large for one review pass",
  budget: "review pass limit reached",
  chunk_failed: "review pass failed",
};

// Model text is posted under Sentryward's name, so it must not ping people, close
// HTML it did not open, or forge Sentryward's own markers.
export function sanitize(text: string): string {
  return text
    .replace(/<!--\s*sentryward:/gi, "<!-- (quoted) sentryward:")
    .replace(/(^|[^\w`])@(?=[\w-])/g, "$1@​");
}

// For text inside HTML (summary tags) and table cells. Backslashes are escaped
// first so text ending in "\" cannot swallow the escape of a following "|".
function inline(text: string): string {
  return codeCell(text.replace(/\\/g, "\\\\"));
}

// For text inside a code span, where markdown keeps backslashes as written but
// a table still needs its pipes escaped.
function codeCell(text: string): string {
  return sanitize(text).replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;")).replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

function location(finding: Finding): string {
  const lines = finding.startLine === finding.endLine ? `${finding.startLine}` : `${finding.startLine}-${finding.endLine}`;
  return `\`${finding.file}:${lines}\``;
}

function indexLine(finding: Finding): string {
  return `- ${SEVERITY_ICON[finding.severity]} **${finding.severity}** ${location(finding)}: ${inline(finding.title)}`;
}

function bucketSummary(bucket: Bucket, count: number): string {
  return `<summary>${BUCKET_ICON[bucket]} ${BUCKET_TITLE[bucket]} (${count})</summary>`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function fence(code: string, language = ""): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${language}\n${code.replace(/\n$/, "")}\n${ticks}`;
}

function verdictSection(result: ReviewResult): string[] {
  const { verdict, blockOn, blocking } = result.verdict;
  const lines: string[] = [];
  if (verdict === "blocked") {
    lines.push(`${VERDICT_LINE.blocked}: ${plural(blocking.length, "finding")} at or above ${blockOn}.`);
  } else if (verdict === "pass") {
    lines.push(`${VERDICT_LINE.pass}: no findings at or above ${blockOn}.`);
  } else {
    const why = result.status === "failed" ? "the review did not complete" : "part of the change was not reviewed";
    lines.push(`${VERDICT_LINE.error}: ${why}, so the absence of findings is not a pass.`);
  }

  if (blocking.length) {
    const byPrint = new Map(result.findings.map((f) => [f.fingerprint, f]));
    lines.push("");
    for (const print of blocking) {
      const finding = byPrint.get(print);
      if (finding) lines.push(indexLine(finding));
    }
  }
  return lines;
}

function countsLine(result: ReviewResult): string {
  const summary = summarize(result);
  if (summary.total === 0) return "No findings.";
  const severities = SEVERITIES.filter((s) => summary.bySeverity[s])
    .map((s) => `${summary.bySeverity[s]} ${s}`)
    .join(", ");
  const inlineCount = summary.byBucket.actionable ?? 0;
  const rest = summary.total - inlineCount;
  return `${plural(summary.total, "finding")} (${severities}): ${inlineCount} actionable, ${rest} in the sections below.`;
}

const ASSESSMENT_TEXT: Record<IssueAssessment, string> = {
  addressed: "✅ Addressed",
  partial: "🟡 Partly addressed",
  not_addressed: "❌ Not addressed",
  unclear: "❔ Unclear",
};

function issueLink(issue: IssueRef): string {
  const title = inline(issue.title);
  return issue.url && /^https?:\/\//.test(issue.url) ? `[${issue.ref}](${issue.url}) ${title}` : `${issue.ref} ${title}`;
}

// The optional walkthrough parts. Each is only in the result when its setting
// was on, so a stored review renders as it was produced.
function walkthroughExtras(walkthrough: Walkthrough, options: WalkthroughOptions): string[] {
  const lines: string[] = [];
  if (walkthrough.sequenceDiagram) {
    lines.push("", "<details>", "<summary>📊 Sequence diagram</summary>", "", fence(walkthrough.sequenceDiagram, "mermaid"), "", "</details>");
  }
  if (walkthrough.linkedIssues?.length) {
    lines.push("", "<details open>", `<summary>🔗 Linked issues (${walkthrough.linkedIssues.length})</summary>`, "");
    lines.push("| Issue | Assessment | Notes |", "| --- | --- | --- |");
    for (const issue of walkthrough.linkedIssues) {
      lines.push(`| ${issueLink(issue)} | ${ASSESSMENT_TEXT[issue.assessment]} | ${inline(issue.note)} |`);
    }
    lines.push("", "</details>");
  }
  if (walkthrough.relatedIssues?.length) {
    lines.push("", "<details>", `<summary>🔍 Possibly related issues (${walkthrough.relatedIssues.length})</summary>`, "");
    for (const issue of walkthrough.relatedIssues) {
      lines.push(`- ${issueLink(issue)}${issue.reason ? `: ${inline(issue.reason)}` : ""}`);
    }
    lines.push("", "</details>");
  }
  return lines;
}

export interface WalkthroughOptions {
  // output.estimateEffort; the estimate is still made, for the effort label.
  effort?: boolean;
  // The high-level summary goes in the walkthrough rather than the description.
  highLevelSummary?: boolean;
}

// Display options from a config's output settings. Missing settings, as in a
// job stored before they existed, render as those jobs were.
export function walkthroughOptions(output: { estimateEffort?: boolean; highLevelSummaryPlacement?: string } | undefined): WalkthroughOptions {
  return {
    effort: output?.estimateEffort !== false,
    highLevelSummary: output?.highLevelSummaryPlacement === "walkthrough",
  };
}

// The heading the comment opens with, and the walkthrough under it. A
// high-level summary placed in the walkthrough takes the overview's place, so
// the comment does not describe the change twice; the overview is still the
// fallback when this review has no summary.
function walkthroughSection(
  result: ReviewResult,
  options: WalkthroughOptions = {},
): { heading: string; lines: string[] } | null {
  const walkthrough = result.walkthrough;
  if (!walkthrough) return null;
  const summary = options.highLevelSummary ? walkthrough.highLevelSummary : undefined;
  const heading = summary ? "## High-level summary" : "## Summary";
  const lines = ["", sanitize(summary ?? walkthrough.overview)];
  const meta = [
    walkthrough.labels.length ? `🏷️ Labels: ${walkthrough.labels.map((l) => `\`${codeCell(l)}\``).join(", ")}` : "",
    options.effort !== false ? `⏱️ Review effort: ${walkthrough.estimatedEffort}/5` : "",
    walkthrough.blastRadius ? `💥 Blast radius: ${walkthrough.blastRadius}` : "",
  ].filter(Boolean);
  if (meta.length) lines.push("", meta.join(" · "));
  if (walkthrough.fileSummaries.length) {
    lines.push("", "<details>", `<summary>📂 Changes (${plural(walkthrough.fileSummaries.length, "file")})</summary>`, "");
    lines.push("| File | Summary |", "| --- | --- |");
    for (const entry of walkthrough.fileSummaries) {
      lines.push(`| \`${codeCell(entry.path)}\` | ${inline(entry.summary)} |`);
    }
    lines.push("", "</details>");
  }
  lines.push(...walkthroughExtras(walkthrough, options));
  return { heading, lines };
}

function findingDetail(finding: Finding): string[] {
  const lines = [
    `#### ${location(finding)}: ${inline(finding.title)}`,
    "",
    `${SEVERITY_ICON[finding.severity]} *${finding.severity} · ${finding.category} · ${finding.kind.replace(/_/g, " ")}*`,
    "",
    sanitize(finding.body),
  ];
  if (finding.evidenceNote) lines.push("", `**🔎 Evidence:** ${sanitize(finding.evidenceNote)}`);
  if (finding.suggestion) lines.push("", fence(finding.suggestion));
  return lines;
}

function bucketSections(result: ReviewResult): string[] {
  const lines: string[] = [];
  const actionable = result.findings.filter((f) => f.bucket === "actionable");
  if (actionable.length) {
    // Each has its own inline thread; the summary only indexes them.
    lines.push("", "<details>", bucketSummary("actionable", actionable.length), "");
    for (const finding of actionable) {
      lines.push(indexLine(finding));
    }
    lines.push("", "</details>");
  }
  for (const bucket of SUMMARY_BUCKETS) {
    const findings = result.findings.filter((f) => f.bucket === bucket);
    if (!findings.length) continue;
    lines.push("", "<details>", bucketSummary(bucket, findings.length), "");
    findings.forEach((finding, index) => {
      if (index) lines.push("");
      lines.push(...findingDetail(finding));
    });
    lines.push("", "</details>");
  }
  return lines;
}

function coverageSection(result: ReviewResult): string[] {
  const lines: string[] = [];
  const { omissions } = result.coverage;
  if (omissions.length) {
    lines.push("", "<details>", `<summary>🚫 Not reviewed (${plural(omissions.length, "item")})</summary>`, "");
    for (const omission of omissions) {
      const detail = omission.detail ? `, ${inline(omission.detail)}` : "";
      lines.push(`- \`${codeCell(omission.path)}\`: ${OMISSION_TEXT[omission.reason]}${detail}`);
    }
    lines.push("", "</details>");
  }
  const notes = [...result.errors, ...result.warnings];
  if (notes.length) {
    lines.push("", "**📝 Notes**", "", ...notes.map((note) => `- ${inline(note)}`));
  }
  return lines;
}

function footer(result: ReviewResult): string {
  const models = [...new Set(result.usage.map((u) => u.model))].join(", ") || "no model call";
  const passes = plural(result.coverage.passes, "review pass");
  const refuted = result.validation.dropped.refuted ?? 0;
  const verification = refuted ? ` · ${plural(refuted, "finding")} refuted on verification` : "";
  return `<sub>Reviewed \`${result.change.headSha.slice(0, 7)}\` with ${models} · ${passes} · ${plural(result.coverage.reviewedFiles.length, "file")} reviewed${verification}</sub>`;
}

// The one markdown document for a review. The forge summary comment and the
// dashboard's "copy markdown" are this function's output, byte for byte; it
// depends only on the result, so re-rendering a stored review reproduces it.
// The walkthrough, when there is one, opens the document under its heading
// (walkthroughSection), so one comment carries what the change does and what
// the review found. `walkthrough: false` leaves it out, and `stats: false` the line
// naming the commit, models and coverage (output.reviewStats), and
// `agentPrompt: false` the one prompt covering every finding
// (output.agentPromptAll). The rest shape the walkthrough (walkthroughOptions).
export function toMarkdown(
  result: ReviewResult,
  options: { walkthrough?: boolean; stats?: boolean; agentPrompt?: boolean } & WalkthroughOptions = {},
): string {
  const walkthrough = options.walkthrough === false ? null : walkthroughSection(result, options);
  const lines = [walkthrough?.heading ?? "## Summary", ...(walkthrough?.lines ?? [])];
  lines.push("", ...verdictSection(result), "", countsLine(result));
  lines.push(...bucketSections(result));
  if (options.agentPrompt !== false && result.findings.length) {
    lines.push("", ...agentPromptBlock("Prompt for all review comments with AI agents", allFindingsPrompt(result.findings)));
  }
  lines.push(...coverageSection(result));
  if (options.stats !== false) lines.push("", footer(result));
  lines.push("", BRAND_FOOTER, "", SUMMARY_MARKER);
  return `${lines.join("\n")}\n`;
}

// The walkthrough on its own, for a comment of its own while the review
// comment is turned off. Empty when the review has none.
export function walkthroughMarkdown(result: ReviewResult, options: WalkthroughOptions = {}): string {
  const section = walkthroughSection(result, options);
  if (!section) return "";
  return `${[section.heading, ...section.lines, "", BRAND_FOOTER].join("\n")}\n`;
}

// The high-level summary as a block for the PR/MR description, between
// markers so a later run replaces it and a review never reads it back as the
// author's text. Empty when the review has none.
export function descriptionSummaryBlock(result: ReviewResult): string {
  const summary = result.walkthrough?.highLevelSummary;
  if (!summary) return "";
  return [DESCRIPTION_SUMMARY_START, "## High-level summary", "", sanitize(summary), DESCRIPTION_SUMMARY_END].join("\n");
}
