---
title: Agent evals
description: Colocate an eval file with an agent spec, run it against draft or stable, and fail authoring PRs on regression.
---

An **eval suite** is a regression check for one agent. It lives next to the
agent spec, runs the agent on known inputs, and scores each reply with
assertions or an LLM judge. An agent with an eval file gets a pass/fail check
on its authoring PR; the latest result shows on the agent's **Versions** tab.

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

### LLM judge

`judge.rubric` is scored with the workspace Anthropic key (Haiku). The judge
must answer `PASS` or `FAIL`. If both `assert` and `judge` are set, both must
pass.

## Running evals

### In the UI

On the agent's **Versions** tab, **Run evals on draft** executes the live file.
**Run evals on stable** executes the current promoted version. Latest pass/fail
and per-case reasons stay on that tab. Case rows link to the underlying run.

### REST API

Operator key. `POST /api/v1/evals` queues a suite and returns `202`. Poll
`GET /api/v1/evals/{id}` until `status` is `passed`, `failed`, or `error`.

```bash
curl -s -X POST https://your-tas-host/api/v1/evals \
  -H "Authorization: Bearer tas_..." \
  -H "Content-Type: application/json" \
  -d '{"agent":"hello-world","version":"draft"}'
# → 202 { "eval_id": "...", "eval": { "status": "queued", ... } }
```

For an unmerged PR, send the checkout's spec and eval text so TAS does not
need the branch:

```json
{
  "agent": "hello-world",
  "version": "draft",
  "spec": "...",
  "eval": "...",
  "commitSha": "abc123",
  "source": "ci"
}
```

`version` is `draft` (default) or `stable`. `GET /api/v1/evals?agent=hello-world`
lists recent suites; `?latest=true` returns only the newest.

### Runner command

From a checkout that contains `agents/`:

```bash
TAS_URL=https://your-tas-host TAS_API_TOKEN=tas_... \
  ./scripts/run-agent-evals.sh
```

Set `EVAL_BASE_SHA` to only evaluate agents changed since that commit. The
command exits `1` if any suite fails.

## CI gate

Add a workflow to the **agents** repo so authoring PRs that touch `agents/**`
run evals against your TAS instance. Store an operator API key as
`TAS_API_TOKEN` and the TAS origin as `TAS_URL` (a variable is fine).

```yaml
name: Agent evals
on:
  pull_request:
    paths: ["agents/**"]
jobs:
  evals:
    uses: tembo/agent-studio/.github/workflows/agent-evals.yml@main
    with:
      tas_url: ${{ vars.TAS_URL }}
    secrets:
      tas_api_token: ${{ secrets.TAS_API_TOKEN }}
```

Or call the composite action after checkout:

```yaml
- uses: tembo/agent-studio/.github/actions/run-agent-evals@main
  with:
    tas-url: ${{ vars.TAS_URL }}
    tas-token: ${{ secrets.TAS_API_TOKEN }}
    base-sha: ${{ github.event.pull_request.base.sha }}
```

Agents without an eval sidecar are skipped. The check fails only when a
changed agent that *has* an eval file regresses. Eval runs use trigger `eval`
and stay out of the default Runs list (`GET /api/v1/runs?trigger=eval` to see
them).

The API key acts as that user, so authorize any `connections:` the agent
declares before CI can pass.
