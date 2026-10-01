"use server";

import { authorizeWorkspace, DENIED_MESSAGE } from "@/lib/auth-server";
import { searchWorkspaceMembers } from "@/lib/workspace-member-search";
import type { MemberChoice } from "@/lib/member-choice";

export type MemberSearchResult = { members: MemberChoice[]; hasMore: boolean; error?: string };

export async function searchMembersAction(workspaceSlug: string, search: string): Promise<MemberSearchResult> {
  const auth = await authorizeWorkspace(workspaceSlug, "operator");
  if (!auth.ok) return { members: [], hasMore: false, error: DENIED_MESSAGE };
  if (typeof search !== "string" || search.length > 200) {
    return { members: [], hasMore: false, error: "Use a search of 200 characters or fewer." };
  }
  return searchWorkspaceMembers(auth.workspace.id, search);
}
