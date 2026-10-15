import type { Config } from "../config/schema.ts";
import { bucketFor } from "../core/buckets.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { isAddedLine, type ChangedFile, type ChangeSet, type Finding } from "../core/models.ts";
import { atLeast, severityRank } from "../core/severity.ts";
import type { ModelFinding } from "../llm/schemas.ts";

// How far a reported line may be from a changed line and still be snapped to
// it. Models are occasionally off by a line or two; further than this, the
// finding is about something else.
const SNAP_DISTANCE = 3;

export type DropReason =
  | "invalid_line"
  | "unknown_file"
  | "category"
  | "off_diff"
  | "low_confidence"
  | "below_floor"
  | "empty"
  | "duplicate"
  | "over_limit"
  // A second model call showed the finding wrong (verify.ts).
  | "refuted";

export interface ValidationResult {
  findings: Finding[];
  dropped: Partial<Record<DropReason, number>>;
  demoted: number;
}

function nearestAdded(file: ChangedFile, line: number): number | undefined {
  let best: number | undefined;
  for (const hunk of file.hunks) {
    for (const added of hunk.addedLines) {
      const distance = Math.abs(added - line);
      if (distance <= SNAP_DISTANCE && (best === undefined || distance < Math.abs(best - line))) {
        best = added;
      }
    }
  }
  return best;
}

// A multi-line comment must start and end inside one hunk; otherwise the
// forge rejects it. Collapse to the first line rather than lose the finding.
function clampEnd(file: ChangedFile, start: number, end: number): number {
  if (end <= start) return start;
  const hunk = file.hunks.find((h) => h.newLineToPosition[String(start)] !== undefined);
  return hunk && hunk.newLineToPosition[String(end)] !== undefined ? end : start;
}

function isUnprovenBlocker(finding: ModelFinding): boolean {
  return (
    (finding.severity === "critical" || finding.severity === "major") &&
    (finding.evidence === "unverified" || finding.evidenceNote.trim() === "")
  );
}

// What a finding the review cannot stand behind becomes: still shown, never
// blocking (see isBlocking), and never more severe than it was. Kind is part
// of the fingerprint, so it and the bucket follow.
export function demoteFinding(finding: Finding, changeSet: ChangeSet): Finding {
  const kind = "verification_needed";
  return {
    ...finding,
    severity: severityRank(finding.severity) < severityRank("minor") ? finding.severity : "minor",
    kind,
    fingerprint: fingerprint({ file: finding.file, category: finding.category, kind, title: finding.title }),
    bucket: bucketFor({ file: finding.file, startLine: finding.startLine, kind }, changeSet),
  };
}

function rank(finding: Finding): [number, number] {
  return [severityRank(finding.severity), finding.confidence];
}

// Worst first, then most confident, then by place.
export function compareFindings(a: Finding, b: Finding): number {
  return (
    severityRank(b.severity) - severityRank(a.severity) ||
    b.confidence - a.confidence ||
    a.file.localeCompare(b.file) ||
    a.startLine - b.startLine
  );
}

// Of two findings with one fingerprint, the one to keep.
export function stronger(existing: Finding, candidate: Finding): Finding {
  const [es, ec] = rank(existing);
  const [ns, nc] = rank(candidate);
  return ns < es || (ns === es && nc <= ec) ? existing : candidate;
}

export function validateFindings(
  raw: ModelFinding[],
  changeSet: ChangeSet,
  reviewed: ChangedFile[],
  config: Config,
): ValidationResult {
  const dropped: Partial<Record<DropReason, number>> = {};
  const drop = (reason: DropReason) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };
  const files = new Map(reviewed.map((file) => [file.path, file]));
  const categories = new Set(config.review.categories);
  let demoted = 0;
  const kept = new Map<string, Finding>();

  for (const candidate of raw) {
    let start = Math.round(candidate.startLine);
    let end = Math.round(candidate.endLine);
    if (!Number.isFinite(start) || start < 1) {
      drop("invalid_line");
      continue;
    }
    if (!Number.isFinite(end)) end = start;

    const file = files.get(candidate.file);
    if (!file) {
      drop("unknown_file");
      continue;
    }
    if (!categories.has(candidate.category)) {
      drop("category");
      continue;
    }

    if (!isAddedLine(file, start)) {
      const snapped = nearestAdded(file, start);
      if (snapped !== undefined) {
        end += snapped - start;
        start = snapped;
      } else if (!config.review.fullFile) {
        drop("off_diff");
        continue;
      }
    }
    end = clampEnd(file, start, end);

    const confidence = Math.min(1, Math.max(0, candidate.confidence));
    if (confidence < config.review.minConfidence) {
      drop("low_confidence");
      continue;
    }

    let { severity, kind } = candidate as { severity: Finding["severity"]; kind: Finding["kind"] };
    // Blocking takes evidence. Self-reported confidence is not evidence.
    if (config.review.requireEvidence && isUnprovenBlocker(candidate)) {
      severity = "minor";
      kind = "verification_needed";
      demoted += 1;
    }
    if (!atLeast(severity, config.review.severityFloor)) {
      drop("below_floor");
      continue;
    }

    const title = candidate.title.trim().slice(0, 200);
    const body = candidate.body.trim();
    if (!title || !body) {
      drop("empty");
      continue;
    }
    const suggestion =
      config.review.committableSuggestions && candidate.suggestion?.trim() ? candidate.suggestion : undefined;

    const finding: Finding = {
      file: file.path,
      startLine: start,
      endLine: end,
      severity,
      category: candidate.category,
      kind,
      effort: candidate.effort,
      title,
      body,
      ...(suggestion !== undefined ? { suggestion } : {}),
      confidence,
      evidence: candidate.evidence,
      evidenceNote: candidate.evidenceNote.trim(),
      evidenceFiles: candidate.evidenceFiles.filter((path) => path !== file.path),
      source: "llm",
      fingerprint: fingerprint({ file: file.path, category: candidate.category, kind, title }),
      bucket: bucketFor({ file: file.path, startLine: start, kind }, changeSet),
    };

    const existing = kept.get(finding.fingerprint);
    if (existing) drop("duplicate");
    kept.set(finding.fingerprint, existing ? stronger(existing, finding) : finding);
  }

  const sorted = [...kept.values()].sort(compareFindings);
  const overLimit = sorted.length - config.review.maxFindings;
  if (overLimit > 0) dropped.over_limit = overLimit;

  return { findings: sorted.slice(0, config.review.maxFindings), dropped, demoted };
}
