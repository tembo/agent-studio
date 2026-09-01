#!/usr/bin/env bash
set -euo pipefail

repo="${1:-tembo/agent-studio}"
project_owner="${PROJECT_OWNER:-tembo}"
project_number="${PROJECT_NUMBER:-1}"
audit_dir="$(mktemp -d)"
trap 'rm -rf "$audit_dir"' EXIT

gh issue list \
  --repo "$repo" \
  --state all \
  --limit 1000 \
  --json number,title,url,state,labels,milestone \
  > "$audit_dir/issues.json"

if ! gh project item-list "$project_number" \
  --owner "$project_owner" \
  --limit 1000 \
  --format json \
  > "$audit_dir/project.json"; then
  printf 'Unable to read %s project %s. The token needs Projects v2 read access.\n' \
    "$project_owner" "$project_number" >&2
  exit 1
fi

# GraphQL variables are expanded by GitHub, not by this shell.
# shellcheck disable=SC2016
if ! gh api graphql --paginate --slurp \
  -F owner="$project_owner" \
  -F number="$project_number" \
  -f query='query($owner: String!, $number: Int!, $endCursor: String) {
    organization(login: $owner) {
      projectV2(number: $number) {
        items(first: 100, after: $endCursor) {
          nodes {
            content {
              ... on Issue {
                number
                repository { nameWithOwner }
                parent { number repository { nameWithOwner } }
                blockedBy(first: 100) {
                  nodes { number state repository { nameWithOwner } }
                }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }' \
  > "$audit_dir/dependency-pages.json"; then
  printf 'Unable to read Project dependency relationships.\n' >&2
  exit 1
fi

jq '[.[].data.organization.projectV2.items.nodes[].content | select(.number != null)]' \
  "$audit_dir/dependency-pages.json" > "$audit_dir/dependencies.json"

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
          or ((names | index("user request")) != null and $priority[0] != "priority: p0" and $priority[0] != "priority: p1")
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
      (if (names | index("user request")) != null then "user request" else "" end),
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

repo_slug="$repo" jq -n -r \
  --slurpfile issues "$audit_dir/issues.json" \
  --slurpfile project "$audit_dir/project.json" \
  --slurpfile dependencies "$audit_dir/dependencies.json" '
  def names($issue): [$issue.labels[].name];
  def prefixed($issue; $prefix): first(names($issue)[] | select(startswith($prefix))) // "";
  def expected_priority($issue):
    prefixed($issue; "priority: ")
    | sub("^priority: "; "")
    | if . == "parked" then "Parked" else ascii_upcase end;
  def expected_status($issue):
    if $issue.state == "CLOSED" then "Done"
    else prefixed($issue; "status: ")
      | sub("^status: "; "")
      | if . == "in progress" then "In Progress"
        elif . == "backlog" then "Backlog"
        elif . == "ready" then "Ready"
        elif . == "blocked" then "Blocked"
        else ""
        end
    end;
  ($issues[0] | map({key: (.number | tostring), value: .}) | from_entries) as $by_number
  | ($project[0].items
      | map(select(.content.type == "Issue" and .content.repository == env.repo_slug))) as $items
  | ($items | map({key: (.content.number | tostring), value: .}) | from_entries) as $items_by_number
  | ($dependencies[0] | map({key: (.number | tostring), value: .}) | from_entries) as $dependencies_by_number
  | [
      $issues[0][] as $issue
      | select($issue.state == "OPEN" and $items_by_number[$issue.number | tostring] == null)
      | [($issue.number | tostring), "missing from project", $issue.title]
    ]
    + [
      $items[] as $item
      | ($by_number[$item.content.number | tostring] // null) as $issue
      | ([
          if $issue == null then "not found in repository issue list" else empty end,
          if $issue != null and (($item.priority // "") | ascii_downcase) != (expected_priority($issue) | ascii_downcase)
            then "Priority expected " + expected_priority($issue) + ", got " + ($item.priority // "<empty>") else empty end,
          if $issue != null and (($item.status // "") | ascii_downcase) != (expected_status($issue) | ascii_downcase)
            then "Status expected " + expected_status($issue) + ", got " + ($item.status // "<empty>") else empty end,
          if $issue != null and $issue.state == "OPEN" and (($item.initiative // "") == "")
            then "Initiative is empty" else empty end,
          if $issue != null and $issue.state == "OPEN" and (($item.order // 0) <= 0)
            then "Order must be a positive number" else empty end,
          if $issue != null and $issue.state == "CLOSED" and ($item.order != null)
            then "closed issue must not have Order" else empty end
        ]) as $problems
      | select($problems | length > 0)
      | [($item.content.number | tostring), ($problems | join("; ")), $item.title]
    ]
    + [
      $items
      | map(. as $item | select(($by_number[$item.content.number | tostring].state // "") == "OPEN" and $item.order != null))
      | group_by(.order)[]
      | select(length > 1)
      | .[]
      | [(.content.number | tostring), ("duplicate Order " + (.order | tostring)), .title]
    ]
    + [
      $items[] as $item
      | ($by_number[$item.content.number | tostring] // null) as $issue
      | select($issue != null and $issue.state == "OPEN")
      | ($dependencies_by_number[$item.content.number | tostring].blockedBy.nodes // [])[] as $blocker
      | select($blocker.repository.nameWithOwner == env.repo_slug and $blocker.state == "OPEN")
      | ($items_by_number[$blocker.number | tostring] // null) as $blocker_item
      | if $blocker_item == null then
          [($item.content.number | tostring), ("open blocker #" + ($blocker.number | tostring) + " is missing from project"), $item.title]
        elif (($blocker_item.order // 0) >= ($item.order // 0)) then
          [($item.content.number | tostring), ("Order must follow open blocker #" + ($blocker.number | tostring)), $item.title]
        else empty
        end
    ]
  | .[]
  | @tsv
' > "$audit_dir/project-problems.tsv"

if [[ -s "$audit_dir/project-problems.tsv" ]]; then
  printf 'Backlog Project problems:\n'
  printf 'issue\tproblem\ttitle\n'
  cat "$audit_dir/project-problems.tsv"
  exit 1
fi

printf 'Backlog taxonomy and Project fields are consistent.\n\n'
printf 'order\tpriority\tstatus\tinitiative\tblocked_by\ttype\tuser_request\tmilestone\tissue\ttitle\n'
repo_slug="$repo" jq -n -r \
  --slurpfile issues "$audit_dir/issues.json" \
  --slurpfile project "$audit_dir/project.json" \
  --slurpfile dependencies "$audit_dir/dependencies.json" '
  def names: [.labels[].name];
  def prefixed($prefix): first(names[] | select(startswith($prefix)));
  def type: first(names[] | select(. == "bug" or . == "enhancement" or . == "task" or . == "epic"));
  ($issues[0] | map({key: (.number | tostring), value: .}) | from_entries) as $by_number
  | ($dependencies[0] | map({key: (.number | tostring), value: .}) | from_entries) as $dependencies_by_number
  | $project[0].items
  | map(select(.content.type == "Issue" and .content.repository == env.repo_slug)
      | . as $item
      | $by_number[$item.content.number | tostring] as $issue
      | select($issue.state == "OPEN")
      | $issue + {
          project_priority: $item.priority,
          project_status: $item.status,
          project_initiative: $item.initiative,
          project_order: $item.order,
          project_blocked_by: ($dependencies_by_number[$item.content.number | tostring].blockedBy.nodes // [])
        })
  | sort_by(.project_order, .number)
  | .[]
  | [
      (.project_order | tostring),
      .project_priority,
      .project_status,
      .project_initiative,
      (.project_blocked_by | map("#" + (.number | tostring)) | join(",")),
      type,
      (if (names | index("user request")) != null then "yes" else "" end),
      (.milestone.title // ""),
      ("#" + (.number | tostring)),
      .title
    ]
  | @tsv
'
