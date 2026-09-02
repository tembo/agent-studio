import { redirect } from "next/navigation";

import { loadAgentContext } from "../agent-page-context";

export const dynamic = "force-dynamic";

export default async function AgentCodePage({
  params,
}: {
  params: Promise<{ workspace: string; agent: string }>;
}) {
  const { workspace: slug, agent: agentName } = await params;
  const { canonicalName } = await loadAgentContext(slug, agentName);
  redirect(
    `/${slug}/agents/${encodeURIComponent(canonicalName)}/versions`,
  );
}
