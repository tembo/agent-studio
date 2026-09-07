import "server-only";

export type MemorySettings = {
  configured: boolean;
  warning: string | null;
  enabled: boolean;
  memory_workspace_id: string;
  default_workspace_id: string;
  workspaces: { id: string; name: string }[];
  counts: Record<string, number>;
  blocked: { id: string; memory_workspace_id: string; error: string }[];
};

export async function memoryRequest<T>(workspaceId: string, method = "GET", body?: unknown, retry = false): Promise<T> {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) throw new Error("Studio API is not configured");
  const origin = process.env.API_INTERNAL_URL ?? "http://localhost:8080";
  const response = await fetch(`${origin}/internal/memory/workspaces/${encodeURIComponent(workspaceId)}${retry ? "/retry" : ""}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) throw new Error("Memory settings could not be loaded or saved. Check the API and Memory connection.");
  return response.json() as Promise<T>;
}
