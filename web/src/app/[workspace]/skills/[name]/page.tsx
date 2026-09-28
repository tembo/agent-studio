import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { Markdown } from "@/components/markdown";
import { getServerSession } from "@/lib/session";
import { listSkillOwners } from "@/lib/skill-owners";
import {
  getWorkspaceBySlug,
  getWorkspaceRole,
  listWorkspaceMembers,
} from "@/lib/workspace";
import {
  getSkillInstallSource,
  readInstalledSkill,
} from "@/lib/workspace-skills";

import { RemoveSkillForm } from "../skills-forms";
import { SkillOwnerForm } from "../skill-owner-form";

export const dynamic = "force-dynamic";

// Detail view for one installed skill: its source, full SKILL.md content, and a
// Remove button top-right. Reached by clicking a row on the Skills index.
export default async function SkillDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; name: string }>;
}) {
  const { workspace: slug, name } = await params;
  const session = await getServerSession();
  if (!session) notFound();
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();

  const [skill, source, role, owners] = await Promise.all([
    readInstalledSkill(workspace.id, name),
    getSkillInstallSource(workspace.id, name),
    getWorkspaceRole(workspace.id, session.user.id),
    listSkillOwners(workspace.id),
  ]);
  if (!skill || !role) notFound();
  const isAdmin = role === "workspace_admin";
  const owner = owners.get(name);
  const canChangeOwner = isAdmin || owner?.userId === session.user.id;
  const members = canChangeOwner ? await listWorkspaceMembers(workspace.id) : [];
  const ownerOptions = members
    .filter((member) => isAdmin || member.userId !== session.user.id)
    .map((member) => ({ userId: member.userId, name: member.name || member.email }));
  const src = describeSource(source);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <BackLink href={`/${workspace.slug}/skills`} label="Skills" />
          {isAdmin && (
            <RemoveSkillForm workspaceSlug={workspace.slug} name={skill.name} />
          )}
        </div>
        <div className="flex flex-col gap-1">
          <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
            <code>{skill.name}</code>
          </h1>
          {skill.description && (
            <p className="text-foreground-weak text-base">
              {skill.description}
            </p>
          )}
        </div>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[8rem_1fr]">
        <dt className="text-foreground-muted">Owner</dt>
        <dd className="text-foreground-weak">
          {owner?.name ?? "Unassigned"}
        </dd>
        <dt className="text-foreground-muted">Source</dt>
        <dd className="text-foreground-weak">
          {src ? (
            src.url ? (
              <a
                href={src.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-foreground underline underline-offset-2"
              >
                {src.label}
              </a>
            ) : (
              src.label
            )
          ) : (
            "—"
          )}
        </dd>
        <dt className="text-foreground-muted">Path</dt>
        <dd className="text-foreground-weak">
          <code>{skill.path}</code>
        </dd>
        <dt className="text-foreground-muted">Files</dt>
        <dd className="text-foreground-weak">{skill.fileCount}</dd>
      </dl>

      {canChangeOwner && (
        <SkillOwnerForm
          key={owner?.userId ?? "unassigned"}
          workspaceSlug={slug}
          skillName={name}
          members={ownerOptions}
        />
      )}

      <div className="flex flex-col gap-2">
        <span className="text-foreground text-sm font-medium">SKILL.md</span>
        <div className="border-border bg-surface-raised rounded-lg border px-4 py-3">
          {skill.skillMd ? (
            <Markdown>{stripFrontmatter(skill.skillMd)}</Markdown>
          ) : (
            <p className="text-foreground-muted text-sm">
              Couldn&apos;t read SKILL.md for this skill.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// Strip a leading YAML frontmatter block (--- … ---) so it doesn't render as a
// bold blob in the markdown body — the name/description it carries are already
// shown parsed at the top of the page.
function stripFrontmatter(md: string): string {
  const m = md.match(/^﻿?\s*---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/);
  return m ? md.slice(m[0].length) : md;
}

// Map the stored install source ("github:owner/repo", "skills.sh:slug",
// "upload", "claude-api") to a label + optional outbound link.
function describeSource(
  source: string | null,
): { label: string; url?: string } | null {
  if (!source) return null;
  if (source.startsWith("github:")) {
    const repo = source.slice("github:".length);
    return { label: repo, url: `https://github.com/${repo}` };
  }
  if (source.startsWith("skills.sh:")) {
    const s = source.slice("skills.sh:".length);
    return { label: `skills.sh/${s}`, url: `https://skills.sh/${s}` };
  }
  if (source === "upload") return { label: "Uploaded file" };
  if (source === "claude-api") return { label: "Claude Skills API" };
  return { label: source };
}
