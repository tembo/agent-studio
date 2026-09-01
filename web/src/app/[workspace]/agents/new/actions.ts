"use server";

import { notFound } from "next/navigation";

import { validateAgentName } from "@/lib/agent-format";
import { FRAMEWORKS, type Framework } from "@/lib/agent-framework";
import { suggestSlug } from "@/lib/slugify";
import {
  authorizeWorkspace,
  DENIED_MESSAGE,
} from "@/lib/auth-server";
import {
  buildCreateAgentPrompt,
  createTemboTask,
  type CapError,
} from "@/lib/cap-api";
import { buildPromptConnectionContext } from "@/lib/prompt-connections";
import { suggestScheduleFromDescription } from "@/lib/schedule-parse";
import {
  createImprovement,
  improvementMarker,
  setImprovementCommitted,
  setImprovementTask,
} from "@/lib/improvements-api";
import { getAgentByName } from "@/lib/workspace-agents";
import { resolveTemboCredential } from "@/lib/tembo-credentials";
import { getWorkspaceRepo } from "@/lib/workspace";

function parseFrameworkField(raw: unknown): Framework | null {
  if (typeof raw !== "string") return null;
  return (FRAMEWORKS as readonly string[]).includes(raw)
    ? (raw as Framework)
    : null;
}

// File extension + subdirectory by framework. Inlined rather than
// exported from workspace-agents.ts because the chat-to-create path
// doesn't directly commit anything — Tembo writes the file on merge
// — so we only need the path shape here.
const FRAMEWORK_PATH: Record<Framework, { dir: string; ext: "yaml" | "json" }> = {
  "pydantic-agentspec": { dir: "pydantic-agentspec", ext: "yaml" },
  "cargo-ai": { dir: "cargo-ai", ext: "json" },
};

export type ChatCreateFormState = {
  error?: string;
  success?: {
    improvementId: string;
    taskId: string;
    htmlUrl: string;
    status: string;
    agentName: string;
    agentPath: string;
    /** Set when the description names a schedule. This is guidance only; the
     *  user must explicitly create an automation after testing the agent. */
    suggestedSchedule?: { cron: string; humanReadable: string };
  };
};

export async function createFromChatAction(
  _prev: ChatCreateFormState,
  formData: FormData,
): Promise<ChatCreateFormState> {
  const slug = String(formData.get("workspace") ?? "");
  // The name is free text (e.g. "Inbox Triage"). The filename + spec `name:`
  // identifier are a slug derived from it; the free text rides along as `title`.
  const displayName = String(formData.get("name") ?? "").trim();
  const agentSlug = suggestSlug(displayName);
  const framework = parseFrameworkField(formData.get("framework"));
  const description = String(formData.get("description") ?? "").trim();

  if (!displayName) {
    return { error: "Enter a name for the agent." };
  }
  if (!validateAgentName(agentSlug)) {
    return {
      error: "Use a name with at least two letters or numbers (for the filename).",
    };
  }
  if (!framework) {
    return { error: "Pick a framework for the new agent." };
  }
  if (!description) {
    return { error: "Describe what the agent should do before submitting." };
  }

  const auth = await authorizeWorkspace(slug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace, userId } = auth;

  const repo = await getWorkspaceRepo(workspace.id);
  if (!repo) {
    return {
      error:
        "This workspace has no GitHub repository connected. Connect one in Settings before chatting.",
    };
  }
  const temboCredential = await resolveTemboCredential(workspace.id, userId);
  if (!temboCredential) {
    return {
      error:
        "Connect your Tembo account or ask an admin to configure the workspace fallback account in Settings → Tembo Coding Agent.",
    };
  }

  // Name-collision check against the repo's current agents. Treat
  // both parsed-OK matches (by canonical name) and parse-error
  // matches (by filename base) as taken.
  const collision = await getAgentByName(workspace.id, agentSlug);
  if (collision) {
    return {
      error:
        "An agent with this name already exists in the connected repo. Pick a different name.",
    };
  }

  const { dir, ext } = FRAMEWORK_PATH[framework];
  const agentPath = `agents/${dir}/${agentSlug}.${ext}`;

  // Persist the request as an improvement row before talking to
  // Tembo so we own the id we embed in the prompt. agent_name +
  // agent_path are the *intended* values; once the PR merges, an
  // agent at that path will satisfy them. runId is null because
  // there's no prior run to anchor against.
  const row = await createImprovement({
    workspaceId: workspace.id,
    runId: null,
    agentName: agentSlug,
    agentPath,
    improvementText: description,
    kind: "create",
    delivery: workspace.commitMode,
    userId,
  });

  // Fetch the requesting user's authorized connections (Composio + native MCP)
  // so the prompt lists real slot names (not just `default`) and CAP can look
  // up native tool slugs. Tembo's coding agent reads the repo, not the TAS DB,
  // so without this it writes `name: default` even when a slot already exists.
  const prompt = buildCreateAgentPrompt({
    framework,
    agentName: agentSlug,
    title: displayName,
    agentPath,
    description,
    improvementMarker: improvementMarker(row.id),
    commitMode: workspace.commitMode,
    defaultBranch: repo.defaultBranch,
    repositoryUrl: `https://github.com/${repo.owner}/${repo.name}`,
    ...(await buildPromptConnectionContext(
      workspace.id,
      userId,
      Math.floor(Date.now() / 1000),
    )),
  });

  const res = await createTemboTask({
    apiKey: temboCredential.apiKey,
    input: {
      prompt,
      repositoryUrl: `https://github.com/${repo.owner}/${repo.name}`,
      targetBranch: repo.defaultBranch,
    },
  });
  if (!res.ok) {
    return { error: formatCapError(res.error) };
  }
  // Direct/YOLO: the change lands straight on the branch — mark it committed
  // now (the scan attaches the commit URL later). PR mode stays 'submitted'
  // until the PR is detected.
  if (workspace.commitMode === "direct") {
    await setImprovementCommitted({
      id: row.id,
      temboTaskId: res.result.taskId,
      temboTaskHtmlUrl: res.result.htmlUrl,
    });
  } else {
    await setImprovementTask({
      id: row.id,
      temboTaskId: res.result.taskId,
      temboTaskHtmlUrl: res.result.htmlUrl,
    });
  }

  const suggestedSchedule = suggestScheduleFromDescription(description);

  return {
    success: {
      improvementId: row.id,
      taskId: res.result.taskId,
      htmlUrl: res.result.htmlUrl,
      status: res.result.status,
      agentName: displayName,
      agentPath,
      ...(suggestedSchedule ? { suggestedSchedule } : {}),
    },
  };
}

function formatCapError(error: CapError): string {
  switch (error.kind) {
    case "missing_tembo_key":
      return "Connect your Tembo account or ask an admin to configure the workspace fallback account under Settings → Tembo Coding Agent.";
    case "http":
      if (error.status === 401 || error.status === 403) {
        return "Tembo rejected the API key (it may have been rotated or revoked). Update it under Settings → Tembo Coding Agent.";
      }
      return `POST ${error.url} → ${error.status}\n${error.body.slice(0, 600) || "(no body)"}`;
    case "network":
      return `Could not reach Tembo CAP: ${error.message}`;
  }
}
