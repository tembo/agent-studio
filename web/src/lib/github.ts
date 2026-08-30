import "server-only";

import { updateTag } from "next/cache";

// Accept the forms a user is likely to paste — the github.com host is
// optional, and so is the scheme (https://) and www., so the bare
// `github.com/owner/repo` we show as the placeholder works too:
//   owner/repo
//   github.com/owner/repo
//   www.github.com/owner/repo
//   https://github.com/owner/repo[.git][/]
//   http://github.com/owner/repo
//   git@github.com:owner/repo.git
const REPO_RE =
  /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/|git@github\.com:)?([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

export type ParsedRepo = { owner: string; name: string };

export function parseRepoInput(input: string): ParsedRepo | null {
  const m = REPO_RE.exec(input.trim());
  if (!m) return null;
  const [, owner, name] = m;
  if (!owner || !name) return null;
  return { owner, name };
}

export type ValidateRepoError =
  | "invalid-token"
  | "not-found"
  | "no-push"
  | "network"
  | "rate-limited";

export type ValidateRepoResult =
  | {
      ok: true;
      owner: string;
      name: string;
      fullName: string;
      defaultBranch: string;
    }
  | { ok: false; error: ValidateRepoError; detail?: string };

/**
 * Confirm the PAT can both read and write the given repo. Returns a typed
 * error code rather than throwing so the UI can render a clean message.
 *
 * Implementation note: `GET /repos/{owner}/{repo}` returns the requesting
 * user's `permissions` block when authenticated. `permissions.push === true`
 * is GitHub's documented signal for write access. We do NOT actually attempt
 * a write — creating + deleting a probe branch is invasive and would leave
 * a noisy audit trail in the customer's repo.
 */
export async function validateRepo(
  token: string,
  parsed: ParsedRepo,
): Promise<ValidateRepoResult> {
  let res: Response;
  try {
    res = await fetch(
      `https://api.github.com/repos/${parsed.owner}/${parsed.name}`,
      {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "tembo-agent-studio",
        },
        cache: "no-store",
      },
    );
  } catch (err) {
    return {
      ok: false,
      error: "network",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (res.status === 401) {
    return { ok: false, error: "invalid-token" };
  }
  if (res.status === 404) {
    // GitHub does not distinguish "repo doesn't exist" from "token can't see it"
    // on purpose, to avoid leaking private-repo existence.
    return { ok: false, error: "not-found" };
  }
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    return { ok: false, error: "rate-limited" };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: "network",
      detail: `GitHub returned ${res.status}`,
    };
  }

  const body = (await res.json()) as {
    name: string;
    full_name: string;
    owner: { login: string };
    default_branch: string;
    permissions?: { push?: boolean };
  };

  if (!body.permissions?.push) {
    return { ok: false, error: "no-push" };
  }

  return {
    ok: true,
    owner: body.owner.login,
    name: body.name,
    fullName: body.full_name,
    defaultBranch: body.default_branch,
  };
}

// ── File operations ──────────────────────────────────────────────────────

const GITHUB_HEADERS = (token: string) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "tembo-agent-studio",
});

export type RepoRef = { owner: string; name: string; branch: string };

// Next.js fetch cache key — every read of this repo's tree shares
// the same tag, so a single revalidateTag call after a write
// invalidates everything cached for that repo. The branch is part
// of the tag because reads include a `?ref=` querystring and a
// branch switch should not see stale content from the old branch.
//
// Caching read calls (and not writes) cuts the GitHub round trip
// for listAgents from "every workspace page load" to "once per 60s
// per repo per process", which is what the sidebar missing-
// connections scan needs to be cheap.
export function repoCacheTag(ref: RepoRef): string {
  return `gh:${ref.owner}/${ref.name}@${ref.branch}`;
}

// 60s is the cache TTL we apply to read-side fetches. Short enough
// that drift after a manual repo edit is bounded; long enough that
// sidebar-rendering on every page load doesn't pay one round trip
// per agent per page.
const READ_CACHE_TTL_SECONDS = 60;

export type GitHubFileError =
  | "invalid-token"
  | "not-found"
  | "path-exists"
  | "branch-protected"
  | "rate-limited"
  | "network";

export type GitHubContentEntry = {
  type: "file" | "dir" | "submodule" | "symlink";
  name: string;
  path: string;
  size: number;
  sha: string;
  download_url: string | null;
};

export type ListDirectoryResult =
  | { ok: true; entries: GitHubContentEntry[] }
  | { ok: true; entries: []; missing: true }
  | { ok: false; error: GitHubFileError; detail?: string };

/**
 * GET /repos/{o}/{r}/contents/{path}?ref={branch}
 * Returns an empty list (with `missing: true`) when the directory doesn't
 * exist — that's the expected state for a brand-new workspace whose repo
 * doesn't have an `agents/` directory yet.
 */
export async function listDirectory(
  token: string,
  ref: RepoRef,
  path: string,
): Promise<ListDirectoryResult> {
  const url = `https://api.github.com/repos/${ref.owner}/${ref.name}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref.branch)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: GITHUB_HEADERS(token),
      next: {
        revalidate: READ_CACHE_TTL_SECONDS,
        tags: [repoCacheTag(ref)],
      },
    });
  } catch (err) {
    return {
      ok: false,
      error: "network",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (res.status === 401) return { ok: false, error: "invalid-token" };
  if (res.status === 404) return { ok: true, entries: [], missing: true };
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    return { ok: false, error: "rate-limited" };
  }
  if (!res.ok) {
    return { ok: false, error: "network", detail: `GitHub returned ${res.status}` };
  }
  const body = (await res.json()) as GitHubContentEntry | GitHubContentEntry[];
  // The endpoint returns an array for directories and an object for files;
  // callers should ask listDirectory only for directories, but tolerate the
  // single-entry case rather than crashing.
  const entries = Array.isArray(body) ? body : [body];
  return { ok: true, entries };
}

export type ReadFileResult =
  | { ok: true; content: string; sha: string }
  | { ok: false; error: GitHubFileError; detail?: string };

/**
 * GET /repos/{o}/{r}/contents/{path}?ref={branch}, decoded from base64.
 */
export async function readFile(
  token: string,
  ref: RepoRef,
  path: string,
): Promise<ReadFileResult> {
  const url = `https://api.github.com/repos/${ref.owner}/${ref.name}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref.branch)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: GITHUB_HEADERS(token),
      next: {
        revalidate: READ_CACHE_TTL_SECONDS,
        tags: [repoCacheTag(ref)],
      },
    });
  } catch (err) {
    return {
      ok: false,
      error: "network",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (res.status === 401) return { ok: false, error: "invalid-token" };
  if (res.status === 404) return { ok: false, error: "not-found" };
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    return { ok: false, error: "rate-limited" };
  }
  if (!res.ok) {
    return { ok: false, error: "network", detail: `GitHub returned ${res.status}` };
  }
  const body = (await res.json()) as { content: string; encoding: string; sha: string };
  if (body.encoding !== "base64") {
    return { ok: false, error: "network", detail: `unexpected encoding ${body.encoding}` };
  }
  const content = Buffer.from(body.content, "base64").toString("utf8");
  return { ok: true, content, sha: body.sha };
}

export type FileCommit = {
  sha: string;
  shortSha: string;
  /** ISO timestamp of the commit (author date). */
  date: string;
  /** First line of the commit message. */
  summary: string;
  authorName: string | null;
  /** github.com link to the commit. */
  htmlUrl: string;
};

export type ListFileCommitsResult =
  | { ok: true; commits: FileCommit[] }
  | { ok: false; error: GitHubFileError; detail?: string };

/**
 * GET /repos/{o}/{r}/commits?path={path}&sha={branch} — the commit history of
 * one file on a branch, newest first. Used by the Definition tab to show every
 * version of an agent spec that landed on GitHub (commit hash + date).
 */
export async function listFileCommits(
  token: string,
  ref: RepoRef,
  path: string,
  limit = 30,
): Promise<ListFileCommitsResult> {
  const url =
    `https://api.github.com/repos/${ref.owner}/${ref.name}/commits` +
    `?path=${encodePath(path)}&sha=${encodeURIComponent(ref.branch)}` +
    `&per_page=${Math.min(Math.max(limit, 1), 100)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: GITHUB_HEADERS(token),
      next: { revalidate: READ_CACHE_TTL_SECONDS, tags: [repoCacheTag(ref)] },
    });
  } catch (err) {
    return {
      ok: false,
      error: "network",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (res.status === 401) return { ok: false, error: "invalid-token" };
  if (res.status === 404) return { ok: false, error: "not-found" };
  if (res.status === 403) return { ok: false, error: "rate-limited" };
  if (!res.ok) {
    return { ok: false, error: "network", detail: `GitHub returned ${res.status}` };
  }
  const body = (await res.json()) as Array<{
    sha: string;
    html_url: string;
    commit: { message: string; author: { name?: string; date?: string } | null };
  }>;
  const commits: FileCommit[] = body.map((c) => ({
    sha: c.sha,
    shortSha: c.sha.slice(0, 7),
    date: c.commit.author?.date ?? "",
    summary: (c.commit.message ?? "").split("\n")[0],
    authorName: c.commit.author?.name ?? null,
    htmlUrl: c.html_url,
  }));
  return { ok: true, commits };
}

export type CreateFileResult =
  | { ok: true; commitSha: string }
  | { ok: false; error: GitHubFileError; detail?: string };

/**
 * PUT /repos/{o}/{r}/contents/{path} without `sha` — refuses to overwrite
 * an existing file, returning `path-exists`.
 */
export async function createFile(
  token: string,
  ref: RepoRef,
  path: string,
  args: { content: string; message: string },
): Promise<CreateFileResult> {
  const url = `https://api.github.com/repos/${ref.owner}/${ref.name}/contents/${encodePath(path)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers: { ...GITHUB_HEADERS(token), "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        message: args.message,
        content: Buffer.from(args.content, "utf8").toString("base64"),
        branch: ref.branch,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      error: "network",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (res.status === 401) return { ok: false, error: "invalid-token" };
  if (res.status === 404) return { ok: false, error: "not-found" };
  if (res.status === 422) {
    // 422 covers both "file exists" (no sha provided) and "branch
    // protected". The error body usually distinguishes; do a cheap text
    // sniff so the UI can render a clean message.
    const text = await res.text();
    if (/branch.*protected/i.test(text)) {
      return { ok: false, error: "branch-protected", detail: text };
    }
    return { ok: false, error: "path-exists", detail: text };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      error: "network",
      detail: `GitHub returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
    };
  }
  const body = (await res.json()) as { commit: { sha: string } };
  // Bust any cached reads of this repo so the next listAgents
  // pageload sees the newly-created file immediately. `updateTag`
  // is the Next.js 16 read-your-own-writes API; safe outside server
  // actions too (returns undefined and no-ops if there's nothing to
  // invalidate).
  updateTag(repoCacheTag(ref));
  return { ok: true, commitSha: body.commit.sha };
}

export type UpdateFileResult =
  | { ok: true; commitSha: string }
  | { ok: false; error: GitHubFileError | "sha-mismatch"; detail?: string };

/**
 * PUT /repos/{o}/{r}/contents/{path} with the existing blob's `sha`,
 * which is how GitHub distinguishes update from create on the same
 * endpoint. The caller must supply the current sha (read it via
 * readFile first); a stale sha returns 'sha-mismatch'.
 */
export async function updateFile(
  token: string,
  ref: RepoRef,
  path: string,
  args: { content: string; message: string; sha: string },
): Promise<UpdateFileResult> {
  const url = `https://api.github.com/repos/${ref.owner}/${ref.name}/contents/${encodePath(path)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers: { ...GITHUB_HEADERS(token), "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        message: args.message,
        content: Buffer.from(args.content, "utf8").toString("base64"),
        branch: ref.branch,
        sha: args.sha,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      error: "network",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (res.status === 401) return { ok: false, error: "invalid-token" };
  if (res.status === 404) return { ok: false, error: "not-found" };
  if (res.status === 409) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: "sha-mismatch", detail: text };
  }
  if (res.status === 422) {
    const text = await res.text();
    if (/branch.*protected/i.test(text)) {
      return { ok: false, error: "branch-protected", detail: text };
    }
    // 422 with no protection signal on update is usually a stale sha.
    return { ok: false, error: "sha-mismatch", detail: text };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      error: "network",
      detail: `GitHub returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
    };
  }
  const body = (await res.json()) as { commit: { sha: string } };
  updateTag(repoCacheTag(ref));
  return { ok: true, commitSha: body.commit.sha };
}

export type DeleteFileResult =
  | { ok: true; commitSha: string }
  | { ok: false; error: GitHubFileError | "sha-mismatch"; detail?: string };

/**
 * DELETE /repos/{o}/{r}/contents/{path}. Requires the file's current sha
 * so we don't accidentally delete a stale revision; pull it from readFile
 * immediately before calling this.
 */
export async function deleteFile(
  token: string,
  ref: RepoRef,
  path: string,
  args: { sha: string; message: string },
): Promise<DeleteFileResult> {
  const url = `https://api.github.com/repos/${ref.owner}/${ref.name}/contents/${encodePath(path)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "DELETE",
      headers: { ...GITHUB_HEADERS(token), "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        message: args.message,
        sha: args.sha,
        branch: ref.branch,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      error: "network",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (res.status === 401) return { ok: false, error: "invalid-token" };
  if (res.status === 404) return { ok: false, error: "not-found" };
  if (res.status === 409) return { ok: false, error: "sha-mismatch" };
  if (res.status === 422) {
    const text = await res.text();
    if (/branch.*protected/i.test(text)) {
      return { ok: false, error: "branch-protected", detail: text };
    }
    return { ok: false, error: "network", detail: text };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      error: "network",
      detail: `GitHub returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
    };
  }
  const body = (await res.json()) as { commit: { sha: string } };
  updateTag(repoCacheTag(ref));
  return { ok: true, commitSha: body.commit.sha };
}

function encodePath(p: string): string {
  return p
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}
