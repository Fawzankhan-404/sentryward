// Reviews every corpus case with a real model and scores the findings against
// the case's expectations. Costs money, so it is never part of `npm test`.
//
//   npm run eval -- --model anthropic/claude-sonnet-5-5 [--case a,b] [--out file]
//
// See README "Review quality evals" for the options and how to add a case.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_CONFIG } from "../src/review/config/schema.ts";
import {
  createGenerate,
  missingKeys,
  providerOf,
  type ApiKeys,
  type ProviderBaseUrls,
} from "../src/review/llm/providers.ts";
import { loadCorpus } from "./corpus.ts";
import { evaluate, type CaseReport } from "./evaluate.ts";
import { DEFAULT_MATCH_OPTIONS } from "./match.ts";
import { parsePrice } from "./pricing.ts";

const { values: args } = parseArgs({
  options: {
    model: { type: "string", default: DEFAULT_CONFIG.llm.model },
    case: { type: "string" },
    concurrency: { type: "string", default: "2" },
    out: { type: "string" },
    tolerance: { type: "string", default: String(DEFAULT_MATCH_OPTIONS.tolerance) },
    "strict-category": { type: "boolean", default: false },
    price: { type: "string" },
    "base-url": { type: "string" },
  },
});

function positiveInt(name: string, text: string, min: number): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < min) throw new Error(`--${name} must be an integer >= ${min}`);
  return value;
}

// Read straight from the environment rather than services/llm.ts, which would
// pull in the API's env validation and Prisma: an eval needs neither a
// database nor the server's secrets.
const keys: ApiKeys = {
  anthropic: process.env.ANTHROPIC_API_KEY || undefined,
  openai: process.env.OPENAI_API_KEY || undefined,
  google: process.env.GOOGLE_GENERATIVE_AI_API_KEY || undefined,
};

// The container has no git, so a SHA can also be handed in.
function gitSha(): string | null {
  if (process.env.EVAL_GIT_SHA) return process.env.EVAL_GIT_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const percent = (value: number | null) => (value === null ? "-" : `${(value * 100).toFixed(0)}%`);
const usd = (value: number | null) => (value === null ? "n/a" : `$${value.toFixed(4)}`);

function row(report: CaseReport): string {
  const s = report.score;
  const cells = s
    ? [
        `${s.truePositives}/${report.expected.length}`,
        String(s.falsePositives),
        s.trapHits ? String(s.trapHits) : "",
        percent(s.precision),
        percent(s.recall),
      ]
    : [report.status, "", "", "", ""];
  return [report.id.padEnd(32), ...cells.map((cell) => cell.padStart(7)), usd(report.costUsd).padStart(10)].join(" ");
}

async function main() {
  const model = args.model!;
  const baseUrls: ProviderBaseUrls = args["base-url"] ? { [providerOf(model)]: args["base-url"] } : {};
  const missing = missingKeys([model], keys, undefined, baseUrls);
  if (missing.length > 0) {
    throw new Error(`No API key for ${missing.join(", ")}: set it in the environment (the worker container has them).`);
  }
  const options = {
    model,
    concurrency: positiveInt("concurrency", args.concurrency!, 1),
    match: { tolerance: positiveInt("tolerance", args.tolerance!, 0), strictCategory: args["strict-category"]! },
    ...(args.price ? { price: parsePrice(args.price) } : {}),
  };
  const cases = loadCorpus(args.case?.split(",").map((id) => id.trim()).filter(Boolean));

  console.log(`Reviewing ${cases.length} case(s) with ${model}...\n`);
  const startedAt = new Date();
  const run = await evaluate(cases, createGenerate(keys, undefined, baseUrls), options);

  console.log(["case".padEnd(32), ..."found fp traps prec recall".split(" ").map((h) => h.padStart(7)), "cost".padStart(10)].join(" "));
  for (const report of run.cases) {
    console.log(row(report));
    if (report.error) console.log(`  ${report.error}`);
  }
  const t = run.totals;
  console.log(
    `\nprecision ${percent(t.precision)}  recall ${percent(t.recall)}  f1 ${percent(t.f1)}` +
      `  category ${percent(t.categoryAgreement)}  traps hit ${t.trapHits}` +
      `  clean-case FPs ${t.cleanCaseFalsePositives}/${t.cleanCases} cases` +
      `  errored ${t.errored}  tokens ${t.inputTokens}/${t.outputTokens}  cost ${usd(t.costUsd)}`,
  );

  const out =
    args.out ??
    join(import.meta.dirname, "reports", `${startedAt.toISOString().replace(/[:.]/g, "-")}-${model.replace(/[^\w.-]+/g, "_")}.json`);
  mkdirSync(dirname(out), { recursive: true });
  const report = {
    model,
    gitSha: gitSha(),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    options,
    ...run,
  };
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nReport: ${relative(process.cwd(), out)}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
