---
name: reprioritize-backlog
description: Audit, sequence, or update the tembo/agent-studio GitHub issue backlog using its priority, status, type, customer, milestone, and dependency conventions.
---

# Reprioritize the Agent Studio backlog

Treat GitHub Issues as the live source of truth. Use this skill when asked to
triage, prioritize, sequence, or review the backlog. Do not use it for ordinary
single-issue implementation.

## Taxonomy

Every open issue has exactly one label from each required group:

- Type: `bug`, `enhancement`, `task`, or `epic`.
- Priority: `priority: p0`, `priority: p1`, `priority: p2`, `priority: p3`, or
  `priority: parked`.
- Status: `status: triage`, `status: ready`, `status: in progress`, or
  `status: blocked`.

Other labels are additive evidence or routing, including `customer`, `security`,
severity, and component labels such as `web`, `runner`, and `observability`.

Priority meanings:

- **P0:** immediate security, authorization, data-integrity, or incident work.
- **P1:** next outcome-bearing work, validated customer demand, or a required
  safety/reliability foundation.
- **P2:** valuable after the current P0/P1 queue.
- **P3:** low urgency or demand-gated.
- **Parked:** intentionally deferred pending strategy, demand, or prerequisites.

The `customer` label makes P1 the default priority unless the issue is already
P0 for independent safety or incident reasons. A lower customer priority needs
a written exception. Customer provenance alone does not create P0 work. Closed
issues keep `customer` for historical reporting but do not enter the active
queue.

Status meanings:

- **Triage:** needs an owner, product decision, or scope refinement.
- **Ready:** scoped enough to begin when capacity is available.
- **In progress:** actively owned; do not duplicate it.
- **Blocked:** waiting on a hard dependency or external capability. Do not use
  this for work that is merely lower in the preferred sequence.

Use milestones only for a real delivery target or a maintained initiative.
Avoid assigning a milestone merely to make an issue look organized. An issue
can have only one milestone.

## Workflow

1. Run `./.agents/skills/reprioritize-backlog/scripts/audit-backlog.sh` from the
   repository root. Fix taxonomy drift before evaluating order.
2. Fetch current issue bodies, recent comments, linked work, labels, milestones,
   and assignees. Do not prioritize from titles alone.
3. Preserve active ownership. An issue marked `status: in progress` stays out of
   other work queues unless the owner or user says it is abandoned.
4. Separate hard dependencies from preferred sequence:
   - Use GitHub parent/sub-issue or blocked-by relationships for hard dependencies.
   - Use priority and a written sequence for work that should merely happen first.
5. Propose a concise change table with issue, current classification, proposed
   classification, dependency, and rationale.
6. If the user requested analysis only, stop after the proposal. Mutating live
   labels, milestones, relationships, assignments, or issue bodies requires
   explicit authorization.
7. After authorized changes, rerun the audit and report the resulting GitHub
   queries or Project view. Do not create, close, or assign issues unless that
   was also requested.

## Judgment cadence

Re-prioritization is manual because business value and urgency cannot be inferred
reliably from metadata. Run it when:

- a `customer` issue is added;
- an incident or security finding changes urgency;
- a dependency ships or becomes blocked;
- active ownership changes;
- planning the next release or clearing stale backlog.

The backlog-taxonomy workflow applies safe defaults: new/reopened issues enter
triage, unlabeled priority defaults to P2, `customer` promotes to P1 unless the
issue is already P0, and closing clears the active status label. Automation
should otherwise surface drift rather than silently decide the final order.

## GitHub views

Until the organization Project is writable by the repository integration, use
repository issue queries:

- Now: open P0/P1 issues, excluding blocked and parked work.
- Customer: open issues labeled `customer`, ordered by priority.
- In progress: open issues labeled `status: in progress`.
- Blocked: open issues labeled `status: blocked`.
- Triage: open issues labeled `status: triage`.
- Parked: open issues labeled `priority: parked`.

The organization Project is
[Agent Studio Backlog](https://github.com/orgs/tembo/projects/1). When it is
writable by the repository integration, mirror these fields there:

- Priority: P0, P1, P2, P3, Parked.
- Status: use the Project's built-in status for Todo, In progress, and Done;
  retain `status: triage` and `status: blocked` labels for the finer distinction.
- Initiative: Runtime safety, Customer workflow, Outputs, Instance
  administration, Adaptive intelligence, Shared learning, Integrations,
  Mycelium, or Maintenance.
- Order: a number for preferred sequence within a priority/initiative, not a
  substitute for a hard dependency.

Labels remain the portable source for provenance, risk, type, and components.
Until organization issue types are writable, `bug`, `enhancement`, `task`, and
`epic` are the type source of truth.
