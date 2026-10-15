import { resolveConfig } from "../../src/review/config/resolve.ts";
import type { ReviewResult } from "../../src/review/core/models.ts";
import { runReview } from "../../src/review/pipeline.ts";
import { APP_PATCH, makeChangeSet } from "./changeSet.ts";
import { WALKTHROUGH, fakeModel, modelFinding } from "./model.ts";

// A realistic result built by the real pipeline: one blocker, one inline issue,
// a nitpick, a finding outside the diff, an ignored file and a warning.
export async function sampleResult(): Promise<ReviewResult> {
  const changeSet = makeChangeSet([
    { path: "src/app.ts", changeType: "modified", patch: APP_PATCH },
    { path: "package-lock.json", changeType: "modified", patch: APP_PATCH },
  ]);
  const { generate } = fakeModel({
    code_review: {
      findings: [
        modelFinding({ severity: "critical", title: "SQL built from @input", suggestion: "db.query(sql, [b]);" }),
        modelFinding({ severity: "minor", startLine: 12, endLine: 12, title: "c is never negative", evidence: "contract" }),
        modelFinding({ severity: "minor", kind: "nitpick", category: "bug", startLine: 12, endLine: 12, title: "Name c more clearly" }),
        modelFinding({ severity: "major", startLine: 40, endLine: 41, title: "Caller ignores <result>", evidenceNote: "x | y" }),
      ],
    },
    walkthrough: WALKTHROUGH,
  });
  // Verification is off so the rendered snapshot and usage totals cover the
  // review itself; tests/verify.test.ts covers it.
  const { config } = resolveConfig({ trigger: { review: { fullFile: true, verify: "off" } } });
  return runReview(
    { changeSet, config, warnings: [".sentryward.yaml was ignored: review: unknown setting nope"] },
    { generate, now: () => new Date("2026-10-04T12:00:00Z") },
  );
}
