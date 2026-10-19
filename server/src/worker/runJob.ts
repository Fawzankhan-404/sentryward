import { env } from "../config/env.ts";
import type { ForgeConnection, IgnoreReason, ReviewJob } from "../generated/prisma/client.ts";
import { prisma } from "../lib/prisma.ts";
import { skipFilterReason } from "../review/config/filters.ts";
import { loadDashboardConfig, loadReviewConfig } from "../review/config/load.ts";
import type { Config } from "../review/config/schema.ts";
import type { ChangeSet, RejectedFinding, ToolAnnotation } from "../review/core/models.ts";
import type { ContextSource } from "../review/context/gather.ts";
import { cacheKey, cached, forgeCache, type ForgeCache } from "../review/forge/cache.ts";
import { ForgeError } from "../review/forge/http.ts";
import { searchTerms } from "../review/forge/issues.ts";
import {
  abortableGenerate,
  createGenerate,
  missingKeys,
  modelChain,
  type ApiKeys,
  type Endpoint,
  type Generate,
  type ProviderBaseUrls,
} from "../review/llm/providers.ts";
import type { WalkthroughIssues } from "../review/llm/walkthrough.ts";
import { runReview } from "../review/pipeline.ts";
import { publishes, publishReview, resolvesThreads } from "../review/publish/publisher.ts";
import { pendingStatus } from "../review/publish/status.ts";
import { summarize } from "../review/render/json.ts";
import { progressMarkdown } from "../review/render/progress.ts";
import { adapterForConnection, type Forge } from "../services/forge.ts";
import { llmCredentialsFor, type StoredLlmConnections } from "../services/llm.ts";
import { CLOSE_CHECK_INTERVAL_MS, watchForClose } from "./closeWatch.ts";
import { incrementFor } from "./incremental.ts";
import { CLOSED_REASON, complete, isCancelled } from "./queue.ts";
import { findingTransitions, syncFindings, threadOperations, type ThreadOutcome } from "./syncFindings.ts";

// How many recent dismissals to feed into the review prompt; bounded so a noisy
// repository cannot grow the prompt without limit.
const MAX_REJECTED_FINDINGS = 20;

export interface RunJobDeps {
  adapterFor: (connection: ForgeConnection) => Forge;
  generateFor: (keys: ApiKeys, endpoint?: Endpoint, baseUrls?: ProviderBaseUrls) => Generate;
  credentialsFor: (
    workspaceId: string,
  ) => Promise<{ keys: ApiKeys; baseUrls: ProviderBaseUrls; connections: StoredLlmConnections }>;
  // Absent means every read goes to the forge, as with review.disableCache.
  cache?: ForgeCache;
  closeCheckIntervalMs?: number;
}

const defaultDeps: RunJobDeps = {
  adapterFor: adapterForConnection,
  generateFor: createGenerate,
  credentialsFor: llmCredentialsFor,
  cache: forgeCache,
};

// Decided here rather than in the webhook handler, because only now is the
// full configuration known, including the repository file. A manual review is
// never skipped; someone asked for it, and so did a permitted review command.
export function skipReason(
  job: { trigger: ReviewJob["trigger"]; event?: string | null; actor?: string | null },
  config: Config,
  change: Parameters<typeof skipFilterReason>[1] & { isDraft: boolean },
): string | null {
  const { triggers } = config;
  if (job.trigger === "webhook") {
    if (triggers.review === "manual") return "Automatic reviews are turned off for this repository";
    if (change.isDraft && triggers.review !== "all") return "Draft changes are not reviewed automatically";
    if (job.event === "push" && !triggers.reviewOnPush) return "New commits are not reviewed automatically";
    return skipFilterReason(triggers, change, job.actor);
  }
  if (job.trigger === "comment" && !triggers.command) {
    return "Review commands are turned off for this repository";
  }
  return null;
}

// Automatic reviews include the walkthrough only when the summary trigger
// allows it; a requested review follows the walkthrough setting alone.
export function walkthroughEnabled(trigger: ReviewJob["trigger"], config: Config, isDraft: boolean): boolean {
  if (!config.output.walkthrough) return false;
  if (trigger !== "webhook") return true;
  return config.triggers.summary === "published" && !isDraft;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Issues for the walkthrough, best effort: a tracker the token cannot read
// (or one that is turned off) costs a warning, never the review.
async function walkthroughIssues(forge: Forge, changeSet: ChangeSet, config: Config, warnings: string[]): Promise<WalkthroughIssues> {
  const issues: WalkthroughIssues = {};
  if (config.output.assessLinkedIssues) {
    issues.linked = await forge.getLinkedIssues(changeSet).catch((err: unknown) => {
      warnings.push(`Linked issues could not be read: ${message(err)}`);
      return undefined;
    });
  }
  if (config.output.relatedIssues) {
    const terms = searchTerms(changeSet.title);
    const linked = new Set((issues.linked ?? []).map((issue) => issue.ref));
    const found = terms.length
      ? await forge.searchIssues(changeSet.forgeRef.project, terms).catch((err: unknown) => {
          warnings.push(`Related issues could not be searched: ${message(err)}`);
          return undefined;
        })
      : [];
    issues.candidates = found?.filter((issue) => !linked.has(issue.ref));
  }
  return issues;
}

// Static analyzer results, best effort like the issues above: a forge that
// will not show them (most often a GitHub App without the Checks permission)
// costs a warning, and the review goes on with the model's findings alone.
async function toolAnnotations(forge: Forge, changeSet: ChangeSet, warnings: string[]): Promise<ToolAnnotation[] | undefined> {
  try {
    const results = await forge.getToolAnnotations(changeSet.forgeRef);
    warnings.push(...results.warnings);
    return results.annotations;
  } catch (err) {
    const denied = err instanceof ForgeError && (err.status === 403 || err.status === 404);
    warnings.push(
      denied && changeSet.forgeRef.provider === "github"
        ? "Static analysis results could not be read; the GitHub App needs the Checks (read) permission"
        : `Static analysis results could not be read: ${message(err)}`,
    );
    return undefined;
  }
}

// Loads everything a review needs, runs it, publishes it and stores the
// result. Anything thrown before the review starts (the repository vanished,
// the forge is down, no model key) fails the job through the worker, and
// nothing has been posted yet. Problems inside the review or while publishing
// are recorded instead.
export async function runJob(job: ReviewJob, deps: RunJobDeps = defaultDeps): Promise<void> {
  const repo = await prisma.repository.findUnique({
    where: { id: job.repositoryId },
    include: { connection: { include: { workspace: { select: { reviewSettings: true } } } } },
  });
  if (!repo) {
    throw new Error("The repository is no longer connected");
  }

  const forge = deps.adapterFor(repo.connection);
  const saved = {
    globalSettings: repo.connection.workspace.reviewSettings,
    repoSettings: repo.settings,
    followGlobal: repo.followGlobal,
  };
  // The repository file can only be read once the change is known, so the
  // first reads go by the dashboard settings alone.
  const cacheFor = (disabled: boolean) => (disabled ? undefined : deps.cache);
  const savedDisablesCache = loadDashboardConfig(saved).review.disableCache;
  // The PR may have moved since the job was queued; review what is there now
  // and record which head that was.
  let changeSet = await forge.getChange(repo.fullPath, job.number, cacheFor(savedDisablesCache));
  const loaded = await loadReviewConfig({
    adapter: forge,
    project: repo.fullPath,
    ref: changeSet.forgeRef.baseSha,
    ...saved,
    cache: cacheFor(savedDisablesCache),
  });

  const { config } = loaded;
  // The repository file asked for fresh reads after a cached one was used.
  if (config.review.disableCache && !savedDisablesCache && deps.cache) {
    changeSet = await forge.getChange(repo.fullPath, job.number);
  }
  const skip = skipReason(job, config, changeSet);
  if (skip) {
    await complete(job.id, {
      status: "skipped",
      verdict: null,
      resolvedConfig: { config, sources: loaded.sources, repoFile: loaded.repoFile },
      error: skip,
      headSha: changeSet.forgeRef.headSha,
      baseSha: changeSet.forgeRef.baseSha,
    });
    return;
  }

  const walkthrough = walkthroughEnabled(job.trigger, config, changeSet.isDraft);
  // Only the models this review will call are checked, so a walkthrough or
  // verify model left set while that pass is off does not fail the job.
  const primary = [modelChain(config.llm, "review")[0]];
  if (walkthrough) primary.push(modelChain(config.llm, "walkthrough")[0]);
  if (config.review.verify !== "off") primary.push(modelChain(config.llm, "verify")[0]);
  const models = [...new Set(primary)];

  const { keys, baseUrls, connections } = await deps.credentialsFor(repo.connection.workspaceId);
  const { connection, baseUrl, endpointKey } = config.llm;
  let endpoint: Endpoint | undefined;
  if (connection) {
    const selected = connections[connection];
    if (!selected) {
      throw new Error(`The selected ${connection} LLM connection no longer exists: configure it in settings`);
    }
    if (selected.baseUrl) {
      endpoint = { baseUrl: selected.baseUrl, apiKey: selected.apiKey };
    } else {
      const incompatible = [...models, ...config.llm.fallbackModels].find(
        (model) => model.split("/")[0] !== connection,
      );
      if (incompatible) {
        throw new Error(
          `The ${connection} LLM connection uses its official API and cannot run model ${incompatible}`,
        );
      }
    }
  } else if (baseUrl) {
    // Compatibility for settings saved before connections were referenced live.
    if (endpointKey && !keys[endpointKey]) {
      throw new Error(`No API key for ${endpointKey}: store one in settings or configure it on the server`);
    }
    endpoint = { baseUrl, apiKey: endpointKey ? keys[endpointKey] : undefined };
  } else {
    throw new Error("No LLM connection selected: choose one in Configuration > LLM Config");
  }
  const unkeyed = models.find((model) => missingKeys([model], keys, endpoint, baseUrls).length > 0);
  if (unkeyed) {
    const provider = unkeyed.split("/")[0];
    throw new Error(`No API key for ${provider}: store one in settings or configure it on the server`);
  }
  const warnings = [...loaded.warnings];
  const fallbackModels = config.llm.fallbackModels.filter((model) => {
    const usable = missingKeys([model], keys, endpoint, baseUrls).length === 0;
    if (!usable) warnings.push(`Fallback model ${model} skipped: no API key for its provider`);
    return usable;
  });

  const targetUrl = `${env.CLIENT_ORIGIN}/reviews/${job.id}`;
  const ref = changeSet.forgeRef;
  const resolvedConfig = { config, sources: loaded.sources, repoFile: loaded.repoFile };

  // A person can cancel any running job, so it is always watched. Closing the
  // change cancels its queued jobs from the webhook; with abortOnClose this also
  // catches the rest: a close the webhook missed, and one that lands mid-review.
  let cancelledBy: "manual" | "closed" | undefined;
  const watch = watchForClose(async () => {
    if (await isCancelled(job.id)) {
      cancelledBy = "manual";
      return true;
    }
    if (!config.triggers.abortOnClose) return false;
    const { state } = await forge.getChangeHead(repo.fullPath, job.number);
    if (state !== "closed" && state !== "merged") return false;
    cancelledBy = "closed";
    return true;
  }, deps.closeCheckIntervalMs ?? CLOSE_CHECK_INTERVAL_MS);
  const cancel = async (posted: boolean) => {
    watch.stop();
    const closed = cancelledBy === "closed";
    // Best effort, and only over what this run already put on the change.
    if (posted && config.output.postCheck) {
      const description = closed ? "Review cancelled: the change was closed" : "Review cancelled";
      await forge.setCommitStatus(ref, { state: "error", description, targetUrl }).catch(() => undefined);
    }
    // A manual cancel already stored its reason and status, so this only
    // finishes a job the change being closed stopped.
    await complete(job.id, {
      status: "cancelled",
      verdict: null,
      resolvedConfig,
      error: closed ? CLOSED_REASON : "Review cancelled",
      headSha: ref.headSha,
      baseSha: ref.baseSha,
    });
  };
  if (await watch.closedNow()) {
    await cancel(false);
    return;
  }

  if (publishes(config)) {
    // Best effort: a review must not fail because its progress note did.
    if (config.output.postSummary) {
      await forge.upsertSummaryComment(ref, progressMarkdown(changeSet)).catch((err: unknown) => {
        warnings.push(`Progress comment failed: ${message(err)}`);
      });
    }
    if (config.output.postCheck) {
      await forge.setCommitStatus(ref, pendingStatus(targetUrl)).catch((err: unknown) => {
        warnings.push(`Pending status failed: ${message(err)}`);
      });
    }
  }

  const issues = walkthrough ? await walkthroughIssues(forge, changeSet, config, warnings) : undefined;
  const generate = deps.generateFor(keys, endpoint, baseUrls);
  // Files at the head sha never change, so they share the config file's cache
  // key shape. Code search results are not fixed by a sha and stay uncached.
  const fileCache = cacheFor(config.review.disableCache);
  const context: ContextSource = {
    readFile: (path) =>
      cached(fileCache, cacheKey("file", forge.host, repo.fullPath, path, ref.headSha), () =>
        forge.getFileAtRef(repo.fullPath, path, ref.headSha),
      ),
    searchCode: (term) => forge.searchCode(repo.fullPath, term, ref.headSha),
  };
  // Findings this team dismissed as false positives or deliberate: never repost
  // them on this change, and tell the model what the repo has recently rejected.
  // fix_later / not_specified are not suppression signals.
  let ignoredFingerprints: Set<string> | undefined;
  let rejectedFindings: RejectedFinding[] | undefined;
  if (config.review.suppressIgnored) {
    const dismissed = { in: ["false_positive", "intentional"] satisfies IgnoreReason[] };
    const [sameChange, recent] = await Promise.all([
      prisma.finding.findMany({
        where: { repositoryId: repo.id, number: job.number, state: "ignored", ignoreReason: dismissed },
        select: { fingerprint: true },
      }),
      prisma.finding.findMany({
        where: { repositoryId: repo.id, state: "ignored", ignoreReason: dismissed },
        orderBy: { ignoredAt: "desc" },
        take: MAX_REJECTED_FINDINGS,
        select: { title: true, category: true, file: true, ignoreNote: true },
      }),
    ]);
    ignoredFingerprints = new Set(sameChange.map((row) => row.fingerprint));
    rejectedFindings = recent.map((row) => ({
      title: row.title,
      category: row.category,
      file: row.file,
      ...(row.ignoreNote ? { note: row.ignoreNote } : {}),
    }));
  }

  const tools = config.review.toolFindings ? await toolAnnotations(forge, changeSet, warnings) : undefined;

  const increment = await incrementFor({
    job,
    project: repo.fullPath,
    changeSet,
    config,
    forge,
    cache: fileCache,
    warnings,
  });

  let result;
  try {
    result = await runReview(
      {
        changeSet,
        config: {
          ...config,
          llm: { ...config.llm, fallbackModels },
          output: { ...config.output, walkthrough },
        },
        warnings,
        issues,
        ignoredFingerprints,
        rejectedFindings,
        increment,
        toolAnnotations: tools,
      },
      { generate: abortableGenerate(generate, watch.signal), context },
    );
  } finally {
    watch.stop();
  }
  // Nothing is published for a review cancelled or a change no longer open.
  if (await watch.closedNow()) {
    await cancel(publishes(config));
    return;
  }

  let publication = null;
  let threadOutcome: ThreadOutcome | null = null;
  if (publishes(config)) {
    const [already, findings] = await Promise.all([
      prisma.postedFinding.findMany({
        where: { repositoryId: repo.id, number: job.number },
        select: { fingerprint: true },
      }),
      prisma.finding.findMany({
        where: { repositoryId: repo.id, number: job.number },
        select: { fingerprint: true, state: true, file: true, threadPending: true },
      }),
    ]);
    // The same transitions syncFindings writes after the job is stored, plus
    // thread updates an earlier run could not make.
    const threads = threadOperations(findings, findingTransitions(findings, result));
    publication = await publishReview({
      publisher: forge,
      changeSet,
      result,
      config,
      postedFingerprints: new Set(already.map((row) => row.fingerprint)),
      resolvedFingerprints: threads.resolve,
      reopenedFingerprints: threads.reopen,
      targetUrl,
    });
    if (resolvesThreads(config)) {
      threadOutcome = { attempted: [...threads.resolve, ...threads.reopen], failed: publication.threadsFailed ?? [] };
    }
    if (publication.inlinePosted.length) {
      await prisma.postedFinding.createMany({
        data: publication.inlinePosted.map((posted) => ({
          repositoryId: repo.id,
          number: job.number,
          fingerprint: posted.fingerprint,
          forgeCommentId: posted.forgeCommentId,
        })),
        skipDuplicates: true,
      });
    }
  }

  // A review that ran but could not be fully published is partial: the result
  // stands, and the job says what did not reach the forge.
  const errors = [...result.errors, ...(publication?.errors ?? [])];
  const status = result.status === "completed" && publication?.errors.length ? "partial" : result.status;
  const stored = await complete(job.id, {
    status,
    verdict: result.verdict.verdict,
    result,
    summary: summarize(result),
    publication,
    resolvedConfig,
    error: errors.length ? errors.join("\n") : null,
    headSha: ref.headSha,
    baseSha: ref.baseSha,
  });
  // A run superseded or cancelled meanwhile no longer speaks for the change.
  // The review itself is stored by now, so a failed sync must not fail the job.
  if (stored) {
    await syncFindings({
      repositoryId: repo.id,
      number: job.number,
      jobId: job.id,
      author: changeSet.author,
      result,
      threads: threadOutcome,
    }).catch(
      (err: unknown) => console.error(`[worker] could not sync findings for job ${job.id}`, err),
    );
  }
}
