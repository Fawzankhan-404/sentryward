import type { ToolAnnotation } from "../core/models.ts";
import type { Category, Severity } from "../core/severity.ts";

// Static analyzer results as each forge holds them, turned into the
// forge-neutral ToolAnnotation. Nothing here checks lines against the diff;
// validateToolFindings does that like it does for model findings.

export interface ToolResults {
  annotations: ToolAnnotation[];
  // Partial reads, e.g. checks still running or a report that could not be
  // downloaded. A read that fails outright throws instead.
  warnings: string[];
}

// Annotations a review can use are on changed lines, so a noisy analyzer
// beyond this many is not worth more requests.
export const MAX_TOOL_ANNOTATIONS = 1000;

// The first line of a message stands in for a missing title.
function headline(message: string): string {
  return message.trim().split("\n", 1)[0] ?? "";
}

function lineOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

// Analyzers that report security problems, by the name of their check run.
const SECURITY_TOOL = /codeql|code scanning|security|sast|semgrep|snyk|trivy|bandit|gosec|brakeman/i;

export interface GhAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "notice" | "warning" | "failure";
  title: string | null;
  message: string;
}

const GITHUB_SEVERITY: Record<GhAnnotation["annotation_level"], Severity> = {
  failure: "major",
  warning: "minor",
  notice: "info",
};

// A check run's annotations carry only a level, so the category is a guess:
// security for a security analyzer, otherwise a failure is a bug and the rest
// is maintainability (out of the default categories, so linter warnings are
// only reported where a repo asks for them).
export function fromGitHubAnnotation(tool: string, annotation: GhAnnotation): ToolAnnotation | undefined {
  const startLine = lineOf(annotation.start_line);
  if (!startLine || !annotation.path) return undefined;
  const category: Category = SECURITY_TOOL.test(tool)
    ? "security"
    : annotation.annotation_level === "failure"
      ? "bug"
      : "maintainability";
  return {
    tool,
    file: annotation.path,
    startLine,
    endLine: lineOf(annotation.end_line) ?? startLine,
    severity: GITHUB_SEVERITY[annotation.annotation_level] ?? "info",
    category,
    title: annotation.title?.trim() || headline(annotation.message),
    message: annotation.message,
  };
}

// Code Climate's format, which GitLab Code Quality reads.
export interface CodeQualityIssue {
  description?: string;
  check_name?: string;
  severity?: string;
  categories?: string[];
  engine_name?: string;
  location?: {
    path?: string;
    lines?: { begin?: number; end?: number };
    positions?: { begin?: { line?: number }; end?: { line?: number } };
  };
}

const CODE_QUALITY_SEVERITY: Record<string, Severity> = {
  blocker: "critical",
  critical: "critical",
  major: "major",
  minor: "minor",
  info: "info",
};

const CODE_QUALITY_CATEGORY: Record<string, Category> = {
  "bug risk": "bug",
  security: "security",
  performance: "performance",
  compatibility: "reliability",
  style: "style",
  clarity: "style",
  complexity: "maintainability",
  duplication: "maintainability",
};

export function fromCodeQuality(issue: CodeQualityIssue): ToolAnnotation | undefined {
  const location = issue.location;
  const startLine = lineOf(location?.lines?.begin) ?? lineOf(location?.positions?.begin?.line);
  if (!location?.path || !startLine || !issue.description) return undefined;
  const severity = CODE_QUALITY_SEVERITY[issue.severity?.toLowerCase() ?? ""] ?? "minor";
  const named = issue.categories?.map((name) => CODE_QUALITY_CATEGORY[name.toLowerCase()]).find(Boolean);
  // Most GitLab analyzers leave categories out; as on GitHub, a serious
  // result is taken for a bug.
  const category = named ?? (severity === "critical" || severity === "major" ? "bug" : "maintainability");
  return {
    tool: issue.engine_name || "Code Quality",
    file: location.path,
    startLine,
    endLine: lineOf(location.lines?.end) ?? lineOf(location.positions?.end?.line) ?? startLine,
    severity,
    category,
    ...(issue.check_name ? { ruleId: issue.check_name } : {}),
    title: headline(issue.description),
    message: issue.description,
  };
}

// GitLab's SAST report schema, the parts read here.
export interface SastReport {
  scan?: { scanner?: { name?: string }; analyzer?: { name?: string } };
  vulnerabilities?: {
    name?: string;
    message?: string;
    description?: string;
    severity?: string;
    identifiers?: { value?: string; name?: string }[];
    location?: { file?: string; start_line?: number; end_line?: number };
  }[];
}

const SAST_SEVERITY: Record<string, Severity> = {
  critical: "critical",
  high: "major",
  medium: "minor",
  low: "info",
  info: "info",
  unknown: "info",
};

export function fromSastReport(report: SastReport): ToolAnnotation[] {
  const tool = report.scan?.scanner?.name || report.scan?.analyzer?.name || "SAST";
  return (report.vulnerabilities ?? []).flatMap((vulnerability) => {
    const location = vulnerability.location;
    const startLine = lineOf(location?.start_line);
    const title = (vulnerability.name || vulnerability.message || "").trim();
    if (!location?.file || !startLine || !title) return [];
    const ruleId = vulnerability.identifiers?.[0]?.value;
    return [
      {
        tool,
        file: location.file,
        startLine,
        endLine: lineOf(location.end_line) ?? startLine,
        severity: SAST_SEVERITY[vulnerability.severity?.toLowerCase() ?? ""] ?? "info",
        category: "security" as const,
        ...(ruleId ? { ruleId } : {}),
        title,
        message: vulnerability.description?.trim() || title,
      },
    ];
  });
}
