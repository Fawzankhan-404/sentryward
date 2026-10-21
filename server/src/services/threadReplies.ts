import { prisma } from "../lib/prisma.ts";
import { parseReply } from "../lib/webhook.ts";
import { REPLY_MARKER } from "../review/core/markers.ts";
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
  // Whether the author may act on the repository; asked only once the reply is
  // known not to be the bot's own.
  allowed: () => Promise<boolean>;
}

// Records a person's reply on one of Sentryward's inline threads for the worker
// to answer. Shared by both forges once their payload is read.
export async function recordThreadReply(input: ThreadReplyInput): Promise<WebhookOutcome> {
  const { repo, forge, number, threadId, commentId, actor, body } = input;
  // Never answer itself: by login, and by marker in case the bot posts under a
  // login the connection does not know (a token swapped for another account).
  if (!actor || forge.isSelfLogin(actor) || body.includes(REPLY_MARKER)) {
    return { body: { outcome: "ignored" } };
  }
  if (!(await input.allowed())) return { body: { outcome: "not_allowed" } };

  const root = await forge.getThreadRoot({ project: repo.fullPath, number }, threadId);
  if (!root?.ownedBySelf || !root.fingerprint) return { body: { outcome: "ignored" } };

  const recent = await prisma.threadReply.count({
    where: { repositoryId: repo.id, number, createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
  });
  if (recent >= MAX_REPLIES_PER_HOUR) return { body: { outcome: "rate_limited" } };

  const parsed = parseReply(body);
  try {
    const reply = await prisma.threadReply.create({
      data: {
        repositoryId: repo.id,
        number,
        fingerprint: root.fingerprint,
        threadId,
        commentId,
        actor,
        kind: parsed.kind,
        body: body.slice(0, MAX_BODY),
        ignoreReason: parsed.kind === "ignore" ? parsed.reason : null,
        ignoreNote: parsed.kind === "ignore" ? parsed.note : null,
      },
    });
    return { body: { outcome: "queued", replyId: reply.id } };
  } catch (err) {
    // The forge redelivered an event already recorded.
    if (isUniqueViolation(err)) return { body: { outcome: "duplicate" } };
    throw err;
  }
}
