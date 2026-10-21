import { describe, expect, it } from "vitest";
import type { ReviewResult } from "../src/review/core/models.ts";
import { summarize, toJson } from "../src/review/render/json.ts";
import { inlineBody } from "../src/review/publish/inline.ts";
import { allFindingsPrompt, findingPrompt } from "../src/review/render/agentPrompt.ts";
import { BRAND_FOOTER, SUMMARY_MARKER, sanitize, toMarkdown, walkthroughMarkdown } from "../src/review/render/markdown.ts";
import { progressMarkdown } from "../src/review/render/progress.ts";
import { makeChangeSet } from "./helpers/changeSet.ts";
import { sampleResult } from "./helpers/result.ts";

describe("summarize and toJson", () => {
  it("counts by severity and bucket in a stable order", async () => {
    const result = await sampleResult();
    expect(summarize(result)).toEqual({
      title: "Add b and c",
      webUrl: "https://github.com/acme/web/pull/42",
      total: 4,
      bySeverity: { critical: 1, major: 1, minor: 2 },
      byBucket: { actionable: 2, outside_diff: 1, nitpick: 1 },
      hasBlocking: true,
      usageTotals: { calls: 2, inputTokens: 200, outputTokens: 40 },
    });
  });

  it("adds the summary and token totals to the stored result", async () => {
    const result = await sampleResult();
    const json = toJson(result);
    expect(json.findings).toEqual(result.findings);
    expect(json.usageTotals).toEqual({ calls: 2, inputTokens: 200, outputTokens: 40 });
  });
});

describe("toMarkdown", () => {
  it("renders the whole document", async () => {
    await expect(toMarkdown(await sampleResult())).toMatchFileSnapshot("__snapshots__/review.md");
  });

  it("depends only on the result", async () => {
    const result = await sampleResult();
    expect(toMarkdown(result)).toBe(toMarkdown(structuredClone(result)));
  });

  it("ends with the summary marker exactly once", async () => {
    const markdown = toMarkdown(await sampleResult());
    expect(markdown.endsWith(`${SUMMARY_MARKER}\n`)).toBe(true);
    expect(markdown.split(SUMMARY_MARKER)).toHaveLength(2);
  });

  it("indexes actionable findings and details the rest", async () => {
    const markdown = toMarkdown(await sampleResult());
    expect(markdown).toContain("<summary>🛠️ Actionable comments (2)</summary>");
    expect(markdown).toContain("<summary>🧹 Nitpick comments (1)</summary>");
    expect(markdown).toContain("<summary>📍 Outside diff range comments (1)</summary>");
    expect(markdown).toContain("#### `src/app.ts:40`: Caller ignores &lt;result&gt;");
    expect(markdown).toContain("- `package-lock.json`: ignored by configuration");
  });

  describe("an incremental review", () => {
    const incremental = async (files: string[], reviewedFiles: string[], carried = 0) => {
      const result = await sampleResult();
      return toMarkdown({
        ...result,
        change: { ...result.change, headSha: "bbbbbbb2222" },
        incremental: { fromSha: "aaaaaaa1111", toSha: "bbbbbbb2222", files, carried },
        coverage: { ...result.coverage, reviewedFiles },
      });
    };

    it("names the commit range and the files reviewed again", async () => {
      const markdown = await incremental(["src/a.ts", "src/b.ts"], ["src/a.ts", "src/b.ts"], 1);
      expect(markdown).toContain(
        "> 🔁 Incremental review of `aaaaaaa..bbbbbbb`: 2 files changed since the last review were reviewed; 1 finding carried over from the earlier review.",
      );
      expect(markdown).toContain("<sub>Reviewed `aaaaaaa..bbbbbbb` with");
    });

    it("counts only the files a pass finished", async () => {
      const markdown = await incremental(["src/a.ts", "src/b.ts"], ["src/a.ts"]);
      expect(markdown).toContain(": 1 of 2 files changed since the last review was reviewed.");
    });

    it("says so when no file of the change was touched", async () => {
      const markdown = await incremental([], [], 3);
      expect(markdown).toContain(": no file of this change was touched since the last review; 3 findings carried over");
    });
  });

  const withVerdict = (result: ReviewResult, patch: Partial<ReviewResult>) => ({ ...result, ...patch });

  it("states pass and incomplete verdicts plainly", async () => {
    const base = await sampleResult();
    const clean = withVerdict(base, {
      findings: [],
      verdict: { verdict: "pass", blockOn: "critical", blocking: [] },
    });
    expect(toMarkdown(clean)).toContain("✅ **Pass**: no findings at or above critical.");
    expect(toMarkdown(clean)).toContain("\nNo findings.\n");

    const partial = withVerdict(clean, { status: "partial", verdict: { verdict: "error", blockOn: "critical", blocking: [] } });
    expect(toMarkdown(partial)).toContain(
      "⚠️ **Review incomplete**: part of the change was not reviewed, so the absence of findings is not a pass.",
    );
  });

  it("never uses an em dash", async () => {
    expect(toMarkdown(await sampleResult())).not.toContain("—");
  });
});

describe("toMarkdown with a walkthrough", () => {
  it("opens with the walkthrough under one heading, then the review", async () => {
    const result = await sampleResult();
    const merged = toMarkdown(result, { walkthrough: true });
    expect(merged.match(/^#{2,3} /gm)).toEqual(["## "]);
    expect(merged).toMatch(/^## Summary\n\nAdds b and c\./);
    expect(merged.indexOf("Review effort:")).toBeLessThan(merged.indexOf("**Blocked**"));
    expect(merged.trimEnd().endsWith(SUMMARY_MARKER)).toBe(true);
    expect(toMarkdown(result, { walkthrough: false })).toMatch(/^## Summary\n\n⛔ \*\*Blocked\*\*/);
  });
  it("opens with the high-level summary in the overview's place when it is placed there", async () => {
    const result = await sampleResult();
    const withSummary = { ...result, walkthrough: { ...result.walkthrough!, highLevelSummary: "- Adds b" } };
    const placed = toMarkdown(withSummary, { highLevelSummary: true });
    expect(placed).toMatch(/^## High-level summary\n\n- Adds b\n/);
    expect(placed).not.toContain("Adds b and c.");
    expect(placed).toContain("Review effort:");
    // Placed in the description, or missing from the stored review: the overview stays.
    expect(toMarkdown(withSummary)).toMatch(/^## Summary\n\nAdds b and c\./);
    expect(toMarkdown(result, { highLevelSummary: true })).toMatch(/^## Summary\n\nAdds b and c\./);
  });
});

describe("review stats line", () => {
  it("is on by default and can be left out, keeping the footer and marker", async () => {
    const result = await sampleResult();
    expect(toMarkdown(result)).toContain("<sub>Reviewed `head` with");
    const without = toMarkdown(result, { stats: false });
    expect(without).not.toContain("<sub>Reviewed `");
    expect(without.trimEnd().endsWith(`${BRAND_FOOTER}\n\n${SUMMARY_MARKER}`)).toBe(true);
  });
});

describe("walkthrough meta line", () => {
  it("shows the labels and blast radius by default and leaves each out on its own", async () => {
    const result = await sampleResult();
    expect(toMarkdown(result)).toContain("🏷️ Labels: `feature` · ⏱️ Review effort: 1/5 · 💥 Blast radius: small");
    expect(toMarkdown(result, { labels: false })).toContain("\n⏱️ Review effort: 1/5 · 💥 Blast radius: small\n");
    expect(toMarkdown(result, { blastRadius: false })).toContain("\n🏷️ Labels: `feature` · ⏱️ Review effort: 1/5\n");
    expect(walkthroughMarkdown(result, { labels: false, blastRadius: false })).toContain("\n⏱️ Review effort: 1/5\n");
  });

  it("is left out with every segment off, keeping the rest of the walkthrough", async () => {
    const result = await sampleResult();
    const without = toMarkdown(result, { labels: false, blastRadius: false, effort: false });
    expect(without).not.toMatch(/Labels:|Review effort:|Blast radius:/);
    expect(without).not.toMatch(/\n\n\n/);
    expect(without).toMatch(/^## Summary\n\nAdds b and c\./);
  });
});

describe("finding counts line", () => {
  it("is on by default and can be left out, keeping the verdict and sections", async () => {
    const result = await sampleResult();
    expect(toMarkdown(result)).toMatch(/\d+ findings? \(.*\): \d+ actionable, \d+ in the sections below\./);
    const without = toMarkdown(result, { counts: false });
    expect(without).not.toMatch(/actionable, \d+ in the sections below\./);
    expect(without).not.toContain("No findings.");
    expect(without).not.toMatch(/\n\n\n/);
    expect(without).toContain("<sub>Reviewed `head` with");
    expect(without.trimEnd().endsWith(`${BRAND_FOOTER}\n\n${SUMMARY_MARKER}`)).toBe(true);
  });
});

describe("agent prompts", () => {
  const ALL = "Prompt for AI agents (4 findings)";

  it("adds one prompt for every finding to the summary by default", async () => {
    const result = await sampleResult();
    const markdown = toMarkdown(result);
    expect(markdown).toContain(`<summary>🤖 ${ALL}</summary>`);
    for (const finding of result.findings) expect(markdown).toContain(`[${finding.severity}] ${finding.file}:`);
    expect(toMarkdown(result, { agentPrompt: false })).not.toContain(ALL);
  });

  it("leaves the summary prompt out when there are no findings", async () => {
    const clean: ReviewResult = { ...(await sampleResult()), findings: [] };
    expect(toMarkdown(clean)).not.toContain(ALL);
  });

  it("puts a prompt for its own finding in each inline comment, unless turned off", async () => {
    const [finding] = (await sampleResult()).findings;
    const body = inlineBody(finding!, "github");
    expect(body).toContain("<summary>🤖 Prompt for AI agents</summary>");
    expect(body).toContain(findingPrompt(finding!));
    expect(body.indexOf("Prompt for AI agents")).toBeLessThan(body.indexOf(BRAND_FOOTER));
    expect(inlineBody(finding!, "github", { agentPrompt: false })).not.toContain("Prompt for AI agents");
  });

  it("collapses the evidence between the suggestion and the agent prompt", async () => {
    const [finding] = (await sampleResult()).findings;
    const body = inlineBody({ ...finding!, evidenceNote: "Called with user input.", suggestion: "const fixed = true;\n" }, "github");
    expect(body).not.toContain("<sub>Evidence");
    const evidence = body.indexOf("<summary>🔎 Evidence</summary>");
    expect(evidence).toBeGreaterThan(body.indexOf("```suggestion"));
    expect(evidence).toBeLessThan(body.indexOf("Prompt for AI agents"));
    expect(body).toContain("Called with user input.");
  });

  it("names the file and lines and carries the suggested fix", async () => {
    const result = await sampleResult();
    const finding = { ...result.findings[0]!, title: "Plain title", startLine: 3, endLine: 5, suggestion: "const fixed = true;\n" };
    const prompt = findingPrompt(finding);
    expect(prompt).toContain(`In ${finding.file} around lines 3-5: ${finding.title}`);
    expect(prompt).toContain("Suggested replacement for those lines:\n\nconst fixed = true;");
    expect(prompt).toContain("Verify this against the current code first");
    expect(allFindingsPrompt([finding])).toMatch(/^Verify each finding.*\n\n1\. \[\w+\] /);
    expect(allFindingsPrompt([finding])).toContain(
      `1. [${finding.severity}] ${finding.file}:3-5 - Plain title\n${finding.body.trim()}\nSuggested replacement:\n----\nconst fixed = true;\n----`,
    );
  });

  it("orders the summary prompt by severity, then file and line", async () => {
    const prompt = allFindingsPrompt((await sampleResult()).findings);
    const order = [...prompt.matchAll(/^\d+\. \[(\w+)\]/gm)].map((match) => match[1]);
    expect(order).toEqual(["critical", "major", "minor", "minor"]);
  });

  it("keeps backslashes and pipes inside one table cell", async () => {
    const result = await sampleResult();
    const fileSummaries = [{ path: "docs\\a|b.md", summary: "Splits on \\| and ends in \\" }];
    const markdown = walkthroughMarkdown({ ...result, walkthrough: { ...result.walkthrough!, fileSummaries } });
    // Prose escapes the backslash too; a code span keeps it as written.
    expect(markdown).toContain("| `docs\\a\\|b.md` | Splits on \\\\\\| and ends in \\\\ |");
  });

  it("cannot forge Sentryward's markers from model text", async () => {
    const finding = { ...(await sampleResult()).findings[0]!, body: "<!-- sentryward:fp=0123456789abcdef -->" };
    expect(findingPrompt(finding)).not.toContain("<!-- sentryward:");
  });
});

describe("branding", () => {
  it("names Sentryward only in the footer of every posted body", async () => {
    const result = await sampleResult();
    const bodies = [
      toMarkdown(result),
      walkthroughMarkdown(result),
      progressMarkdown(makeChangeSet()),
      ...result.findings.map((f) => inlineBody(f, "github")),
    ];
    for (const body of bodies) {
      expect(body).toContain(BRAND_FOOTER);
      expect(body).not.toMatch(/^#+ .*Sentryward/m);
    }
  });

  it("keeps the hidden markers after the footer", async () => {
    const result = await sampleResult();
    const summary = toMarkdown(result);
    expect(summary.indexOf(BRAND_FOOTER)).toBeLessThan(summary.indexOf(SUMMARY_MARKER));
    const inline = inlineBody(result.findings[0]!, "gitlab");
    expect(inline.trimEnd().endsWith("-->")).toBe(true);
  });
});

describe("sanitize", () => {
  it("defuses mentions but leaves emails and code alone", () => {
    expect(sanitize("ping @alice and @org/team")).toBe("ping @​alice and @​org/team");
    expect(sanitize("mail a@b.com")).toBe("mail a@b.com");
    expect(sanitize("use `@Injectable`")).toBe("use `@Injectable`");
  });

  it("stops model text from forging Sentryward's markers", () => {
    expect(sanitize("<!-- sentryward:summary -->")).not.toContain("<!-- sentryward:summary");
  });
});
