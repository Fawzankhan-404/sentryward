import type { Request, Response } from "express";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import { median } from "../lib/stats.ts";
import type { Prisma } from "../generated/prisma/client.ts";
import { reviewResultSchema } from "../review/core/models.ts";
import { CATEGORIES, SEVERITIES, type Category } from "../review/core/severity.ts";
import {
  findingIdParamSchema,
  findingStatsQuerySchema,
  listFindingsQuerySchema,
  updateFindingSchema,
} from "../schemas/findings.schema.ts";

const listFields = {
  id: true,
  number: true,
  state: true,
  title: true,
  file: true,
  startLine: true,
  severity: true,
  category: true,
  kind: true,
  changeTitle: true,
  author: true,
  lastJobId: true,
  firstSeenAt: true,
  lastSeenAt: true,
  resolvedAt: true,
  ignoredAt: true,
  ignoreReason: true,
  ignoreNote: true,
  repository: { select: { id: true, provider: true, host: true, fullPath: true } },
} as const;

function ownedBy(workspaceId: string) {
  return { repository: { connection: { workspaceId } } };
}

type ListQuery = ReturnType<typeof listFindingsQuerySchema.parse>;
type Dir = ListQuery["dir"];

// Severity is stored most severe first, so "desc" (most severe on top) reads
// the enum backwards. Authors are unknown for backfilled rows; those go last
// either way.
const SORT_ORDER: Record<ListQuery["sort"], (dir: Dir) => Prisma.FindingOrderByWithRelationInput> = {
  title: (dir) => ({ title: dir }),
  number: (dir) => ({ number: dir }),
  repository: (dir) => ({ repository: { fullPath: dir } }),
  state: (dir) => ({ state: dir }),
  severity: (dir) => ({ severity: dir === "desc" ? "asc" : "desc" }),
  category: (dir) => ({ category: dir }),
  kind: (dir) => ({ kind: dir }),
  author: (dir) => ({ author: { sort: dir, nulls: "last" } }),
  lastSeenAt: (dir) => ({ lastSeenAt: dir }),
};

type BreakdownRow<K> = { key: K; found: number; falsePositives: number; rate: number | null };

function breakdownRow<K>(key: K, found: number, falsePositives: number): BreakdownRow<K> {
  return { key, found, falsePositives, rate: found ? Math.round((falsePositives / found) * 100) : null };
}

// Noisiest first, so the rows worth acting on lead.
function byRate<K>(a: BreakdownRow<K>, b: BreakdownRow<K>) {
  return (b.rate ?? -1) - (a.rate ?? -1) || b.found - a.found;
}

// "#12" (GitHub) and "!12" (GitLab) are how people write change numbers.
const NUMBER_QUERY = /^[#!]?(\d{1,9})$/;

export async function listFindings(req: Request, res: Response) {
  const { repoId, state, severity, category, kind, q, sort, dir, page, limit } = listFindingsQuerySchema.parse(req.query);
  const where: Prisma.FindingWhereInput = {
    ...ownedBy(req.workspaceId!),
    ...(repoId ? { repositoryId: repoId } : {}),
    ...(state ? { state } : {}),
    ...(severity ? { severity } : {}),
    ...(category ? { category } : {}),
    ...(kind ? { kind } : {}),
  };
  if (q) {
    const asNumber = NUMBER_QUERY.exec(q);
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { file: { contains: q, mode: "insensitive" } },
      { author: { contains: q, mode: "insensitive" } },
      { repository: { fullPath: { contains: q, mode: "insensitive" } } },
      ...(asNumber ? [{ number: Number(asNumber[1]) }] : []),
    ];
  }
  const [findings, total] = await prisma.$transaction([
    prisma.finding.findMany({
      where,
      // The id tiebreak keeps rows from shifting between pages when values collide.
      orderBy: [SORT_ORDER[sort](dir), { id: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
      select: listFields,
    }),
    prisma.finding.count({ where }),
  ]);
  res.json({ findings, total, page, limit });
}

export async function getFindingStats(req: Request, res: Response) {
  const { repoId, days } = findingStatsQuerySchema.parse(req.query);
  const since = new Date(Date.now() - days * 86_400_000);
  const scope = { ...ownedBy(req.workspaceId!), ...(repoId ? { repositoryId: repoId } : {}) };
  const workspaceId = req.workspaceId!;
  const [open, recent, staleOpen, resolvedRecently, found, falsePositives, byKind, byModel] = await prisma.$transaction([
    prisma.finding.groupBy({
      by: ["severity"],
      where: { ...scope, state: "open" },
      orderBy: { severity: "asc" },
      _count: { _all: true },
    }),
    // Ignored findings were never going to be fixed; they would only drag the rate down.
    prisma.finding.groupBy({
      by: ["state"],
      where: { ...scope, firstSeenAt: { gte: since }, state: { not: "ignored" } },
      orderBy: { state: "asc" },
      _count: { _all: true },
    }),
    // Usually left behind by changes that were merged or closed without another run.
    prisma.finding.count({ where: { ...scope, state: "open", firstSeenAt: { lt: since } } }),
    prisma.finding.findMany({
      where: { ...scope, state: "resolved", resolvedAt: { gte: since } },
      select: { firstSeenAt: true, resolvedAt: true },
    }),
    // Unlike the resolution rate, this counts ignored findings: dismissing one
    // as a false positive is exactly what it measures.
    prisma.finding.count({ where: { ...scope, firstSeenAt: { gte: since } } }),
    prisma.finding.count({
      where: { ...scope, firstSeenAt: { gte: since }, state: "ignored", ignoreReason: "false_positive" },
    }),
    // Same population as `found`, split so category and severity can both be
    // folded from one query.
    prisma.finding.groupBy({
      by: ["category", "severity", "state", "ignoreReason"],
      where: { ...scope, firstSeenAt: { gte: since } },
      orderBy: { category: "asc" },
      _count: { _all: true },
    }),
    // The model is the one the last run reporting the finding was configured
    // with, read from its stored config rather than a column on findings. A
    // deleted run (or one stored before configs were) groups under null.
    prisma.$queryRaw<{ model: string | null; found: number; false_positives: number }[]>`
      SELECT j.resolved_config #>> '{config,llm,model}' AS model,
        count(*)::int AS found,
        (count(*) FILTER (WHERE f.state = 'ignored' AND f.ignore_reason = 'false_positive'))::int AS false_positives
      FROM findings f
      JOIN repositories r ON r.id = f.repository_id
      JOIN forge_connections c ON c.id = r.connection_id
      LEFT JOIN review_jobs j ON j.id = f.last_job_id
      WHERE c.workspace_id = ${workspaceId}::uuid
        AND (${repoId ?? null}::uuid IS NULL OR f.repository_id = ${repoId ?? null}::uuid)
        AND f.first_seen_at >= ${since}
      GROUP BY 1
    `,
  ]);
  const count = (row: { _count?: unknown }) => (row._count as { _all: number })._all;
  const openBySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<(typeof SEVERITIES)[number], number>;
  for (const row of open) {
    if (row.severity in openBySeverity) openBySeverity[row.severity as keyof typeof openBySeverity] = count(row);
  }
  const total = recent.reduce((sum, row) => sum + count(row), 0);
  const resolved = recent.filter((row) => row.state === "resolved").reduce((sum, row) => sum + count(row), 0);
  const tally = <K extends string>(keys: readonly K[], keyOf: (row: (typeof byKind)[number]) => K) => {
    const totals = new Map(keys.map((k) => [k, { found: 0, falsePositives: 0 }]));
    for (const row of byKind) {
      const entry = totals.get(keyOf(row));
      if (!entry) continue;
      entry.found += count(row);
      if (row.state === "ignored" && row.ignoreReason === "false_positive") entry.falsePositives += count(row);
    }
    return [...totals]
      .filter(([, t]) => t.found > 0)
      .map(([key, t]) => breakdownRow(key, t.found, t.falsePositives));
  };
  res.json({
    days,
    open: open.reduce((sum, row) => sum + count(row), 0),
    openBySeverity,
    resolved,
    total,
    resolutionRate: total ? Math.round((resolved / total) * 100) : null,
    staleOpen,
    medianTimeToResolve: median(resolvedRecently.map((f) => f.resolvedAt!.getTime() - f.firstSeenAt.getTime())),
    falsePositives,
    found,
    falsePositiveRate: found ? Math.round((falsePositives / found) * 100) : null,
    // Every group with at least one finding; how few is too few to show is the
    // dashboard's call.
    falsePositivesBy: {
      category: tally(CATEGORIES, (row) => row.category as Category).sort(byRate),
      severity: tally(SEVERITIES, (row) => row.severity),
      model: byModel.map((row) => breakdownRow(row.model, row.found, row.false_positives)).sort(byRate),
    },
  });
}

// The row plus the full finding from the run that last reported it. A result
// written by an older version, or a deleted run, leaves only the row.
export async function getFinding(req: Request, res: Response) {
  const { id } = findingIdParamSchema.parse(req.params);
  const row = await prisma.finding.findFirst({
    where: { id, ...ownedBy(req.workspaceId!) },
    select: { ...listFields, fingerprint: true, lastJob: { select: { result: true } } },
  });
  if (!row) {
    throw new HttpError(404, "Finding not found");
  }
  const { fingerprint, lastJob, ...finding } = row;
  const parsed = lastJob?.result ? reviewResultSchema.safeParse(lastJob.result) : null;
  const result = parsed?.success ? parsed.data : null;
  res.json({
    finding,
    detail: result?.findings.find((f) => f.fingerprint === fingerprint) ?? null,
    change: result?.change ?? null,
  });
}

export async function updateFinding(req: Request, res: Response) {
  const { id } = findingIdParamSchema.parse(req.params);
  const input = updateFindingSchema.parse(req.body);
  const existing = await prisma.finding.findFirst({ where: { id, ...ownedBy(req.workspaceId!) }, select: { id: true } });
  if (!existing) {
    throw new HttpError(404, "Finding not found");
  }
  // Reopening puts it back in the worker's hands (the next run resolves it if
  // it is gone) and forgets why it was ignored.
  const data =
    input.state === "ignored"
      ? { state: input.state, ignoredAt: new Date(), ignoreReason: input.reason, ignoreNote: input.note || null }
      : { state: input.state, ignoredAt: null, ignoreReason: null, ignoreNote: null };
  const finding = await prisma.finding.update({
    where: { id },
    data: { ...data, resolvedAt: null },
    select: listFields,
  });
  res.json({ finding });
}
