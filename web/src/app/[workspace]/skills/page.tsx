import Link from "next/link";
import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  getWorkspaceBySlug,
  getWorkspaceRepo,
} from "@/lib/workspace";
import { listInstalledSkills } from "@/lib/workspace-skills";
import { listSkillOwners } from "@/lib/skill-owners";
import { IconPlusLarge } from "central-icons";

import { SkillsTable, type SkillRow } from "./skills-table";

export const dynamic = "force-dynamic";

// Agent Skills: reusable SKILL.md folders the model can load + run. They live in
// the connected repo under skills/<name>/; agents opt in via their `skills:`
// field. This page lists what's installed; adding new skills (skills.sh, .zip
// upload, Claude API import) lives behind "+ New Skill" → /skills/new.
export default async function SkillsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();

  const repo = await getWorkspaceRepo(workspace.id);
  const installed = repo ? await listInstalledSkills(workspace.id) : [];
  const owners = repo ? await listSkillOwners(workspace.id) : new Map();
  const rows: SkillRow[] = installed.map((s) => ({
    name: s.name,
    description: s.description,
    owner: owners.get(s.name) ?? null,
    href: `/${slug}/skills/${encodeURIComponent(s.name)}`,
  }));

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
          Skills
        </h1>
        <p className="text-foreground-weak text-base">
          Reusable Agent Skills (SKILL.md folders) committed to your repo under{" "}
          <code>skills/</code>. An agent opts in with a <code>skills:</code>{" "}
          field; the runner mounts them so the model can follow their
          instructions and run their scripts — locally, with any model.
        </p>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      {!repo ? (
        <div className="border-border bg-surface-raised rounded-lg border p-4 text-sm">
          <p className="text-foreground-weak">
            Connect a GitHub repository in{" "}
            <Link
              href={`/${slug}/settings/repository`}
              className="text-foreground font-medium underline underline-offset-2"
            >
              Settings → Repository
            </Link>{" "}
            — skills are stored there alongside your agents.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex justify-end">
            <Button asChild>
              <Link href={`/${slug}/skills/new`}>
                <IconPlusLarge size={16} />
                <span>New skill</span>
              </Link>
            </Button>
          </div>
          {rows.length === 0 ? (
            <div className="text-foreground-weak rounded-lg border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-sm">
              No skills installed yet.{" "}
              <Link
                href={`/${slug}/skills/new`}
                className="text-foreground font-medium hover:underline"
              >
                Add your first one →
              </Link>
            </div>
          ) : (
            <SkillsTable rows={rows} />
          )}
        </div>
      )}
    </div>
  );
}
