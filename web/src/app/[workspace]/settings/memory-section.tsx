import { Section } from "@/components/section";
import { authorizeInstance } from "@/lib/instance";
import { authorizeWorkspace } from "@/lib/auth-server";
import { memoryRequest, type MemorySettings } from "@/lib/memory";
import { MemoryForm } from "./memory-form";

export async function MemorySection({ workspaceId, slug }: { workspaceId: string; slug: string }) {
  const membership = await authorizeWorkspace(slug);
  if (!membership.ok || membership.workspace.id !== workspaceId) return null;
  const admin = await authorizeInstance();
  let settings: MemorySettings;
  try {
    settings = await memoryRequest<MemorySettings>(workspaceId);
  } catch {
    return <Section title="Memory"><p className="text-sm text-foreground-weak">Memory status is unavailable. Agent runs are not blocked by Memory outages.</p></Section>;
  }
  if (!admin.ok) settings = { ...settings, workspaces: [], blocked: [] };
  return <Section title="Memory" description="Optional shared knowledge with durable report delivery. Multiple Studio workspaces can share one Memory workspace.">
    <MemoryForm key={`${settings.memory_workspace_id}:${settings.enabled}`} slug={slug} settings={settings} editable={admin.ok} />
  </Section>;
}
