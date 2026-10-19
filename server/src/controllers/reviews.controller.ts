import type { Request, Response } from "express";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import { median } from "../lib/stats.ts";
import type { Prisma, Repository } from "../generated/prisma/client.ts";
import { reviewResultSchema } from "../review/core/models.ts";
import { parseChangeUrl } from "../review/forge/url.ts";
import { toJson } from "../review/render/json.ts";
import { toMarkdown, walkthroughOptions } from "../review/render/markdown.ts";
import { adapterForConnection, toHttpError } from "../services/forge.ts";
import { cancelJob, enqueue } from "../worker/queue.ts";
import {
  createReviewByRepoSchema,
  createReviewSchema,
  listReviewsQuerySchema,
  reviewIdParamSchema,
  reviewStatsQuerySchema,
} from "../schemas/reviews.schema.ts";

const listFields = {
  id: true,
  number: true,
  headSha: true,
  trigger: true,
  status: true,
  verdict: true,
  summary: true,
  error: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  repository: { select: { id: true, provider: true, host: true, fullPath: true } },
} as const;

function ownedBy(workspaceId: string) {
  return { repository: { connection: { workspaceId } } };
}

type RepoWithConnection = Repository & { connection: Parameters<typeof adapterForConnection>[0] };

async function queueLatest(repo: RepoWithConnection, number: number) {
  const head = await adapterForConnection(repo.connection)
    .getChangeHead(repo.fullPath, number)
    .catch((err: unknown) => {
      throw toHttpError(err, repo.provider);
    });
  return enqueue({ repositoryId: repo.id, number, headSha: head.headSha, trigger: "manual" });
}

// Both ways of asking for a review end here, so they refuse and queue alike.
async function queueManual(res: Response, repo: RepoWithConnection, number: number) {
  if (!repo.enabled) {
    throw new HttpError(409, `Reviews are turned off for ${repo.fullPath}`);
  }
  const job = await queueLatest(repo, number);
  const review = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id }, select: listFields });
  res.status(202).json({ review });
}

export async function createReview(req: Request, res: Response) {
  if (req.body && typeof req.body === "object" && "repoId" in req.body) {
    const { repoId, number } = createReviewByRepoSchema.parse(req.body);
    const repo = await prisma.repository.findFirst({
      where: { id: repoId, connection: { workspaceId: req.workspaceId } },
      include: { connection: true },
    });
    if (!repo) {
      throw new HttpError(404, "Repository not found");
    }
    await queueManual(res, repo, number);
    return;
  }

  const { url } = createReviewSchema.parse(req.body);
  const parsed = parseChangeUrl(url);
  if (!parsed) {
    throw new HttpError(400, "Not a pull or merge request URL");
  }

  // Forge paths are case-insensitive; compare the way the forge would.
  const candidates = await prisma.repository.findMany({
    where: { provider: parsed.provider, host: parsed.host, connection: { workspaceId: req.workspaceId } },
    include: { connection: true },
  });
  const repo = candidates.find((r) => r.fullPath.toLowerCase() === parsed.project.toLowerCase());
  if (!repo) {
    throw new HttpError(404, `${parsed.project} is not connected; enable it under Repositories first`);
  }
  await queueManual(res, repo, parsed.number);
}

type ListQuery = ReturnType<typeof listReviewsQuerySchema.parse>;

// "#12" (GitHub) and "!12" (GitLab) are how people write change numbers.
const NUMBER_QUERY = /^[#!]?(\d{1,9})$/;

function listWhere(workspaceId: string, query: ListQuery): Prisma.ReviewJobWhereInput {
  const { repoId, status, verdict, trigger, number, q, includeSuperseded } = query;
  const where: Prisma.ReviewJobWhereInput = {
    ...ownedBy(workspaceId),
    ...(repoId ? { repositoryId: repoId } : {}),
    ...(verdict ? { verdict } : {}),
    ...(trigger ? { trigger } : {}),
    ...(number ? { number } : {}),
  };
  if (status) where.status = status;
  else if (!includeSuperseded) where.status = { not: "superseded" };
  if (q) {
    const asNumber = NUMBER_QUERY.exec(q);
    where.OR = [
      { repository: { fullPath: { contains: q, mode: "insensitive" } } },
      // JSON string matching has no case-insensitive mode.
      { summary: { path: ["title"], string_contains: q } },
      ...(asNumber ? [{ number: Number(asNumber[1]) }] : []),
    ];
  }
  return where;
}

export async function listReviews(req: Request, res: Response) {
  const query = listReviewsQuerySchema.parse(req.query);
  const { page, limit } = query;
  const where = listWhere(req.workspaceId!, query);
  if (query.view === "changes") {
    res.json({ ...(await listChanges(where, page, limit)), page, limit });
    return;
  }
  // Offset paging so the dashboard can show page numbers and a total; the id
  // tiebreak keeps rows from shifting between pages when timestamps collide.
  const [reviews, total] = await prisma.$transaction([
    prisma.reviewJob.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
      select: listFields,
    }),
    prisma.reviewJob.count({ where }),
  ]);
  res.json({ reviews, total, page, limit });
}

// One row per pull/merge request: its latest run matching the filters, plus
// how many matching runs it has. Filters apply before grouping, so filtering
// by "failed" shows each change's latest failed run.
async function listChanges(where: Prisma.ReviewJobWhereInput, page: number, limit: number) {
  const by: ["repositoryId", "number"] = ["repositoryId", "number"];
  const [groups, all] = await prisma.$transaction([
    prisma.reviewJob.groupBy({
      by,
      where,
      _max: { createdAt: true },
      _count: { _all: true },
      orderBy: [{ _max: { createdAt: "desc" } }, { repositoryId: "asc" }, { number: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    // Prisma has no count(distinct ...); the keys alone are small enough.
    prisma.reviewJob.groupBy({ by, where, orderBy: [{ repositoryId: "asc" }, { number: "asc" }] }),
  ]);
  if (groups.length === 0) return { reviews: [], total: all.length };

  const latest = await prisma.reviewJob.findMany({
    where: {
      AND: [
        where,
        { OR: groups.map((g) => ({ repositoryId: g.repositoryId, number: g.number, createdAt: g._max!.createdAt! })) },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { ...listFields, repositoryId: true },
  });
  const reviews = groups.flatMap((g) => {
    // Two runs queued in the same instant: the id order above picks one.
    const job = latest.find((r) => r.repositoryId === g.repositoryId && r.number === g.number);
    if (!job) return [];
    const { repositoryId: _, ...review } = job;
    return [{ ...review, runCount: (g._count as { _all: number })._all }];
  });
  return { reviews, total: all.length };
}

export async function getReviewStats(req: Request, res: Response) {
  const { repoId, days } = reviewStatsQuerySchema.parse(req.query);
  const since = new Date(Date.now() - days * 86_400_000);
  // Only small columns are read, never full results.
  const jobs = await prisma.reviewJob.findMany({
    where: {
      ...ownedBy(req.workspaceId!),
      ...(repoId ? { repositoryId: repoId } : {}),
      createdAt: { gte: since },
      status: { notIn: ["superseded", "skipped", "cancelled"] },
    },
    // summary is a small digest column; result (large) is never loaded here.
    select: { status: true, verdict: true, startedAt: true, finishedAt: true, summary: true },
  });
  // Failed runs are left out: an error can end a run early and would make
  // reviews look faster than they are.
  const durations = jobs
    .filter((j) => (j.status === "completed" || j.status === "partial") && j.startedAt && j.finishedAt)
    .map((j) => j.finishedAt!.getTime() - j.startedAt!.getTime());
  // Token totals come from each job's summary digest. Jobs reviewed before the
  // digest carried usageTotals contribute nothing until they are re-run.
  const tokens = jobs.reduce(
    (total, job) => {
      const usage = (job.summary as { usageTotals?: { calls?: number; inputTokens?: number; outputTokens?: number } } | null)
        ?.usageTotals;
      return {
        calls: total.calls + (usage?.calls ?? 0),
        inputTokens: total.inputTokens + (usage?.inputTokens ?? 0),
        outputTokens: total.outputTokens + (usage?.outputTokens ?? 0),
      };
    },
    { calls: 0, inputTokens: 0, outputTokens: 0 },
  );
  res.json({
    days,
    runs: jobs.length,
    blocked: jobs.filter((j) => j.verdict === "blocked").length,
    passed: jobs.filter((j) => j.verdict === "pass").length,
    failed: jobs.filter((j) => j.status === "failed").length,
    duration: { median: median(durations), max: durations.length ? Math.max(...durations) : null },
    tokens,
  });
}

async function loadOwnedReview(workspaceId: string, id: string) {
  const review = await prisma.reviewJob.findFirst({
    where: { id, ...ownedBy(workspaceId) },
    select: { ...listFields, baseSha: true, attempts: true, result: true, publication: true, resolvedConfig: true },
  });
  if (!review) {
    throw new HttpError(404, "Review not found");
  }
  return review;
}

// A stored result that no longer matches the schema (written by an older
// version) is served as-is rather than failing the whole page.
function parseResult(raw: unknown) {
  const parsed = reviewResultSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function getReview(req: Request, res: Response) {
  const { id } = reviewIdParamSchema.parse(req.params);
  const { result: raw, ...review } = await loadOwnedReview(req.workspaceId!, id);
  const result = raw === null ? null : parseResult(raw);
  res.json({ review: { ...review, result: result ? toJson(result) : raw } });
}

export async function getReviewMarkdown(req: Request, res: Response) {
  const { id } = reviewIdParamSchema.parse(req.params);
  const review = await loadOwnedReview(req.workspaceId!, id);
  const result = review.result === null ? null : parseResult(review.result);
  if (!result) {
    throw new HttpError(409, review.result === null ? "This review has no result yet" : "This result can no longer be rendered");
  }
  // Rendered as the summary comment was, so the copy matches the forge. Jobs
  // stored before output.reviewStats existed showed the stats line; jobs
  // stored before output.agentPromptAll existed had no prompt.
  const stored = review.resolvedConfig as {
    config?: {
      output?: {
        reviewStats?: boolean;
        agentPromptAll?: boolean;
        estimateEffort?: boolean;
        highLevelSummaryPlacement?: string;
      };
    };
  } | null;
  const output = stored?.config?.output;
  const stats = output?.reviewStats !== false;
  const agentPrompt = output?.agentPromptAll === true;
  res
    .type("text/markdown; charset=utf-8")
    .send(toMarkdown(result, { stats, agentPrompt, ...walkthroughOptions(output) }));
}

export async function rerunReview(req: Request, res: Response) {
  const { id } = reviewIdParamSchema.parse(req.params);
  const existing = await prisma.reviewJob.findFirst({
    where: { id, ...ownedBy(req.workspaceId!) },
    include: { repository: { include: { connection: true } } },
  });
  if (!existing) {
    throw new HttpError(404, "Review not found");
  }
  const job = await queueLatest(existing.repository, existing.number);
  const review = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id }, select: listFields });
  res.status(202).json({ review });
}

export async function cancelReview(req: Request, res: Response) {
  const { id } = reviewIdParamSchema.parse(req.params);
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { name: true } });
  const cancelled = await cancelJob(id, req.workspaceId!, `Cancelled by ${user?.name ?? "a workspace member"}`);
  const review = await prisma.reviewJob.findFirst({ where: { id, ...ownedBy(req.workspaceId!) }, select: listFields });
  if (!review) {
    throw new HttpError(404, "Review not found");
  }
  if (!cancelled) {
    throw new HttpError(409, "Only a queued or running review can be cancelled");
  }
  res.json({ review });
}
