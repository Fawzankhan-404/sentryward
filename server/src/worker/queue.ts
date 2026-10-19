import { prisma } from "../lib/prisma.ts";
import type { Repository, ReviewJob, ReviewTrigger } from "../generated/prisma/client.ts";
import { loadDashboardConfig } from "../review/config/load.ts";

export interface EnqueueInput {
  repositoryId: string;
  number: number;
  headSha: string;
  trigger: ReviewTrigger;
  event?: "open" | "push";
  actor?: string;
}

// A newer push makes any still-queued review of the same PR pointless, so it is
// marked superseded rather than left to spend a model call. A job for the same
// head that is already queued or running is returned instead of duplicated.
export async function enqueue(input: EnqueueInput): Promise<ReviewJob> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.reviewJob.findFirst({
      where: {
        repositoryId: input.repositoryId,
        number: input.number,
        headSha: input.headSha,
        status: { in: ["queued", "running"] },
      },
    });
    if (existing) {
      return existing;
    }

    await tx.reviewJob.updateMany({
      where: {
        repositoryId: input.repositoryId,
        number: input.number,
        status: "queued",
      },
      data: { status: "superseded", finishedAt: new Date() },
    });

    return tx.reviewJob.create({ data: input });
  });
}

// Forge redeliveries and repeated events must not review a commit twice, and a
// burst of pushes must not pile up work: a repository holds at most this many
// queued jobs (newer pushes already supersede older ones).
const MAX_QUEUED_PER_REPOSITORY = 10;

export type WebhookEnqueueResult =
  | { queued: true; job: ReviewJob }
  | { queued: false; reason: "duplicate" | "queue_full" };

// For automatic triggers: a head that was ever queued or reviewed is left
// alone. A person asking explicitly (manual or comment) goes through enqueue().
export async function enqueueFromWebhook(input: EnqueueInput): Promise<WebhookEnqueueResult> {
  const seen = await prisma.reviewJob.findFirst({
    where: {
      repositoryId: input.repositoryId,
      number: input.number,
      headSha: input.headSha,
      // A skipped job does not count: a draft marked ready for review keeps its
      // head, and must still be reviewed.
      status: { notIn: ["superseded", "skipped"] },
    },
    select: { id: true },
  });
  if (seen) return { queued: false, reason: "duplicate" };

  const queued = await prisma.reviewJob.count({
    where: { repositoryId: input.repositoryId, status: "queued", number: { not: input.number } },
  });
  if (queued >= MAX_QUEUED_PER_REPOSITORY) return { queued: false, reason: "queue_full" };

  return { queued: true, job: await enqueue(input) };
}

// Claims the oldest queued job whose workspace is under the per-workspace
// running limit. SKIP LOCKED lets several workers poll the same table without
// ever handing one job to two of them. Two workers claiming for the same
// workspace at the same instant can exceed the limit by one; it is a fairness
// bound, not a hard quota.
export async function claimNext(workspaceConcurrency = Number.MAX_SAFE_INTEGER): Promise<ReviewJob | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE review_jobs
    SET status = 'running', locked_at = now(), started_at = now(), attempts = attempts + 1
    WHERE id = (
      SELECT j.id FROM review_jobs j
      JOIN repositories r ON r.id = j.repository_id
      JOIN forge_connections c ON c.id = r.connection_id
      WHERE j.status = 'queued'
        AND (
          SELECT count(*) FROM review_jobs running
          JOIN repositories rr ON rr.id = running.repository_id
          JOIN forge_connections rc ON rc.id = rr.connection_id
          WHERE running.status = 'running' AND rc.workspace_id = c.workspace_id
        ) < ${workspaceConcurrency}
      ORDER BY j.created_at
      FOR UPDATE OF j SKIP LOCKED
      LIMIT 1
    )
    RETURNING id
  `;
  const claimed = rows[0];
  return claimed ? prisma.reviewJob.findUnique({ where: { id: claimed.id } }) : null;
}

export interface CompleteInput {
  status: "completed" | "partial" | "failed" | "skipped" | "cancelled";
  verdict: ReviewJob["verdict"];
  result?: unknown;
  summary?: unknown;
  publication?: unknown;
  resolvedConfig?: unknown;
  error?: string | null;
}

// Only a running job is finished: one cancelled while it ran keeps that
// status, so a close that arrives mid-review is never overwritten.
export async function complete(
  id: string,
  input: CompleteInput & Partial<Pick<ReviewJob, "headSha" | "baseSha">>,
): Promise<boolean> {
  const { count } = await prisma.reviewJob.updateMany({
    where: { id, status: "running" },
    data: {
      headSha: input.headSha,
      baseSha: input.baseSha,
      status: input.status,
      verdict: input.verdict,
      result: input.result as object | undefined,
      summary: input.summary as object | undefined,
      publication: input.publication as object | undefined,
      resolvedConfig: input.resolvedConfig as object | undefined,
      error: input.error ?? null,
      lockedAt: null,
      finishedAt: new Date(),
    },
  });
  return count > 0;
}

export async function fail(id: string, error: string): Promise<void> {
  await prisma.reviewJob.updateMany({
    where: { id, status: "running" },
    data: { status: "failed", verdict: "error", error, lockedAt: null, finishedAt: new Date() },
  });
}

export const CLOSED_REASON = "The pull or merge request was closed or merged";

// A closed or merged change needs no review, so its queued jobs are
// cancelled when the forge reports the close, unless the dashboard settings
// turned that off. A running job is left to the worker, which checks the change
// itself with the full configuration, repository file included.
export async function cancelQueuedForClosedChange(
  repo: Pick<Repository, "id" | "settings" | "followGlobal" | "connectionId">,
  number: number,
): Promise<number> {
  const owner = await prisma.forgeConnection.findUnique({
    where: { id: repo.connectionId },
    select: { workspace: { select: { reviewSettings: true } } },
  });
  const config = loadDashboardConfig({
    globalSettings: owner?.workspace.reviewSettings,
    repoSettings: repo.settings,
    followGlobal: repo.followGlobal,
  });
  if (!config.triggers.abortOnClose) return 0;
  const { count } = await prisma.reviewJob.updateMany({
    where: { repositoryId: repo.id, number, status: "queued" },
    data: { status: "cancelled", error: CLOSED_REASON, finishedAt: new Date() },
  });
  return count;
}

// A person stopping a review. One status check and write, so it cannot race a
// worker: claimNext only takes queued jobs, and complete() and fail() only
// finish running ones, so the reason given here is the one that stays.
export async function cancelJob(id: string, workspaceId: string, reason: string): Promise<number> {
  const { count } = await prisma.reviewJob.updateMany({
    where: { id, repository: { connection: { workspaceId } }, status: { in: ["queued", "running"] } },
    data: { status: "cancelled", error: reason, lockedAt: null, finishedAt: new Date() },
  });
  return count;
}

export async function isCancelled(id: string): Promise<boolean> {
  const job = await prisma.reviewJob.findUnique({ where: { id }, select: { status: true } });
  return job?.status === "cancelled";
}

// A worker that died mid-job leaves it running forever. Jobs locked longer than
// the timeout go back to the queue, or fail once they have used every attempt.
export async function recoverStale(lockTimeoutMs: number, maxAttempts: number): Promise<number> {
  const cutoff = new Date(Date.now() - lockTimeoutMs);
  const [requeued, failed] = await prisma.$transaction([
    prisma.reviewJob.updateMany({
      where: { status: "running", lockedAt: { lt: cutoff }, attempts: { lt: maxAttempts } },
      data: { status: "queued", lockedAt: null },
    }),
    prisma.reviewJob.updateMany({
      where: { status: "running", lockedAt: { lt: cutoff }, attempts: { gte: maxAttempts } },
      data: {
        status: "failed",
        verdict: "error",
        error: "Worker stopped responding",
        lockedAt: null,
        finishedAt: new Date(),
      },
    }),
  ]);
  return requeued.count + failed.count;
}
