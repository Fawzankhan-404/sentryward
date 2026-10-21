import { prisma } from "../lib/prisma.ts";
import type { ThreadReply } from "../generated/prisma/client.ts";

// Same claim as review jobs (queue.ts claimNext): SKIP LOCKED so several
// workers never take one reply twice. Replies are small, so there is no
// per-workspace limit.
export async function claimNextReply(): Promise<ThreadReply | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE thread_replies
    SET status = 'running', locked_at = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM thread_replies
      WHERE status = 'queued'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id
  `;
  const claimed = rows[0];
  return claimed ? prisma.threadReply.findUnique({ where: { id: claimed.id } }) : null;
}

export interface FinishReplyInput {
  status: "done" | "skipped" | "failed";
  answerCommentId?: string;
  error?: string;
}

export async function finishReply(id: string, input: FinishReplyInput): Promise<void> {
  await prisma.threadReply.updateMany({
    where: { id, status: "running" },
    data: { ...input, lockedAt: null, finishedAt: new Date() },
  });
}

// A worker that died mid-reply: back to the queue, or failed once out of
// attempts. A reply posted just before the crash may be posted again; that is
// rarer and cheaper than one never answered.
export async function recoverStaleReplies(lockTimeoutMs: number, maxAttempts: number): Promise<number> {
  const cutoff = new Date(Date.now() - lockTimeoutMs);
  const [requeued, failed] = await prisma.$transaction([
    prisma.threadReply.updateMany({
      where: { status: "running", lockedAt: { lt: cutoff }, attempts: { lt: maxAttempts } },
      data: { status: "queued", lockedAt: null },
    }),
    prisma.threadReply.updateMany({
      where: { status: "running", lockedAt: { lt: cutoff }, attempts: { gte: maxAttempts } },
      data: { status: "failed", error: "Worker stopped responding", lockedAt: null, finishedAt: new Date() },
    }),
  ]);
  return requeued.count + failed.count;
}
