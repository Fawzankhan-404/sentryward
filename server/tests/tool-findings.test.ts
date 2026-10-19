import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/review/config/resolve.ts";
import type { Config, ConfigOverride } from "../src/review/config/schema.ts";
import type { ToolAnnotation } from "../src/review/core/models.ts";
import { fromCodeQuality, fromGitHubAnnotation, fromSastReport } from "../src/review/forge/toolResults.ts";
import { runReview } from "../src/review/pipeline.ts";
import { inlineBody } from "../src/review/publish/inline.ts";
import { toMarkdown } from "../src/review/render/markdown.ts";
import { validateToolFindings } from "../src/review/validate/validator.ts";
import { makeChangeSet } from "./helpers/changeSet.ts";
import { WALKTHROUGH, fakeModel, modelFinding } from "./helpers/model.ts";

const config = (override: ConfigOverride = {}): Config => resolveConfig({ trigger: override }).config;

function annotation(overrides: Partial<ToolAnnotation> = {}): ToolAnnotation {
  return {
    tool: "tsc",
    file: "src/app.ts",
    startLine: 12,
    endLine: 12,
    severity: "major",
    category: "bug",
    title: "Type 'string' is not assignable to type 'number'",
    message: "Type 'string' is not assignable to type 'number'.",
    ...overrides,
  };
}

describe("validateToolFindings", () => {
  const changeSet = makeChangeSet();
  const validate = (annotations: ToolAnnotation[], override: ConfigOverride = {}, ignored?: Set<string>) =>
    validateToolFindings(annotations, changeSet, changeSet.files, config(override), ignored);

  it("keeps an annotation on an added line as a tool finding", () => {
    const { findings, dropped } = validate([annotation({ ruleId: "TS2322" })]);
    expect(dropped).toEqual({});
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      source: "tool",
      tool: "tsc",
      ruleId: "TS2322",
      startLine: 12,
      confidence: 1,
      evidence: "static_tool",
      evidenceNote: "Reported by tsc (TS2322)",
      kind: "potential_issue",
      bucket: "actionable",
    });
  });

  it("never snaps: an unchanged line is off the diff unless full_file is on", () => {
    expect(validate([annotation({ startLine: 13, endLine: 13 })]).dropped).toEqual({ off_diff: 1 });
    expect(validate([annotation({ startLine: 13, endLine: 13 })], { review: { fullFile: true } }).findings).toHaveLength(1);
  });

  it("applies the categories, floor, files and dismissals of the config", () => {
    const kept = validate([annotation()]).findings[0]!;
    const { findings, dropped } = validate(
      [
        annotation({ category: "maintainability" }),
        annotation({ severity: "info" }),
        annotation({ file: "src/other.ts" }),
        annotation({ message: " " }),
        annotation(),
      ],
      {},
      new Set([kept.fingerprint]),
    );
    expect(findings).toEqual([]);
    expect(dropped).toEqual({ category: 1, below_floor: 1, unknown_file: 1, empty: 1, previously_ignored: 1 });
  });

  it("keeps two messages of one rule apart, and one message reported twice once", () => {
    const { findings, dropped } = validate([
      annotation({ ruleId: "no-unused-vars", title: "no-unused-vars", message: "'b' is unused" }),
      annotation({ ruleId: "no-unused-vars", title: "no-unused-vars", message: "'c' is unused", startLine: 11, endLine: 11 }),
      annotation({ ruleId: "no-unused-vars", title: "no-unused-vars", message: "'c' is unused", startLine: 11, endLine: 11 }),
    ]);
    expect(findings).toHaveLength(2);
    expect(dropped).toEqual({ duplicate: 1 });
  });
});

describe("runReview with tool annotations", () => {
  const now = () => new Date("2026-10-04T12:00:00Z");
  const model = (findings = [modelFinding({ severity: "minor" })]) =>
    fakeModel({ code_review: { findings }, walkthrough: WALKTHROUGH }).generate;

  it("adds tool findings next to the model's and keeps the model's where they overlap", async () => {
    const result = await runReview(
      {
        changeSet: makeChangeSet(),
        config: config(),
        toolAnnotations: [
          // Same file, category and line as the model finding (line 11).
          annotation({ startLine: 11, endLine: 11, title: "Overflow", message: "Possible overflow." }),
          annotation(),
        ],
      },
      { generate: model(), now },
    );
    expect(result.findings.map((finding) => finding.source).sort()).toEqual(["llm", "tool"]);
    expect(result.findings.find((finding) => finding.source === "tool")).toMatchObject({ startLine: 12 });
    expect(result.validation.dropped).toEqual({ duplicate: 1 });
  });

  it("does not let tool findings block unless tool_findings_block is on", async () => {
    const input = { changeSet: makeChangeSet(), toolAnnotations: [annotation({ severity: "critical" })] };
    const advisory = await runReview({ ...input, config: config() }, { generate: model([]), now });
    expect(advisory.findings).toHaveLength(1);
    expect(advisory.verdict).toMatchObject({ verdict: "pass", blocking: [] });

    const blocking = await runReview(
      { ...input, config: config({ review: { toolFindingsBlock: true } }) },
      { generate: model([]), now },
    );
    expect(blocking.verdict).toMatchObject({ verdict: "blocked", blocking: [blocking.findings[0]!.fingerprint] });
  });

  it("ignores annotations when tool_findings is off", async () => {
    const result = await runReview(
      { changeSet: makeChangeSet(), config: config({ review: { toolFindings: false } }), toolAnnotations: [annotation()] },
      { generate: model([]), now },
    );
    expect(result.findings).toEqual([]);
  });

  it("caps model and tool findings together at max_findings", async () => {
    const result = await runReview(
      {
        changeSet: makeChangeSet(),
        config: config({ review: { maxFindings: 1 } }),
        toolAnnotations: [annotation({ severity: "minor", category: "reliability" })],
      },
      { generate: model([modelFinding({ severity: "major", startLine: 11, endLine: 11 })]), now },
    );
    expect(result.findings.map((finding) => finding.source)).toEqual(["llm"]);
    expect(result.validation.dropped).toEqual({ over_limit: 1 });
  });

  it("names the analyzer, escaped, in the inline comment and the summary", async () => {
    const result = await runReview(
      {
        changeSet: makeChangeSet(),
        // Line 40 is outside the diff, so with full_file the finding is
        // summarised in full rather than only indexed.
        config: config({ review: { fullFile: true } }),
        toolAnnotations: [annotation({ tool: "ES*Lint\\_x" }), annotation({ tool: "ES*Lint\\_x", startLine: 40, endLine: 40, title: "Other" })],
      },
      { generate: model([]), now },
    );
    const actionable = result.findings.find((finding) => finding.bucket === "actionable")!;
    expect(inlineBody(actionable, "github")).toContain("· via ES\\*Lint\\\\\\_x");
    expect(toMarkdown(result)).toContain("potential issue · via ES\\*Lint\\\\\\_x*");
  });
});

describe("forge result parsers", () => {
  it("maps a GitHub annotation's level and falls back to its message for a title", () => {
    expect(
      fromGitHubAnnotation("lint", {
        path: "src/app.ts",
        start_line: 3,
        end_line: 4,
        annotation_level: "warning",
        title: null,
        message: "Unexpected any.\nSpecify a type.",
      }),
    ).toMatchObject({ tool: "lint", severity: "minor", category: "maintainability", title: "Unexpected any.", endLine: 4 });
    expect(
      fromGitHubAnnotation("CodeQL", {
        path: "src/app.ts",
        start_line: 3,
        end_line: 3,
        annotation_level: "failure",
        title: "SQL injection",
        message: "Query built from user input.",
      }),
    ).toMatchObject({ severity: "major", category: "security" });
  });

  it("reads Code Quality issues by line or position", () => {
    expect(
      fromCodeQuality({
        description: "Function has a complexity of 12.",
        check_name: "complexity",
        severity: "minor",
        categories: ["Complexity"],
        engine_name: "eslint",
        location: { path: "src/app.ts", lines: { begin: 7 } },
      }),
    ).toMatchObject({ tool: "eslint", ruleId: "complexity", severity: "minor", category: "maintainability", startLine: 7 });
    expect(
      fromCodeQuality({ description: "Bad", severity: "blocker", location: { path: "a.ts", positions: { begin: { line: 2 } } } }),
    ).toMatchObject({ tool: "Code Quality", severity: "critical", category: "bug", startLine: 2 });
    expect(fromCodeQuality({ description: "No location" })).toBeUndefined();
  });

  it("reads SAST vulnerabilities as security findings", () => {
    expect(
      fromSastReport({
        scan: { scanner: { name: "Semgrep" } },
        vulnerabilities: [
          {
            name: "Use of eval",
            description: "eval() runs arbitrary code.",
            severity: "High",
            identifiers: [{ value: "javascript.eval" }],
            location: { file: "src/app.ts", start_line: 5 },
          },
          { name: "No line", location: { file: "src/app.ts" } },
        ],
      }),
    ).toEqual([
      {
        tool: "Semgrep",
        file: "src/app.ts",
        startLine: 5,
        endLine: 5,
        severity: "major",
        category: "security",
        ruleId: "javascript.eval",
        title: "Use of eval",
        message: "eval() runs arbitrary code.",
      },
    ]);
  });
});
