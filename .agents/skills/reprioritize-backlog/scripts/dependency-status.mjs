const BLOCKED = "status: blocked";
const IN_PROGRESS = "status: in progress";
const READY = "status: ready";

export function dependencyStatusLabel(currentStatus, blockers) {
  if (currentStatus === IN_PROGRESS || blockers.length === 0) return null;
  if (blockers.some((blocker) => blocker.state === "OPEN")) return BLOCKED;
  return currentStatus === BLOCKED ? READY : null;
}
