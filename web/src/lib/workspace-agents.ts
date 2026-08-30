import "server-only";

import {
  baseAgentSlug,
  detectFormat,
  ownerHandle,
  parseAgentContent,
  parseAgentFile,
  type AgentConnection,
  type AgentFileFormat,
  type AgentSpec,
  type Framework,
  type ParseAgentError,
} from "@/lib/agent-format";
import {
  additionalInstructionsFile,
  guidanceFilesFor,
} from "@/lib/agent-guidance";
import { getStableVersion, setAgentOwner } from "@/lib/agent-versions";
import { db } from "@/lib/db";
import { resolveAgentReader, type AgentReader } from "@/lib/agent-source";
import {
  createFile,
  deleteFile,
  readFile,
  updateFile,
  type GitHubFileError,
  type RepoRef,
} from "@/lib/github";
import { getWorkspaceRepo, getWorkspaceSecretPlaintext } from "@/lib/workspace";
import { readSkillFolder } from "@/lib/workspace-skills";

const AGENTS_DIR = "agents";

// Where new agents are written, per framework. The repo's `agents/`
// directory uses one subfolder per supported framework so v0.3+ multi-
// file frameworks (LangGraph, Mastra, …) slot in cleanly without
// migration churn. v0.1 still *reads* agents directly under agents/
// (legacy flat layout) so existing workspaces keep working.
const FRAMEWORK_DIRS: Record<Framework, string> = {
  "pydantic-agentspec": "pydantic-agentspec",
  "cargo-ai": "cargo-ai",
};

const FRAMEWORK_DIR_VALUES = Object.values(FRAMEWORK_DIRS);

// ── Sidecar tools module ─────────────────────────────────────────────
//
// A Pydantic agent may declare `tools_module: foo.py` — a sibling Python
// file of deterministic tool functions the model can call. We resolve it
// next to the spec, read it from the repo, and thread the source through
// to the runner (which hands it to the pydantic wrapper). Pure-data
// passthrough: the web layer never executes it.

/** Hard cap so a runaway file can't blow past the subprocess env limit. */
const TOOLS_MODULE_MAX_BYTES = 256 * 1024;

/** The `tools_module` value, only meaningful for Pydantic specs. */
function specToolsModule(spec: AgentSpec): string | undefined {
  return spec.framework === "pydantic-agentspec" ? spec.toolsModule : undefined;
}

// ── Agent Skills ──────────────────────────────────────────────────────
//
// A Pydantic agent may opt into `skills: [name]` — folders under skills/<name>/
// in the repo. We read the named folders at dispatch and thread their files to
// the runner (which mounts them for pydantic-ai-skills). A declared-but-missing
// skill fails resolution, same as a missing tools_module.

const SKILLS_TOTAL_MAX_BYTES = 1024 * 1024;

function specSkills(spec: AgentSpec): string[] {
  return spec.framework === "pydantic-agentspec" ? spec.skills : [];
}

async function loadDispatchSkills(
  workspaceId: string,
  skills: string[],
): Promise<
  | { ok: true; content?: Record<string, string> }
  | { ok: false; detail: string; sourceError?: AgentSourceError }
> {
  if (skills.length === 0) return { ok: true };
  const repo = await getWorkspaceRepo(workspaceId);
  if (!repo) {
    return { ok: false, detail: "no connected repo", sourceError: "no-repo" };
  }
  const token = await getWorkspaceSecretPlaintext(workspaceId, "github_pat");
  const ref: RepoRef = {
    owner: repo.owner,
    name: repo.name,
    branch: repo.defaultBranch,
  };
  const content: Record<string, string> = {};
  let total = 0;
  for (const name of skills) {
    const folder = await readSkillFolder(token, ref, name);
    if (!folder.ok) {
      return {
        ok: false,
        detail: `skill "${name}": ${folder.detail}`,
        sourceError: folder.sourceError,
      };
    }
    for (const [path, body] of Object.entries(folder.files)) {
      total += body.length;
      if (total > SKILLS_TOTAL_MAX_BYTES) {
        return { ok: false, detail: "declared skills exceed the size limit" };
      }
      content[path] = body;
    }
  }
  return { ok: true, content };
}

/** Resolve a bare filename in the same directory as the agent file. */
function siblingPath(agentPath: string, filename: string): string {
  const slash = agentPath.lastIndexOf("/");
  const dir = slash >= 0 ? agentPath.slice(0, slash + 1) : "";
  return `${dir}${filename}`;
}

async function readToolsModuleContent(
  reader: AgentReader,
  agentPath: string,
  toolsModule: string,
): Promise<
  | { ok: true; content: string }
  | { ok: false; detail: string; sourceError?: AgentSourceError }
> {
  const path = siblingPath(agentPath, toolsModule);
  const read = await reader.readFile(path);
  if (!read.ok) {
    return {
      ok: false,
      detail:
        read.error === "not-found"
          ? `referenced tools module "${path}" was not found in the repo`
          : (read.detail ?? read.error),
      sourceError: read.error === "not-found" ? undefined : read.error,
    };
  }
  if (read.content.length > TOOLS_MODULE_MAX_BYTES) {
    return {
      ok: false,
      detail: `tools module "${path}" exceeds the ${TOOLS_MODULE_MAX_BYTES}-byte limit`,
    };
  }
  return { ok: true, content: read.content };
}

/**
 * Strictly loads a declared tools module at dispatch time.
 * If no module is declared, returns success with no content.
 * If a module is declared but cannot be read, returns an error instead of
 * silently dropping tools.
 *
 * @param workspaceId Workspace identifier used to resolve repo and token.
 * @param agentPath Path to the agent spec file in the repository.
 * @param toolsModule Optional tools module filename declared by the spec.
 * @returns `{ ok: true, content?: string }` when loading is not required or succeeds;
 * otherwise `{ ok: false, detail: string }` with a user-facing failure reason.
 */
async function loadDispatchToolsModule(
  workspaceId: string,
  agentPath: string,
  toolsModule: string | undefined,
): Promise<
  | { ok: true; content?: string }
  | { ok: false; detail: string; sourceError?: AgentSourceError }
> {
  if (!toolsModule) return { ok: true };
  const reader = await resolveAgentReader(workspaceId);
  if (!reader) {
    return { ok: false, detail: "no connected repo", sourceError: "no-repo" };
  }
  const res = await readToolsModuleContent(reader, agentPath, toolsModule);
  if (!res.ok) return res;
  return { ok: true, content: res.content };
}

export type ListedAgent =
  | {
      filename: string;
      path: string;
      format: AgentFileFormat;
      ok: true;
      spec: AgentSpec;
    }
  | {
      filename: string;
      path: string;
      format: AgentFileFormat | null;
      ok: false;
      error: ParseAgentError;
      detail?: string;
    };

export type ListAgentsResult =
  | { ok: true; agents: ListedAgent[] }
  | { ok: false; error: GitHubFileError | "no-repo"; detail?: string };

type AgentSourceError = GitHubFileError | "no-repo";

type AgentRecord = {
  agent: ListedAgent;
  raw: string;
  /** Source of the declared tools module, when present and readable. */
  toolsModuleContent?: string;
  /** Files from the agent's opted-in skills, when present and readable. */
  skillsContent?: Record<string, string>;
};

type AgentLookupResult =
  | { ok: true; found: AgentRecord | null }
  | { ok: false; error: AgentSourceError; detail?: string };

/**
 * Walk the connected repo's `agents/` tree and parse every file we find.
 *
 *   agents/pydantic-agentspec/   one Pydantic AgentSpec file per agent
 *   agents/cargo-ai/             one Cargo AI JSON file per agent
 *
 * Only the framework subfolders are read. Files placed directly at
 * `agents/foo.yaml` are ignored — move them into the right subfolder.
 * Invalid files are surfaced inline with their parser error rather than
 * silently filtered (US-0.1-05 explicitly rejects "silent failure").
 */
export async function listAgents(workspaceId: string): Promise<ListAgentsResult> {
  const reader = await resolveAgentReader(workspaceId);
  if (!reader) return { ok: false, error: "no-repo" };

  // Walk each framework subfolder. Missing subfolders are normal (a
  // fresh repo won't have an agents/cargo-ai/ directory yet) — those
  // surface as `entries: []` from listDirectory's `missing: true` path.
  const subfolderListings = await Promise.all(
    FRAMEWORK_DIR_VALUES.map((dir) =>
      reader.listDirectory(`${AGENTS_DIR}/${dir}`),
    ),
  );

  for (const sub of subfolderListings) {
    if (!sub.ok) {
      return { ok: false, error: sub.error, detail: sub.detail };
    }
  }

  const allEntries = subfolderListings.flatMap((sub) =>
    sub.ok
      ? sub.entries.filter(
          (e) => e.type === "file" && detectFormat(e.name) !== null,
        )
      : [],
  );

  const agents = await Promise.all(
    allEntries.map(async (entry): Promise<ListedAgent> => {
      const read = await reader.readFile(entry.path);
      if (!read.ok) {
        return {
          filename: entry.name,
          path: entry.path,
          format: detectFormat(entry.name),
          ok: false,
          error: "invalid-yaml",
          detail: read.detail ?? read.error,
        };
      }
      const parsed = parseAgentFile(entry.name, read.content);
      if (!parsed.ok) {
        return {
          filename: entry.name,
          path: entry.path,
          format: detectFormat(entry.name),
          ok: false,
          error: parsed.error,
          detail: parsed.detail,
        };
      }
      return {
        filename: entry.name,
        path: entry.path,
        format: parsed.format,
        ok: true,
        spec: parsed.spec,
      };
    }),
  );

  // Stable order: valid first (by name), then invalid (by filename).
  agents.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    const an = a.ok ? a.spec.name : a.filename;
    const bn = b.ok ? b.spec.name : b.filename;
    return an.localeCompare(bn);
  });

  return { ok: true, agents };
}

/**
 * Find one agent by its declared name while preserving repository failures:
 *  - the agent (valid or invalid) if a file in agents/** parses to that name
 *  - the invalid file if its filename basename matches (so broken specs
 *    are still inspectable on the detail page)
 *  - a successful null result only when the repository was read successfully
 */
async function lookupAgentByName(
  workspaceId: string,
  agentName: string,
): Promise<AgentLookupResult> {
  const list = await listAgents(workspaceId);
  if (!list.ok) return list;

  const match = list.agents.find((a) => {
    if (a.ok) return a.spec.name === agentName;
    const base = a.filename.replace(/\.(yaml|yml|json)$/i, "");
    return base === agentName;
  });
  if (!match) return { ok: true, found: null };

  const reader = await resolveAgentReader(workspaceId);
  if (!reader) return { ok: false, error: "no-repo" };
  const read = await reader.readFile(match.path);
  if (!read.ok) {
    if (read.error === "not-found") return { ok: true, found: null };
    return { ok: false, error: read.error, detail: read.detail };
  }

  let toolsModuleContent: string | undefined;
  const toolsModule = match.ok ? specToolsModule(match.spec) : undefined;
  if (toolsModule) {
    const mod = await readToolsModuleContent(reader, match.path, toolsModule);
    if (mod.ok) toolsModuleContent = mod.content;
  }

  let skillsContent: Record<string, string> | undefined;
  const skills = match.ok ? specSkills(match.spec) : [];
  if (skills.length > 0) {
    const loaded = await loadDispatchSkills(workspaceId, skills);
    if (loaded.ok) skillsContent = loaded.content;
  }

  return {
    ok: true,
    found: {
      agent: match,
      raw: read.content,
      toolsModuleContent,
      skillsContent,
    },
  };
}

/** Best-effort nullable lookup for interactive paths that predate typed errors. */
export async function getAgentByName(
  workspaceId: string,
  agentName: string,
): Promise<AgentRecord | null> {
  const result = await lookupAgentByName(workspaceId, agentName);
  return result.ok ? result.found : null;
}

// ────────────────────────────────────────────────────────────────────
// Dispatch resolution: pick the spec a run should execute.
//
// Runs default to the agent's current STABLE snapshot (frozen in Postgres
// at promotion time) and only use the live DRAFT file when explicitly
// asked, or when the agent has never been promoted (fallback — so nothing
// breaks before the first promotion). This is the single choke point all
// five dispatch paths call; it also centralizes the parse/model/format
// validation those call sites used to duplicate.

export type ResolvedDispatch = {
  agentName: string;
  agentPath: string;
  framework: Framework;
  model: string;
  specContent: string;
  specFormat: AgentFileFormat;
  /** agent_version.id when running a stable snapshot; null for draft. */
  versionId: string | null;
  /** Human label for the run row / UI: "v3" or "draft". */
  versionLabel: string;
  /** Source of the agent's `tools_module` sibling, if declared. The
   *  module is read live from the default branch (not snapshotted with
   *  the version yet); a declared-but-missing module fails resolution. */
  toolsModuleContent?: string;
  /** Files of the skills the agent opts into, as { repoPath: content }
   *  (e.g. "skills/pdf/SKILL.md"). Read live from the default branch, like
   *  tools_module; a declared-but-missing skill fails resolution. */
  skillsContent?: Record<string, string>;
  /** External services the agent declares (Pydantic only; [] otherwise).
   *  Used to pre-flight the acting user's connections before a run. */
  connections: AgentConnection[];
};

export type ResolveDispatchError =
  | { kind: "not-found"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "no-model"; message: string }
  | {
      kind: "source-unavailable";
      message: string;
      sourceError: AgentSourceError;
      retryable: boolean;
    };

export type ResolveDispatchResult =
  | { ok: true; resolved: ResolvedDispatch }
  | { ok: false; error: ResolveDispatchError };

function sourceUnavailable(
  error: AgentSourceError,
  detail?: string,
): Extract<ResolveDispatchError, { kind: "source-unavailable" }> {
  const retryable = error === "network" || error === "rate-limited";
  const reason =
    error === "rate-limited"
      ? "GitHub rate-limited the request"
      : error === "invalid-token"
        ? "the GitHub token is no longer valid"
        : error === "no-repo"
          ? "no repository is connected"
          : detail || "the repository could not be reached";
  return {
    kind: "source-unavailable",
    message: `Could not read the connected agent repository: ${reason}.`,
    sourceError: error,
    retryable,
  };
}

export async function resolveAgentForDispatch(
  workspaceId: string,
  agentName: string,
  opts: { preferDraft?: boolean } = {},
): Promise<ResolveDispatchResult> {
  // Default path: serve the current stable snapshot if one exists.
  if (!opts.preferDraft) {
    const stable = await getStableVersion(workspaceId, agentName);
    if (stable) {
      if (!stable.model) {
        return {
          ok: false,
          error: {
            kind: "no-model",
            message: `Stable v${stable.versionNumber} of "${agentName}" has no model declared.`,
          },
        };
      }
      // The version snapshot froze the spec, but not the sibling `.py`
      // (v1) — re-read the declared module from the live default branch.
      const stableParsed = parseAgentContent(
        stable.specContent,
        stable.specFormat,
      );
      const stableToolsModule = stableParsed.ok
        ? specToolsModule(stableParsed.spec)
        : undefined;
      const stableMod = await loadDispatchToolsModule(
        workspaceId,
        stable.agentPath,
        stableToolsModule,
      );
      if (!stableMod.ok) {
        if (stableMod.sourceError) {
          return {
            ok: false,
            error: sourceUnavailable(stableMod.sourceError, stableMod.detail),
          };
        }
        return {
          ok: false,
          error: {
            kind: "invalid",
            message: `Agent "${agentName}" declares a tools_module that couldn't be loaded: ${stableMod.detail}`,
          },
        };
      }
      const stableSkills = await loadDispatchSkills(
        workspaceId,
        stableParsed.ok ? specSkills(stableParsed.spec) : [],
      );
      if (!stableSkills.ok) {
        if (stableSkills.sourceError) {
          return {
            ok: false,
            error: sourceUnavailable(
              stableSkills.sourceError,
              stableSkills.detail,
            ),
          };
        }
        return {
          ok: false,
          error: {
            kind: "invalid",
            message: `Agent "${agentName}" opts into a skill that couldn't be loaded: ${stableSkills.detail}`,
          },
        };
      }
      return {
        ok: true,
        resolved: {
          agentName: stable.agentName,
          agentPath: stable.agentPath,
          framework: stable.framework,
          model: stable.model,
          specContent: stable.specContent,
          specFormat: stable.specFormat,
          versionId: stable.id,
          versionLabel: `v${stable.versionNumber}`,
          toolsModuleContent: stableMod.content,
          skillsContent: stableSkills.content,
          connections:
            stableParsed.ok &&
            stableParsed.spec.framework === "pydantic-agentspec"
              ? stableParsed.spec.connections
              : [],
        },
      };
    }
    // No stable version yet → fall through to the live file.
  }

  // Draft / fallback path: the live default-branch file.
  const lookup = await lookupAgentByName(workspaceId, agentName);
  if (!lookup.ok) {
    return {
      ok: false,
      error: sourceUnavailable(lookup.error, lookup.detail),
    };
  }
  if (!lookup.found) {
    return {
      ok: false,
      error: {
        kind: "not-found",
        message: `Agent "${agentName}" is no longer in the connected repo.`,
      },
    };
  }
  const found = lookup.found;
  if (!found.agent.ok) {
    return {
      ok: false,
      error: {
        kind: "invalid",
        message: `Agent file failed to parse: ${found.agent.error}${found.agent.detail ? ` — ${found.agent.detail}` : ""}`,
      },
    };
  }
  const spec = found.agent.spec;
  const model = spec.model ?? "";
  if (!model) {
    return {
      ok: false,
      error: {
        kind: "no-model",
        message: `Agent "${agentName}" has no model declared. Add a model and try again.`,
      },
    };
  }
  const mod = await loadDispatchToolsModule(
    workspaceId,
    found.agent.path,
    specToolsModule(spec),
  );
  if (!mod.ok) {
    if (mod.sourceError) {
      return {
        ok: false,
        error: sourceUnavailable(mod.sourceError, mod.detail),
      };
    }
    return {
      ok: false,
      error: {
        kind: "invalid",
        message: `Agent "${agentName}" declares a tools_module that couldn't be loaded: ${mod.detail}`,
      },
    };
  }
  const skills = await loadDispatchSkills(workspaceId, specSkills(spec));
  if (!skills.ok) {
    if (skills.sourceError) {
      return {
        ok: false,
        error: sourceUnavailable(skills.sourceError, skills.detail),
      };
    }
    return {
      ok: false,
      error: {
        kind: "invalid",
        message: `Agent "${agentName}" opts into a skill that couldn't be loaded: ${skills.detail}`,
      },
    };
  }
  return {
    ok: true,
    resolved: {
      agentName: spec.name,
      agentPath: found.agent.path,
      framework: spec.framework,
      model,
      specContent: found.raw,
      specFormat: found.agent.format,
      versionId: null,
      versionLabel: "draft",
      toolsModuleContent: mod.content,
      skillsContent: skills.content,
      connections:
        spec.framework === "pydantic-agentspec" ? spec.connections : [],
    },
  };
}

/**
 * Best-effort guidance-file bootstrap and refresh.
 *
 * For each TAS-managed guidance file:
 * - missing: create it
 * - present with matching content: leave it unchanged
 * - present with differing content (older TAS version or hand-edit drift):
 *   update it in place with a stamped commit message
 *
 * Network/auth failures are intentionally swallowed so transient issues
 * never block an agent commit; the refresh-first protocol in cap-api
 * will catch anything missed here.
 *
 * @param token GitHub auth token used for repository file operations.
 * @param ref Repository owner/name/ref context.
 * @param framework Framework used to determine required guidance files.
 * @returns Resolves when best-effort guidance synchronization completes.
 */
async function ensureGuidanceFiles(
  token: string,
  ref: RepoRef,
  framework: Framework,
): Promise<void> {
  // TAS-managed files (root AGENTS.md + agents/ subdir guides):
  // refresh on content drift so a workspace stays current with the
  // studio it's connected to.
  for (const file of guidanceFilesFor(framework)) {
    try {
      const existing = await readFile(token, ref, file.path);
      if (!existing.ok) {
        if (existing.error === "not-found") {
          await createFile(token, ref, file.path, {
            content: file.content,
            message: `Add ${file.path} (TAS agent authoring guide)`,
          });
        }
        // network / invalid-token / etc. — skip, try again on the
        // next agent commit
        continue;
      }
      if (existing.content === file.content) continue;
      await updateFile(token, ref, file.path, {
        content: file.content,
        message: `Refresh ${file.path} (TAS agent authoring guide)`,
        sha: existing.sha,
      });
    } catch {
      // ignore — guidance is a nice-to-have, not blocking
    }
  }

  // Customer-managed file: created once with a starter template, then
  // never touched again. This is where the customer adds project-
  // specific overrides that layer on top of the TAS defaults.
  await ensureAdditionalInstructionsFile(token, ref);
}

/**
 * Ensures the customer-managed additional-instructions file exists.
 *
 * Unlike TAS-managed guidance files, this file is created only if missing
 * and is never updated afterward so customer customizations are preserved.
 * Any read/create failures are treated as best-effort and are retried by
 * future sync/commit flows.
 */
async function ensureAdditionalInstructionsFile(
  token: string,
  ref: RepoRef,
): Promise<void> {
  try {
    const file = additionalInstructionsFile();
    const existing = await readFile(token, ref, file.path);
    if (existing.ok) return; // already exists; this file is customer-owned, never overwrite
    if (existing.error !== "not-found") return; // network/auth — try again later
    await createFile(token, ref, file.path, {
      content: file.content,
      message: `Add ${file.path} (TAS customization slot)`,
    });
  } catch {
    // best-effort
  }
}

// Public form of the same bootstrap, runnable on demand (e.g. from
// a "Sync guidance" button in workspace settings). Always writes
// both frameworks' guides so a workspace using both gets fully
// caught up in one call.
export async function refreshAllGuidanceFiles(
  workspaceId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const repo = await getWorkspaceRepo(workspaceId);
  if (!repo) return { ok: false, error: "no-repo" };
  const token = await getWorkspaceSecretPlaintext(workspaceId, "github_pat");
  const ref: RepoRef = {
    owner: repo.owner,
    name: repo.name,
    branch: repo.defaultBranch,
  };
  // Run the per-framework path twice to cover both guides (the index
  // is shared; idempotent skip handles it the second time).
  await ensureGuidanceFiles(token, ref, "pydantic-agentspec");
  await ensureGuidanceFiles(token, ref, "cargo-ai");
  return { ok: true };
}

// ── Delete + restore ─────────────────────────────────────────────────────

export type DeleteAgentError =
  | "no-repo"
  | "not-found"
  | GitHubFileError
  | "sha-mismatch";

export type DeleteAgentResult =
  | { ok: true; commitSha: string }
  | { ok: false; error: DeleteAgentError; detail?: string };

export async function deleteAgent(
  workspaceId: string,
  userId: string,
  agentName: string,
): Promise<DeleteAgentResult> {
  const repo = await getWorkspaceRepo(workspaceId);
  if (!repo) return { ok: false, error: "no-repo" };

  const found = await getAgentByName(workspaceId, agentName);
  if (!found) return { ok: false, error: "not-found" };

  const token = await getWorkspaceSecretPlaintext(workspaceId, "github_pat");
  const ref: RepoRef = {
    owner: repo.owner,
    name: repo.name,
    branch: repo.defaultBranch,
  };

  const read = await readFile(token, ref, found.agent.path);
  if (!read.ok) {
    return {
      ok: false,
      error: read.error,
      detail: read.detail,
    };
  }

  const del = await deleteFile(token, ref, found.agent.path, {
    sha: read.sha,
    message: `Delete agent: ${agentName}`,
  });
  if (!del.ok) return { ok: false, error: del.error, detail: del.detail };

  await db.query(
    `INSERT INTO workspace_agent_deletion
       (workspace_id, agent_name, file_path, content_snapshot,
        deletion_commit_sha, deleted_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      workspaceId,
      agentName,
      found.agent.path,
      read.content,
      del.commitSha,
      userId,
    ],
  );

  return { ok: true, commitSha: del.commitSha };
}

export type DeletedAgent = {
  id: string;
  agentName: string;
  filePath: string;
  deletionCommitSha: string;
  deletedAt: Date;
  deletedBy: string;
};

export async function listDeletedAgents(
  workspaceId: string,
): Promise<DeletedAgent[]> {
  const { rows } = await db.query<{
    id: string;
    agent_name: string;
    file_path: string;
    deletion_commit_sha: string;
    deleted_at: Date;
    deleted_by: string;
  }>(
    `SELECT id, agent_name, file_path, deletion_commit_sha,
            deleted_at, deleted_by
       FROM workspace_agent_deletion
      WHERE workspace_id = $1 AND restored_at IS NULL
      ORDER BY deleted_at DESC`,
    [workspaceId],
  );
  return rows.map((r) => ({
    id: r.id,
    agentName: r.agent_name,
    filePath: r.file_path,
    deletionCommitSha: r.deletion_commit_sha,
    deletedAt: r.deleted_at,
    deletedBy: r.deleted_by,
  }));
}

export type RestoreAgentError =
  | "no-repo"
  | "not-found"
  | "already-restored"
  | GitHubFileError;

export type RestoreAgentResult =
  | { ok: true; commitSha: string; agentName: string }
  | { ok: false; error: RestoreAgentError; detail?: string };

export async function restoreAgent(
  workspaceId: string,
  userId: string,
  deletionId: string,
): Promise<RestoreAgentResult> {
  const repo = await getWorkspaceRepo(workspaceId);
  if (!repo) return { ok: false, error: "no-repo" };

  const { rows } = await db.query<{
    agent_name: string;
    file_path: string;
    content_snapshot: string;
    restored_at: Date | null;
  }>(
    `SELECT agent_name, file_path, content_snapshot, restored_at
       FROM workspace_agent_deletion
      WHERE id = $1 AND workspace_id = $2`,
    [deletionId, workspaceId],
  );
  const row = rows[0];
  if (!row) return { ok: false, error: "not-found" };
  if (row.restored_at) return { ok: false, error: "already-restored" };

  const token = await getWorkspaceSecretPlaintext(workspaceId, "github_pat");
  const ref: RepoRef = {
    owner: repo.owner,
    name: repo.name,
    branch: repo.defaultBranch,
  };

  const create = await createFile(token, ref, row.file_path, {
    content: row.content_snapshot,
    message: `Restore agent: ${row.agent_name}`,
  });
  if (!create.ok) {
    return { ok: false, error: create.error, detail: create.detail };
  }

  await db.query(
    `UPDATE workspace_agent_deletion
       SET restored_at = NOW(),
           restored_by = $1,
           restore_commit_sha = $2
       WHERE id = $3`,
    [userId, create.commitSha, deletionId],
  );

  return {
    ok: true,
    commitSha: create.commitSha,
    agentName: row.agent_name,
  };
}

export type ForkAgentResult =
  | { ok: true; commitSha: string; agentName: string; agentPath: string }
  | {
      ok: false;
      error: GitHubFileError | "no-repo" | "not-found" | "invalid-source";
      detail?: string;
    };

/**
 * Fork an agent into the current user's owner-namespaced copy. Reads the source
 * spec, computes a unique `<handle>.<base-slug>` name (deduped), writes the new
 * file (the source content with only `name:` swapped) via a direct commit —
 * mirroring restoreAgent — and sets the forker as owner so it lands in their
 * "Mine + Starred" view. Requires a connected repo (writes are repo-only).
 *
 * The fork keeps the same `tools_module:` filename, which resolves to the same
 * sibling `.py` (both live in agents/<framework>/) — so a tool-using agent forks
 * and runs without copying the module.
 */
export async function forkAgent(
  workspaceId: string,
  userId: string,
  userEmail: string,
  sourceName: string,
): Promise<ForkAgentResult> {
  const repo = await getWorkspaceRepo(workspaceId);
  if (!repo) return { ok: false, error: "no-repo" };

  const found = await getAgentByName(workspaceId, sourceName);
  if (!found || !found.agent.ok) return { ok: false, error: "not-found" };

  // dir + ext from the source path (agents/<framework>/<name>.<ext>).
  const slash = found.agent.path.lastIndexOf("/");
  const dirPart = slash >= 0 ? found.agent.path.slice(0, slash) : "agents";
  const ext = (found.agent.path.match(/\.([^./]+)$/)?.[1] ?? "yaml").toLowerCase();
  const format = detectFormat(found.agent.path);
  if (!format) return { ok: false, error: "invalid-source" };

  // Unique owner-prefixed name: <handle>.<base>, then -2, -3 … if taken.
  const handle = ownerHandle(userEmail);
  const base = baseAgentSlug(found.agent.spec.name);
  let target = `${handle}.${base}`;
  for (let n = 2; await getAgentByName(workspaceId, target); n++) {
    target = `${handle}.${base}-${n}`;
  }

  const content = renameInSpec(found.raw, format, target);
  const token = await getWorkspaceSecretPlaintext(workspaceId, "github_pat");
  const ref: RepoRef = {
    owner: repo.owner,
    name: repo.name,
    branch: repo.defaultBranch,
  };
  const targetPath = `${dirPart}/${target}.${ext}`;
  const create = await createFile(token, ref, targetPath, {
    content,
    message: `Fork agent ${sourceName} → ${target}`,
  });
  if (!create.ok) return { ok: false, error: create.error, detail: create.detail };

  await setAgentOwner(workspaceId, target, userId, userId);
  return {
    ok: true,
    commitSha: create.commitSha,
    agentName: target,
    agentPath: targetPath,
  };
}

// Swap the top-level `name:` in a spec's raw text, format-aware (the rest of the
// source is copied verbatim — comments, tools_module, skills all preserved).
function renameInSpec(
  raw: string,
  format: AgentFileFormat,
  target: string,
): string {
  return format === "json"
    ? raw.replace(/("name"\s*:\s*)"[^"]*"/, `$1"${target}"`)
    : raw.replace(/^name:[ \t]*.*$/m, `name: ${target}`);
}
