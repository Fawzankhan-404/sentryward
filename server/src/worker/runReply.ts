import { env } from "../config/env.ts";
import type { ForgeConnection, IgnoreReason, ThreadReply } from "../generated/prisma/client.ts";
import { prisma } from "../lib/prisma.ts";
import { loadReviewConfig } from "../review/config/load.ts";
import { REPLY_MARKER } from "../review/core/markers.ts";
import { reviewResultSchema } from "../review/core/models.ts";
import { abortableGenerate, createGenerate, modelChain, type ApiKeys, type Endpoint, type Generate, type ProviderBaseUrls } from "../review/llm/providers.ts";
import { answerThreadQuestion } from "../review/llm/threadAnswer.ts";
import { BRAND_FOOTER } from "../review/render/markdown.ts";
import { adapterForConnection, type Forge } from "../services/forge.ts";
import { llmCredentialsFor } from "../services/llm.ts";
import { resolveLlm, type LlmCredentials } from "./llmEndpoint.ts";
import { finishReply } from "./replyQueue.ts";

// Lines of the file shown around a finding when answering a question about it.
const CODE_CONTEXT_LINES = 20;

const REASON_LABEL: Partial<Record<IgnoreReason, string>> = {
  false_positive: "a false positive",
  intentional: "intentional",
};

const USAGE =
  "Use `/sentryward ignore false-positive [note]` or `/sentryward ignore intentional [note]` to dismiss this finding.";

export interface RunReplyDeps {
  adapterFor: (connection: ForgeConnection) => Forge;
  generateFor: (keys: ApiKeys, endpoint?: Endpoint, baseUrls?: ProviderBaseUrls) => Generate;
  credentialsFor: (workspaceId: string) => Promise<LlmCredentials>;
}

const defaultDeps: RunReplyDeps = {
  adapterFor: adapterForConnection,
  generateFor: createGenerate,
  credentialsFor: llmCredentialsFor,
};

function withFooter(text: string): string {
  return [text, "", BRAND_FOOTER, REPLY_MARKER].join("\n");
}

// The file around the finding, numbered like the diff a review reads.
function codeAround(content: string | null, startLine: number, endLine: number): string {
  if (!content) return "";
  const lines = content.split("\n");
  const from = Math.max(1, startLine - CODE_CONTEXT_LINES);
  const to = Math.min(lines.length, endLine + CODE_CONTEXT_LINES);
  const numbered: string[] = [];
  for (let line = from; line <= to; line++) numbered.push(`${String(line).padStart(6)} | ${lines[line - 1]}`);
  return numbered.join("\n");
}

// Answers one reply on a finding's thread: an ignore command updates the
// finding as the dashboard would and acknowledges it; anything else gets one
// short model answer. Anything thrown fails the reply through the worker, and
// nothing has been posted. Once `signal` aborts (the run outlived its bound and
// was failed), nothing more is changed or posted.
export async function runReply(
  reply: ThreadReply,
  deps: RunReplyDeps = defaultDeps,
  signal?: AbortSignal,
): Promise<void> {
  const repo = await prisma.repository.findUnique({
    where: { id: reply.repositoryId },
    include: { connection: { include: { workspace: { select: { reviewSettings: true } } } } },
  });
  if (!repo) {
    throw new Error("The repository is no longer connected");
  }
  // Queued before the repository was turned off.
  if (!repo.enabled) {
    await finishReply(reply.id, { status: "skipped", error: "The repository is disabled" });
    return;
  }
  const forge = deps.adapterFor(repo.connection);
  const target = { project: repo.fullPath, number: reply.number };
  // Settings come from the base revision, as for the review that posted the
  // finding, so the change's own commits cannot turn replies on.
  const head = await forge.getChangeHead(repo.fullPath, reply.number);
  const { config } = await loadReviewConfig({
    adapter: forge,
    project: repo.fullPath,
    ref: head.baseSha,
    globalSettings: repo.connection.workspace.reviewSettings,
    repoSettings: repo.settings,
    followGlobal: repo.followGlobal,
  });
  if (!config.triggers.replies) {
    await finishReply(reply.id, { status: "skipped", error: "Replies are turned off for this repository" });
    return;
  }

  const finding = await prisma.finding.findUnique({
    where: {
      repositoryId_number_fingerprint: { repositoryId: repo.id, number: reply.number, fingerprint: reply.fingerprint },
    },
    include: { lastJob: { select: { result: true } } },
  });

  let text: string;
  if (!finding) {
    text = "This finding is not tracked any more, so there is nothing to update.";
  } else if (reply.kind === "ignore") {
    if (!reply.ignoreReason) {
      text = `That reason was not understood. ${USAGE}`;
    } else {
      // As PATCH /api/findings/:id does (controllers/findings.controller.ts).
      signal?.throwIfAborted();
      await prisma.finding.update({
        where: { id: finding.id },
        data: {
          state: "ignored",
          ignoredAt: new Date(),
          ignoreReason: reply.ignoreReason,
          ignoreNote: reply.ignoreNote,
          resolvedAt: null,
        },
      });
      // Both reasons a command accepts are ones review.suppressIgnored acts on.
      const suppressed = config.review.suppressIgnored ? " Later reviews of this change will not raise it again." : "";
      text =
        `Ignored as ${REASON_LABEL[reply.ignoreReason]} by @${reply.actor}.${suppressed} ` +
        `Reopen it from the [dashboard](${env.CLIENT_ORIGIN}/findings) if needed.`;
    }
  } else {
    const parsed = finding.lastJob?.result ? reviewResultSchema.safeParse(finding.lastJob.result) : null;
    const result = parsed?.success ? parsed.data : undefined;
    const detail = result?.findings.find((f) => f.fingerprint === reply.fingerprint);
    if (!result || !detail) {
      text = "The details of this finding are no longer available, so I cannot answer about it.";
    } else {
      const model = modelChain(config.llm, "review")[0]!;
      const credentials = await deps.credentialsFor(repo.connection.workspaceId);
      const llm = resolveLlm(config, [model], credentials);
      const base = deps.generateFor(llm.keys, llm.endpoint, llm.baseUrls);
      const generate = signal ? abortableGenerate(base, signal) : base;
      // At the head the finding was raised on: its lines number that revision,
      // and the change may have moved on since.
      const content = await forge.getFileAtRef(repo.fullPath, detail.file, result.change.headSha);
      text = await answerThreadQuestion(
        generate,
        { finding: detail, code: codeAround(content, detail.startLine, detail.endLine), reply: reply.body },
        { ...config, llm: { ...config.llm, fallbackModels: llm.fallbackModels } },
      );
      if (!text) text = "I could not produce an answer to this.";
    }
  }

  signal?.throwIfAborted();
  const answerCommentId = await forge.replyToThread(target, reply.threadId, withFooter(text));
  await finishReply(reply.id, { status: "done", answerCommentId });
}
