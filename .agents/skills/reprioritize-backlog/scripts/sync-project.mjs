#!/usr/bin/env node

const token = process.env.GH_TOKEN;
if (!token) throw new Error("GH_TOKEN is required");

const repository = process.env.GITHUB_REPOSITORY ?? "tembo/agent-studio";
const [repoOwner, repoName] = repository.split("/");
const projectOwner = process.env.PROJECT_OWNER ?? "tembo";
const projectNumber = Number(process.env.PROJECT_NUMBER ?? "1");
const apiVersion = "2022-11-28";
const mutations = {
  added: 0,
  fieldsUpdated: 0,
  fieldsCleared: 0,
  labelsUpdated: 0,
  positionsUpdated: 0,
  viewsUpdated: 0,
};

async function request(url, options = {}, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": apiVersion,
        ...options.headers,
      },
    });
    if (response.ok) return response.json();
    const body = await response.text();
    if (attempt === attempts || ![502, 503, 504].includes(response.status)) {
      throw new Error(`${response.status} ${response.statusText}: ${body}`);
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
  }
}

async function graphql(query, variables = {}) {
  const result = await request("https://api.github.com/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (result.errors?.length) {
    throw new Error(result.errors.map((error) => error.message).join("; "));
  }
  return result.data;
}

async function getOpenIssues() {
  const issues = [];
  let after = null;
  do {
    const data = await graphql(
      `query($owner: String!, $repo: String!, $after: String) {
        repository(owner: $owner, name: $repo) {
          issues(first: 100, after: $after, states: OPEN) {
            nodes {
              id number title state
              labels(first: 100) { nodes { name } }
              milestone { title }
              blockedBy(first: 100) {
                nodes { id number state repository { nameWithOwner } }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { owner: repoOwner, repo: repoName, after },
    );
    issues.push(...data.repository.issues.nodes);
    if (!data.repository.issues.pageInfo.hasNextPage) break;
    after = data.repository.issues.pageInfo.endCursor;
  } while (true);
  return issues;
}

async function getOpenPullRequestIssueNumbers() {
  const numbers = new Set();
  let after = null;
  do {
    const data = await graphql(
      `query($owner: String!, $repo: String!, $after: String) {
        repository(owner: $owner, name: $repo) {
          pullRequests(first: 100, after: $after, states: OPEN) {
            nodes {
              closingIssuesReferences(first: 50) { nodes { number } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { owner: repoOwner, repo: repoName, after },
    );
    for (const pullRequest of data.repository.pullRequests.nodes) {
      for (const issue of pullRequest.closingIssuesReferences.nodes) {
        numbers.add(issue.number);
      }
    }
    if (!data.repository.pullRequests.pageInfo.hasNextPage) break;
    after = data.repository.pullRequests.pageInfo.endCursor;
  } while (true);
  return numbers;
}

function fieldValue(nodes, name) {
  return nodes.find((node) => node.field?.name === name);
}

async function getProject() {
  const items = [];
  let project = null;
  let after = null;
  do {
    const data = await graphql(
      `query($owner: String!, $number: Int!, $after: String) {
        organization(login: $owner) {
          projectV2(number: $number) {
            id
            fields(first: 50) {
              nodes {
                ... on ProjectV2Field { id name dataType }
                ... on ProjectV2SingleSelectField {
                  id name options { id name }
                }
              }
            }
            view(number: 1) {
              id
              fields(first: 50) {
                nodes {
                  ... on ProjectV2Field { id name }
                  ... on ProjectV2SingleSelectField { id name }
                }
              }
            }
            items(first: 100, after: $after) {
              nodes {
                id
                content {
                  ... on Issue {
                    id number title state
                    repository { nameWithOwner }
                    labels(first: 100) { nodes { name } }
                    milestone { title }
                    blockedBy(first: 100) {
                      nodes { id number state repository { nameWithOwner } }
                    }
                  }
                }
                fieldValues(first: 50) {
                  nodes {
                    ... on ProjectV2ItemFieldNumberValue {
                      number field { ... on ProjectV2Field { name } }
                    }
                    ... on ProjectV2ItemFieldTextValue {
                      text field { ... on ProjectV2Field { name } }
                    }
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name optionId field { ... on ProjectV2SingleSelectField { name } }
                    }
                  }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
      { owner: projectOwner, number: projectNumber, after },
    );
    project ??= data.organization.projectV2;
    items.push(...data.organization.projectV2.items.nodes);
    if (!data.organization.projectV2.items.pageInfo.hasNextPage) break;
    after = data.organization.projectV2.items.pageInfo.endCursor;
  } while (true);
  return { ...project, items };
}

async function addItem(projectId, contentId) {
  const data = await graphql(
    `mutation($project: ID!, $content: ID!) {
      addProjectV2ItemById(input: {projectId: $project, contentId: $content}) {
        item { id }
      }
    }`,
    { project: projectId, content: contentId },
  );
  mutations.added += 1;
  return data.addProjectV2ItemById.item;
}

async function updateField(projectId, itemId, fieldId, value) {
  await graphql(
    `mutation($project: ID!, $item: ID!, $field: ID!, $value: ProjectV2FieldValue!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $project, itemId: $item, fieldId: $field, value: $value
      }) { projectV2Item { id } }
    }`,
    { project: projectId, item: itemId, field: fieldId, value },
  );
  mutations.fieldsUpdated += 1;
}

async function clearField(projectId, itemId, fieldId) {
  await graphql(
    `mutation($project: ID!, $item: ID!, $field: ID!) {
      clearProjectV2ItemFieldValue(input: {
        projectId: $project, itemId: $item, fieldId: $field
      }) { projectV2Item { id } }
    }`,
    { project: projectId, item: itemId, field: fieldId },
  );
  mutations.fieldsCleared += 1;
}

async function positionItem(projectId, itemId, afterId) {
  await graphql(
    `mutation($project: ID!, $item: ID!, $after: ID) {
      updateProjectV2ItemPosition(input: {
        projectId: $project, itemId: $item, afterId: $after
      }) { clientMutationId }
    }`,
    { project: projectId, item: itemId, after: afterId },
  );
  mutations.positionsUpdated += 1;
}

async function replaceStatusLabel(issue, statusName) {
  const names = issue.labels.nodes.map((label) => label.name);
  const next = names.filter((name) => !name.startsWith("status: "));
  next.push(statusName);
  await request(`https://api.github.com/repos/${repository}/issues/${issue.number}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ labels: next }),
  });
  mutations.labelsUpdated += 1;
  issue.labels.nodes = next.map((name) => ({ name }));
}

function labelNames(issue) {
  return issue.labels.nodes.map((label) => label.name);
}

function desiredPriority(issue) {
  const label = labelNames(issue).find((name) => name.startsWith("priority: "));
  if (!label) return null;
  const value = label.slice("priority: ".length);
  return value === "parked" ? "Parked" : value.toUpperCase();
}

function desiredStatus(issue) {
  if (issue.state === "CLOSED") return "Done";
  const label = labelNames(issue).find((name) => name.startsWith("status: "));
  return new Map([
    ["status: triage", "Triage"],
    ["status: ready", "Ready"],
    ["status: in progress", "In Progress"],
    ["status: blocked", "Blocked"],
  ]).get(label) ?? null;
}

function desiredInitiative(issue, current) {
  if (current) return current;
  if (labelNames(issue).includes("user request")) return "User requests";
  if (["Adaptive intelligence", "Mycelium"].includes(issue.milestone?.title)) {
    return issue.milestone.title;
  }
  return "Unassigned";
}

function rank(item) {
  const priority = item.priority;
  const status = item.status;
  if (priority === "P0") return 0;
  if (status === "In Progress") return item.type === "epic" ? 3 : 1;
  const scores = {
    P1: { Ready: 2, Triage: 3, Blocked: 4 },
    P2: { Ready: 4, Triage: 5, Blocked: 8 },
    P3: { Ready: 6, Triage: 7, Blocked: 9 },
    Parked: { Ready: 10, Triage: 10, Blocked: 10 },
  };
  const base = scores[priority]?.[status] ?? 11;
  return status === "Triage" && item.userRequest ? base - 1 : base;
}

function compareItems(left, right) {
  return (
    rank(left) - rank(right) ||
    Number(!left.userRequest) - Number(!right.userRequest) ||
    Number(left.type === "epic") - Number(right.type === "epic") ||
    (left.existingOrder ?? Number.MAX_SAFE_INTEGER) -
      (right.existingOrder ?? Number.MAX_SAFE_INTEGER) ||
    right.issue.number - left.issue.number
  );
}

function topologicalOrder(items) {
  const byNumber = new Map(items.map((item) => [item.issue.number, item]));
  const indegree = new Map(items.map((item) => [item.issue.number, 0]));
  const dependents = new Map(items.map((item) => [item.issue.number, []]));
  for (const item of items) {
    for (const blocker of item.issue.blockedBy.nodes) {
      if (
        blocker.state !== "OPEN" ||
        blocker.repository.nameWithOwner !== repository ||
        !byNumber.has(blocker.number)
      ) continue;
      indegree.set(item.issue.number, indegree.get(item.issue.number) + 1);
      dependents.get(blocker.number).push(item.issue.number);
    }
  }

  const available = items.filter((item) => indegree.get(item.issue.number) === 0);
  const ordered = [];
  while (available.length) {
    available.sort(compareItems);
    const item = available.shift();
    ordered.push(item);
    for (const dependentNumber of dependents.get(item.issue.number)) {
      indegree.set(dependentNumber, indegree.get(dependentNumber) - 1);
      if (indegree.get(dependentNumber) === 0) {
        available.push(byNumber.get(dependentNumber));
      }
    }
  }
  if (ordered.length !== items.length) {
    const cycle = items
      .filter((item) => indegree.get(item.issue.number) > 0)
      .map((item) => `#${item.issue.number}`)
      .join(", ");
    throw new Error(`Dependency cycle detected among ${cycle}`);
  }
  return ordered;
}

function optionId(field, name) {
  const option = field.options.find((candidate) => candidate.name === name);
  if (!option) throw new Error(`${field.name} option ${name} is missing`);
  return option.id;
}

async function ensureVisibleFields(project, fields) {
  const required = ["Priority", "Initiative", "Order"].map((name) => fields.get(name).id);
  const visible = project.view.fields.nodes.map((field) => field.id);
  const next = [...new Set([...visible, ...required])];
  if (next.length === visible.length) return;
  await graphql(
    `mutation($view: ID!, $fields: [ID!]) {
      updateProjectV2View(input: {
        viewId: $view, configuration: {visibleFieldIds: $fields}
      }) { projectV2View { id } }
    }`,
    { view: project.view.id, fields: next },
  );
  mutations.viewsUpdated += 1;
}

const openIssues = await getOpenIssues();
const openPrIssues = await getOpenPullRequestIssueNumbers();
for (const issue of openIssues) {
  if (openPrIssues.has(issue.number) && desiredStatus(issue) !== "In Progress") {
    await replaceStatusLabel(issue, "status: in progress");
  }
}

let project = await getProject();
const projectIssueIds = new Set(
  project.items.map((item) => item.content?.id).filter(Boolean),
);
let addedAny = false;
for (const issue of openIssues) {
  if (!projectIssueIds.has(issue.id)) {
    await addItem(project.id, issue.id);
    addedAny = true;
  }
}
if (addedAny) {
  project = await getProject();
}

const fields = new Map(project.fields.nodes.map((field) => [field.name, field]));
for (const name of ["Priority", "Status", "Initiative", "Order"]) {
  if (!fields.has(name)) throw new Error(`Project field ${name} is missing`);
}
await ensureVisibleFields(project, fields);

const managedItems = project.items.filter(
  (item) => item.content?.repository?.nameWithOwner === repository,
);
const openItems = [];
for (const item of managedItems) {
  const issue = item.content;
  const values = item.fieldValues.nodes;
  const currentPriority = fieldValue(values, "Priority")?.name ?? null;
  const currentStatus = fieldValue(values, "Status")?.name ?? null;
  const currentInitiative = fieldValue(values, "Initiative")?.text ?? null;
  const currentOrder = fieldValue(values, "Order")?.number ?? null;
  const priority = desiredPriority(issue);
  const status = desiredStatus(issue);
  const initiative = desiredInitiative(issue, currentInitiative);

  if (priority && currentPriority !== priority) {
    await updateField(project.id, item.id, fields.get("Priority").id, {
      singleSelectOptionId: optionId(fields.get("Priority"), priority),
    });
  } else if (!priority && currentPriority) {
    await clearField(project.id, item.id, fields.get("Priority").id);
  }
  if (status && currentStatus !== status) {
    await updateField(project.id, item.id, fields.get("Status").id, {
      singleSelectOptionId: optionId(fields.get("Status"), status),
    });
  } else if (!status && currentStatus) {
    await clearField(project.id, item.id, fields.get("Status").id);
  }
  if (currentInitiative !== initiative) {
    await updateField(project.id, item.id, fields.get("Initiative").id, {
      text: initiative,
    });
  }

  if (issue.state === "OPEN") {
    const type = labelNames(issue).find((name) =>
      ["bug", "enhancement", "task", "epic"].includes(name),
    );
    openItems.push({
      item,
      issue,
      priority,
      status,
      type,
      userRequest: labelNames(issue).includes("user request"),
      existingOrder: currentOrder,
    });
  } else if (currentOrder !== null) {
    await clearField(project.id, item.id, fields.get("Order").id);
  }
}

const ordered = topologicalOrder(openItems);
for (const [index, entry] of ordered.entries()) {
  const order = index + 1;
  if (entry.existingOrder !== order) {
    await updateField(project.id, entry.item.id, fields.get("Order").id, { number: order });
  }
}

const managedOpenIds = new Set(ordered.map((entry) => entry.item.id));
const managedClosed = managedItems.filter((item) => !managedOpenIds.has(item.id));
const unmanaged = project.items.filter((item) => !managedItems.includes(item));
const desiredPositions = [
  ...ordered.map((entry) => entry.item),
  ...managedClosed,
  ...unmanaged,
];
const currentPositions = project.items.map((item) => item.id);
if (desiredPositions.some((item, index) => item.id !== currentPositions[index])) {
  let afterId = null;
  for (const item of desiredPositions) {
    await positionItem(project.id, item.id, afterId);
    afterId = item.id;
  }
}

console.log(
  `Synchronized ${managedItems.length} project items; ordered ${ordered.length} open issues.`,
);
console.log(`Mutations: ${JSON.stringify(mutations)}`);
