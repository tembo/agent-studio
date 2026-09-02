"use server";

import { revalidatePath } from "next/cache";

import { authorizeInstance } from "@/lib/instance";
import {
  addInstanceAdmin,
  removeInstanceAdmin,
} from "@/lib/instance-admins";
import {
  isFirstRun,
  setInstanceName,
  setRunQueueSettings,
  setSignupPolicy,
} from "@/lib/instance-settings";
import { MAX_CONCURRENT_RUNS_CAP } from "@/lib/run-queue";
import { updateRunConcurrency } from "@/lib/runs-api";
import {
  isSignupPolicy,
  parseAllowedDomains,
} from "@/lib/signup-policy";

export type InstanceSettingsState = {
  ok: boolean;
  error?: string;
  saved?: boolean;
};

const MAX_NAME = 120;

export async function updateInstanceNameAction(
  _prev: InstanceSettingsState,
  formData: FormData,
): Promise<InstanceSettingsState> {
  // Re-check the gate here — never trust the client; the page render
  // gate isn't a substitute for action-level enforcement.
  const auth = await authorizeInstance();
  if (!auth.ok) {
    return {
      ok: false,
      error: "You don't have permission to change instance settings.",
    };
  }

  const name = String(formData.get("instanceName") ?? "").trim();
  if (name.length > MAX_NAME) {
    return { ok: false, error: `Name must be ${MAX_NAME} characters or fewer.` };
  }

  await setInstanceName(name, auth.userId);

  // The name renders on the login screen + app header; bust those.
  revalidatePath("/settings");
  revalidatePath("/", "layout");

  return { ok: true, saved: true };
}

// First-run setup: set the instance name before any account exists
// (the pre-sign-in setup screen). Gated on first-run only — once a user
// exists, the name is managed via Instance settings (admin-gated above).
export async function setupInstanceNameAction(
  _prev: InstanceSettingsState,
  formData: FormData,
): Promise<InstanceSettingsState> {
  if (!(await isFirstRun())) {
    return {
      ok: false,
      error: "Setup is closed — sign in and edit Instance settings.",
    };
  }

  const name = String(formData.get("instanceName") ?? "").trim();
  if (name.length > MAX_NAME) {
    return { ok: false, error: `Name must be ${MAX_NAME} characters or fewer.` };
  }

  await setInstanceName(name, null);
  revalidatePath("/", "layout");
  return { ok: true, saved: true };
}

export async function updateSignupPolicyAction(
  _prev: InstanceSettingsState,
  formData: FormData,
): Promise<InstanceSettingsState> {
  const auth = await authorizeInstance();
  if (!auth.ok) {
    return {
      ok: false,
      error: "You don't have permission to change instance settings.",
    };
  }

  const policyRaw = String(formData.get("signupPolicy") ?? "").trim();
  if (!isSignupPolicy(policyRaw)) {
    return { ok: false, error: "Pick a sign-up policy." };
  }

  const allowedDomains = parseAllowedDomains(
    String(formData.get("allowedDomains") ?? ""),
  );
  if (policyRaw === "domain_allowlist" && allowedDomains.length === 0) {
    return {
      ok: false,
      error: "Enter at least one valid domain (e.g. acme.com).",
    };
  }

  await setSignupPolicy(policyRaw, allowedDomains, auth.userId);
  revalidatePath("/settings");
  revalidatePath("/");
  return { ok: true, saved: true };
}

function parseQueueInt(raw: string, label: string): number | InstanceSettingsState {
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(n) || n < 1) {
    return { ok: false, error: `${label} must be at least 1.` };
  }
  if (n > MAX_CONCURRENT_RUNS_CAP) {
    return {
      ok: false,
      error: `${label} must be ${MAX_CONCURRENT_RUNS_CAP} or fewer.`,
    };
  }
  return n;
}

export async function updateRunQueueAction(
  _prev: InstanceSettingsState,
  formData: FormData,
): Promise<InstanceSettingsState> {
  const auth = await authorizeInstance();
  if (!auth.ok) {
    return {
      ok: false,
      error: "You don't have permission to change instance settings.",
    };
  }

  const maxConcurrentRuns = parseQueueInt(
    String(formData.get("maxConcurrentRuns") ?? ""),
    "Concurrent agent runs",
  );
  if (typeof maxConcurrentRuns !== "number") return maxConcurrentRuns;

  const maxSubAgentsPerOrchestrator = parseQueueInt(
    String(formData.get("maxSubAgentsPerOrchestrator") ?? ""),
    "Concurrent sub-agents per orchestrator",
  );
  if (typeof maxSubAgentsPerOrchestrator !== "number") {
    return maxSubAgentsPerOrchestrator;
  }

  await setRunQueueSettings(
    { maxConcurrentRuns, maxSubAgentsPerOrchestrator },
    auth.userId,
  );
  try {
    await updateRunConcurrency({
      maxConcurrentRuns,
      maxSubAgentsPerOrchestrator,
    });
  } catch (e) {
    console.error("updateRunConcurrency failed (saved; api will pick up on restart)", e);
  }
  revalidatePath("/settings");
  return { ok: true, saved: true };
}

export type InstanceAdminsState = {
  ok: boolean;
  error?: string;
  /** Email just granted admin — the form shows a "send them the URL" hint. */
  added?: string;
};

const ADMIN_ERRORS: Record<"bad-email" | "already-admin", string> = {
  "bad-email": "Enter a valid email address.",
  "already-admin": "That email is already an instance admin.",
};

export async function addInstanceAdminAction(
  _prev: InstanceAdminsState,
  formData: FormData,
): Promise<InstanceAdminsState> {
  const auth = await authorizeInstance();
  if (!auth.ok) {
    return { ok: false, error: "You don't have permission to manage admins." };
  }

  const result = await addInstanceAdmin(
    String(formData.get("email") ?? ""),
    auth.userId,
  );
  if (!result.ok) return { ok: false, error: ADMIN_ERRORS[result.error] };

  revalidatePath("/settings");
  return { ok: true, added: result.email };
}

export async function removeInstanceAdminAction(
  _prev: InstanceAdminsState,
  formData: FormData,
): Promise<InstanceAdminsState> {
  const auth = await authorizeInstance();
  if (!auth.ok) {
    return { ok: false, error: "You don't have permission to manage admins." };
  }

  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  // Locking yourself out mid-setup is unrecoverable in-app; env-listed
  // admins aren't offered removal at all (the env grant would stand).
  if (email === auth.email.toLowerCase()) {
    return { ok: false, error: "You can't remove your own admin access." };
  }

  await removeInstanceAdmin(email);
  revalidatePath("/settings");
  return { ok: true };
}
