---
title: Skills
description: Give agents reusable Agent Skills (SKILL.md folders) from skills.sh, custom uploads, or the Claude API — committed to your repo and opted into per agent.
---

**Skills** are reusable capabilities you attach to agents. Each skill is a
folder — a `SKILL.md` (instructions + metadata) plus optional scripts and
resources — following Anthropic's [Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
format. An agent **opts in** to the skills it needs; at run time the model can
read a skill's instructions and run its scripts.

Skills live as files in your connected repo under `skills/<name>/`, right
alongside `agents/`. They run **locally** in your environment (no Anthropic
code-execution sandbox) and work with **any model**.

## Installing skills

Open **Skills** in the sidebar. Several sources, each commits the skill folder to
your repo:

- **Anthropic knowledge-work skills** — browse role-specific Agent Skills from
  [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins)
  (sales, support, finance, legal, data, …) by work area and install with one
  click. These give an agent domain expertise it can draw on; pair them with a
  matching [agent library](/agent-studio/agent-library/) starter.
- **skills.sh** — browse and search the open
  [Agent Skills directory](https://www.skills.sh/) right in the app and install
  with one click. (You can also paste a slug or GitHub URL for a skill that
  isn't in the directory.)
- **Upload** — a custom skill bundled as a `.zip` (a folder containing
  `SKILL.md`).
- **Import from the Claude API** — copy a skill your team created via the Claude
  Skills API into the repo. Needs an Anthropic API key in
  [Settings → LLM Providers](/agent-studio/settings/).

**Operators and workspace admins** can upload custom skill bundles through
**Skills → New skill → Upload a custom skill**, without needing an admin to
upload on their behalf. Skills are shared across the workspace; uploading a
bundle with an existing skill name updates that skill's files.

Installing from GitHub or skills.sh, importing from the Claude API, and removing
skills still require a **workspace admin**. Viewers cannot upload, install, or
remove skills. Successful installs, uploads, and removals are recorded with the acting
team member in the [audit log](/agent-studio/audit-and-roles/).

## Skill owners

The first team member to successfully upload or install a skill is recorded as
its **owner**. Uploading or installing updates preserves the existing owner.
Removing a skill clears its ownership, so a new installation gets a new owner.

The Skills list includes an **Owner** column and an **Owner** filter. Choose a
team member to see their skills, **Unassigned** to find skills without an owner,
or **All owners** to reset the filter. The skill detail page also shows its owner.
Workspace admins can change the owner of any skill (including unassigned
skills) from its detail page. The current owner can also transfer their skill
to **another workspace member**, even if they are not an admin. Other members
cannot reassign it. An admin can assign themselves; a non-admin owner must
choose someone else. Once transferred, the previous owner can no longer
reassign the skill unless they are an admin. Ownership changes are audited.

Skills remain shared across the workspace. Ownership does not grant upload,
install, or removal permissions; the permissions above still apply. An owner
with the viewer role can transfer ownership, but cannot modify skill content.

Skills installed before ownership tracking was introduced, or added directly
to the repository, show **Unassigned** until an admin assigns an owner or their
next successful upload or installation through the app. Deleting an owner's
user account also leaves their skills unassigned.

## Opting an agent in

Add the skill's folder name to the agent's `skills:` field (the Tembo coding
agent does this when you ask it to use a skill):

```yaml
name: deck-builder
model: anthropic:claude-opus-4-7
instructions: |
  Build slide decks from the user's outline.
skills:
  - pptx
  - brand-guidelines
```

The agent page shows which skills an agent uses. A run resolves the named
folders from the repo and mounts them; a declared-but-missing skill fails the
run (same as a missing `tools_module`).

## At run time

Skills are mounted with [pydantic-ai-skills](https://pypi.org/project/pydantic-ai-skills/):
the model gets tools to load a skill's instructions, read its resources, and run
its scripts. Skill scripts execute in the agent's runtime — the same trust model
as [sidecar Python tools](/agent-studio/sidecar-python-tools/) (your own,
review-gated repo code). Nothing runs in an Anthropic-hosted container.

:::note
Skills are text (SKILL.md, scripts, references). Binary resources aren't
supported and are skipped on import/upload.
:::
