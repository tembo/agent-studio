"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { authClient } from "@/lib/auth-client";

type WorkspaceOption = { id: string; name: string; slug: string };

export function OAuthConsentCard({ workspaces }: { workspaces: WorkspaceOption[] }) {
  const [selectedId, setSelectedId] = useState(workspaces[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const selectedWorkspace = workspaces.find(({ id }) => id === selectedId);

  function decide(accept: boolean) {
    setError(null);
    startTransition(async () => {
      if (accept) {
        const selected = await fetch("/api/mcp/oauth/select-workspace", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId: selectedId }),
        });
        if (!selected.ok) {
          const payload = (await selected.json().catch(() => null)) as {
            error?: string;
          } | null;
          setError(payload?.error ?? "Could not select that workspace.");
          return;
        }
      }

      const result = await authClient.oauth2.consent({ accept });
      if (result.error) {
        setError(result.error.message ?? "Could not complete authorization.");
        return;
      }
      if (result.data?.url) window.location.href = result.data.url;
    });
  }

  return (
    <Card className="w-full max-w-md p-3">
      <CardHeader className="px-1 pb-3 pt-1">
        <CardTitle className="text-foreground-title text-base">
          Allow MCP access?
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-1 pb-1">
        {selectedWorkspace ? (
          <div className="text-foreground-weak space-y-2 text-sm">
            <p>
              The MCP client will act as you in the workspace you select.
            </p>
            <label className="text-foreground flex flex-col gap-1 text-sm">
              Workspace
              <select
                className="border-border bg-surface text-foreground h-9 rounded-md border px-3"
                value={selectedId}
                onChange={(event) => setSelectedId(event.target.value)}
                disabled={pending}
              >
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name} ({workspace.slug})
                  </option>
                ))}
              </select>
            </label>
            <ul className="list-disc space-y-1 pl-5">
              <li>Read agents, runs, tools, connections, and automations.</li>
              <li>
                Trigger runs and make changes allowed by your live workspace
                role.
              </li>
            </ul>
          </div>
        ) : (
          <p className="text-sentiment-negative text-sm" role="alert">
            No workspace was selected. Restart the connector setup and choose a
            workspace.
          </p>
        )}
        {error && (
          <p className="text-sentiment-negative text-sm" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => decide(false)}
            disabled={pending}
          >
            Deny
          </Button>
          <Button
            type="button"
            onClick={() => decide(true)}
            disabled={pending || !selectedWorkspace}
          >
            {pending ? "Authorizing…" : "Allow"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
