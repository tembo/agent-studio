"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";

import { writeAuditEvent } from "@/lib/audit-db";
import { authorizeWorkspace, DENIED_MESSAGE } from "@/lib/auth-server";
import { changeSkillOwner, listSkillOwners } from "@/lib/skill-owners";
import { readInstalledSkill } from "@/lib/workspace-skills";

import type { SkillActionState } from "./actions";

export async function changeSkillOwnerAction(
  _prev: SkillActionState,
  formData: FormData,
): Promise<SkillActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const ownerUserId = String(formData.get("ownerUserId") ?? "").trim();
  const auth = await authorizeWorkspace(slug, "viewer");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !ownerUserId) {
    return { error: "Choose a skill and a new owner." };
  }

  const isAdmin = auth.role === "workspace_admin";
  if (!isAdmin) {
    const owners = await listSkillOwners(auth.workspace.id);
    if (owners.get(name)?.userId !== auth.userId) return { error: DENIED_MESSAGE };
    if (ownerUserId === auth.userId) {
      return { error: "Choose another workspace member to transfer ownership to." };
    }
  }
  const skill = await readInstalledSkill(auth.workspace.id, name);
  if (!skill) return { error: "Skill not found." };

  const changed = await changeSkillOwner({
    workspaceId: auth.workspace.id,
    skillName: name,
    actorUserId: auth.userId,
    isAdmin,
    ownerUserId,
  });
  if (!changed) {
    return { error: "Ownership could not be changed. Refresh and choose a current workspace member." };
  }
  await writeAuditEvent({
    workspaceId: auth.workspace.id,
    actorUserId: auth.userId,
    source: "human_action",
    kind: "skill.owner_changed",
    targetType: "skill",
    targetId: name,
    agentName: null,
    payload: { ownerUserId },
  });
  revalidatePath(`/${slug}/skills`);
  revalidatePath(`/${slug}/skills/${encodeURIComponent(name)}`);
  return { message: "Skill owner updated." };
}
