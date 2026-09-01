import "server-only";

// Single-process cron scheduler that fires runs for due automations.
// Started by instrumentation.ts at Node.js boot; idempotent so the
// dev-server hot reload doesn't double-start it.
//
// Design notes (single-tenant, single-node — the deployment model
// memo this whole product is built around):
//   - One setInterval at TICK_MS resolution. Granularity is fine for
//     v0.2 ("basic recurring schedules"); sub-minute precision is
//     out of scope.
//   - Per-tick we list enabled automations and, for each, ask the
//     cron library "did anything fire after the last_fired_at floor?"
//     If yes, we fire exactly one run regardless of how many windows
//     were missed — no catch-up storm if the api was offline for an
//     hour.
//   - Run creation goes through the API's /internal/runs endpoint so
//     execution is identical to a manual run; the only difference is
//     the trigger='schedule' + automation_id columns on the run row.
//   - Permanent failures (bad cron, missing agent file, parse error)
//     are recorded on the automation row and advance the last_fired_at
//     floor so they don't retry-storm. Transient repository failures keep
//     the window due and retry with bounded exponential backoff.

import { requestAgentChangeSystem } from "@/lib/api-v1/actions";
import {
  listEnabledAutomations,
  type Automation,
} from "@/lib/automations-api";
import {
  agentResolutionFailure,
  automationServiceConfigurationFailure,
  pauseAutomationsWithMissingOwners,
  recordAutomationFailure,
  recordAutomationSuccess,
  runApiFailure,
  unexpectedDispatchFailure,
  type AutomationDispatchFailure,
} from "@/lib/automation-events";
import {
  listDueLearningConfigs,
  setAgentLearned,
  type AgentLearning,
} from "@/lib/agent-learning-api";
import { hasFiringInWindow } from "@/lib/cron";
import {
  listUnconsumedSignalsForAgent,
  markSignalsConsumed,
  type InboxAction,
  type InboxItem,
} from "@/lib/inbox-api";
import { isAgentCreatePending } from "@/lib/improvements-api";
import { resolveAgentForDispatch } from "@/lib/workspace-agents";
import { maybeReconcileToolCaches } from "@/lib/tool-reconcile";

const TICK_MS = 30_000;
const SOURCE_RETRY_MAX_MS = 15 * 60_000;
// Boot reconcile floor — a fresh process re-syncs tool caches unless one ran in
// the last 10 min. Deploys (minutes+ apart) always run; a crash-looping restart
// within 10 min doesn't re-storm provider APIs.
const RECONCILE_BOOT_FLOOR_MS = 10 * 60_000;
// Daily reconcile for long-running instances with no deploys — catches external
// (Composio / native provider) tools that change server-side.
const RECONCILE_DAILY_MS = 24 * 60 * 60_000;
// How many corrected cases to include in one batched learning prompt. Bounds
// the CAP prompt size; older signals beyond this still get consumed so they
// don't pile up, they just don't each get spelled out.
const MAX_LEARNING_CASES = 20;

let started = false;
let timer: NodeJS.Timeout | null = null;
const sourceRetries = new Map<
  string,
  { attempts: number; retryAfter: number }
>();
const pendingCreateRetries = new Map<
  string,
  { attempts: number; retryAfter: number }
>();

export function startScheduler() {
  if (started) return;
  started = true;
  // Run one tick immediately so a fresh boot doesn't wait 30s before
  // catching up on anything that came due during downtime.
  void tick().catch((e) => console.error("[scheduler] initial tick threw", e));
  void learningTick().catch((e) =>
    console.error("[scheduler] initial learning tick threw", e),
  );
  // Refresh every connection's cached tool catalog on boot (i.e. each deploy),
  // throttled so restarts don't re-storm provider APIs. Background — must not
  // block the scheduler from starting.
  void maybeReconcileToolCaches(RECONCILE_BOOT_FLOOR_MS).catch((e) =>
    console.error("[scheduler] initial tool reconcile threw", e),
  );
  timer = setInterval(() => {
    void tick().catch((e) => console.error("[scheduler] tick threw", e));
    void learningTick().catch((e) =>
      console.error("[scheduler] learning tick threw", e),
    );
    // Daily drift catch-up; the throttle makes this a cheap no-op most ticks.
    void maybeReconcileToolCaches(RECONCILE_DAILY_MS).catch((e) =>
      console.error("[scheduler] tool reconcile threw", e),
    );
  }, TICK_MS);
  console.log(`[scheduler] started, tick=${TICK_MS}ms`);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
  sourceRetries.clear();
  pendingCreateRetries.clear();
}

async function tick() {
  const paused = await pauseAutomationsWithMissingOwners();
  if (paused > 0) {
    console.warn(
      `[scheduler] paused ${paused} automation(s) whose owner is no longer a workspace member`,
    );
  }
  const automations = await listEnabledAutomations();
  if (automations.length === 0) return;
  const now = new Date();
  for (const a of automations) {
    try {
      await maybeFire(a, now);
    } catch (e) {
      console.error("[scheduler] maybeFire threw", a.id, e);
      sourceRetries.delete(a.id);
      pendingCreateRetries.delete(a.id);
      await recordAutomationFailure({
        kind: "schedule",
        id: a.id,
        occurredAt: now,
        failure: unexpectedDispatchFailure(e),
      });
    }
  }
}

async function maybeFire(a: Automation, now: Date) {
  // Use last_fired_at as the floor; for never-fired automations,
  // anchor to created_at so we don't fire on every tick for a brand-
  // new cron whose first window is in the future.
  const floor = a.lastFiredAt ?? a.createdAt;
  if (!hasFiringInWindow(a.cron, floor, now)) return;

  // Editing an automation clears its persisted error and should also cancel
  // any in-memory delay left from the previous source failure.
  if (!a.lastFireError) sourceRetries.delete(a.id);
  const pendingRetry = sourceRetries.get(a.id);
  if (pendingRetry && pendingRetry.retryAfter > now.getTime()) return;
  const pendingCreateRetry = pendingCreateRetries.get(a.id);
  if (pendingCreateRetry && pendingCreateRetry.retryAfter > now.getTime()) return;

  // Resolve the agent — the stable snapshot by default, or the live draft
  // when the automation opts in. listEnabledAutomations doesn't pre-fetch
  // this because most automations don't fire on most ticks.
  const dispatch = await resolveAgentForDispatch(a.workspaceId, a.agentName, {
    preferDraft: a.useDraft,
  });
  if (!dispatch.ok) {
    if (
      dispatch.error.kind === "not-found" &&
      (await isAgentCreatePending(a.workspaceId, a.agentName))
    ) {
      const previousAttempts = pendingCreateRetries.get(a.id)?.attempts ?? 0;
      const attempts = previousAttempts + 1;
      const delay = Math.min(
        TICK_MS * 2 ** Math.min(attempts - 1, 10),
        SOURCE_RETRY_MAX_MS,
      );
      pendingCreateRetries.set(a.id, {
        attempts,
        retryAfter: now.getTime() + delay,
      });
      console.log(
        "[scheduler] agent creation pending; retrying",
        a.id,
        `in ${delay}ms`,
      );
      return;
    }
    pendingCreateRetries.delete(a.id);
    if (dispatch.error.kind === "source-unavailable" && dispatch.error.retryable) {
      const previousAttempts = sourceRetries.get(a.id)?.attempts ?? 0;
      const attempts = previousAttempts + 1;
      const delay = Math.min(
        TICK_MS * 2 ** Math.min(attempts - 1, 10),
        SOURCE_RETRY_MAX_MS,
      );
      sourceRetries.set(a.id, {
        attempts,
        retryAfter: now.getTime() + delay,
      });
      console.warn(
        "[scheduler] transient source failure; retrying",
        a.id,
        `in ${delay}ms`,
        dispatch.error.message,
      );
      await recordAutomationFailure({
        kind: "schedule",
        id: a.id,
        occurredAt: now,
        failure: agentResolutionFailure(dispatch.error),
        advanceFiringFloor: false,
      });
      return;
    }
    await recordSkipAndAdvance(a, now, agentResolutionFailure(dispatch.error));
    return;
  }
  sourceRetries.delete(a.id);
  pendingCreateRetries.delete(a.id);
  const r = dispatch.resolved;

  // POST directly to /internal/runs with the new spec_content /
  // spec_format contract + trigger + automation_id. We don't go
  // through @/lib/runs-api because that helper still speaks the old
  // (instructions / spec_json) shape today.
  const apiUrl = process.env.API_INTERNAL_URL ?? "http://localhost:8080";
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) {
    await recordSkipAndAdvance(
      a,
      now,
      automationServiceConfigurationFailure(),
    );
    return;
  }

  const res = await fetch(`${apiUrl}/internal/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
    body: JSON.stringify({
      workspace_id: a.workspaceId,
      // Scheduled runs act as the automation's owner (per migration
      // 0023). The owner's credentials are what the Composio session
      // looks up; defaults to createdBy when an automation is
      // created and can be reassigned from the form.
      user_id: a.ownerUserId,
      agent_name: r.agentName,
      agent_path: r.agentPath,
      model: r.model,
      user_message: a.inputMessage,
      framework: r.framework,
      spec_content: r.specContent,
      spec_format: r.specFormat,
      tools_module_content: r.toolsModuleContent,
      skills_content: r.skillsContent,
      trigger: "schedule",
      automation_id: a.id,
      agent_version_id: r.versionId,
      agent_version_label: r.versionLabel,
      output_delivery: r.delivery,
    }),
  });

  if (!res.ok) {
    await recordSkipAndAdvance(a, now, runApiFailure(res.status));
    return;
  }

  const body = (await res.json().catch(() => null)) as {
    run_id?: string;
  } | null;
  await recordAutomationSuccess({
    kind: "schedule",
    id: a.id,
    occurredAt: now,
    runId: body?.run_id ?? null,
  });
}

// Advance last_fired_at even when we couldn't actually fire, so a
// broken cron / missing agent doesn't churn the DB every 30s with
// the same error. The error is stamped onto the row so the UI can
// surface it; once the underlying problem is fixed, the next
// natural cron window fires normally and clears the error.
async function recordSkipAndAdvance(
  a: Automation,
  now: Date,
  failure: AutomationDispatchFailure,
): Promise<void> {
  sourceRetries.delete(a.id);
  pendingCreateRetries.delete(a.id);
  console.warn("[scheduler] skip fire", a.id, failure.code, failure.summary);
  await recordAutomationFailure({
    kind: "schedule",
    id: a.id,
    occurredAt: now,
    failure,
  });
}

// ── Batched Tasks Inbox learning pass ─────────────────────────────────
// For each agent in learning mode whose cadence window has elapsed, gather the
// inbox signals it produced (resolved items the pass hasn't folded in yet),
// and — if any were CORRECTED by the human — collapse them into ONE improvement
// -> CAP PR via the existing requestAgentChange pipeline. Accepted-as-is signals
// are consumed too (nothing to change) so they don't re-accumulate. One PR per
// cycle, not per signal.

async function learningTick() {
  const now = new Date();
  const due = await listDueLearningConfigs(now);
  for (const cfg of due) {
    try {
      await runLearningCycle(cfg, now);
    } catch (e) {
      console.error(
        "[scheduler] learning cycle threw",
        cfg.workspaceId,
        cfg.agentName,
        e,
      );
      // Advance the floor regardless so a broken cycle doesn't re-run every
      // tick; the signals stay unconsumed and get picked up next window.
      await setAgentLearned(cfg.workspaceId, cfg.agentName, now);
    }
  }
}

async function runLearningCycle(cfg: AgentLearning, now: Date): Promise<void> {
  if (!cfg.ownerUserId) {
    await setAgentLearned(cfg.workspaceId, cfg.agentName, now);
    return;
  }

  const signals = await listUnconsumedSignalsForAgent(
    cfg.workspaceId,
    cfg.agentName,
  );
  if (signals.length === 0) {
    await setAgentLearned(cfg.workspaceId, cfg.agentName, now);
    return;
  }

  const corrected = signals.filter((s) =>
    actionDiffers(s.proposedAction, s.finalAction),
  );

  // Nothing was corrected this cycle — the agent's guesses were accepted as-is.
  // Mark the signals consumed (confirmation, no spec change) and advance.
  if (corrected.length === 0) {
    await markSignalsConsumed(signals.map((s) => s.id), null);
    await setAgentLearned(cfg.workspaceId, cfg.agentName, now);
    console.log(
      `[scheduler] learning: ${cfg.agentName} — ${signals.length} signal(s), 0 corrections; no change`,
    );
    return;
  }

  const description = buildLearningDescription(cfg.agentName, corrected);
  const res = await requestAgentChangeSystem(cfg.workspaceId, cfg.ownerUserId, {
    agent: cfg.agentName,
    description,
  });

  if (!res.ok) {
    // Leave signals unconsumed so the next due window retries; just advance the
    // floor so we don't hammer CAP every tick.
    await setAgentLearned(cfg.workspaceId, cfg.agentName, now);
    console.warn(
      `[scheduler] learning: ${cfg.agentName} — requestAgentChange failed: ${res.error}`,
    );
    return;
  }

  // Consume every gathered signal under this batch improvement.
  await markSignalsConsumed(
    signals.map((s) => s.id),
    res.result.improvementId,
  );
  await setAgentLearned(cfg.workspaceId, cfg.agentName, now);
  console.log(
    `[scheduler] learning: ${cfg.agentName} — batched ${corrected.length} correction(s) into improvement ${res.result.improvementId}`,
  );
}

function actionText(a: InboxAction | null): string {
  return (a?.text ?? "").trim();
}
function actionFields(a: InboxAction | null): string {
  return JSON.stringify(a?.fields ?? null);
}
/** A signal is a "correction" when the human's final action differs from the
 *  agent's proposal (in text or structured fields). */
function actionDiffers(
  proposed: InboxAction | null,
  final: InboxAction | null,
): boolean {
  return (
    actionText(proposed) !== actionText(final) ||
    actionFields(proposed) !== actionFields(final)
  );
}

/** Build one CAP prompt summarizing the corrected cases, grouped by item type,
 *  asking it to update the agent's instructions so future items match. */
function buildLearningDescription(
  agentName: string,
  corrected: InboxItem[],
): string {
  const cases = corrected.slice(0, MAX_LEARNING_CASES);
  const omitted = corrected.length - cases.length;

  const byType = new Map<string, InboxItem[]>();
  for (const c of cases) {
    const arr = byType.get(c.itemType) ?? [];
    arr.push(c);
    byType.set(c.itemType, arr);
  }

  const lines: string[] = [
    `The agent "${agentName}" proposes actions for Tasks Inbox items that a human reviews before they go out. ` +
      `Below are recent cases where the human CORRECTED the agent's proposed action. ` +
      `Update the agent's instructions (its system prompt) — and/or add worked examples — so it would produce the corrected version on its own next time. ` +
      `Generalize the patterns; don't hard-code these specific names. Keep existing behavior that wasn't corrected.`,
    "",
  ];

  for (const [itemType, items] of byType) {
    lines.push(`## ${itemType} (${items.length} corrected)`);
    items.forEach((c, i) => {
      lines.push(
        `### Case ${i + 1}: ${c.title}`,
        `Context: ${JSON.stringify(c.context)}`,
        `Agent proposed: ${actionText(c.proposedAction) || "(nothing)"}`,
        `Human submitted: ${actionText(c.finalAction) || "(nothing)"}`,
        "",
      );
    });
  }

  if (omitted > 0) {
    lines.push(
      `(${omitted} additional corrected case(s) this cycle are omitted from this summary but follow the same patterns.)`,
    );
  }

  return lines.join("\n");
}
