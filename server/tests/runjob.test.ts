import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.ts";
import type { IssueContext } from "../src/review/core/models.ts";
import { ForgeCache } from "../src/review/forge/cache.ts";
import type { InlineComment } from "../src/review/forge/types.ts";
import type { Forge } from "../src/services/forge.ts";
import { claimNext, enqueue } from "../src/worker/queue.ts";
import { runJob, skipReason, walkthroughEnabled, type RunJobDeps } from "../src/worker/runJob.ts";
import { DEFAULT_CONFIG } from "../src/review/config/schema.ts";
import { fingerprint } from "../src/review/core/fingerprint.ts";
import { makeChangeSet } from "./helpers/changeSet.ts";
import { WALKTHROUGH, fakeModel, modelFinding } from "./helpers/model.ts";

let repositoryId: string;

// The fingerprint the default modelFinding() gets after validation (its kind is
// not demoted, as it carries real evidence), used to seed a prior dismissal.
const DEFAULT_FINGERPRINT = fingerprint({
  file: "src/app.ts",
  category: "bug",
  kind: "potential_issue",
  title: "b overflows for large a",
});

async function seedIgnored(overrides: {
  number: number;
  fingerprint: string;
  title: string;
  ignoreReason: "false_positive" | "intentional" | "fix_later" | "not_specified";
  ignoreNote?: string;
}) {
  await prisma.finding.create({
    data: {
      repositoryId,
      number: overrides.number,
      fingerprint: overrides.fingerprint,
      state: "ignored",
      ignoredAt: new Date(),
      ignoreReason: overrides.ignoreReason,
      ignoreNote: overrides.ignoreNote,
      title: overrides.title,
      file: "src/app.ts",
      startLine: 11,
      severity: "major",
      category: "bug",
      kind: "potential_issue",
      changeTitle: "t",
    },
  });
}

beforeEach(async () => {
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  const workspace = await prisma.workspace.create({
    data: { name: "W", reviewSettings: { llm: { connection: "anthropic" } } },
  });
  const connection = await prisma.forgeConnection.create({
    data: { workspaceId: workspace.id, provider: "github", host: "github.com", kind: "github_app", installationId: "1", accountLogin: "acme" },
  });
  const repo = await prisma.repository.create({
    data: {
      connectionId: connection.id,
      provider: "github",
      host: "github.com",
      fullPath: "acme/web",
      externalId: "1",
      defaultBranch: "main",
      enabled: true,
      settings: { review: { blockOn: "major" } },
      followGlobal: false,
    },
  });
  repositoryId = repo.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

interface Published {
  inline: { fingerprint: string; startLine: number }[];
  summaries: string[];
  statuses: string[];
  descriptions: string[];
  labels: string[][];
  threads: { fingerprints: string[]; resolved: boolean }[];
}

function deps(
  files: Record<string, string>,
  answers: Parameters<typeof fakeModel>[0],
  keys = { anthropic: "k" },
  options: {
    failSummary?: boolean;
    onForge?: string[];
    // What getChangeHead reports, once per call; the last entry repeats.
    states?: ("open" | "closed" | "merged")[];
    issues?: { linked?: IssueContext[]; found?: IssueContext[] };
    title?: string;
    cache?: ForgeCache;
  } = {},
) {
  const reads: string[] = [];
  const published: Published = { inline: [], summaries: [], statuses: [], descriptions: [], labels: [], threads: [] };
  const forge = {
    getChange: async (_p: string, _n: number, cache?: ForgeCache) => {
      reads.push(cache ? "change:cached" : "change");
      const change = makeChangeSet();
      return {
        ...change,
        title: options.title ?? change.title,
        author: "alice",
        forgeRef: { ...change.forgeRef, headSha: "newhead" },
      };
    },
    getChangeHead: async () => {
      const states = options.states ?? ["open"];
      const state = states.length > 1 ? states.shift()! : states[0]!;
      return { headSha: "newhead", title: "t", state, isDraft: false };
    },
    getLinkedIssues: async () => options.issues?.linked ?? [],
    searchIssues: async (_project: string, terms: string[]) => {
      reads.push(`search:${terms.join(" ")}`);
      return options.issues?.found ?? [];
    },
    getFileAtRef: async (_p: string, path: string, ref: string) => {
      reads.push(`${ref}:${path}`);
      return files[`${ref}:${path}`] ?? null;
    },
    searchCode: async (_p: string, term: string) => {
      reads.push(`code:${term}`);
      return [];
    },
    listPostedFingerprints: async () => new Set(options.onForge ?? []),
    postInlineComments: async (_ref: unknown, comments: InlineComment[]) => {
      published.inline.push(...comments.map((c) => ({ fingerprint: c.fingerprint, startLine: c.startLine })));
      return { posted: comments.map((c) => ({ fingerprint: c.fingerprint, forgeCommentId: `c-${c.fingerprint}` })), failed: [] };
    },
    upsertSummaryComment: async (_ref: unknown, body: string) => {
      if (options.failSummary && !body.includes("Reviewing")) throw new Error("403 Forbidden");
      published.summaries.push(body);
      return "note-1";
    },
    upsertComment: async (_ref: unknown, _marker: string, body: string) => {
      published.summaries.push(body);
      return "note-2";
    },
    updateDescription: async (_ref: unknown, transform: (description: string) => string) => {
      // Like the adapters: only an actual change is written.
      const next = transform("");
      if (next !== "") published.descriptions.push(next);
    },
    setLabels: async (_ref: unknown, add: string[]) => {
      published.labels.push(add);
    },
    setCommitStatus: async (_ref: unknown, status: { state: string }) => {
      published.statuses.push(status.state);
    },
    setThreadsResolved: async (_ref: unknown, fingerprints: string[], resolved: boolean) => {
      published.threads.push({ fingerprints, resolved });
      return { updated: fingerprints, failed: [] };
    },
  } as unknown as Forge;
  const model = fakeModel(answers);
  const connections = Object.fromEntries(
    Object.entries(keys).map(([provider, apiKey]) => [provider, { apiKey }]),
  );
  const runDeps: RunJobDeps = {
    adapterFor: () => forge,
    generateFor: () => model.generate,
    credentialsFor: async () => ({ keys, baseUrls: {}, connections }),
    cache: options.cache,
  };
  return { runDeps, reads, model, published };
}

async function claimedJob() {
  await enqueue({ repositoryId, number: 42, headSha: "oldhead", trigger: "manual" });
  return (await claimNext())!;
}

describe("runJob", () => {
  it("reviews the change and stores result, verdict, config and the actual head", async () => {
    const job = await claimedJob();
    const { runDeps, reads } = deps(
      { "base:.sentryward.yaml": "output:\n  walkthrough: true\n" },
      { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH },
    );

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored).toMatchObject({ status: "completed", verdict: "blocked", headSha: "newhead", baseSha: "base", error: null });
    expect(stored.lockedAt).toBeNull();
    const result = stored.result as { findings: unknown[]; verdict: { blockOn: string } };
    expect(result.findings).toHaveLength(1);
    // blockOn came from the saved repository settings.
    expect(result.verdict.blockOn).toBe("major");
    expect(stored.resolvedConfig).toMatchObject({ repoFile: ".sentryward.yaml", sources: { "review.blockOn": "repoSettings" } });
    // The repository file is read at the base revision, never the head; review
    // context is read at the head, and callers of the changed main() searched.
    expect(reads).toEqual(["change", "base:.sentryward.yaml", "newhead:src/app.ts", "code:main"]);
    // The findings table follows the run, with the change's author.
    const findings = await prisma.finding.findMany({ where: { repositoryId, number: 42 } });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ state: "open", author: "alice", lastJobId: job.id });
  });

  it("never reposts a finding this team dismissed on the same change", async () => {
    const job = await claimedJob();
    await seedIgnored({ number: 42, fingerprint: DEFAULT_FINGERPRINT, title: "b overflows for large a", ignoreReason: "false_positive" });
    const { runDeps, published } = deps({}, { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH });

    await runJob(job, runDeps);

    expect(published.inline).toHaveLength(0);
    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    const result = stored.result as { findings: unknown[]; validation: { dropped: Record<string, number> } };
    expect(result.findings).toHaveLength(0);
    expect(result.validation.dropped.previously_ignored).toBe(1);
  });

  it("lists recent repo dismissals in the review prompt, excluding fix_later", async () => {
    const job = await claimedJob();
    await seedIgnored({ number: 7, fingerprint: "aaaa000000000000", title: "nullable config read", ignoreReason: "false_positive", ignoreNote: "config is always set by the loader" });
    await seedIgnored({ number: 8, fingerprint: "bbbb000000000000", title: "intentional global mutation", ignoreReason: "intentional" });
    await seedIgnored({ number: 9, fingerprint: "cccc000000000000", title: "fix this later please", ignoreReason: "fix_later" });
    const { runDeps, model } = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH });

    await runJob(job, runDeps);

    const review = model.requests.find((r) => r.schemaName === "code_review");
    expect(review?.prompt).toContain("Previously rejected by this team");
    expect(review?.prompt).toContain("nullable config read");
    expect(review?.prompt).toContain("config is always set by the loader");
    expect(review?.prompt).toContain("intentional global mutation");
    expect(review?.prompt).not.toContain("fix this later please");
  });

  it("reports a dismissed finding again when suppression is turned off", async () => {
    const job = await claimedJob();
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { settings: { review: { blockOn: "major", suppressIgnored: false } } },
    });
    await seedIgnored({ number: 42, fingerprint: DEFAULT_FINGERPRINT, title: "b overflows for large a", ignoreReason: "false_positive" });
    const { runDeps, model, published } = deps({}, { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH });

    await runJob(job, runDeps);

    expect(published.inline).toHaveLength(1);
    const review = model.requests.find((r) => r.schemaName === "code_review");
    expect(review?.prompt).not.toContain("Previously rejected by this team");
  });

  it("stores a failed review as failed with its errors", async () => {
    const job = await claimedJob();
    const { runDeps } = deps({}, { code_review: new Error("provider down"), walkthrough: WALKTHROUGH });

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored).toMatchObject({ status: "failed", verdict: "error", error: "Review pass 1 failed: provider down" });
    expect(await prisma.finding.count()).toBe(0);
  });

  it("refuses to run without a key for the configured model", async () => {
    const job = await claimedJob();
    const { runDeps, model } = deps({}, {}, {} as never);

    await expect(runJob(job, runDeps)).rejects.toThrow(/selected anthropic LLM connection no longer exists/);
    expect(model.requests).toHaveLength(0);
  });

  it("rejects a fallback that cannot use the selected official connection", async () => {
    const job = await claimedJob();
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { settings: { llm: { fallbackModels: ["openai/gpt-5"] } } },
    });
    const { runDeps } = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH });

    await expect(runJob(job, runDeps)).rejects.toThrow(/anthropic LLM connection.*cannot run model openai\/gpt-5/);
  });

  it("sends every model call to the endpoint with the chosen key", async () => {
    const job = await claimedJob();
    const baseUrl = "http://host.docker.internal:20128/v1";
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { settings: { llm: { model: "openai/cx/gpt-5.6-sol(medium)", connection: "openai" } } },
    });
    const keys = { anthropic: "k", openai: "router-key" };
    const { runDeps, model } = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH }, keys);
    const generateFor: unknown[][] = [];
    runDeps.generateFor = (...args) => {
      generateFor.push(args);
      return model.generate;
    };
    runDeps.credentialsFor = async () => ({
      keys,
      baseUrls: { openai: baseUrl },
      connections: { anthropic: { apiKey: "k" }, openai: { apiKey: "router-key", baseUrl } },
    });

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.status).toBe("completed");
    expect(generateFor).toEqual([[keys, { baseUrl, apiKey: "router-key" }, { openai: baseUrl }]]);
  });

  it("refuses to run when the selected connection is not stored", async () => {
    const job = await claimedJob();
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { settings: { llm: { connection: "google" } } },
    });
    const { runDeps, model } = deps({}, {});

    await expect(runJob(job, runDeps)).rejects.toThrow(/selected google LLM connection no longer exists/);
    expect(model.requests).toHaveLength(0);
  });

  it("posts progress first, then inline comments, the summary and the status", async () => {
    const job = await claimedJob();
    const { runDeps, published } = deps({}, { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH });

    await runJob(job, runDeps);

    expect(published.summaries).toHaveLength(2);
    expect(published.summaries[0]).toContain("Reviewing `newhead`");
    expect(published.summaries[1]).toMatch(/^## Summary\n/);
    expect(published.statuses).toEqual(["pending", "failure"]);
    expect(published.inline).toHaveLength(1);
    // The walkthrough opens the review comment; the description is left alone.
    expect(published.descriptions).toEqual([]);
    expect(published.summaries[1]).not.toContain("### Walkthrough");
    expect(published.summaries[1]).toContain("Review effort:");

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.publication).toMatchObject({ summaryCommentId: "note-1", statusState: "failure", errors: [] });
    expect(await prisma.postedFinding.count({ where: { repositoryId, number: 42 } })).toBe(1);
  });

  it("never posts the same finding twice across runs", async () => {
    const answers = { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH };
    await runJob(await claimedJob(), deps({}, answers).runDeps);

    const second = deps({}, answers);
    await enqueue({ repositoryId, number: 42, headSha: "again", trigger: "manual" });
    await runJob((await claimNext())!, second.runDeps);

    expect(second.published.inline).toEqual([]);
    expect(await prisma.postedFinding.count()).toBe(1);
  });

  it("resolves the thread of a fixed finding and reopens it when the finding returns", async () => {
    const found = { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH };
    const clean = { code_review: { findings: [] }, walkthrough: WALKTHROUGH };
    const first = deps({}, found);
    await runJob(await claimedJob(), first.runDeps);
    const print = first.published.inline[0]!.fingerprint;
    expect(first.published.threads).toEqual([]);

    const fixed = deps({}, clean);
    await enqueue({ repositoryId, number: 42, headSha: "fixed", trigger: "manual" });
    const fixedJob = (await claimNext())!;
    await runJob(fixedJob, fixed.runDeps);
    expect(fixed.published.threads).toEqual([{ fingerprints: [print], resolved: true }]);
    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: fixedJob.id } });
    expect(stored.publication).toMatchObject({ threadsResolved: [print], threadsReopened: [] });
    expect(await prisma.finding.findFirst({ where: { fingerprint: print } })).toMatchObject({ state: "resolved" });

    const back = deps({}, found);
    await enqueue({ repositoryId, number: 42, headSha: "back", trigger: "manual" });
    await runJob((await claimNext())!, back.runDeps);
    expect(back.published.threads).toEqual([{ fingerprints: [print], resolved: false }]);
  });

  it("trusts markers already on the forge when the database has no row", async () => {
    const answers = { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH };
    const first = deps({}, answers);
    await runJob(await claimedJob(), first.runDeps);
    await prisma.postedFinding.deleteMany();

    const second = deps({}, answers, { anthropic: "k" }, { onForge: [first.published.inline[0]!.fingerprint] });
    await enqueue({ repositoryId, number: 42, headSha: "again", trigger: "manual" });
    await runJob((await claimNext())!, second.runDeps);

    expect(second.published.inline).toEqual([]);
  });

  it("marks the job partial when publishing fails, keeping the result", async () => {
    const job = await claimedJob();
    const { runDeps, published } = deps(
      {},
      { code_review: { findings: [] }, walkthrough: WALKTHROUGH },
      { anthropic: "k" },
      { failSummary: true },
    );

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored).toMatchObject({ status: "partial", verdict: "pass", error: "Summary comment failed: 403 Forbidden" });
    expect(stored.result).not.toBeNull();
    // The status still went out even though the summary did not.
    expect(published.statuses).toEqual(["pending", "success"]);
  });

  it("adds the estimate labels when they are turned on", async () => {
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { settings: { output: { blastRadiusLabel: true, effortLabel: true } } },
    });
    const job = await claimedJob();
    const { runDeps, published } = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH });

    await runJob(job, runDeps);

    expect(published.labels).toEqual([["Small blast radius", "1-5 Minutes"]]);
    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.publication).toMatchObject({ labels: ["Small blast radius", "1-5 Minutes"], walkthroughLocation: "comment" });
  });

  it("publishes nothing when every output is turned off", async () => {
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { settings: { output: { postInline: false, postSummary: false, postCheck: false, walkthrough: false } } },
    });
    const job = await claimedJob();
    const { runDeps, published } = deps({}, { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH });

    await runJob(job, runDeps);

    expect(published).toEqual({ inline: [], summaries: [], statuses: [], descriptions: [], labels: [], threads: [] });
    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.publication).toBeNull();
  });
});

describe("runJob when the change closes", () => {
  const answers = { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH };

  it("cancels without a model call when the change is already closed", async () => {
    const job = await claimedJob();
    const { runDeps, model, published } = deps({}, answers, undefined, { states: ["merged"] });

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored).toMatchObject({ status: "cancelled", verdict: null, error: "The pull or merge request was closed or merged" });
    expect(stored.resolvedConfig).toMatchObject({ config: { triggers: { abortOnClose: true } } });
    expect(model.requests).toHaveLength(0);
    expect(published).toEqual({ inline: [], summaries: [], statuses: [], descriptions: [], labels: [], threads: [] });
  });

  it("publishes nothing when the change closes during the review", async () => {
    const job = await claimedJob();
    const { runDeps, model, published } = deps({}, answers, undefined, { states: ["open", "closed"] });

    await runJob(job, runDeps);

    expect((await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("cancelled");
    expect(model.requests.length).toBeGreaterThan(0);
    // Only the progress note and the pending status went out; the status is closed off.
    expect(published.inline).toEqual([]);
    expect(published.summaries).toHaveLength(1);
    expect(published.statuses).toEqual(["pending", "error"]);
  });

  it("hands model calls a signal the watch fires on close", async () => {
    const job = await claimedJob();
    const { runDeps, model } = deps({}, answers, undefined, { states: ["open", "closed"] });
    runDeps.closeCheckIntervalMs = 5;
    const signals: (AbortSignal | undefined)[] = [];
    runDeps.generateFor = () => async (request) => {
      signals.push(request.abortSignal);
      // Slower than the watch, so the close lands mid-call.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return model.generate(request);
    };

    await runJob(job, runDeps);

    expect((await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("cancelled");
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
  });

  it("finishes the review when abort on close is off", async () => {
    await prisma.repository.update({ where: { id: repositoryId }, data: { settings: { triggers: { abortOnClose: false } } } });
    const job = await claimedJob();
    const { runDeps, published } = deps({}, answers, undefined, { states: ["closed"] });

    await runJob(job, runDeps);

    expect((await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("completed");
    expect(published.inline).toHaveLength(1);
  });

  it("keeps a job cancelled from elsewhere cancelled", async () => {
    const job = await claimedJob();
    const { runDeps } = deps({}, answers);
    runDeps.generateFor = () => async () => {
      await prisma.reviewJob.update({ where: { id: job.id }, data: { status: "cancelled" } });
      throw new Error("aborted");
    };

    await runJob(job, runDeps);

    expect((await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("cancelled");
    expect(await prisma.finding.count()).toBe(0);
  });
});

describe("runJob issues and cache", () => {
  const issue = (ref: string, title: string): IssueContext => ({ ref, title, state: "open", body: `${title} body`, url: `https://github.com/acme/web/issues/${ref.slice(1)}` });

  it("hands linked and related issues to the walkthrough, minus duplicates", async () => {
    const job = await claimedJob();
    const { runDeps, model, reads } = deps(
      {},
      {
        code_review: { findings: [] },
        walkthrough: {
          ...WALKTHROUGH,
          linkedIssues: [{ ref: "#5", assessment: "addressed", note: "Done." }],
          relatedIssues: [{ ref: "#9", reason: "Same parser." }, { ref: "#404", reason: "Invented." }],
        },
      },
      undefined,
      {
        title: "Rework parser tokenizer",
        issues: { linked: [issue("#5", "Parser crash")], found: [issue("#5", "Parser crash"), issue("#9", "Tokenizer speed")] },
      },
    );

    await runJob(job, runDeps);

    expect(reads).toContain("search:rework parser tokenizer");
    const prompt = model.requests.find((r) => r.schemaName === "walkthrough")!.prompt;
    expect(prompt).toContain("Linked issues:\n#5 (open)");
    expect(prompt).toContain("Candidate issues:\n#9 (open)");
    expect(prompt.match(/#5 \(open\)/g)).toHaveLength(1);
    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    const walkthrough = (stored.result as { walkthrough: Record<string, unknown> }).walkthrough;
    // Bodies are prompt context only; issues the forge did not return are dropped.
    expect(walkthrough.linkedIssues).toEqual([
      { ref: "#5", title: "Parser crash", state: "open", url: "https://github.com/acme/web/issues/5", assessment: "addressed", note: "Done." },
    ]);
    expect(walkthrough.relatedIssues).toEqual([{ ref: "#9", title: "Tokenizer speed", state: "open", url: "https://github.com/acme/web/issues/9", reason: "Same parser." }]);
  });

  it("reads through the cache unless the repository disables it", async () => {
    const cache = new ForgeCache();
    const job = await claimedJob();
    const cached = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH }, undefined, { cache });
    await runJob(job, cached.runDeps);
    expect(cached.reads[0]).toBe("change:cached");
    // The change, the (missing) repository file and the changed file at head.
    expect(cache.size).toBe(3);
    const again = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH }, undefined, { cache });
    await runJob(await claimedJob(), again.runDeps);
    expect(again.reads.filter((read) => read.startsWith("newhead:"))).toEqual([]);

    // Turned off by the repository file: the cached read is redone fresh. (A
    // file at a sha never changes, so a new one needs an emptied cache here.)
    cache.clear();
    const second = await claimedJob();
    const fresh = deps({ "base:.sentryward.yaml": "review:\n  disable_cache: true\n" }, { code_review: { findings: [] }, walkthrough: WALKTHROUGH }, undefined, { cache });
    await runJob(second, fresh.runDeps);
    expect(fresh.reads.filter((read) => read.startsWith("change"))).toEqual(["change:cached", "change"]);

    // Turned off in the dashboard: nothing goes through the cache at all.
    await prisma.repository.update({ where: { id: repositoryId }, data: { settings: { review: { disableCache: true } } } });
    const third = await claimedJob();
    const none = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH }, undefined, { cache });
    await runJob(third, none.runDeps);
    expect(none.reads.filter((read) => read.startsWith("change"))).toEqual(["change"]);
    expect(none.reads.filter((read) => read.startsWith("newhead:"))).toEqual(["newhead:src/app.ts"]);
  });
});

describe("runJob with the global config", () => {
  it("applies the owner's global config beneath the repository settings", async () => {
    const repo = await prisma.repository.findUniqueOrThrow({ where: { id: repositoryId }, include: { connection: true } });
    await prisma.workspace.update({
      where: { id: repo.connection.workspaceId },
      data: { reviewSettings: { llm: { connection: "anthropic" }, review: { blockOn: "minor", maxFindings: 5 } } },
    });
    const job = await claimedJob();
    const { runDeps } = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH });

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.resolvedConfig).toMatchObject({
      config: { review: { blockOn: "major", maxFindings: 5 } },
      sources: { "review.blockOn": "repoSettings", "review.maxFindings": "global" },
    });
  });

  it("ignores the repository settings while the repository follows the global config", async () => {
    const repo = await prisma.repository.update({ where: { id: repositoryId }, data: { followGlobal: true }, include: { connection: true } });
    await prisma.workspace.update({
      where: { id: repo.connection.workspaceId },
      data: { reviewSettings: { llm: { connection: "anthropic" }, review: { blockOn: "minor" } } },
    });
    const job = await claimedJob();
    const { runDeps } = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH });

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.resolvedConfig).toMatchObject({
      config: { review: { blockOn: "minor" } },
      sources: { "review.blockOn": "global" },
    });
  });
});

describe("skipReason", () => {
  const triggers = (t: Partial<typeof DEFAULT_CONFIG.triggers>) => ({ ...DEFAULT_CONFIG, triggers: { ...DEFAULT_CONFIG.triggers, ...t } });
  const change = (c: Partial<ReturnType<typeof makeChangeSet>> = {}) => ({ ...makeChangeSet(), ...c });
  const opened = { trigger: "webhook" as const, event: "open", actor: null };
  const pushed = { trigger: "webhook" as const, event: "push", actor: null };

  it("follows the code review trigger for automatic reviews", () => {
    expect(skipReason(opened, DEFAULT_CONFIG, change({ isDraft: true }))).toMatch(/Draft/);
    expect(skipReason(opened, DEFAULT_CONFIG, change())).toBeNull();
    expect(skipReason(opened, triggers({ review: "all" }), change({ isDraft: true }))).toBeNull();
    expect(skipReason(opened, triggers({ review: "manual" }), change())).toMatch(/turned off/);
    expect(skipReason(pushed, triggers({ review: "manual" }), change())).toMatch(/turned off/);
  });

  it("reviews new commits only while review on push is on", () => {
    expect(skipReason(pushed, DEFAULT_CONFIG, change())).toBeNull();
    expect(skipReason(pushed, triggers({ reviewOnPush: false }), change())).toMatch(/New commits/);
    expect(skipReason(opened, triggers({ reviewOnPush: false }), change())).toBeNull();
  });

  it("applies the skip lists to automatic reviews only", () => {
    const skipAll = triggers({ ignoreTitles: ["wip"], skipAuthors: ["dependabot"] });
    expect(skipReason(opened, skipAll, change({ title: "WIP: add b" }))).toMatch(/title contains "wip"/);
    expect(skipReason(opened, skipAll, change({ author: "Dependabot" }))).toMatch(/Dependabot/);
    expect(skipReason({ ...pushed, actor: "dependabot" }, skipAll, change({ author: "alice" }))).toMatch(/dependabot/);
    expect(skipReason({ trigger: "manual" }, skipAll, change({ title: "WIP" }))).toBeNull();
    expect(skipReason({ trigger: "comment" }, skipAll, change({ title: "WIP" }))).toBeNull();
  });

  it("honours the command switch and never skips a manual review", () => {
    expect(skipReason({ trigger: "comment" }, triggers({ command: false }), change())).toMatch(/commands/);
    expect(skipReason({ trigger: "comment" }, DEFAULT_CONFIG, change({ isDraft: true }))).toBeNull();
    expect(skipReason({ trigger: "manual" }, triggers({ review: "manual", command: false }), change({ isDraft: true }))).toBeNull();
  });
});

describe("walkthroughEnabled", () => {
  const withTriggers = (summary: "manual" | "published") => ({
    ...DEFAULT_CONFIG,
    triggers: { ...DEFAULT_CONFIG.triggers, summary },
  });

  it("limits automatic summaries to published changes, or none when manual", () => {
    expect(walkthroughEnabled("webhook", withTriggers("published"), false)).toBe(true);
    expect(walkthroughEnabled("webhook", withTriggers("published"), true)).toBe(false);
    expect(walkthroughEnabled("webhook", withTriggers("manual"), false)).toBe(false);
    expect(walkthroughEnabled("manual", withTriggers("manual"), true)).toBe(true);
    expect(walkthroughEnabled("comment", { ...DEFAULT_CONFIG, output: { ...DEFAULT_CONFIG.output, walkthrough: false } }, false)).toBe(false);
  });
});

describe("runJob with automatic triggers", () => {
  it("records a skipped webhook job without calling the model or the forge", async () => {
    await enqueue({ repositoryId, number: 42, headSha: "oldhead", trigger: "webhook" });
    const job = (await claimNext())!;
    const { runDeps, model, published } = deps({ "base:.sentryward.yaml": "triggers:\n  on_push: false\n" }, {});

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored).toMatchObject({ status: "skipped", verdict: null, result: null });
    expect(stored.error).toMatch(/turned off/);
    expect(model.requests).toHaveLength(0);
    expect(published).toEqual({ inline: [], summaries: [], statuses: [], descriptions: [], labels: [], threads: [] });
  });
});
