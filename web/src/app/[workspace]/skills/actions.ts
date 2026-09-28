"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { exportAnthropicSkill } from "@/lib/anthropic-skills";
import { writeAuditEvent } from "@/lib/audit-db";
import { authorizeWorkspace, DENIED_MESSAGE } from "@/lib/auth-server";
import { unzipSkillBundle } from "@/lib/skill-bundle";
import { recordSkillOwner, removeSkillOwner } from "@/lib/skill-owners";
import { fetchSkillFromGitHub, parseSkillRef } from "@/lib/skillssh";
import {
  downloadSkillSh,
  searchSkillsSh,
  type SkillsShEntry,
} from "@/lib/skillssh-api";
import { suggestSlug } from "@/lib/slugify";
import { getWorkspaceSecretPlaintext } from "@/lib/workspace";
import {
  installSkillFiles,
  parseSkillFrontmatter,
  removeSkill,
  type SkillFiles,
} from "@/lib/workspace-skills";

export type SkillActionState = { message?: string; error?: string };

// Name a skill from its SKILL.md `name` (slugified), falling back to a source
// hint. The folder under skills/<name>/ is what an agent references.
function deriveSkillName(files: SkillFiles, fallback?: string): string | null {
  const fm = files["SKILL.md"] ? parseSkillFrontmatter(files["SKILL.md"]) : null;
  const slug = suggestSlug(fm?.title ?? fallback ?? "");
  return slug || null;
}

async function commitSkill(
  workspaceId: string,
  userId: string,
  slug: string,
  name: string,
  files: SkillFiles,
  source: string,
): Promise<SkillActionState> {
  const res = await installSkillFiles(workspaceId, name, files);
  if (!res.ok) return { error: res.error };
  await recordSkillOwner(workspaceId, name, userId);
  await writeAuditEvent({
    workspaceId,
    actorUserId: userId,
    source: "human_action",
    kind: "skill.installed",
    targetType: "skill",
    targetId: name,
    agentName: null,
    payload: { name, source, fileCount: res.fileCount },
  });
  revalidatePath(`/${slug}/skills`);
  return { message: `Installed skill "${name}" (${res.fileCount} files).` };
}

// Install from the skills.sh directory / a GitHub folder (owner/repo[/path]).
export async function installFromGitHubAction(
  _prev: SkillActionState,
  formData: FormData,
): Promise<SkillActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const ref = String(formData.get("ref") ?? "").trim();

  const auth = await authorizeWorkspace(slug, "workspace_admin");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  if (!ref) return { error: "Enter a skills.sh slug or GitHub URL." };

  const parsed = parseSkillRef(ref);
  if (!parsed) {
    return { error: "Couldn't parse that — use owner/repo[/path] or a GitHub URL." };
  }
  // Public-repo read; the workspace token (if any) lifts the rate limit.
  const token = await getWorkspaceSecretPlaintext(auth.workspace.id, "github_pat");
  const fetched = await fetchSkillFromGitHub(parsed, token ?? undefined);
  if (!fetched.ok) return { error: fetched.error };

  const name =
    deriveSkillName(fetched.files, parsed.path.split("/").pop() || parsed.repo);
  if (!name) return { error: "Couldn't determine a skill name from SKILL.md." };
  return commitSkill(auth.workspace.id, auth.userId, slug, name, fetched.files, `github:${parsed.owner}/${parsed.repo}`);
}

// Live search of the skills.sh directory (membership-gated proxy, read-only).
export type SearchSkillsResult =
  | { ok: true; skills: SkillsShEntry[] }
  | { ok: false; error: string };

export async function searchSkillsShAction(
  workspaceSlug: string,
  query: string,
): Promise<SearchSkillsResult> {
  const auth = await authorizeWorkspace(workspaceSlug, "viewer");
  if (!auth.ok) {
    if (auth.reason === "denied") return { ok: false, error: DENIED_MESSAGE };
    notFound();
  }
  return searchSkillsSh(query);
}

// Install a skill from the skills.sh directory (downloads its files + commits).
export async function installFromSkillsShAction(
  _prev: SkillActionState,
  formData: FormData,
): Promise<SkillActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const source = String(formData.get("source") ?? "").trim();
  const skillId = String(formData.get("skillId") ?? "").trim();

  const auth = await authorizeWorkspace(slug, "workspace_admin");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  if (!source || !skillId) return { error: "Missing skill reference." };

  const dl = await downloadSkillSh(source, skillId);
  if (!dl.ok) return { error: dl.error };

  const name = deriveSkillName(dl.files, skillId);
  if (!name) return { error: "Couldn't determine a skill name from SKILL.md." };
  return commitSkill(auth.workspace.id, auth.userId, slug, name, dl.files, `skills.sh:${source}`);
}

// Import a skill the org created via the Claude Skills API (downloads its zip).
export async function importFromAnthropicAction(
  _prev: SkillActionState,
  formData: FormData,
): Promise<SkillActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const skillId = String(formData.get("skillId") ?? "").trim();
  const hint = String(formData.get("hint") ?? "").trim();

  const auth = await authorizeWorkspace(slug, "workspace_admin");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  if (!skillId) return { error: "Pick a skill to import." };

  const apiKey = await getWorkspaceSecretPlaintext(auth.workspace.id, "anthropic_api_key");
  if (!apiKey) {
    return { error: "Set an Anthropic API key under Settings → LLM Providers first." };
  }
  const exported = await exportAnthropicSkill(apiKey, skillId);
  if (!exported.ok) return { error: exported.error };

  const name = deriveSkillName(exported.files, hint);
  if (!name) return { error: "Couldn't determine a skill name from SKILL.md." };
  return commitSkill(auth.workspace.id, auth.userId, slug, name, exported.files, "claude-api");
}

// Upload a custom skill as a .zip (SKILL.md + resources).
export async function uploadSkillAction(
  _prev: SkillActionState,
  formData: FormData,
): Promise<SkillActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const file = formData.get("bundle");

  const auth = await authorizeWorkspace(slug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a .zip bundle to upload." };
  }
  if (file.size > 2 * 1024 * 1024) {
    return { error: "Bundle exceeds the 2 MB limit." };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const unzipped = unzipSkillBundle(bytes);
  if (!unzipped.ok) return { error: unzipped.error };

  const fallback = file.name.replace(/\.zip$/i, "");
  const name = deriveSkillName(unzipped.files, fallback);
  if (!name) return { error: "Couldn't determine a skill name from SKILL.md." };
  const res = await commitSkill(auth.workspace.id, auth.userId, slug, name, unzipped.files, "upload");
  if (res.message && unzipped.skipped.length > 0) {
    return { message: `${res.message} Skipped: ${unzipped.skipped.join(", ")}.` };
  }
  return res;
}

export async function removeSkillAction(
  _prev: SkillActionState,
  formData: FormData,
): Promise<SkillActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const name = String(formData.get("name") ?? "").trim();

  const auth = await authorizeWorkspace(slug, "workspace_admin");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  if (!name) return { error: "Missing skill name." };

  const res = await removeSkill(auth.workspace.id, name);
  if (!res.ok) return { error: res.error };
  await removeSkillOwner(auth.workspace.id, name);
  await writeAuditEvent({
    workspaceId: auth.workspace.id,
    actorUserId: auth.userId,
    source: "human_action",
    kind: "skill.removed",
    targetType: "skill",
    targetId: name,
    agentName: null,
    payload: { name, deleted: res.deleted },
  });
  revalidatePath(`/${slug}/skills`);
  // Removal is triggered from the skill's detail page, which no longer resolves.
  redirect(`/${slug}/skills`);
}
