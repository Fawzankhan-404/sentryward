import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.ts";
import {
  cancelJob,
  claimNext,
  claimState,
  complete,
  enqueue,
  enqueueFromWebhook,
  fail,
  heartbeat,
  recoverStale,
} from "../src/worker/queue.ts";

let repositoryId: string;

beforeEach(async () => {
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  const workspace = await prisma.workspace.create({ data: { name: "Queue Test" } });
  const connection = await prisma.forgeConnection.create({
    data: {
      workspaceId: workspace.id,
      provider: "github",
      host: "github.com",
      kind: "github_app",
      installationId: "1",
      accountLogin: "acme",
    },
  });
  const repository = await prisma.repository.create({
    data: {
      connectionId: connection.id,
      provider: "github",
      host: "github.com",
      fullPath: "acme/web",
      externalId: "100",
      defaultBranch: "main",
      enabled: true,
    },
  });
  repositoryId = repository.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

const job = (headSha: string, number = 7) =>
  enqueue({ repositoryId, number, headSha, trigger: "webhook" });

describe("enqueue", () => {
  it("returns the existing job for the same head instead of duplicating it", async () => {
    const first = await job("aaa");
    const second = await job("aaa");

    expect(second.id).toBe(first.id);
    expect(await prisma.reviewJob.count()).toBe(1);
  });

  it("supersedes a queued job when a newer head arrives", async () => {
    const old = await job("aaa");
    const latest = await job("bbb");

    expect((await prisma.reviewJob.findUniqueOrThrow({ where: { id: old.id } })).status).toBe(
      "superseded",
    );
    expect(latest.status).toBe("queued");
  });

  it("leaves other pull requests alone", async () => {
    const other = await job("aaa", 8);
    await job("bbb", 7);

    expect((await prisma.reviewJob.findUniqueOrThrow({ where: { id: other.id } })).status).toBe(
      "queued",
    );
  });
});

describe("claimNext", () => {
  it("claims the oldest queued job and marks it running", async () => {
    const first = await job("aaa", 1);
    await job("bbb", 2);

    const claimed = await claimNext();

    expect(claimed?.id).toBe(first.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.lockedAt).toBeInstanceOf(Date);
  });

  it("never hands the same job to two concurrent claims", async () => {
    await Promise.all([1, 2, 3].map((n) => job(`sha${n}`, n)));

    const claims = await Promise.all(Array.from({ length: 6 }, () => claimNext()));
    const ids = claims.filter((c) => c !== null).map((c) => c.id);

    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it("returns null when nothing is queued", async () => {
    expect(await claimNext()).toBeNull();
  });
});

describe("complete and fail", () => {
  it("stores the result and verdict and releases the lock", async () => {
    await job("aaa");
    const claimed = (await claimNext())!;

    await complete(claimed.id, {
      status: "completed",
      verdict: "blocked",
      result: { findings: [{ title: "x" }] },
    });

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(stored).toMatchObject({ status: "completed", verdict: "blocked", lockedAt: null });
    expect(stored.result).toEqual({ findings: [{ title: "x" }] });
    expect(stored.finishedAt).toBeInstanceOf(Date);
  });

  it("records a failure as an error verdict", async () => {
    await job("aaa");
    const claimed = (await claimNext())!;

    await fail(claimed.id, "boom");

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(stored).toMatchObject({ status: "failed", verdict: "error", error: "boom" });
  });
});

describe("recoverStale", () => {
  it("requeues a stale job with attempts left and fails one without", async () => {
    const retry = await job("aaa", 1);
    const exhausted = await job("bbb", 2);
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.reviewJob.update({
      where: { id: retry.id },
      data: { status: "running", lockedAt: longAgo, attempts: 1 },
    });
    await prisma.reviewJob.update({
      where: { id: exhausted.id },
      data: { status: "running", lockedAt: longAgo, attempts: 3 },
    });

    expect(await recoverStale(15 * 60 * 1000, 3)).toBe(2);
    expect((await prisma.reviewJob.findUniqueOrThrow({ where: { id: retry.id } })).status).toBe(
      "queued",
    );
    expect(
      await prisma.reviewJob.findUniqueOrThrow({ where: { id: exhausted.id } }),
    ).toMatchObject({ status: "failed", verdict: "error" });
  });

  it("leaves a fresh running job alone", async () => {
    await job("aaa");
    await claimNext();

    expect(await recoverStale(15 * 60 * 1000, 3)).toBe(0);
  });
});

describe("heartbeat", () => {
  it("refreshes the lock so a slow-but-healthy job is not reclaimed", async () => {
    const slow = await job("aaa");
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.reviewJob.update({
      where: { id: slow.id },
      data: { status: "running", lockedAt: longAgo, attempts: 1 },
    });

    await heartbeat(slow.id);

    // The bumped lock is now fresh, so recovery leaves the job running.
    expect(await recoverStale(15 * 60 * 1000, 3)).toBe(0);
    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: slow.id } });
    expect(stored.status).toBe("running");
    expect(stored.lockedAt!.getTime()).toBeGreaterThan(longAgo.getTime());
  });

  it("does not touch a job that is no longer running", async () => {
    const done = await job("aaa");
    const claimed = (await claimNext())!;
    await complete(claimed.id, { status: "completed", verdict: "pass" });

    await heartbeat(done.id);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: done.id } });
    expect(stored.status).toBe("completed");
    expect(stored.lockedAt).toBeNull();
  });
});

describe("claimState", () => {
  it("is owned while the job runs under the same attempt", async () => {
    await job("aaa");
    const claimed = (await claimNext())!;

    expect(await claimState(claimed.id, claimed.attempts)).toBe("owned");
  });

  it("reports a cancel from the dashboard", async () => {
    await job("aaa");
    const claimed = (await claimNext())!;
    const { workspaceId } = await prisma.forgeConnection.findFirstOrThrow();
    await cancelJob(claimed.id, workspaceId, "Cancelled by Dev");

    expect(await claimState(claimed.id, claimed.attempts)).toBe("cancelled");
  });

  it("is lost once the job was failed", async () => {
    await job("aaa");
    const claimed = (await claimNext())!;
    await fail(claimed.id, "Review exceeded the maximum run time");

    expect(await claimState(claimed.id, claimed.attempts)).toBe("lost");
  });

  it("is lost once recovery requeued the job and another run claimed it", async () => {
    await job("aaa");
    const first = (await claimNext())!;
    await prisma.reviewJob.update({
      where: { id: first.id },
      data: { lockedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    await recoverStale(15 * 60 * 1000, 3);
    const second = (await claimNext())!;

    expect(second.id).toBe(first.id);
    expect(await claimState(first.id, first.attempts)).toBe("lost");
    expect(await claimState(second.id, second.attempts)).toBe("owned");
  });
});

describe("per-workspace concurrency", () => {
  it("skips a workspace at its running limit and serves the next workspace", async () => {
    const other = await prisma.workspace.create({ data: { name: "O" } });
    const conn = await prisma.forgeConnection.create({
      data: { workspaceId: other.id, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "o" },
    });
    const otherRepo = await prisma.repository.create({
      data: { connectionId: conn.id, provider: "gitlab", host: "gitlab.com", fullPath: "o/r", externalId: "2", defaultBranch: "main" },
    });
    await job("a", 1);
    await job("b", 2);
    const theirs = await enqueue({ repositoryId: otherRepo.id, number: 1, headSha: "c", trigger: "manual" });

    expect((await claimNext(1))?.number).toBe(1);
    // The first workspace is at its limit of one, so its second job waits.
    expect((await claimNext(1))?.id).toBe(theirs.id);
    expect(await claimNext(1)).toBeNull();
  });
  it("counts every connection in a workspace against the same limit", async () => {
    const { workspaceId } = await prisma.forgeConnection.findFirstOrThrow();
    const second = await prisma.forgeConnection.create({
      data: { workspaceId, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "teammate" },
    });
    const secondRepo = await prisma.repository.create({
      data: { connectionId: second.id, provider: "gitlab", host: "gitlab.com", fullPath: "t/r", externalId: "3", defaultBranch: "main" },
    });
    await job("a", 1);
    await enqueue({ repositoryId: secondRepo.id, number: 1, headSha: "b", trigger: "manual" });

    expect(await claimNext(1)).not.toBeNull();
    expect(await claimNext(1)).toBeNull();
  });
});

describe("enqueueFromWebhook", () => {
  it("refuses a head it has seen in any state but superseded", async () => {
    const done = await job("aaa");
    await prisma.reviewJob.update({ where: { id: done.id }, data: { status: "failed" } });
    expect(await enqueueFromWebhook({ repositoryId, number: 7, headSha: "aaa", trigger: "webhook" })).toEqual({
      queued: false,
      reason: "duplicate",
    });
  });

  it("stops queueing once a repository's queue is full", async () => {
    for (let n = 1; n <= 10; n++) await job(`s${n}`, n);
    expect(await enqueueFromWebhook({ repositoryId, number: 99, headSha: "z", trigger: "webhook" })).toEqual({
      queued: false,
      reason: "queue_full",
    });
  });
});
