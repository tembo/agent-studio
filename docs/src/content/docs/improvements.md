---
title: Improvements
description: Turn run feedback into a pull request, and track it from submission to merge.
---

**Improvements** close the loop from "this run was wrong" to a reviewed change.

## Submitting an improvement

From any [run](/agent-studio/running-agents/), use **Improve the Agent** and
describe what should change ("the response was too long — keep answers under
three sentences"). TAS hands the feedback to the
[Tembo Coding Agent Platform](https://tembo.io), which opens a pull request
against your repo. (This needs a Tembo API key in **Settings**.)

## Tracking

The **Improvements** page lists submissions and their status. TAS correlates the
merged pull request back to your submission, so you can see whether a fix landed
without leaving the studio. Statuses are reconciled against GitHub whenever you
open a page that shows improvements, at most once a minute per workspace — so a
PR you merged moments ago can take up to a minute to show as `Merged`. Because
the change lands as a reviewable diff in Git
— a pull request by default (see [delivery mode](#delivery-mode-always-pr-vs-yolo)
below) — it goes through the same review as any other edit, so the adaptation
stays governed.

## Delivery mode: Always PR vs YOLO

How an improvement *ships* is a per-workspace setting under **Settings → Tembo
Coding Agent → Improvements delivery**:

- **Always PR** (default) — the coding agent opens a pull request you review and
  merge. The Improvements page tracks it from `Submitted` → `PR opened` →
  `Merged`.
- **YOLO (direct commit)** — for trusted workspaces, the coding agent commits the
  change straight to the default branch with no PR. The improvement shows
  `Committed` and links the landed commit instead of a PR.

Switching mode is a workspace-admin action and is recorded in the
[audit log](/agent-studio/audit-and-roles/). YOLO only lands if your default
branch accepts direct pushes from the coding agent — if it's protected behind
required pull requests, keep Always PR (or relax the protection).

:::note
If submitting seems to do nothing, it's usually a stale browser tab from a
previous deployment — refresh and try again. See
[Troubleshooting](/agent-studio/troubleshooting/).
:::
