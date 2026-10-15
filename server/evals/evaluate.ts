import { resolveConfig } from "../src/review/config/resolve.ts";
import type { Config } from "../src/review/config/schema.ts";
import type { LlmUsage, ReviewStatus } from "../src/review/core/models.ts";
import { mapLimit } from "../src/review/core/mapLimit.ts";
import type { Generate } from "../src/review/llm/providers.ts";
import { runReview } from "../src/review/pipeline.ts";
import { caseContext } from "./context.ts";
import type { EvalCase, Expected } from "./corpus.ts";
import { scoreCase, summarize, type CaseScore, type MatchOptions, type Totals } from "./match.ts";
import { costOf, type Price } from "./pricing.ts";

export interface EvalOptions {
  model: string;
  match: MatchOptions;
  // Cases reviewed at once; each review also runs its passes concurrently.
  concurrency: number;
  price?: Price;
}

export interface CaseReport {
  id: string;
  title: string;
  language: string;
  status: ReviewStatus | "error";
  // Set when the review failed or threw; the case is then left out of the rates.
  error?: string;
  warnings: string[];
  expected: Expected[];
  score?: CaseScore;
  usage: {
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    byPurpose: Partial<Record<LlmUsage["purpose"], { calls: number; inputTokens: number; outputTokens: number }>>;
  };
  costUsd: number | null;
}

export interface EvalRun {
  cases: CaseReport[];
  totals: Totals & { inputTokens: number; outputTokens: number; costUsd: number | null };
}

// The config a case is reviewed with: production defaults, the case's own
// override, then the model under test with no fallbacks, so a run measures one
// model only.
export function caseConfig(evalCase: EvalCase, model: string): Config {
  return resolveConfig({
    trigger: { ...evalCase.config, llm: { ...evalCase.config.llm, model, fallbackModels: [] } },
  }).config;
}

function summarizeUsage(usage: LlmUsage[]): CaseReport["usage"] {
  const byPurpose: CaseReport["usage"]["byPurpose"] = {};
  for (const call of usage) {
    const entry = (byPurpose[call.purpose] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
    entry.calls += 1;
    entry.inputTokens += call.inputTokens;
    entry.outputTokens += call.outputTokens;
  }
  return {
    inputTokens: usage.reduce((total, call) => total + call.inputTokens, 0),
    outputTokens: usage.reduce((total, call) => total + call.outputTokens, 0),
    latencyMs: usage.reduce((total, call) => total + call.latencyMs, 0),
    byPurpose,
  };
}

export async function evaluateCase(evalCase: EvalCase, generate: Generate, options: EvalOptions): Promise<CaseReport> {
  const base = { id: evalCase.id, title: evalCase.title, language: evalCase.language, expected: evalCase.expected };
  try {
    const result = await runReview(
      { changeSet: evalCase.changeSet, config: caseConfig(evalCase, options.model) },
      { generate, context: caseContext(evalCase.dir) },
    );
    const usage = summarizeUsage(result.usage);
    const costUsd = costOf(result.usage, options.price);
    if (result.status === "failed") {
      return { ...base, status: "failed", error: result.errors.join("; "), warnings: result.warnings, usage, costUsd };
    }
    return {
      ...base,
      status: result.status,
      warnings: result.warnings,
      score: scoreCase(result.findings, evalCase.expected, evalCase.traps, options.match),
      usage,
      costUsd,
    };
  } catch (err) {
    return {
      ...base,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      warnings: [],
      usage: summarizeUsage([]),
      costUsd: 0,
    };
  }
}

export async function evaluate(cases: EvalCase[], generate: Generate, options: EvalOptions): Promise<EvalRun> {
  const reports = await mapLimit(cases, options.concurrency, (evalCase) => evaluateCase(evalCase, generate, options));
  const costs = reports.map((report) => report.costUsd);
  return {
    cases: reports,
    totals: {
      ...summarize(reports.map((report) => ({ expectedCount: report.expected.length, score: report.score }))),
      inputTokens: reports.reduce((total, report) => total + report.usage.inputTokens, 0),
      outputTokens: reports.reduce((total, report) => total + report.usage.outputTokens, 0),
      costUsd: costs.includes(null) ? null : costs.reduce<number>((total, cost) => total + (cost ?? 0), 0),
    },
  };
}
