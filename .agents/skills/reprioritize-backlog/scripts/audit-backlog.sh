#!/usr/bin/env bash
set -euo pipefail

repo="${1:-tembo/agent-studio}"
audit_dir="$(mktemp -d)"
trap 'rm -rf "$audit_dir"' EXIT

gh issue list \
  --repo "$repo" \
  --state all \
  --limit 1000 \
  --json number,title,url,state,labels,milestone \
  > "$audit_dir/issues.json"

jq -r '
  def names: [.labels[].name];
  def one($prefix): [names[] | select(startswith($prefix))];
  def types: [names[] | select(. == "bug" or . == "enhancement" or . == "task" or . == "epic")];
  .[]
  | (one("priority: ")) as $priority
  | (one("status: ")) as $status
  | (types) as $types
  | select(
      (
        .state == "OPEN"
        and (
          ($priority | length) != 1
          or ($status | length) != 1
          or ($types | length) != 1
          or ((names | index("customer")) != null and $priority[0] != "priority: p0" and $priority[0] != "priority: p1")
        )
      )
      or (.state == "CLOSED" and ($status | length) != 0)
    )
  | [
      (.number | tostring),
      .state,
      ($types | join(",")),
      ($priority | join(",")),
      ($status | join(",")),
      (if (names | index("customer")) != null then "customer" else "" end),
      .title
    ]
  | @tsv
' "$audit_dir/issues.json" > "$audit_dir/problems.tsv"

if [[ -s "$audit_dir/problems.tsv" ]]; then
  printf 'Backlog taxonomy problems:\n'
  printf 'issue\tstate\ttype\tpriority\tstatus\tprovenance\ttitle\n'
  cat "$audit_dir/problems.tsv"
  exit 1
fi

printf 'Backlog taxonomy is consistent.\n\n'
printf 'priority\tstatus\ttype\tcustomer\tmilestone\tissue\ttitle\n'
jq -r '
  def names: [.labels[].name];
  def prefixed($prefix): first(names[] | select(startswith($prefix)));
  def type: first(names[] | select(. == "bug" or . == "enhancement" or . == "task" or . == "epic"));
  def rank:
    if prefixed("priority: ") == "priority: p0" then 0
    elif prefixed("priority: ") == "priority: p1" then 1
    elif prefixed("priority: ") == "priority: p2" then 2
    elif prefixed("priority: ") == "priority: p3" then 3
    else 4
    end;
  map(select(.state == "OPEN"))
  | sort_by(rank, .number)
  | .[]
  | [
      prefixed("priority: "),
      prefixed("status: "),
      type,
      (if (names | index("customer")) != null then "yes" else "" end),
      (.milestone.title // ""),
      ("#" + (.number | tostring)),
      .title
    ]
  | @tsv
' "$audit_dir/issues.json"
