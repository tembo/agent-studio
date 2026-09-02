# Agents

This folder holds your agent definitions, organized by framework:

```
agents/
├── pydantic-agentspec/    Pydantic AI `AgentSpec` (YAML or JSON)
│   ├── hello-world.yaml        ← starter sample
│   └── hello-world.eval.yaml   ← optional eval sidecar (not an agent)
└── cargo-ai/              Cargo AI JSON
    └── hello-world.json   ← starter sample
```

One subfolder per framework. The create-agent UI writes new files
into the right subfolder automatically based on the parsed shape.

**Supported frameworks:**

- **Pydantic AI `AgentSpec`** (YAML or JSON) — the canonical, primary
  format. Parsed, listed, and **runnable** end-to-end against Anthropic and OpenAI.
- **Cargo AI** (JSON) — single-file definitions with `agent_schema` and
  `actions`. Parsed and listed; runtime support is wired separately.

**Layout is required.** Agents must live in the right framework
subfolder. Files placed directly at `agents/foo.yaml` (no subfolder)
are ignored by the listing surface — move them into
`agents/pydantic-agentspec/` or `agents/cargo-ai/` as appropriate.

**Eval sidecars** (`<name>.eval.yaml`) sit next to the spec and are
not listed as agents. See the Agent evals page in the docs.

For the format decision and rationale, see
[`../context/shipped/0.1/AGENT_FORMAT.md`](../context/shipped/0.1/AGENT_FORMAT.md).
