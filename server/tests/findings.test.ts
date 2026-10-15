import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.ts";
import { prisma } from "../src/lib/prisma.ts";
import type { ReviewResult } from "../src/review/core/models.ts";
import { findingTransitions, syncFindings, threadOperations } from "../src/worker/syncFindings.ts";
import { sampleResult } from "./helpers/result.ts";
import { createUser } from "./helpers/users.ts";

let cookie: string;
let workspaceId: string;
let repoId: string;
let base: ReviewResult;

async function createRepo(owner: string, fullPath = "team/web") {
  const connection = await prisma.forgeConnection.create({
    data: { workspaceId: owner, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "dev" },
  });
  const repo = await prisma.repository.create({
    data: {
      connectionId: connection.id,
      provider: "gitlab",
      host: "gitlab.com",
      fullPath,
      externalId: fullPath,
      defaultBranch: "main",
      enabled: true,
    },
  });
  return repo.id;
}

// Stores the result as the worker would, so the finding endpoint can read it back.
async function job(repositoryId: string, number: number, result: ReviewResult) {
  return prisma.reviewJob.create({
    data: { repositoryId, number, headSha: "head", trigger: "manual", status: "completed", result },
  });
}

async function sync(result: ReviewResult, options: { author?: string; repositoryId?: string; number?: number } = {}) {
  const repositoryId = options.repositoryId ?? repoId;
  const number = options.number ?? 7;
  const { id } = await job(repositoryId, number, result);
  await syncFindings({ repositoryId, number, jobId: id, author: options.author ?? "alice", result });
  return id;
}

const rows = () => prisma.finding.findMany({ where: { repositoryId: repoId }, orderBy: { title: "asc" } });
const byTitle = async (title: string) => (await rows()).find((row) => row.title === title)!;

beforeEach(async () => {
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  const created = await createUser();
  cookie = created.cookie;
  workspaceId = created.workspace.id;
  repoId = await createRepo(workspaceId);
  base ??= await sampleResult();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("syncFindings", () => {
  it("records every finding of a run as open, with the author and the run", async () => {
    const jobId = await sync(base);
    const stored = await rows();
    expect(stored).toHaveLength(new Set(base.findings.map((f) => f.fingerprint)).size);
    expect(stored.every((row) => row.state === "open" && row.author === "alice" && row.lastJobId === jobId)).toBe(true);
    expect(stored[0]!.changeTitle).toBe(base.change.title);
  });

  it("resolves a finding a later run no longer reports, and reopens it if it returns", async () => {
    await sync(base);
    const [gone, ...rest] = base.findings;
    await sync({ ...base, findings: rest });
    expect((await byTitle(gone!.title)).state).toBe("resolved");
    expect((await byTitle(gone!.title)).resolvedAt).not.toBeNull();

    await sync(base);
    const back = await byTitle(gone!.title);
    expect(back.state).toBe("open");
    expect(back.resolvedAt).toBeNull();
  });

  it("does not resolve findings in a file the run did not review", async () => {
    await sync(base);
    const file = base.findings[0]!.file;
    await sync({
      ...base,
      status: "partial",
      findings: base.findings.filter((f) => f.file !== file),
      coverage: { ...base.coverage, reviewedFiles: base.coverage.reviewedFiles.filter((f) => f !== file) },
    });
    expect((await rows()).every((row) => row.state === "open")).toBe(true);
  });

  it("keeps an ignored finding ignored", async () => {
    await sync(base);
    const target = base.findings[0]!;
    await prisma.finding.updateMany({ where: { fingerprint: target.fingerprint }, data: { state: "ignored" } });
    await sync(base);
    await sync({ ...base, findings: base.findings.slice(1) });
    expect((await byTitle(target.title)).state).toBe("ignored");
  });

  it("ignores a failed run", async () => {
    await sync({ ...base, status: "failed" });
    expect(await rows()).toHaveLength(0);
  });
});

describe("findingTransitions", () => {
  const row = (fingerprint: string, state: string, file: string) => ({ fingerprint, state, file });

  it("resolves open findings no longer reported in a reviewed file and reopens returning ones", () => {
    const [kept, back] = base.findings;
    const file = base.findings[0]!.file;
    const existing = [
      row(kept!.fingerprint, "open", kept!.file),
      row(back!.fingerprint, "resolved", back!.file),
      row("ffffffffffffffff", "open", file),
      row("eeeeeeeeeeeeeeee", "open", "gone/from/the/change.ts"),
      row("dddddddddddddddd", "ignored", file),
    ];
    expect(findingTransitions(existing, base)).toEqual({
      resolved: ["ffffffffffffffff", "eeeeeeeeeeeeeeee"],
      reopened: [back!.fingerprint],
    });
  });

  it("says nothing about a file the run skipped, or for a failed run", () => {
    const file = base.findings[0]!.file;
    const existing = [row("ffffffffffffffff", "open", file)];
    const skipped = { ...base, coverage: { ...base.coverage, reviewedFiles: base.coverage.reviewedFiles.filter((f) => f !== file) } };
    expect(findingTransitions(existing, skipped).resolved).toEqual([]);
    expect(findingTransitions(existing, { ...base, status: "failed" })).toEqual({ resolved: [], reopened: [] });
  });
});

describe("threadOperations", () => {
  it("adds failed thread updates, toward the state the finding now has", () => {
    const existing = [
      { fingerprint: "aaaaaaaaaaaaaaaa", state: "resolved", file: "a.ts", threadPending: true },
      { fingerprint: "bbbbbbbbbbbbbbbb", state: "open", file: "a.ts", threadPending: true },
      { fingerprint: "cccccccccccccccc", state: "ignored", file: "a.ts", threadPending: true },
      { fingerprint: "dddddddddddddddd", state: "open", file: "a.ts", threadPending: false },
      // Pending a reopen, but this run resolves it again: the transition wins.
      { fingerprint: "eeeeeeeeeeeeeeee", state: "open", file: "a.ts", threadPending: true },
    ];
    expect(threadOperations(existing, { resolved: ["eeeeeeeeeeeeeeee"], reopened: [] })).toEqual({
      resolve: ["eeeeeeeeeeeeeeee", "aaaaaaaaaaaaaaaa"],
      reopen: ["bbbbbbbbbbbbbbbb"],
    });
  });
});

describe("syncFindings thread outcome", () => {
  it("marks failed thread updates pending and clears settled ones, even for a failed run", async () => {
    await sync(base);
    const [failed, settled] = base.findings.map((f) => f.fingerprint);
    const { id } = await job(repoId, 7, base);
    await syncFindings({ repositoryId: repoId, number: 7, jobId: id, result: base, threads: { attempted: [failed!, settled!], failed: [failed!] } });
    const pending = async (print: string) => (await prisma.finding.findFirstOrThrow({ where: { fingerprint: print } })).threadPending;
    expect(await pending(failed!)).toBe(true);
    expect(await pending(settled!)).toBe(false);

    await syncFindings({
      repositoryId: repoId,
      number: 7,
      jobId: id,
      result: { ...base, status: "failed" },
      threads: { attempted: [failed!], failed: [] },
    });
    expect(await pending(failed!)).toBe(false);
  });
});

describe("GET /api/findings", () => {
  it("lists the user's findings with their repository, filtered and paged", async () => {
    await sync(base);
    const critical = base.findings.filter((f) => f.severity === "critical").length;

    const res = await request(app).get("/api/findings?severity=critical").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(critical);
    expect(res.body.findings[0]).toMatchObject({
      number: 7,
      state: "open",
      severity: "critical",
      author: "alice",
      repository: { fullPath: "team/web", provider: "gitlab" },
    });

    const paged = await request(app).get("/api/findings?limit=1&page=2").set("Cookie", cookie);
    expect(paged.body.findings).toHaveLength(1);
    expect(paged.body.total).toBe((await rows()).length);
  });

  it("searches by change number and title", async () => {
    await sync(base);
    await sync(base, { number: 8 });
    const byNumber = await request(app).get("/api/findings?q=!8").set("Cookie", cookie);
    expect(byNumber.body.findings.every((f: { number: number }) => f.number === 8)).toBe(true);
    const byText = await request(app).get(`/api/findings?q=${encodeURIComponent("SQL built")}`).set("Cookie", cookie);
    expect(byText.body.total).toBe(2);
  });

  it("never shows another user's findings", async () => {
    const other = await createUser("other@example.com");
    const otherRepo = await createRepo(other.workspace.id, "other/app");
    await sync(base, { repositoryId: otherRepo });
    const res = await request(app).get("/api/findings").set("Cookie", cookie);
    expect(res.body.total).toBe(0);
  });

  it("rejects an unknown filter value", async () => {
    const res = await request(app).get("/api/findings?state=done").set("Cookie", cookie);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/findings sorting", () => {
  const list = async (query: string) =>
    (await request(app).get(`/api/findings?${query}`).set("Cookie", cookie)).body.findings as {
      number: number;
      severity: string;
      author: string | null;
      repository: { fullPath: string };
    }[];

  it("sorts severity by rank, most severe first when descending", async () => {
    await sync(base);
    const rank = ["critical", "major", "minor", "info"];
    const desc = (await list("sort=severity&dir=desc")).map((f) => rank.indexOf(f.severity));
    expect(desc).toEqual([...desc].sort((a, b) => a - b));
    expect(desc[0]).toBe(0);
    const asc = (await list("sort=severity&dir=asc")).map((f) => rank.indexOf(f.severity));
    expect(asc).toEqual([...asc].sort((a, b) => b - a));
  });

  it("sorts by change number and by repository", async () => {
    await sync(base, { number: 9 });
    await sync(base, { number: 3 });
    const numbers = (await list("sort=number&dir=asc")).map((f) => f.number);
    expect(numbers[0]).toBe(3);
    expect(numbers.at(-1)).toBe(9);

    const second = await createRepo(workspaceId, "team/api");
    await sync(base, { repositoryId: second });
    const paths = (await list("sort=repository&dir=asc&limit=100")).map((f) => f.repository.fullPath);
    expect(paths[0]).toBe("team/api");
    expect(paths.at(-1)).toBe("team/web");
  });

  it("puts findings without an author last either way", async () => {
    await sync(base, { number: 1, author: "zed" });
    await sync(base, { number: 2, author: "amy" });
    await prisma.finding.updateMany({ where: { number: 1 }, data: { author: null } });
    for (const dir of ["asc", "desc"]) {
      const authors = (await list(`sort=author&dir=${dir}&limit=100`)).map((f) => f.author);
      expect(authors.at(-1)).toBeNull();
      expect(authors[0]).toBe("amy");
    }
  });

  it("rejects an unknown sort", async () => {
    const res = await request(app).get("/api/findings?sort=fingerprint").set("Cookie", cookie);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/findings/:id", () => {
  it("returns the row with the full finding and the change it was found on", async () => {
    await sync(base);
    const target = base.findings.find((f) => f.suggestion)!;
    const row = await prisma.finding.findFirstOrThrow({ where: { fingerprint: target.fingerprint } });
    const res = await request(app).get(`/api/findings/${row.id}`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.finding).toMatchObject({ id: row.id, title: target.title, author: "alice" });
    expect(res.body.finding.fingerprint).toBeUndefined();
    expect(res.body.detail).toMatchObject({ body: target.body, suggestion: target.suggestion, endLine: target.endLine });
    expect(res.body.change).toMatchObject({ title: base.change.title, number: base.change.number });
  });

  it("falls back to the row alone once its run is gone", async () => {
    await sync(base);
    const [row] = await rows();
    await prisma.reviewJob.deleteMany();
    const res = await request(app).get(`/api/findings/${row!.id}`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ finding: { id: row!.id, lastJobId: null }, detail: null, change: null });
  });

  it("404s on another user's finding", async () => {
    const other = await createUser("other@example.com");
    const otherRepo = await createRepo(other.workspace.id, "other/app");
    await sync(base, { repositoryId: otherRepo });
    const theirs = await prisma.finding.findFirstOrThrow({ where: { repositoryId: otherRepo } });
    const res = await request(app).get(`/api/findings/${theirs.id}`).set("Cookie", cookie);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/findings/stats", () => {
  it("counts open findings by severity and the resolution rate", async () => {
    await sync(base);
    await sync({ ...base, findings: base.findings.slice(1) });
    const total = (await rows()).length;
    const res = await request(app).get("/api/findings/stats").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ days: 30, open: total - 1, resolved: 1, total });
    expect(res.body.resolutionRate).toBe(Math.round((1 / total) * 100));
    const bySeverity = Object.values(res.body.openBySeverity as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(bySeverity).toBe(total - 1);
    expect(res.body).toMatchObject({ staleOpen: 0, falsePositives: 0, found: total, falsePositiveRate: 0 });
  });

  it("counts stale open findings, the median time to resolve and false positives", async () => {
    await sync(base);
    const [stale, fast, slow, dismissed] = await rows();
    expect(dismissed).toBeDefined();
    const hours = (n: number) => n * 3_600_000;
    const now = Date.now();
    await prisma.finding.update({ where: { id: stale!.id }, data: { firstSeenAt: new Date(now - hours(40 * 24)) } });
    for (const [row, took] of [
      [fast!, hours(2)],
      [slow!, hours(6)],
    ] as const) {
      await prisma.finding.update({
        where: { id: row.id },
        data: { state: "resolved", firstSeenAt: new Date(now - hours(10)), resolvedAt: new Date(now - hours(10) + took) },
      });
    }
    await request(app)
      .patch(`/api/findings/${dismissed!.id}`)
      .set("Cookie", cookie)
      .send({ state: "ignored", reason: "false_positive" });

    const total = (await rows()).length;
    const res = await request(app).get("/api/findings/stats").set("Cookie", cookie);
    // The stale finding was first seen before the period, so it is not "found" in it.
    expect(res.body).toMatchObject({
      staleOpen: 1,
      medianTimeToResolve: hours(4),
      falsePositives: 1,
      found: total - 1,
      falsePositiveRate: Math.round((1 / (total - 1)) * 100),
    });
  });

  it("leaves ignored findings out of the rate", async () => {
    await sync(base);
    await prisma.finding.updateMany({ data: { state: "ignored" } });
    const res = await request(app).get("/api/findings/stats").set("Cookie", cookie);
    expect(res.body).toMatchObject({ open: 0, total: 0, resolutionRate: null });
  });
});

describe("PATCH /api/findings/:id", () => {
  it("ignores and reopens a finding", async () => {
    await sync(base);
    const [row] = await rows();
    const ignored = await request(app).patch(`/api/findings/${row!.id}`).set("Cookie", cookie).send({ state: "ignored" });
    expect(ignored.status).toBe(200);
    expect(ignored.body.finding.state).toBe("ignored");
    expect(ignored.body.finding.ignoredAt).not.toBeNull();

    const reopened = await request(app).patch(`/api/findings/${row!.id}`).set("Cookie", cookie).send({ state: "open" });
    expect(reopened.body.finding).toMatchObject({ state: "open", ignoredAt: null });
  });

  it("stores why a finding was ignored and forgets it on reopen", async () => {
    await sync(base);
    const [row] = await rows();
    const url = `/api/findings/${row!.id}`;
    const ignored = await request(app)
      .patch(url)
      .set("Cookie", cookie)
      .send({ state: "ignored", reason: "false_positive", note: "  The input is validated upstream.  " });
    expect(ignored.body.finding).toMatchObject({
      ignoreReason: "false_positive",
      ignoreNote: "The input is validated upstream.",
    });
    const detail = await request(app).get(url).set("Cookie", cookie);
    expect(detail.body.finding).toMatchObject({ state: "ignored", ignoreReason: "false_positive" });

    const reopened = await request(app).patch(url).set("Cookie", cookie).send({ state: "open" });
    expect(reopened.body.finding).toMatchObject({ state: "open", ignoredAt: null, ignoreReason: null, ignoreNote: null });
  });

  it("records an unspecified reason and no note when none are given", async () => {
    await sync(base);
    const [row] = await rows();
    const res = await request(app)
      .patch(`/api/findings/${row!.id}`)
      .set("Cookie", cookie)
      .send({ state: "ignored", note: "   " });
    expect(res.body.finding).toMatchObject({ ignoreReason: "not_specified", ignoreNote: null });
  });

  it("rejects an unknown reason and an overlong note", async () => {
    await sync(base);
    const [row] = await rows();
    const url = `/api/findings/${row!.id}`;
    const badReason = await request(app).patch(url).set("Cookie", cookie).send({ state: "ignored", reason: "lazy" });
    expect(badReason.status).toBe(400);
    const longNote = await request(app)
      .patch(url)
      .set("Cookie", cookie)
      .send({ state: "ignored", reason: "intentional", note: "x".repeat(1001) });
    expect(longNote.status).toBe(400);
    expect(longNote.body.errors.note).toBeDefined();
  });

  it("refuses to mark a finding resolved by hand", async () => {
    await sync(base);
    const [row] = await rows();
    const res = await request(app).patch(`/api/findings/${row!.id}`).set("Cookie", cookie).send({ state: "resolved" });
    expect(res.status).toBe(400);
  });

  it("404s on another user's finding", async () => {
    const other = await createUser("other@example.com");
    const otherRepo = await createRepo(other.workspace.id, "other/app");
    await sync(base, { repositoryId: otherRepo });
    const theirs = await prisma.finding.findFirstOrThrow({ where: { repositoryId: otherRepo } });
    const res = await request(app).patch(`/api/findings/${theirs.id}`).set("Cookie", cookie).send({ state: "ignored" });
    expect(res.status).toBe(404);
  });
});
