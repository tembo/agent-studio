---
title: Sidecar Python tools
description: Give an agent a sibling Python file of deterministic functions the model calls as tools — for cost, speed, and ETL work.
---

A Pydantic agent can point at a **sidecar Python module** of deterministic
functions, and the model calls those functions as tools. Use this when work is
rote — data transforms, scoring, matching, pagination loops, ETL — so the
function runs in Python at **no token cost** and the model just *supervises*
which function to call. It's the cost-and-speed lever versus making the model do
everything through MCP/Composio tool calls.

## Declaring a tools module

Add `tools_module:` to the agent spec, pointing at a `.py` file that sits **next
to** the spec:

```yaml
name: revenue-rollup
model: anthropic:claude-sonnet-5
tools_module: revenue_tools.py        # agents/pydantic-agentspec/revenue_tools.py
instructions: |
  Call summarize_arr to compute the monthly ARR waterfall, then post a
  one-paragraph summary. Don't recompute anything yourself.
```

Rules:

- `tools_module` is a **bare filename** (no `/`, no `..`), resolved in the same
  directory as the spec, and must end in `.py`.
- The module **must** define a top-level `tools = [...]` list of the functions to
  expose. Anything not in that list stays private.
- The model sees each function's **signature + docstring** — so type the
  parameters and write a clear one-line docstring. That text becomes the tool's
  schema.
- A declared module that's missing from the repo, or whose `tools` list is empty
  or non-callable, **fails the run** loudly — it never silently runs without the
  tools.
- Tool calls appear in the run detail and the
  [Tool uses](/agent-studio/tools-and-tool-uses/) view by function name, just
  like MCP tools.

## Authentication flows through Connections

Tools never carry a hardcoded key. When a function needs to reach an external
system, import the bundled `tas_tools` helper and ask for a
[connection](/agent-studio/connections/) the agent already declares. This is
supported for **Native MCP** connections — their OAuth token also works against
the provider's REST API:

```python
# agents/pydantic-agentspec/revenue_tools.py
import httpx
import tas_tools

def list_companies() -> list[dict]:
    """Return all Attio companies."""
    c = tas_tools.connection("attio")          # the agent's attio connection
    r = httpx.get(
        "https://api.attio.com/v2/objects/companies/records/query",
        headers={"Authorization": f"Bearer {c.access_token}"},
    )
    r.raise_for_status()
    return r.json()["data"]

def summarize_arr(records: list[dict]) -> dict:
    """Compute the monthly ARR waterfall from company records."""
    ...

tools = [list_companies, summarize_arr]
```

`tas_tools.connection(provider, name="default")` returns an object with
`.access_token` and `.mcp_url`, or raises a clear error if that connection isn't
active for the run.

For a service that uses a **plain API key** (no OAuth) — like Clay — read a
workspace [Secret](/agent-studio/connections/#secrets-api-keys) instead:

```python
import httpx
import tas_tools

def enrich(domain: str) -> dict:
    """Enrich a company domain via Clay."""
    key = tas_tools.secret("clay")             # set under Connections → Secrets
    r = httpx.post(
        "https://api.clay.com/v1/enrich",
        headers={"Authorization": f"Bearer {key}"},
        json={"domain": domain},
    )
    r.raise_for_status()
    return r.json()

tools = [enrich]
```

`tas_tools.secret("name")` returns the acting user's personal value when set,
then falls back to the workspace-shared value. It raises a clear error if
neither exists. Secrets are only injected into runs that have a tools module.

## Dependencies

The standard library, `httpx`, and `pydantic` are available out of the box. For
other third-party packages (pandas, database drivers, cloud SDKs), add a pinned
line to `api/scripts/requirements-tools.txt` in your TAS deployment and redeploy
— they're installed into the wrapper's Python environment at image build, so a
given image stays reproducible.

## When to reach for this

| Use a sidecar tool when…                          | Use an MCP/Composio tool when…                 |
| ------------------------------------------------- | ---------------------------------------------- |
| The work is deterministic (math, transforms, ETL) | You need a service's managed action surface    |
| You want it off the token budget / faster         | The action is inherently a model decision      |
| You can express it as a small Python function     | The provider already exposes the tool you need |
