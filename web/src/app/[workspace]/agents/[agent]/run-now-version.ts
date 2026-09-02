export function runNowVersionChoice(args: {
  stableVersion?: number;
  hasDraft: boolean;
}): "draft-only" | "stable-only" | "choose" {
  if (args.stableVersion === undefined) return "draft-only";
  if (args.hasDraft) return "choose";
  return "stable-only";
}
