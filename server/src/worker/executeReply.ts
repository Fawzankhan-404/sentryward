import type { ThreadReply } from "../generated/prisma/client.ts";
import { finishReply } from "./replyQueue.ts";
import { runReply } from "./runReply.ts";

// A reply is a few forge calls and at most one short model call, so unlike a
// review it needs no heartbeat, only a bound that frees its slot if it hangs.
const MAX_REPLY_RUN_MS = 5 * 60 * 1000;

const RUN_TIMEOUT = Symbol("run-timeout");

export async function executeReply(
  reply: ThreadReply,
  run: (reply: ThreadReply) => Promise<void> = (r) => runReply(r),
  maxRunMs = MAX_REPLY_RUN_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof RUN_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(RUN_TIMEOUT), maxRunMs);
    timer.unref();
  });
  try {
    const outcome = await Promise.race([run(reply), timeout]);
    if (outcome === RUN_TIMEOUT) throw new Error("Reply exceeded the maximum run time");
    console.log(`[worker] answered reply ${reply.id}`);
  } catch (err) {
    console.error(`[worker] reply ${reply.id} failed`, err);
    // finishReply only touches a running reply, so a run that finishes after
    // its timeout cannot overwrite this.
    await finishReply(reply.id, { status: "failed", error: err instanceof Error ? err.message : String(err) }).catch(
      (failErr) => console.error(`[worker] could not record failure for reply ${reply.id}`, failErr),
    );
  } finally {
    clearTimeout(timer);
  }
}
