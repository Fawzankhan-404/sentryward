import { markersIn, SUMMARY_MARKER, withoutDescriptionBlock } from "../core/markers.ts";
import type { ChangeSet, ChangeType, ForgeRef, IssueContext } from "../core/models.ts";
import { toChangedFile } from "../diff/parse.ts";
import { ForgeHttp, isNotFound, type FetchLike } from "./http.ts";
import { cacheKey, cached, type ForgeCache } from "./cache.ts";
import { MAX_CANDIDATE_ISSUES, MAX_LINKED_ISSUES } from "./issues.ts";
import {
  hostOrigin,
  STATUS_CONTEXT,
  MAX_OPEN_CHANGE_PAGES,
  MAX_CODE_SEARCH_RESULTS,
  type ChangeHead,
  type ChangeSummary,
  type CommitState,
  type CommitStatus,
  type ForgeAccount,
  type ForgeAdapter,
  type ForgeHooks,
  type ForgePublisher,
  type ForgeRepo,
  type HookTarget,
  type InlineComment,
  type InlineResult,
} from "./types.ts";

export interface GitLabAdapterOptions {
  host: string;
  token: () => Promise<string>;
  // The username Sentryward posts as (the token's user), to find its own notes.
  selfLogin?: string;
  fetch?: FetchLike;
}

interface GlProject {
  id: number;
  path_with_namespace: string;
  default_branch: string | null;
  visibility: "private" | "internal" | "public";
  web_url: string;
}

interface GlMergeRequest {
  iid: number;
  updated_at: string;
  state: "opened" | "closed" | "merged" | "locked";
  sha: string;
  title: string;
  description: string | null;
  draft?: boolean;
  work_in_progress?: boolean;
  web_url: string;
  author?: { username: string };
  labels?: string[];
  source_branch: string;
  target_branch: string;
  diff_refs: { base_sha: string; start_sha: string; head_sha: string } | null;
}

interface GlDiff {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  diff: string;
  too_large?: boolean;
  collapsed?: boolean;
}

function changeTypeOf(diff: GlDiff): ChangeType {
  if (diff.new_file) return "added";
  if (diff.deleted_file) return "deleted";
  if (diff.renamed_file) return "renamed";
  return "modified";
}

function toRepo(project: GlProject): ForgeRepo {
  return {
    externalId: String(project.id),
    fullPath: project.path_with_namespace,
    defaultBranch: project.default_branch ?? "main",
    private: project.visibility !== "public",
    webUrl: project.web_url,
  };
}

function nextPage(res: Response, current: string): string | null {
  const next = res.headers.get("x-next-page");
  if (!next) {
    return null;
  }
  const url = new URL(current, "http://placeholder");
  url.searchParams.set("page", next);
  return `${url.pathname}${url.search}`;
}

interface GlIssue {
  iid: number;
  title: string;
  description: string | null;
  state: "opened" | "closed";
  web_url: string;
}

function toIssue(issue: GlIssue): IssueContext {
  return {
    ref: `#${issue.iid}`,
    title: issue.title,
    url: issue.web_url,
    state: issue.state === "closed" ? "closed" : "open",
    body: issue.description ?? "",
  };
}

interface GlNote {
  id: number;
  body: string;
  system: boolean;
  author: { username: string };
}

interface GlDiscussion {
  id: string;
  notes: GlNote[];
}

// GitLab has no "error" state; a review that could not finish fails the check.
const GITLAB_STATE: Record<CommitState, string> = {
  pending: "running",
  success: "success",
  failure: "failed",
  error: "failed",
};

export class GitLabAdapter implements ForgeAdapter, ForgePublisher, ForgeHooks {
  readonly provider = "gitlab" as const;
  readonly host: string;
  private http: ForgeHttp;
  private selfLogin: string | undefined;

  constructor(options: GitLabAdapterOptions) {
    this.selfLogin = options.selfLogin;
    this.host = options.host;
    this.http = new ForgeHttp({
      baseUrl: `${hostOrigin(options.host)}/api/v4`,
      fetch: options.fetch,
      headers: async () => ({ "PRIVATE-TOKEN": await options.token() }),
    });
  }

  private project(project: string): string {
    return `/projects/${encodeURIComponent(project)}`;
  }

  async currentAccount(): Promise<ForgeAccount> {
    const user = await this.http.json<{ username: string }>("/user");
    return { login: user.username };
  }

  async listRepos(): Promise<ForgeRepo[]> {
    // Developer access (30) is the least that can read MRs and post discussions.
    const projects = await this.http.paginate<GlProject>(
      "/projects?membership=true&min_access_level=30&archived=false&per_page=100&order_by=last_activity_at",
      nextPage,
      10,
    );
    return projects.map(toRepo);
  }

  async getRepo(externalId: string): Promise<ForgeRepo> {
    return toRepo(await this.http.json<GlProject>(this.project(externalId)));
  }

  // `/diffs` arrived in GitLab 15.7; older self-managed instances 404 on it.
  // `/changes` (deprecated, still in API v4) returns the same diff objects in
  // one unpaginated response, so fall back to it only on a 404. The MR itself
  // was just fetched, so a 404 here means the route is missing, not the MR.
  private async mergeRequestDiffs(base: string): Promise<GlDiff[]> {
    try {
      return await this.http.paginate<GlDiff>(`${base}/diffs?per_page=100`, nextPage);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      const mr = await this.http.json<{ changes?: GlDiff[] }>(`${base}/changes`);
      return mr.changes ?? [];
    }
  }

  async getChange(project: string, number: number, cache?: ForgeCache): Promise<ChangeSet> {
    const base = `${this.project(project)}/merge_requests/${number}`;
    const mr = await this.http.json<GlMergeRequest>(base);
    if (!mr.diff_refs) {
      throw new Error(`Merge request !${number} has no diff yet`);
    }
    const refs = mr.diff_refs;
    // The diffs of an MR are fixed by its diff refs.
    const diffs = await cached(
      cache,
      cacheKey("gitlab-diffs", this.host, project, number, refs.base_sha, refs.start_sha, refs.head_sha),
      () => this.mergeRequestDiffs(base),
    );

    return {
      forgeRef: {
        provider: "gitlab",
        host: this.host,
        project,
        number,
        baseSha: mr.diff_refs.base_sha,
        startSha: mr.diff_refs.start_sha,
        headSha: mr.diff_refs.head_sha,
        webUrl: mr.web_url,
      },
      title: mr.title,
      description: withoutDescriptionBlock(mr.description ?? ""),
      baseRef: mr.target_branch,
      headRef: mr.source_branch,
      isDraft: mr.draft ?? mr.work_in_progress ?? false,
      author: mr.author?.username,
      labels: mr.labels ?? [],
      files: diffs.map((diff) =>
        toChangedFile({
          path: diff.deleted_file ? diff.old_path : diff.new_path,
          previousPath: diff.old_path,
          changeType: changeTypeOf(diff),
          // GitLab empties `diff` and flags it when a file is over its limits.
          patch: diff.too_large || diff.collapsed ? undefined : diff.diff,
        }),
      ),
    };
  }

  async getChangeHead(project: string, number: number): Promise<ChangeHead> {
    const mr = await this.http.json<GlMergeRequest>(`${this.project(project)}/merge_requests/${number}`);
    return {
      headSha: mr.diff_refs?.head_sha ?? mr.sha,
      title: mr.title,
      state: mr.state === "merged" ? "merged" : mr.state === "closed" ? "closed" : "open",
      isDraft: mr.draft ?? mr.work_in_progress ?? false,
    };
  }

  async listOpenChanges(project: string): Promise<ChangeSummary[]> {
    const mrs = await this.http.paginate<GlMergeRequest>(
      `${this.project(project)}/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=100`,
      nextPage,
      MAX_OPEN_CHANGE_PAGES,
    );
    return mrs.map((mr) => ({
      number: mr.iid,
      title: mr.title,
      author: mr.author?.username,
      isDraft: mr.draft ?? mr.work_in_progress ?? false,
      headSha: mr.sha,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      webUrl: mr.web_url,
      updatedAt: mr.updated_at,
    }));
  }

  async getFileAtRef(project: string, path: string, ref: string): Promise<string | null> {
    try {
      const res = await this.http.request(
        `${this.project(project)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`,
      );
      return await res.text();
    } catch (err) {
      if (isNotFound(err)) {
        return null;
      }
      throw err;
    }
  }

  // GitLab already knows which issues an MR closes, from the same keywords.
  async getLinkedIssues(change: ChangeSet): Promise<IssueContext[]> {
    const issues = await this.http.json<GlIssue[]>(
      `${this.mergeRequest(change.forgeRef)}/closes_issues?per_page=${MAX_LINKED_ISSUES}`,
    );
    return issues.slice(0, MAX_LINKED_ISSUES).map(toIssue);
  }

  // GitLab's search matches every word it is given, so each term is searched
  // on its own and the results merged.
  async searchIssues(project: string, terms: string[]): Promise<IssueContext[]> {
    const found = new Map<number, GlIssue>();
    for (const term of terms) {
      const issues = await this.http.json<GlIssue[]>(
        `${this.project(project)}/issues?search=${encodeURIComponent(term)}&in=title,description&order_by=updated_at&per_page=${MAX_CANDIDATE_ISSUES}`,
      );
      for (const issue of issues) {
        if (found.size < MAX_CANDIDATE_ISSUES) found.set(issue.iid, issue);
      }
      if (found.size >= MAX_CANDIDATE_ISSUES) break;
    }
    return [...found.values()].map(toIssue);
  }

  async searchCode(project: string, term: string, ref: string): Promise<string[]> {
    const blobs = await this.http.json<{ path: string }[]>(
      `${this.project(project)}/search?scope=blobs&search=${encodeURIComponent(term)}&ref=${encodeURIComponent(ref)}&per_page=${MAX_CODE_SEARCH_RESULTS}`,
    );
    return [...new Set(blobs.map((blob) => blob.path))];
  }

  private mergeRequest(ref: ForgeRef): string {
    return `${this.project(ref.project)}/merge_requests/${ref.number}`;
  }

  private isSelf(note: GlNote): boolean {
    return !note.system && Boolean(this.selfLogin) && note.author.username === this.selfLogin;
  }

  // GitLab has no batch review API, so each finding is its own discussion. A
  // multi-line finding is anchored on its first line; its suggestion block
  // carries the range.
  async postInlineComments(ref: ForgeRef, comments: InlineComment[]): Promise<InlineResult> {
    const result: InlineResult = { posted: [], failed: [] };
    for (const comment of comments) {
      const position = {
        position_type: "text",
        base_sha: ref.baseSha,
        start_sha: ref.startSha,
        head_sha: ref.headSha,
        new_path: comment.path,
        old_path: comment.previousPath ?? comment.path,
        new_line: comment.startLine,
        ...(comment.oldLine !== undefined ? { old_line: comment.oldLine } : {}),
      };
      try {
        const discussion = await this.http.json<GlDiscussion>(`${this.mergeRequest(ref)}/discussions`, {
          method: "POST",
          body: JSON.stringify({ body: comment.body, position }),
        });
        result.posted.push({ fingerprint: comment.fingerprint, forgeCommentId: discussion.id });
      } catch (err) {
        result.failed.push({ fingerprint: comment.fingerprint, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return result;
  }

  async listPostedFingerprints(ref: ForgeRef): Promise<Set<string>> {
    const discussions = await this.http.paginate<GlDiscussion>(
      `${this.mergeRequest(ref)}/discussions?per_page=100`,
      nextPage,
    );
    return new Set(
      discussions.flatMap((d) => d.notes.slice(0, 1)).filter((n) => this.isSelf(n)).flatMap((n) => markersIn(n.body)),
    );
  }

  upsertSummaryComment(ref: ForgeRef, body: string): Promise<string> {
    return this.upsertComment(ref, SUMMARY_MARKER, body);
  }

  async upsertComment(ref: ForgeRef, marker: string, body: string): Promise<string> {
    const notes = await this.http.paginate<GlNote>(`${this.mergeRequest(ref)}/notes?per_page=100&sort=asc`, nextPage);
    const existing = notes.filter((n) => this.isSelf(n) && n.body.includes(marker)).at(-1);
    const saved = existing
      ? await this.http.json<GlNote>(`${this.mergeRequest(ref)}/notes/${existing.id}`, {
          method: "PUT",
          body: JSON.stringify({ body }),
        })
      : await this.http.json<GlNote>(`${this.mergeRequest(ref)}/notes`, { method: "POST", body: JSON.stringify({ body }) });
    return String(saved.id);
  }

  // Read just before writing so an edit the author made since the change was
  // fetched is kept.
  async updateDescription(ref: ForgeRef, transform: (description: string) => string): Promise<void> {
    const mr = await this.http.json<GlMergeRequest>(this.mergeRequest(ref));
    const description = mr.description ?? "";
    const next = transform(description);
    if (next === description) return;
    await this.http.request(this.mergeRequest(ref), { method: "PUT", body: JSON.stringify({ description: next }) });
  }

  // One request; GitLab ignores labels it cannot remove and creates missing ones.
  async setLabels(ref: ForgeRef, add: string[], remove: string[]): Promise<void> {
    if (!add.length && !remove.length) return;
    await this.http.request(this.mergeRequest(ref), {
      method: "PUT",
      body: JSON.stringify({ add_labels: add.join(","), remove_labels: remove.join(",") }),
    });
  }

  async setCommitStatus(ref: ForgeRef, status: CommitStatus): Promise<void> {
    await this.http.request(`${this.project(ref.project)}/statuses/${ref.headSha}`, {
      method: "POST",
      body: JSON.stringify({
        state: GITLAB_STATE[status.state],
        name: STATUS_CONTEXT,
        description: status.description.slice(0, 255),
        ...(status.targetUrl ? { target_url: status.targetUrl } : {}),
      }),
    });
  }

  // Project hooks need Maintainer access; callers treat a failure as "automatic
  // reviews unavailable" rather than an error.
  async createHook(repo: HookTarget, url: string, token: string): Promise<string> {
    const hook = await this.http.json<{ id: number }>(`${this.project(repo.externalId)}/hooks`, {
      method: "POST",
      body: JSON.stringify({
        url,
        token,
        merge_requests_events: true,
        note_events: true,
        push_events: false,
        enable_ssl_verification: true,
      }),
    });
    return String(hook.id);
  }

  async deleteHook(repo: HookTarget, hookId: string): Promise<void> {
    try {
      await this.http.request(`${this.project(repo.externalId)}/hooks/${encodeURIComponent(hookId)}`, { method: "DELETE" });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  // Effective access level of a user on the project, inherited membership
  // included; 0 when they are not a member.
  async memberAccessLevel(project: string, userId: number): Promise<number> {
    try {
      const member = await this.http.json<{ access_level: number }>(`${this.project(project)}/members/all/${userId}`);
      return member.access_level;
    } catch (err) {
      if (isNotFound(err)) return 0;
      throw err;
    }
  }
}
