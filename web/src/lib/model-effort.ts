import YAML, { isMap } from "yaml";
import catalog from "./model-capabilities.json";

export const EFFORT_LABELS: Record<string, string> = {
  none: "None", minimal: "Minimal", low: "Low", medium: "Medium",
  high: "High", xhigh: "Extra high", max: "Maximum",
};

export function effortSupport(model: string) {
  return catalog.effort.find((entry) => entry.models.includes(model.toLowerCase())) ?? null;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function readModelEffort(spec: Record<string, unknown>) {
  const model = typeof spec.model === "string" ? spec.model : "";
  const support = effortSupport(model);
  const settings = object(spec.model_settings);
  const value = support ? settings[support.setting] : settings.anthropic_effort ?? settings.openai_reasoning_effort;
  const extra = object(settings.extra_body);
  // Advanced thinking controls may override effort or constrain legal values.
  // Keep them intact and direct their authors to the raw editor.
  const custom = settings.thinking !== undefined ||
    extra.thinking !== undefined || extra.reasoning !== undefined ||
    object(extra.output_config).effort !== undefined ||
    extra.reasoning_effort !== undefined ||
    object(settings.anthropic_thinking).type === "disabled" ||
    (value !== undefined && value !== null && (typeof value !== "string" || !support?.levels.includes(value)));
  const effort = typeof value === "string" ? value : "";
  return { model, support, effort, custom };
}

export function effortLabel(spec: Record<string, unknown>): string {
  const { support, effort, custom } = readModelEffort(spec);
  if (custom) return "Custom";
  if (effort) return EFFORT_LABELS[effort] ?? effort;
  return support ? `Provider default (${EFFORT_LABELS[support.default]})` : "Not configured";
}

/** Change only the provider's effort field; preserve comments and other settings. */
export function setModelEffort(source: string, format: "yaml" | "json", effort: string): string {
  const doc = YAML.parseDocument(source);
  if (doc.errors.length || !isMap(doc.contents)) throw new Error("The agent definition could not be parsed.");
  const spec = doc.toJS() as Record<string, unknown>;
  if (typeof spec.instructions !== "string") throw new Error("Effort selection requires a Pydantic agent.");
  const { support, custom } = readModelEffort(spec);
  if (!support) throw new Error("No verified effort options for this model.");
  if (custom) throw new Error("This agent has custom thinking settings. Use Edit as draft to update them.");
  if (effort && !support.levels.includes(effort)) throw new Error("This effort level is not supported by the model.");
  const settings = doc.get("model_settings");
  if (settings == null) {
    if (effort) doc.set("model_settings", doc.createNode({}));
  } else if (!isMap(settings)) {
    throw new Error("model_settings must be an object.");
  }
  if (effort) doc.setIn(["model_settings", support.setting], effort);
  else doc.deleteIn(["model_settings", support.setting]);
  return format === "json" ? JSON.stringify(doc.toJS(), null, 2) + "\n" : doc.toString();
}
