---
name: reprioritize-backlog
description: Audit, sequence, or update the tembo/agent-studio backlog in its GitHub Project using priority, status, initiative, order, user-request, milestone, and dependency evidence.
---

# Reprioritize the Agent Studio backlog

Use [Agent Studio Backlog](https://github.com/orgs/tembo/projects/1) as the live
execution surface. GitHub Issues supply scope, history, provenance, type, risk,
components, and dependencies; the Project supplies the current Priority,
Status, Initiative, and global Order. Use this skill when asked to triage,
prioritize, sequence, or review the backlog. Do not use it for ordinary
single-issue implementation.

## Taxonomy

Every open issue has exactly one label from each required group, mirrored to
the Project's Priority and Status fields:

- Type: `bug`, `enhancement`, `task`, or `epic`.
- Priority: `priority: p0`, `priority: p1`, `priority: p2`, `priority: p3`, or
  `priority: parked`.
- Status: `status: triage`, `status: ready`, `status: in progress`, or
  `status: blocked`.

Other labels are additive evidence or routing, including `user request`, `security`,
severity, and component labels such as `web`, `runner`, and `observability`.

Priority meanings:

- **P0:** immediate security, authorization, data-integrity, or incident work.
- **P1:** next outcome-bearing work, validated user demand, or a required
  safety/reliability foundation.
- **P2:** valuable after the current P0/P1 queue.
- **P3:** low urgency or demand-gated.
- **Parked:** intentionally deferred pending strategy, demand, or prerequisites.

The `user request` label makes P1 the default priority unless the issue is already
P0 for independent safety or incident reasons. A lower user-request priority needs
a written exception. User-request provenance alone does not create P0 work. Closed
issues keep `user request` for historical reporting but do not enter the active
queue.

Status meanings (Project option in parentheses):

- **Triage** (`Triage`): needs an owner, product decision, or scope refinement.
- **Ready** (`Ready`): scoped enough to begin when capacity is available.
- **In progress** (`In Progress`): actively owned; do not duplicate it.
- **Blocked** (`Blocked`): waiting on a hard dependency or external capability.
  Do not use this for work that is merely lower in the preferred sequence.

Closed issues have Project Status `Done`, retain Priority and Initiative for
historical reporting, have no active `status: *` label, and have no Order.

Use milestones only for a real delivery target or a maintained initiative.
Avoid assigning a milestone merely to make an issue look organized. An issue
can have only one milestone.

## Workflow

1. Confirm the token can read and write organization Projects v2, then run
   `./.agents/skills/reprioritize-backlog/scripts/audit-backlog.sh` from the
   repository root. Fix taxonomy and Project drift before evaluating order.
2. Fetch all Project items and their current fields, plus issue bodies, recent
   comments, linked work, labels, milestones, assignees, and open pull requests.
   Do not prioritize from titles or issue numbers alone.
3. Preserve active ownership. An issue marked `status: in progress` stays out of
   other work queues unless the owner or user says it is abandoned.
4. Separate hard dependencies from preferred sequence:
   - Use parent/sub-issue relationships for initiative hierarchy.
   - Use GitHub blocked-by relationships for hard dependencies. A dependency
     mentioned only in prose is not complete backlog metadata.
   - Use priority and a written sequence for work that should merely happen first.
5. Propose a concise change table with issue, current and proposed Priority,
   Status, Initiative, Order, dependency, and rationale. Order is global across
   open work: lower numbers come first, are unique positive integers, and should
   normally be contiguous after a full reprioritization.
6. If the user requested analysis only, stop after the proposal. Mutating live
   labels, milestones, relationships, assignments, or issue bodies requires
   explicit authorization.
7. After authorized changes, update the Project fields and keep Priority/Status
   labels in sync. Then mirror Order into the Project's manual item positions
   with `updateProjectV2ItemPosition`; the default view otherwise falls back to
   its previous manual order, which can look like issue-number sorting. Rerun
   the audit and report the Project view. Do not create, close, or assign issues
   unless that was also requested.

Before applying Order, build a dependency graph from every open Project item's
`blockedBy` edges and perform a topological ordering. An open blocker must have
a lower Order than every issue it blocks, even when the dependent has a higher
Priority. Within the set of currently unblocked nodes, use the judgment rules
below. A closed blocker is satisfied and does not occupy Order. Stop and report
a cycle instead of discarding an edge or inventing an order.

## Ordering judgment

Order represents what should receive attention next, not a mechanical label
sort. Apply these signals in combination:

1. Finish genuinely active work and review/merge linked work before starting
   another item, unless it is abandoned or a P0 interrupts it.
2. Put P0 safety, authorization, data-integrity, and incident work first.
3. Prefer executable Ready work over equally important Triage or Blocked work.
   A concrete unblock or product-decision action may itself rank early.
4. Within comparable work, prefer validated user outcomes, work that
   unlocks several other items, and small changes that complete an active
   initiative.
5. Keep epics near their actionable children but do not treat an epic tracker
   as an implementation task.
6. Put Parked work last. Do not disguise deferral by leaving it unordered.

Use a small, maintained set of Initiative names. Reuse an existing Initiative
or a real milestone when it fits; introduce a new name only when the work has a
distinct maintained outcome. Initiative is not a component label.

## Judgment cadence

Re-prioritization is manual because business value and urgency cannot be inferred
reliably from metadata. Run it when:

- a `user request` issue is added;
- an incident or security finding changes urgency;
- a dependency ships or becomes blocked;
- active ownership changes;
- planning the next release or clearing stale backlog.

The backlog-taxonomy workflow applies safe defaults: new/reopened issues enter
triage, unlabeled priority defaults to P2, `user request` promotes to P1 unless the
issue is already P0, and closing clears the active status label. Formal `blockedBy`
relationships move non-active work to Blocked while any dependency is open and
return Blocked work to Ready after every dependency closes. A Blocked issue with no
formal dependency remains untouched because it may be waiting on an external
capability. The workflow adds all open issues to Project 1, mirrors Priority and
Status, preserves an assigned Initiative, and fills an unassigned Initiative from
`user request` or a maintained milestone. It recomputes Order deterministically
from priority, status, user-request evidence, the existing sequence, and
`blockedBy` dependencies. Closing sets Project Status to Done and clears Order.
Strategic priority and initiative decisions remain manual; routine synchronization
does not require an LLM.

## GitHub Project contract

The organization Project is
[Agent Studio Backlog](https://github.com/orgs/tembo/projects/1):

- Priority: P0, P1, P2, P3, Parked.
- Status: Triage, Ready, In Progress, Blocked, Done.
- Initiative: Runtime safety, User requests, Outputs, Instance
  administration, Adaptive intelligence, Shared learning, Integrations,
  Mycelium, Maintenance, or Unassigned.
- Order: the global preferred sequence across all open issues, not a substitute
  for a hard dependency. It must respect all open `blockedBy` edges.

Labels remain the portable source for provenance, risk, type, and components.
Until organization issue types are writable, `bug`, `enhancement`, `task`, and
`epic` are the type source of truth. The audit and workflow accept
`PROJECT_OWNER` and `PROJECT_NUMBER` overrides, but default to `tembo` and `1`.
The Actions workflow requires a `PROJECTS_TOKEN` secret with repository Issues
write and organization Projects v2 write access; `GITHUB_TOKEN` alone cannot
write this private organization Project.
