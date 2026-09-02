#!/usr/bin/env bash
# Runner command for TAS agent evals. Used by the GitHub Action and locally:
#   TAS_URL=https://tas.example TAS_API_TOKEN=tas_… ./scripts/run-agent-evals.sh
set -euo pipefail

TAS_URL="${TAS_URL:-}"
TAS_API_TOKEN="${TAS_API_TOKEN:-}"
TAS_EVAL_VERSION="${TAS_EVAL_VERSION:-draft}"
EVAL_BASE_SHA="${EVAL_BASE_SHA:-}"
COMMIT_SHA="${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || true)}"
AGENTS_DIR="${AGENTS_DIR:-agents}"
POLL_SECONDS="${POLL_SECONDS:-3}"
MAX_WAIT_SECONDS="${MAX_WAIT_SECONDS:-900}"

usage() {
  cat <<'EOF'
Run TAS eval suites for agents that have a colocated *.eval.yaml file.

Required environment:
  TAS_URL          TAS origin, e.g. https://tas.example.com
  TAS_API_TOKEN    Operator API key (tas_…)

Optional:
  TAS_EVAL_VERSION draft (default) or stable
  EVAL_BASE_SHA    If set, only agents changed since this SHA are evaluated
  AGENTS_DIR       Directory to scan (default: agents)
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ -z "$TAS_URL" || -z "$TAS_API_TOKEN" ]]; then
  echo "TAS_URL and TAS_API_TOKEN are required." >&2
  usage >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required." >&2
  exit 2
fi

TAS_URL="${TAS_URL%/}"
API="$TAS_URL/api/v1"

is_eval_file() {
  [[ "$1" =~ \.eval\.(ya?ml|json)$ ]]
}

is_agent_file() {
  local f="$1"
  if is_eval_file "$f"; then
    return 1
  fi
  [[ "$f" =~ \.(ya?ml|json)$ ]]
}

stem_of() {
  local f="$1"
  echo "$f" | sed -E 's/\.eval\.(ya?ml|json)$//; s/\.(ya?ml|json)$//'
}

basename_stem() {
  local stem="$1"
  basename "$stem"
}

find_agent_file() {
  local stem="$1"
  local cand
  for cand in "$stem.yaml" "$stem.yml" "$stem.json"; do
    if [[ -f "$cand" ]]; then
      echo "$cand"
      return 0
    fi
  done
  return 1
}

find_eval_file() {
  local stem="$1"
  local cand
  for cand in "$stem.eval.yaml" "$stem.eval.yml" "$stem.eval.json"; do
    if [[ -f "$cand" ]]; then
      echo "$cand"
      return 0
    fi
  done
  return 1
}

collect_changed_stems() {
  local file stem
  if [[ -n "$EVAL_BASE_SHA" ]]; then
    git diff --name-only "$EVAL_BASE_SHA"...HEAD -- "$AGENTS_DIR" || true
  else
    git ls-files "$AGENTS_DIR"
  fi | while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    if is_agent_file "$file" || is_eval_file "$file"; then
      stem_of "$file"
    fi
  done | sort -u
}

extract_name() {
  local spec="$1"
  local name
  name="$(printf '%s\n' "$spec" | sed -nE 's/^[[:space:]]*"?name"?[[:space:]]*[:=][[:space:]]*"?([^",}]+)"?.*/\1/p' | head -1 | tr -d '[:space:]')"
  printf '%s' "$name"
}

post_eval() {
  local agent="$1"
  local spec="$2"
  local eval_body="$3"
  jq -n \
    --arg agent "$agent" \
    --arg spec "$spec" \
    --arg eval "$eval_body" \
    --arg version "$TAS_EVAL_VERSION" \
    --arg sha "$COMMIT_SHA" \
    '{
      agent: $agent,
      version: $version,
      spec: $spec,
      eval: $eval,
      commitSha: $sha,
      source: "ci"
    }' | curl -sS -X POST "$API/evals" \
      -H "Authorization: Bearer $TAS_API_TOKEN" \
      -H "Content-Type: application/json" \
      --data-binary @-
}

poll_eval() {
  local id="$1"
  local elapsed=0
  local body status
  while (( elapsed < MAX_WAIT_SECONDS )); do
    body="$(curl -sS "$API/evals/$id" -H "Authorization: Bearer $TAS_API_TOKEN")"
    status="$(printf '%s' "$body" | jq -r '.eval.status // empty')"
    case "$status" in
      passed|failed|error)
        printf '%s' "$body"
        return 0
        ;;
    esac
    sleep "$POLL_SECONDS"
    elapsed=$((elapsed + POLL_SECONDS))
  done
  echo "timed out waiting for eval $id" >&2
  return 1
}

stems="$(collect_changed_stems || true)"
if [[ -z "$stems" ]]; then
  echo "No agent files changed; nothing to eval."
  exit 0
fi

failed=0
ran=0
while IFS= read -r stem; do
  [[ -z "$stem" ]] && continue
  agent_file="$(find_agent_file "$stem" || true)"
  eval_file="$(find_eval_file "$stem" || true)"
  if [[ -z "$eval_file" ]]; then
    echo "skip $(basename_stem "$stem"): no eval sidecar"
    continue
  fi
  if [[ -z "$agent_file" ]]; then
    echo "skip $(basename_stem "$stem"): eval file without an agent spec"
    continue
  fi

  spec="$(cat "$agent_file")"
  eval_body="$(cat "$eval_file")"
  agent="$(extract_name "$spec")"
  if [[ -z "$agent" ]]; then
    agent="$(basename_stem "$stem")"
  fi

  echo "Evaluating $agent ($eval_file) against $TAS_EVAL_VERSION…"
  response="$(post_eval "$agent" "$spec" "$eval_body")"
  eval_id="$(printf '%s' "$response" | jq -r '.eval_id // empty')"
  if [[ -z "$eval_id" ]]; then
    echo "Failed to start eval for $agent:" >&2
    echo "$response" >&2
    failed=$((failed + 1))
    ran=$((ran + 1))
    continue
  fi

  result="$(poll_eval "$eval_id")"
  status="$(printf '%s' "$result" | jq -r '.eval.status')"
  passed="$(printf '%s' "$result" | jq -r '.eval.passedCount')"
  failed_count="$(printf '%s' "$result" | jq -r '.eval.failedCount')"
  echo "$agent: $status ($passed passed, $failed_count failed)  eval_id=$eval_id"
  printf '%s' "$result" | jq -r '.eval.cases[]? | "  - \(.name): \(if .passed then "pass" else "FAIL" end) — \(.reason)"'
  ran=$((ran + 1))
  if [[ "$status" != "passed" ]]; then
    failed=$((failed + 1))
  fi
done <<< "$stems"

if (( ran == 0 )); then
  echo "No changed agents have an eval file; check passes."
  exit 0
fi

if (( failed > 0 )); then
  echo "$failed of $ran eval suite(s) failed."
  exit 1
fi

echo "All $ran eval suite(s) passed."
