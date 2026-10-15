import { describe, expect, it } from "vitest";
import { parseRepoFile } from "../src/review/config/repoFile.ts";
import { resolveConfig } from "../src/review/config/resolve.ts";
import type { Config, ConfigOverride } from "../src/review/config/schema.ts";
import { contextTokenBudget } from "../src/review/context/budget.ts";
import { planChunks } from "../src/review/context/chunk.ts";
import { changedSpan, enclosingScope, fileContextBlocks, fileLines, importBlock } from "../src/review/context/fileContext.ts";
import { fillContext, gatherContext, type ContextSource } from "../src/review/context/gather.ts";
import { callSites, moduleCandidates, partSymbols, relativeImports } from "../src/review/context/symbols.ts";
import { GitHubAdapter } from "../src/review/forge/github.ts";
import { GitLabAdapter } from "../src/review/forge/gitlab.ts";
import { runReview } from "../src/review/pipeline.ts";
import { makeChangeSet } from "./helpers/changeSet.ts";
import { fetchStub } from "./helpers/fetchStub.ts";
import { fakeModel, modelFinding } from "./helpers/model.ts";

const config = (override: ConfigOverride = {}): Config =>
  resolveConfig({ trigger: { output: { walkthrough: false }, ...override } }).config;

// src/app.ts at the head: the change rewrites line 8 inside main().
const APP = [
  'import { helper } from "./helper.ts";',
  'import { format as fmt } from "../lib/format.js";',
  "",
  "const LIMIT = 10;",
  "",
  "export function main(input: string) {",
  "  const a = helper(input);",
  "  const b = fmt(a);",
  "  if (b.length > LIMIT) {",
  "    return b.slice(0, LIMIT);",
  "  }",
  "  return b;",
  "}",
  "",
  "export function tail() {",
  "  return 1;",
  "}",
  "",
].join("\n");

const PATCH = [
  "@@ -7,3 +7,3 @@ export function main(input: string) {",
  "   const a = helper(input);",
  "-  const b = a;",
  "+  const b = fmt(a);",
  "   if (b.length > LIMIT) {",
].join("\n");

const FORMAT = ["export function format(value: string): string {", "  return value.trim();", "}", ""].join("\n");
const CLI = ['import { main } from "../src/app.ts";', "", 'const out = main(process.argv[2] ?? "");', "console.log(out);", ""].join("\n");

const changeSet = () => makeChangeSet([{ path: "src/app.ts", changeType: "modified", patch: PATCH }]);

function source(files: Record<string, string> = { "src/app.ts": APP, "lib/format.ts": FORMAT, "bin/cli.ts": CLI }) {
  const reads: string[] = [];
  const searches: string[] = [];
  const context: ContextSource = {
    readFile: async (path) => {
      reads.push(path);
      return files[path] ?? null;
    },
    searchCode: async (term) => {
      searches.push(term);
      return term === "main" ? ["src/app.ts", "bin/cli.ts"] : [];
    },
  };
  return { context, reads, searches };
}

const SCOPE = [
  "=== CONTEXT: src/app.ts (enclosing scope) ===",
  "     6 : export function main(input: string) {",
  "       ...",
  "    10 :     return b.slice(0, LIMIT);",
  "    11 :   }",
  "    12 :   return b;",
  "    13 : }",
].join("\n");

describe("file context", () => {
  const file = changeSet().files[0]!;
  const lines = fileLines(APP);

  it("shows the enclosing function and the imports, without the hunk's own lines or diff markers", () => {
    const blocks = fileContextBlocks(file, file.hunks, lines);
    expect(blocks.map((block) => block.text)).toEqual([
      SCOPE,
      [
        "=== CONTEXT: src/app.ts (imports) ===",
        '     1 : import { helper } from "./helper.ts";',
        '     2 : import { format as fmt } from "../lib/format.js";',
      ].join("\n"),
    ]);
    expect(blocks.map((block) => block.text).join("\n")).not.toMatch(/^\s*\d+ [+-] \|/m);
  });

  it("ends the import block at the first top-level statement", () => {
    expect(importBlock(lines)).toEqual({ start: 1, end: 2 });
    expect(importBlock(fileLines('"""Docs."""\nfrom .a import b\nimport os\n\nx = 1\nimport late\n'))).toEqual({ start: 1, end: 3 });
    expect(importBlock(fileLines("const x = 1;\n"))).toBeUndefined();
    expect(importBlock(fileLines('import {\n  helper,\n  other,\n} from "./helper.ts";\n\nconst a = 1;\n'))).toEqual({ start: 1, end: 4 });
    expect(importBlock(fileLines('package main\n\nimport (\n\t"fmt"\n)\n\nfunc main() {\n}\n'))).toEqual({ start: 1, end: 5 });
    expect(importBlock(fileLines('import("./side-effect.js");\n'))).toBeUndefined();
  });

  it("falls back to a fixed window when no declaration encloses the hunk", () => {
    const deep = Array.from({ length: 300 }, (_, i) => `  line${i + 1}`);
    expect(enclosingScope(deep, 200, 200)).toEqual({ start: 170, end: 230 });
  });

  // f() spans lines 1-6; g() starts at 8.
  const TWO = fileLines("function f(x) {\n  if (!x) return;\n  const y = x.v;\n  use(y);\n  return y;\n}\n\nfunction g() {\n  return 1;\n}\n");

  it("finds the declaration when the hunk ends on the function's closing brace", () => {
    expect(enclosingScope(TWO, 4, 6)).toEqual({ start: 1, end: 6 });
  });

  it("anchors on changed lines, not forge context reaching into the next function", () => {
    const [changed] = makeChangeSet([
      {
        path: "src/f.ts",
        changeType: "modified",
        patch: ["@@ -3,6 +3,6 @@ function f(x) {", "   const y = x.v;", "-  use(x);", "+  use(y);", "   return y;", " }", " ", " function g() {"].join("\n"),
      },
    ]).files;
    const [scope] = fileContextBlocks(changed!, changed!.hunks, TWO);
    expect(scope!.text.split("\n").slice(1)).toEqual(["     1 : function f(x) {", "     2 :   if (!x) return;"]);
  });

  it("anchors a pure deletion where the lines were removed, not where the hunk starts", () => {
    // previous() is 1-3, target() 5-9; a guard after line 5 was removed.
    const head = fileLines("function previous() {\n  return 0;\n}\n\nfunction target(x) {\n  const y = x.v;\n  use(y);\n  return y;\n}\n");
    const [deleted] = makeChangeSet([
      {
        path: "src/t.ts",
        changeType: "modified",
        patch: ["@@ -3,6 +3,5 @@", " }", " ", " function target(x) {", "-  if (!x) throw new Error();", "   const y = x.v;", "   use(y);"].join("\n"),
      },
    ]).files;
    expect(changedSpan(deleted!.hunks[0]!)).toEqual([5, 6]);
    const [scope] = fileContextBlocks(deleted!, deleted!.hunks, head);
    expect(scope!.text.split("\n").slice(1)).toEqual(["     8 :   return y;", "     9 : }"]);
  });

  it("finds an indented Python scope through to the end of the file", () => {
    const py = fileLines("import os\n\ndef run(x):\n    y = x + 1\n    return y\n");
    expect(enclosingScope(py, 4, 4)).toEqual({ start: 3, end: 5 });
  });
});

describe("symbols", () => {
  it("finds names the hunk defines and calls", () => {
    expect(partSymbols(changeSet().files[0]!.hunks)).toEqual({ defined: ["main"], called: ["fmt"] });
  });

  it("binds relative imports and resolves them to candidate paths", () => {
    const bindings = relativeImports(APP);
    expect(bindings.get("fmt")).toEqual({ module: "../lib/format.js", exported: "format" });
    expect(bindings.get("helper")).toEqual({ module: "./helper.ts", exported: "helper" });
    expect(moduleCandidates("src/app.ts", "../lib/format.js")).toEqual(["lib/format.js", "lib/format.ts", "lib/format.tsx"]);
    expect(moduleCandidates("src/app.ts", "./util")).toEqual(["src/util.ts", "src/util.tsx", "src/util/index.ts"]);
    expect(moduleCandidates("src/app.ts", "../../outside")).toEqual([]);

    expect(relativeImports("from .helpers import parse as p, load\n").get("p")).toEqual({ module: ".helpers", exported: "parse" });
    expect(moduleCandidates("pkg/sub/mod.py", "..util")).toEqual(["pkg/util.py", "pkg/util/__init__.py"]);
  });
});

describe("callSites", () => {
  it("matches names literally, metacharacters included", () => {
    const lines = ["const a = $fetch(url);", "", "", "", "", "axb(1);", "", "", "", "", "a.b\\(2);"];
    expect(callSites(lines, "$fetch", 3)).toEqual([{ start: 1, end: 4 }]);
    // Unescaped, "." would also match the "x" in axb on line 6.
    expect(callSites(lines, "a.b\\", 3)).toEqual([{ start: 6, end: 11 }]);
  });
});

describe("gatherContext", () => {
  it("adds scope, imports, definitions and callers in that order, reading each file once", async () => {
    const { context, reads, searches } = source();
    const chunks = planChunks(changeSet().files, 10_000, 3).chunks;

    const gathered = await gatherContext({ chunks, changeSet: changeSet(), source: context, budgetFor: () => 10_000, concurrency: 2 });

    const headers = gathered.contexts[0]!.split("\n").filter((line) => line.startsWith("==="));
    expect(headers).toEqual([
      "=== CONTEXT: src/app.ts (enclosing scope) ===",
      "=== CONTEXT: src/app.ts (imports) ===",
      "=== CONTEXT: lib/format.ts (definition of fmt) ===",
      "=== CONTEXT: bin/cli.ts (call sites of main) ===",
    ]);
    expect(gathered.contexts[0]).toContain("     3 : const out = main(process.argv[2] ?? \"\");");
    expect(gathered.warnings).toEqual([]);
    // The changed file itself is never fetched as a caller.
    expect(reads.sort()).toEqual(["bin/cli.ts", "lib/format.js", "lib/format.ts", "src/app.ts"]);
    expect(searches).toEqual(["main"]);
  });

  it("fetches nothing for a full pass and keeps forge calls within the concurrency", async () => {
    const patch = "@@ -1,2 +1,2 @@\n a\n-b\n+c";
    const many = makeChangeSet(Array.from({ length: 12 }, (_, i) => ({ path: `src/f${i}.ts`, changeType: "modified" as const, patch })));
    const chunks = planChunks(many.files, 10_000, 5).chunks;
    let reads = 0;
    let active = 0;
    let peak = 0;
    const slow: ContextSource = {
      readFile: async () => {
        reads += 1;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return "a\nc\n";
      },
      searchCode: async () => [],
    };

    await gatherContext({ chunks, changeSet: many, source: slow, budgetFor: () => 0, concurrency: 2 });
    expect(reads).toBe(0);

    await gatherContext({ chunks, changeSet: many, source: slow, budgetFor: () => 10_000, concurrency: 2 });
    expect(reads).toBe(12);
    expect(peak).toBe(2);
  });

  it("keeps lower-priority blocks that still fit after a larger one is skipped", () => {
    const block = (priority: number, tokens: number) => ({ path: "p", label: "l", priority, text: `b${priority}`, tokens });
    expect(fillContext([block(2, 5), block(0, 50), block(1, 30)], 40)).toBe("b1\n\nb2");
    expect(fillContext([block(0, 50)], 0)).toBe("");
  });

  it("degrades to the diff alone when reads and searches fail", async () => {
    const context: ContextSource = {
      readFile: async () => {
        throw new Error("502 Bad Gateway");
      },
      searchCode: async () => {
        throw new Error("403 rate limited");
      },
    };
    const chunks = planChunks(changeSet().files, 10_000, 3).chunks;

    const gathered = await gatherContext({ chunks, changeSet: changeSet(), source: context, budgetFor: () => 10_000, concurrency: 2 });

    expect(gathered.contexts).toEqual([""]);
    expect(gathered.warnings).toEqual([
      "Review context could not be read for src/app.ts; the diff was reviewed without it",
      "Caller search failed, so passes saw no call sites: 403 rate limited",
    ]);
  });
});

describe("runReview with context", () => {
  const now = () => new Date("2026-10-04T12:00:00Z");
  const reviewPrompt = (requests: { schemaName: string; prompt: string }[]) =>
    requests.find((request) => request.schemaName === "code_review")!.prompt;

  it("puts context after the diff in its own read-only section", async () => {
    const { generate, requests } = fakeModel({ code_review: { findings: [] } });
    const result = await runReview({ changeSet: changeSet(), config: config() }, { generate, now, context: source().context });

    const prompt = reviewPrompt(requests);
    expect(prompt).toContain(`Context (read-only, from the new version of the code):\n${SCOPE}`);
    expect(prompt.indexOf("Diff:")).toBeLessThan(prompt.indexOf("=== CONTEXT:"));
    expect(result.status).toBe("completed");
    expect(result.warnings).toEqual([]);
  });

  it("never changes coverage: context only fills what the diff left", async () => {
    // Enough for the diff, nothing left over for context.
    const tight = config({ llm: { contextBudget: 4_000 } });
    const withContext = fakeModel({ code_review: { findings: [] } });
    const withSource = await runReview({ changeSet: changeSet(), config: tight }, { generate: withContext.generate, now, context: source().context });
    const without = await runReview({ changeSet: changeSet(), config: tight }, { generate: fakeModel({ code_review: { findings: [] } }).generate, now });

    expect(withSource.coverage).toEqual(without.coverage);
    expect(reviewPrompt(withContext.requests)).not.toContain("=== CONTEXT:");
    expect(contextTokenBudget(tight, 3_000, 500)).toBe(0);
  });

  it("completes with a warning when context cannot be read", async () => {
    const { generate, requests } = fakeModel({ code_review: { findings: [] } });
    const failing: ContextSource = {
      readFile: () => Promise.reject(new Error("timeout")),
      searchCode: async () => [],
    };

    const result = await runReview({ changeSet: changeSet(), config: config() }, { generate, now, context: failing });

    expect(result.status).toBe("completed");
    expect(result.warnings).toEqual(["Review context could not be read for src/app.ts; the diff was reviewed without it"]);
    expect(reviewPrompt(requests)).not.toContain("Context (read-only");
  });

  it("reads nothing when review.fileContext is off", async () => {
    const { context, reads, searches } = source();
    const { generate } = fakeModel({ code_review: { findings: [] } });

    await runReview({ changeSet: changeSet(), config: config({ review: { fileContext: false } }) }, { generate, now, context });

    expect(reads).toEqual([]);
    expect(searches).toEqual([]);
  });

  it("drops findings on context-only lines unless review.fullFile is on", async () => {
    const onContext = { code_review: { findings: [modelFinding({ startLine: 12, endLine: 12 })] } };
    const strict = await runReview(
      { changeSet: changeSet(), config: config() },
      { generate: fakeModel(onContext).generate, now, context: source().context },
    );
    expect(strict.findings).toEqual([]);
    expect(strict.validation.dropped).toEqual({ off_diff: 1 });

    const full = await runReview(
      { changeSet: changeSet(), config: config({ review: { fullFile: true } }) },
      { generate: fakeModel(onContext).generate, now, context: source().context },
    );
    expect(full.findings.map((finding) => finding.startLine)).toEqual([12]);
  });
});

describe("code search", () => {
  it("searches GitHub's index for the repository", async () => {
    const stub = fetchStub([
      { url: /\/search\/code\?/, body: { items: [{ path: "bin/cli.ts" }, { path: "bin/cli.ts" }, { path: "src/x.ts" }] } },
    ]);
    const gh = new GitHubAdapter({ host: "github.com", token: async () => "t", fetch: stub.fetch });

    expect(await gh.searchCode("acme/web", "main", "head")).toEqual(["bin/cli.ts", "src/x.ts"]);
    expect(new URL(stub.calls[0]!.url).searchParams.get("q")).toBe("main repo:acme/web");
  });

  it("searches GitLab blobs at the head revision", async () => {
    const stub = fetchStub([{ url: /\/search\?scope=blobs/, body: [{ path: "bin/cli.ts" }] }]);
    const gl = new GitLabAdapter({ host: "gitlab.com", token: async () => "t", fetch: stub.fetch });

    expect(await gl.searchCode("team/app", "main", "abc123")).toEqual(["bin/cli.ts"]);
    const url = new URL(stub.calls[0]!.url);
    expect(url.searchParams.get("search")).toBe("main");
    expect(url.searchParams.get("ref")).toBe("abc123");
  });
});

describe("file_context in .sentryward.yaml", () => {
  it("parses and defaults to on", () => {
    expect(parseRepoFile(".sentryward.yaml", "review:\n  file_context: false\n")).toEqual({
      override: { review: { fileContext: false } },
      warnings: [],
    });
    expect(config().review.fileContext).toBe(true);
  });
});
