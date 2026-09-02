---
title: Agent evals
description: Optional regression checks. Opt in when creating or editing an agent. TAS runs assertions on authoring PRs and blocks Promote until they pass.
---

An **eval suite** is an optional regression check for one agent. Existing
agents without an eval file stay ungated.

When you **create** or **edit** an agent, TAS asks whether to add evals
(default **yes**). If you leave it on, the coding agent writes a colocated
`<name>.eval.yaml` with assertion cases for the agent's job. Uncheck it to
skip — useful for a quick experiment, or for leaving a legacy agent alone.

**Assertions** are the gate: they must pass before you can [promote](/agent-studio/agent-lifecycle/)
the draft, and TAS runs them on authoring PRs. The **LLM judge** is
informational — a judge miss shows on the Versions tab but does not fail the
gate or the GitHub status TAS posts.

## Eval file

Put a sidecar next to the spec. TAS does not treat these as agents:

```
agents/pydantic-agentspec/hello-world.yaml
agents/pydantic-agentspec/hello-world.eval.yaml
```

`.eval.yml` and `.eval.json` work too. A minimal suite:

```yaml
cases:
  - name: greets-the-user
    input: Hello
    assert:
      contains: hello
      max_chars: 800
  - name: friendly-tone
    input: Hey there
    judge:
      rubric: |
        Pass if the reply is a warm, brief greeting.
        Fail if it is rude, ignores the user, or goes off-topic.
```

Each case needs `name`, `input`, and at least one of `assert` or `judge`.
Suites are capped at 20 cases.

### Assertions

All listed checks must pass (case-insensitive for substring matches):

| Field | Passes when |
| --- | --- |
| `contains` | Output includes every string (string or list) |
| `not_contains` | Output includes none of the strings |
| `regex` | Output matches the JavaScript regular expression |
| `equals` | Trimmed output equals the expected string |
| `max_chars` | Output length is at most this integer |

A failed agent run (the case never produced output) also fails the gate.

### LLM judge

`judge.rubric` is scored with the workspace Anthropic key (Haiku). The judge
must answer `PASS` or `FAIL`. Judge results are shown on the Versions tab;
they never block Promote or the `tas/evals` commit status.

## How TAS runs them

TAS owns the runner. You do not need a GitHub Action in the agents repo.

- **Authoring PR** — when TAS sees an open improvement PR, it runs the eval
  file from the PR head against that spec. It posts an optional
  `tas/evals` commit status on the head SHA (needs `repo:status` on the
  GitHub PAT). Missing scope is ignored; results still land in TAS.
- **Promote** — if the agent has an eval file, **Promote to Stable** is blocked
  until assertions have passed on *this* draft.
- **Versions tab** — run the live draft or the current stable by hand. Latest
  pass/fail and per-case reasons stay here.

Direct-commit (YOLO) authoring has no PR to attach a status to; Promote is
still gated.

## REST API

Operator key. `POST /api/v1/evals` queues a suite and returns `202`. Poll
`GET /api/v1/evals/{id}` until `status` is `passed`, `failed`, or `error`.
`passed` means assertions (and runs) succeeded; inspect `cases[].judgePassed`
for judge results.

```bash
curl -s -X POST https://your-tas-host/api/v1/evals \
  -H "Authorization: Bearer tas_..." \
  -H "Content-Type: application/json" \
  -d '{"agent":"hello-world","version":"draft"}'
```

`GET /api/v1/evals?agent=hello-world` lists recent suites; `?latest=true`
returns only the newest.

## Optional GitHub Action

A reusable workflow and `scripts/run-agent-evals.sh` remain if you want a
*required* GitHub check in addition to TAS. They call the same TAS API.
They are not required for the gate to work.
