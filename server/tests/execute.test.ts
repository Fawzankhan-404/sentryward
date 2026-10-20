import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.ts";
import { execute } from "../src/worker/execute.ts";
import { claimNext, enqueue, recoverStale } from "../src/worker/queue.ts";

let repositoryId: string;

beforeEach(async () => {
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  const workspace = await prisma.workspace.create({ data: { name: "Execute Test" } });
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

async function claimedJob() {
  await enqueue({ repositoryId, number: 7, headSha: "aaa", trigger: "manual" });
  return (await claimNext())!;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("execute", () => {
  it("fails a run that never settles once it passes the maximum run time", async () => {
    const job = await claimedJob();

    await execute(job, { runJob: () => new Promise(() => {}), heartbeatMs: 1000, maxRunMs: 30 });

    expect(await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: "failed",
      verdict: "error",
      error: "Review exceeded the maximum run time",
    });
  });

  it("keeps a long run's lock fresh so recovery leaves it alone", async () => {
    const job = await claimedJob();
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.reviewJob.update({ where: { id: job.id }, data: { lockedAt: longAgo } });
    let recovered = -1;

    await execute(job, {
      runJob: async () => {
        await sleep(60);
        recovered = await recoverStale(15 * 60 * 1000, 3);
      },
      heartbeatMs: 10,
      maxRunMs: 60_000,
    });

    expect(recovered).toBe(0);
    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.status).toBe("running");
    expect(stored.lockedAt!.getTime()).toBeGreaterThan(longAgo.getTime());
  });

  it("records a thrown error as the failure", async () => {
    const job = await claimedJob();

    await execute(job, {
      runJob: async () => {
        throw new Error("The repository is no longer connected");
      },
      heartbeatMs: 1000,
      maxRunMs: 60_000,
    });

    expect(await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: "failed",
      error: "The repository is no longer connected",
    });
  });
});
