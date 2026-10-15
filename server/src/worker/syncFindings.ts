import { prisma } from "../lib/prisma.ts";
import type { ReviewResult } from "../review/core/models.ts";

export interface SyncFindingsInput {
  repositoryId: string;
  number: number;
  jobId: string;
  author?: string;
  result: ReviewResult;
  // The thread updates the publisher attempted and which of them failed, or
  // null when thread resolution did not run (turned off, nothing published).
  threads?: ThreadOutcome | null;
}

export interface ThreadOutcome {
  attempted: string[];
  failed: string[];
}

export interface FindingRow {
  fingerprint: string;
  state: string;
  file: string;
  threadPending?: boolean;
}

export interface FindingTransitions {
  // Open findings this run no longer reports.
  resolved: string[];
  // Resolved findings this run reports again.
  reopened: string[];
}

// Which findings one run moves between open and resolved. A finding is resolved
// only when this run actually read its file (or the file left the change); a
// partial run that skipped the file for budget says nothing about it. Ignoring
// is the user's call, so no run undoes it. The publisher resolves forge threads
// from the same answer before the rows are written, so the two cannot disagree.
export function findingTransitions(existing: FindingRow[], result: ReviewResult): FindingTransitions {
  if (result.status === "failed") return { resolved: [], reopened: [] };
  const reviewed = new Set(result.coverage.reviewedFiles);
  const changed = new Set(result.files.map((file) => file.path));
  const reported = new Set(result.findings.map((finding) => finding.fingerprint));
  return {
    resolved: existing
      .filter((row) => row.state === "open" && !reported.has(row.fingerprint))
      .filter((row) => reviewed.has(row.file) || !changed.has(row.file))
      .map((row) => row.fingerprint),
    reopened: existing.filter((row) => row.state === "resolved" && reported.has(row.fingerprint)).map((row) => row.fingerprint),
  };
}

export interface ThreadOperations {
  resolve: string[];
  reopen: string[];
}

// The forge threads to move this run: every transition, plus earlier ones whose
// thread update failed, retried toward the state the finding will have after
// this run. An ignored finding's thread is left as it is.
export function threadOperations(existing: FindingRow[], transitions: FindingTransitions): ThreadOperations {
  const resolve = new Set(transitions.resolved);
  const reopen = new Set(transitions.reopened);
  for (const row of existing) {
    if (!row.threadPending || resolve.has(row.fingerprint) || reopen.has(row.fingerprint)) continue;
    if (row.state === "resolved") resolve.add(row.fingerprint);
    else if (row.state === "open") reopen.add(row.fingerprint);
  }
  return { resolve: [...resolve], reopen: [...reopen] };
}

// Brings the change's findings table in step with one run's result.
export async function syncFindings({ repositoryId, number, jobId, author, result, threads }: SyncFindingsInput): Promise<void> {
  // Retries happen even on a failed run, so their outcome is kept either way.
  if (result.status === "failed") {
    if (threads) await prisma.$transaction((tx) => recordThreads(tx, repositoryId, number, threads));
    return;
  }
  const now = new Date();
  // A run can report the same fingerprint twice (overlapping chunks); one row each.
  const reported = new Map(result.findings.map((finding) => [finding.fingerprint, finding]));

  await prisma.$transaction(async (tx) => {
    const existing = await tx.finding.findMany({
      where: { repositoryId, number },
      select: { id: true, fingerprint: true, state: true, file: true },
    });
    const known = new Map(existing.map((row) => [row.fingerprint, row]));

    for (const finding of reported.values()) {
      const snapshot = {
        title: finding.title,
        file: finding.file,
        startLine: finding.startLine,
        severity: finding.severity,
        category: finding.category,
        kind: finding.kind,
        changeTitle: result.change.title,
        lastJobId: jobId,
        lastSeenAt: now,
        // Backfilled rows have no author; keep a known one if the forge stops saying.
        ...(author ? { author } : {}),
      };
      const row = known.get(finding.fingerprint);
      if (!row) {
        await tx.finding.create({ data: { repositoryId, number, fingerprint: finding.fingerprint, ...snapshot } });
      } else if (row.state === "resolved") {
        await tx.finding.update({ where: { id: row.id }, data: { ...snapshot, state: "open", resolvedAt: null } });
      } else {
        await tx.finding.update({ where: { id: row.id }, data: snapshot });
      }
    }

    const { resolved } = findingTransitions(existing, result);
    if (resolved.length) {
      await tx.finding.updateMany({
        where: { repositoryId, number, fingerprint: { in: resolved } },
        data: { state: "resolved", resolvedAt: now },
      });
    }
    if (threads) await recordThreads(tx, repositoryId, number, threads);
  });
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// A thread that was found and moved, or was already where it should be (or
// does not exist), is settled; a failed one stays pending for the next run.
async function recordThreads(tx: Tx, repositoryId: string, number: number, threads: ThreadOutcome): Promise<void> {
  const failed = new Set(threads.failed);
  const settled = threads.attempted.filter((print) => !failed.has(print));
  if (failed.size) {
    await tx.finding.updateMany({
      where: { repositoryId, number, fingerprint: { in: [...failed] } },
      data: { threadPending: true },
    });
  }
  if (settled.length) {
    await tx.finding.updateMany({
      where: { repositoryId, number, fingerprint: { in: settled } },
      data: { threadPending: false },
    });
  }
}
