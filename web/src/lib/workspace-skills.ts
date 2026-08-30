import "server-only";
import YAML from "yaml";

import { db } from "@/lib/db";
import {
  createFile,
  deleteFile,
  listDirectory,
  readFile,
  updateFile,
  type GitHubFileError,
  type RepoRef,
} from "@/lib/github";
import { getWorkspaceRepo, getWorkspaceSecretPlaintext } from "@/lib/workspace";

// Agent Skills live as folders in the connected repo, one per skill:
//
//   skills/<name>/SKILL.md         (YAML frontmatter: name, description + body)
//   skills/<name>/scripts/...       (optional)
//   skills/<name>/resources/...     (optional)
//
// They're sourced from skills.sh, custom uploads, or exported from the Claude
// Skills API, then committed here. An agent opts in via its `skills:` field;
// the runner mounts the named folders so the model can load_skill /
// run_skill_script (pydantic-ai-skills). This module is the read/write surface
// over the repo — pure passthrough, it never executes skill code.

export const SKILLS_DIR = "skills";

/** Per-file cap and per-skill total, so a runaway file can't blow the env. */
const SKILL_FILE_MAX_BYTES = 512 * 1024;
const SKILL_TOTAL_MAX_BYTES = 1024 * 1024;
/** Max depth we recurse into a skill folder (SKILL.md + scripts/ + resources/). */
const MAX_DEPTH = 5;

export type InstalledSkill = {
  /** Folder name under skills/ — what an agent references in `skills:`. */
  name: string;
  /** From SKILL.md frontmatter; null if unparseable/missing. */
  description: string | null;
  /** From SKILL.md frontmatter `name`, if present (usually == folder name). */
  title: string | null;
  /** Repo path of the folder, e.g. "skills/pdf". */
  path: string;
};

/** A skill's files as { repoPath: textContent }, e.g. "skills/pdf/SKILL.md". */
export type SkillFiles = Record<string, string>;

function repoRefFor(repo: {
  owner: string;
  name: string;
  defaultBranch: string;
}): RepoRef {
  return { owner: repo.owner, name: repo.name, branch: repo.defaultBranch };
}

/** Pull `name` + `description` out of a SKILL.md's leading YAML frontmatter. */
export function parseSkillFrontmatter(skillMd: string): {
  title: string | null;
  description: string | null;
} {
  const m = skillMd.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return { title: null, description: null };
  try {
    const fm = YAML.parse(m[1]);
    if (!fm || typeof fm !== "object") return { title: null, description: null };
    const o = fm as Record<string, unknown>;
    return {
      title: typeof o.name === "string" ? o.name : null,
      description: typeof o.description === "string" ? o.description : null,
    };
  } catch {
    return { title: null, description: null };
  }
}

/** Skills installed in the repo, with their SKILL.md metadata. */
export async function listInstalledSkills(
  workspaceId: string,
): Promise<InstalledSkill[]> {
  const repo = await getWorkspaceRepo(workspaceId);
  if (!repo) return [];
  const token = await getWorkspaceSecretPlaintext(workspaceId, "github_pat");
  const ref = repoRefFor(repo);

  const top = await listDirectory(token, ref, SKILLS_DIR);
  if (!top.ok || ("missing" in top && top.missing)) return [];

  const dirs = top.entries.filter((e) => e.type === "dir");
  const out = await Promise.all(
    dirs.map(async (d): Promise<InstalledSkill> => {
      const md = await readFile(token, ref, `${d.path}/SKILL.md`);
      const meta = md.ok
        ? parseSkillFrontmatter(md.content)
        : { title: null, description: null };
      return {
        name: d.name,
        description: meta.description,
        title: meta.title,
        path: d.path,
      };
    }),
  );
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export type InstalledSkillDetail = {
  name: string;
  title: string | null;
  description: string | null;
  path: string;
  /** The full SKILL.md (frontmatter + body) for display. */
  skillMd: string;
  /** Total files in the skill folder. */
  fileCount: number;
};

/**
 * One installed skill with its full SKILL.md content, for the detail view.
 * Returns null when the workspace has no repo or the skill folder is gone.
 */
export async function readInstalledSkill(
  workspaceId: string,
  name: string,
): Promise<InstalledSkillDetail | null> {
  const repo = await getWorkspaceRepo(workspaceId);
  if (!repo) return null;
  const token = await getWorkspaceSecretPlaintext(workspaceId, "github_pat");
  const ref = repoRefFor(repo);
  const res = await readSkillFolder(token ?? "", ref, name);
  if (!res.ok) return null;
  const mdKey = Object.keys(res.files).find((k) =>
    k.toLowerCase().endsWith("/skill.md"),
  );
  const skillMd = mdKey ? res.files[mdKey] : "";
  const meta = skillMd
    ? parseSkillFrontmatter(skillMd)
    : { title: null, description: null };
  return {
    name,
    title: meta.title,
    description: meta.description,
    path: `${SKILLS_DIR}/${name}`,
    skillMd,
    fileCount: Object.keys(res.files).length,
  };
}

/**
 * The source a skill was installed from, read off its most recent
 * `skill.installed` audit event (e.g. "github:owner/repo", "skills.sh:slug",
 * "upload", "claude-api"). Null if no install event is recorded.
 */
export async function getSkillInstallSource(
  workspaceId: string,
  name: string,
): Promise<string | null> {
  const { rows } = await db.query<{ payload: { source?: string } | null }>(
    `SELECT payload FROM audit_event
      WHERE workspace_id = $1 AND kind = 'skill.installed' AND target_id = $2
      ORDER BY at DESC
      LIMIT 1`,
    [workspaceId, name],
  );
  const source = rows[0]?.payload?.source;
  return typeof source === "string" ? source : null;
}

/**
 * Read a skill folder recursively into { repoPath: content }. Used at dispatch
 * to hand the runner the opted-in skills. Enforces the size caps so a large
 * skill can't blow the subprocess env. Binary files aren't supported (skills
 * are text: SKILL.md, scripts, references) — they round-trip as UTF-8.
 */
export async function readSkillFolder(
  token: string,
  ref: RepoRef,
  name: string,
): Promise<
  | { ok: true; files: SkillFiles }
  | { ok: false; detail: string; sourceError?: GitHubFileError }
> {
  const root = `${SKILLS_DIR}/${name}`;
  const files: SkillFiles = {};
  let total = 0;

  async function walk(
    path: string,
    depth: number,
  ): Promise<{ detail: string; sourceError?: GitHubFileError } | null> {
    if (depth > MAX_DEPTH) return null;
    const listing = await listDirectory(token, ref, path);
    if (!listing.ok) {
      return {
        detail: listing.detail ?? listing.error,
        sourceError: listing.error,
      };
    }
    if ("missing" in listing && listing.missing) {
      return depth === 0
        ? { detail: `skill folder "${root}" not found` }
        : null;
    }
    for (const entry of listing.entries) {
      if (entry.type === "dir") {
        const err = await walk(entry.path, depth + 1);
        if (err) return err;
      } else if (entry.type === "file") {
        if (entry.size > SKILL_FILE_MAX_BYTES) {
          return {
            detail: `"${entry.path}" exceeds the ${SKILL_FILE_MAX_BYTES}-byte file limit`,
          };
        }
        const file = await readFile(token, ref, entry.path);
        if (!file.ok) {
          return {
            detail: file.detail ?? file.error,
            sourceError: file.error,
          };
        }
        total += file.content.length;
        if (total > SKILL_TOTAL_MAX_BYTES) {
          return {
            detail: `skill "${name}" exceeds the ${SKILL_TOTAL_MAX_BYTES}-byte total limit`,
          };
        }
        files[entry.path] = file.content;
      }
    }
    return null;
  }

  const err = await walk(root, 0);
  if (err) return { ok: false, ...err };
  if (!files[`${root}/SKILL.md`]) {
    return { ok: false, detail: `skill "${name}" has no SKILL.md` };
  }
  return { ok: true, files };
}

export type InstallSkillResult =
  | { ok: true; name: string; fileCount: number }
  | { ok: false; error: string };

/**
 * Commit a skill's files under skills/<name>/. `files` is keyed by path
 * *within* the skill (e.g. "SKILL.md", "scripts/run.py"). Mirrors
 * ensureGuidanceFiles: create-or-update per file, so re-installing overwrites.
 * Requires a SKILL.md. Best-effort cache busting happens inside create/update.
 */
export async function installSkillFiles(
  workspaceId: string,
  name: string,
  files: SkillFiles,
): Promise<InstallSkillResult> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    return { ok: false, error: "Skill name must be lowercase letters, digits, and hyphens." };
  }
  const entries = Object.entries(files);
  if (!entries.some(([p]) => p === "SKILL.md" || p.endsWith("/SKILL.md"))) {
    return { ok: false, error: "Skill bundle has no SKILL.md at its root." };
  }

  const repo = await getWorkspaceRepo(workspaceId);
  if (!repo) return { ok: false, error: "No GitHub repository connected." };
  const token = await getWorkspaceSecretPlaintext(workspaceId, "github_pat");
  const ref = repoRefFor(repo);

  let committed = 0;
  for (const [rel, content] of entries) {
    // `rel` is skill-root-relative (e.g. "SKILL.md", "scripts/run.py") — the
    // importers strip any zip top-dir. Just clean a leading "./".
    const within = rel.replace(/^(\.\/)+/, "");
    const path = `${SKILLS_DIR}/${name}/${within}`;
    const existing = await readFile(token, ref, path);
    if (existing.ok) {
      if (existing.content === content) {
        committed++;
        continue;
      }
      const up = await updateFile(token, ref, path, {
        content,
        message: `Update ${path} (skill ${name})`,
        sha: existing.sha,
      });
      if (!up.ok) return { ok: false, error: `Failed to write ${path}: ${up.error}` };
    } else if (existing.error === "not-found") {
      const cr = await createFile(token, ref, path, {
        content,
        message: `Add ${path} (skill ${name})`,
      });
      if (!cr.ok) return { ok: false, error: `Failed to write ${path}: ${cr.error}` };
    } else {
      return { ok: false, error: `Couldn't read ${path}: ${existing.error}` };
    }
    committed++;
  }
  return { ok: true, name, fileCount: committed };
}

export type RemoveSkillResult =
  | { ok: true; name: string; deleted: number }
  | { ok: false; error: string };

/** Delete every file under skills/<name>/. */
export async function removeSkill(
  workspaceId: string,
  name: string,
): Promise<RemoveSkillResult> {
  const repo = await getWorkspaceRepo(workspaceId);
  if (!repo) return { ok: false, error: "No GitHub repository connected." };
  const token = await getWorkspaceSecretPlaintext(workspaceId, "github_pat");
  const ref = repoRefFor(repo);

  const folder = await readSkillFolder(token, ref, name);
  if (!folder.ok) return { ok: false, error: folder.detail };

  let deleted = 0;
  for (const path of Object.keys(folder.files)) {
    // deleteFile needs the current sha — re-read to get it.
    const cur = await readFile(token, ref, path);
    if (!cur.ok) continue;
    const del = await deleteFile(token, ref, path, {
      sha: cur.sha,
      message: `Remove ${path} (skill ${name})`,
    });
    if (del.ok) deleted++;
  }
  return { ok: true, name, deleted };
}
