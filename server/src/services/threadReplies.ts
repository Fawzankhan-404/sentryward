import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import { parseReply } from "../lib/webhook.ts";
import { markersIn, REPLY_MARKER } from "../review/core/markers.ts";
import type { Forge, RepoWithConnection, WebhookOutcome } from "./providers/types.ts";
import { isUniqueViolation } from "./users.ts";

// Replies the bot acts on per pull/merge request per hour. Past it, replies are
// dropped without a word: saying so would be one more comment in the thread.
export const MAX_REPLIES_PER_HOUR = 10;
// Only the start of a long reply is kept; a model only ever sees a part of it.
const MAX_BODY = 4000;

export interface ThreadReplyInput {
  repo: RepoWithConnection;
  forge: Forge;
  number: number;
  threadId: string;
  commentId: string;
  actor: string | undefined;
  body: string;
  // Whether the connection posts as an account of its own (a GitHub App's
  // "<slug>[bot]"). A token or OAuth connection posts as the person who
  // connected it, so its login is also theirs and says nothing about who wrote
  // a note.
  botLogin: boolean;
  // Whether the author may act on the repository; asked only once the reply is
  // known not to be the bot's own.
  allowed: () => Promise<boolean>;
}

// Records a person's reply on one of Sentryward's inline threads for the worker
// to answer. Shared by both forges once their payload is read.
export async function recordThreadReply(input: ThreadReplyInput): Promise<WebhookOutcome> {
  const { repo, forge, number, threadId, commentId, actor, body } = input;
  // Never answer itself. Everything Sentryward posts in a thread carries a
  // marker: its answers the reply marker, a finding (a GitLab thread's first
  // note arrives here too) its fingerprint. The login is checked as well only
  // where it is the bot's alone.
  if (!actor || body.includes(REPLY_MARKER) || markersIn(body).length > 0) {
    return { body: { outcome: "ignored" } };
  }
  if (input.botLogin && forge.isSelfLogin(actor)) return { body: { outcome: "ignored" } };

  // Every note on a diff thread lands here, most of them between people. A
  // change Sentryward never raised a finding on cannot hold one of its threads,
  // and this costs no forge call.
  const tracked = await prisma.finding.findFirst({ where: { repositoryId: repo.id, number }, select: { id: true } });
  if (!tracked) return { body: { outcome: "ignored" } };

  let root: Awaited<ReturnType<Forge["getThreadRoot"]>>;
  try {
    if (!(await input.allowed())) return { body: { outcome: "not_allowed" } };
    root = await forge.getThreadRoot({ project: repo.fullPath, number }, threadId);
  } catch (err) {
    // Not retried here: the forge is waiting on this response. A failed
    // delivery shows in its webhook log, where it can be redelivered.
    console.error(`[webhook] could not check reply ${commentId} on ${repo.fullPath}#${number}`, err);
    throw new HttpError(503, "Could not reach the forge to check this reply");
  }
  if (!root?.ownedBySelf || !root.fingerprint) return { body: { outcome: "ignored" } };
  const fingerprint = root.fingerprint;

  const parsed = parseReply(body);
  try {
    // Count and insert under a lock per change, so concurrent deliveries cannot
    // all pass the count before any of them is recorded.
    const reply = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${repo.id}::text), ${number}::int)`;
      const recent = await tx.threadReply.count({
        where: { repositoryId: repo.id, number, createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
      });
      if (recent >= MAX_REPLIES_PER_HOUR) return null;
      return tx.threadReply.create({
        data: {
          repositoryId: repo.id,
          number,
          fingerprint,
          threadId,
          commentId,
          actor,
          kind: parsed.kind,
          body: body.slice(0, MAX_BODY),
          ignoreReason: parsed.kind === "ignore" ? parsed.reason : null,
          ignoreNote: parsed.kind === "ignore" ? parsed.note : null,
        },
      });
    });
    if (!reply) return { body: { outcome: "rate_limited" } };
    return { body: { outcome: "queued", replyId: reply.id } };
  } catch (err) {
    // The forge redelivered an event already recorded.
    if (isUniqueViolation(err)) return { body: { outcome: "duplicate" } };
    throw err;
  }
}
