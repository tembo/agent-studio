import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Execute the real entry point with isolated credentials and a fetch stub that
// rejects unexpected requests. No production token or network access is used.
const source = (await readFile(new URL("./sync-project.mjs", import.meta.url), "utf8"))
  .replace(/^#![^\n]*\n/, "");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runScript = new AsyncFunction("fetch", "process", "console", source);
const fields = [
  { id: "priority", name: "Priority", options: ["P0", "P1", "P2", "P3", "Parked"].map(name => ({ id: name, name })) },
  { id: "status", name: "Status", options: ["Backlog", "Ready", "In Progress", "Blocked", "Done"].map(name => ({ id: name, name })) },
  { id: "initiative", name: "Initiative" },
  { id: "order", name: "Order" },
];

function item(number, {
  labels = ["priority: p1", "status: ready"],
  state = "OPEN", priority = "P1", status = "Ready", order = number,
  initiative = "Runtime safety", blockers = [],
} = {}) {
  return {
    id: `item-${number}`, isArchived: false,
    content: {
      id: `issue-${number}`, number, title: `Issue ${number}`, state,
      repository: { nameWithOwner: "tembo/agent-studio" },
      labels: { nodes: labels.map(name => ({ name })) },
      milestone: null,
      blockedBy: { nodes: blockers.map(number => ({
        number, state: "OPEN", repository: { nameWithOwner: "tembo/agent-studio" },
      })) },
    },
    fieldValues: { nodes: [
      ...(priority === null ? [] : [{ field: { name: "Priority" }, name: priority }]),
      ...(status === null ? [] : [{ field: { name: "Status" }, name: status }]),
      ...(initiative === null ? [] : [{ field: { name: "Initiative" }, text: initiative }]),
      ...(order === null ? [] : [{ field: { name: "Order" }, number: order }]),
    ] },
  };
}

async function sync(items, { env = {}, pullRequests = [], newItems = [] } = {}) {
  const writes = [];
  const logs = [];
  const warnings = [];
  const project = {
    id: "project", fields: { nodes: fields },
    view: { id: "view", fields: { nodes: fields } },
    items: { nodes: items.filter(item => !newItems.includes(item.content.number)), pageInfo: { hasNextPage: false } },
  };
  await runScript(async (url, options) => {
    if (url.startsWith("https://api.github.com/repos/tembo/agent-studio/issues/")) {
      assert.match(url, /\/issues\/\d+\/labels(?:\/status%3A%20[^/]+)?$/);
      assert.ok(["POST", "DELETE"].includes(options.method));
      writes.push({ operation: "label", url, method: options.method, body: options.body && JSON.parse(options.body) });
      return { ok: true, json: async () => [] };
    }
    assert.equal(url, "https://api.github.com/graphql");
    const { query, variables } = JSON.parse(options.body);
    let data;
    if (query.includes("addProjectV2ItemById")) {
      const added = items.find(item => item.content.id === variables.content);
      project.items.nodes.push(added);
      writes.push({ operation: "add", ...variables });
      data = { addProjectV2ItemById: { item: { id: added.id } } };
    } else if (query.includes("updateProjectV2ItemFieldValue")) {
      writes.push({ operation: "update", ...variables });
      data = {};
    } else if (query.includes("clearProjectV2ItemFieldValue")) {
      writes.push({ operation: "clear", ...variables });
      data = {};
    } else if (query.includes("updateProjectV2ItemPosition")) {
      writes.push({ operation: "position", ...variables });
      data = {};
    } else if (query.includes("organization(login:")) {
      data = { organization: { projectV2: project } };
    } else if (query.includes("pullRequests(first:")) {
      data = { repository: { pullRequests: { nodes: pullRequests, pageInfo: { hasNextPage: false } } } };
    } else if (query.includes("issues(first:")) {
      data = { repository: { issues: {
        nodes: items.filter(item => item.content.state === "OPEN").map(item => item.content),
        pageInfo: { hasNextPage: false },
      } } };
    } else {
      assert.fail(`Unexpected request: ${query}`);
    }
    return { ok: true, json: async () => ({ data }) };
  }, { env: { GH_TOKEN: "test-only", ...env } }, {
    log: message => logs.push(message), warn: message => warnings.push(message),
  });
  return { writes, logs, warnings };
}

for (const [name, labels, warningCount] of [
  ["missing labels", [], 1],
  ["missing priority", ["status: ready"], 1],
  ["missing status", ["priority: p1"], 0],
  ["invalid labels", ["priority: urgent", "status: unknown"], 1],
  ["conflicting labels", ["priority: p2", "priority: p3", "status: blocked", "status: backlog"], 1],
  ["valid plus invalid labels", ["priority: p2", "priority: urgent", "status: blocked", "status: unknown"], 1],
]) {
  test(`${name} preserve Project fields and their ranking`, async () => {
    const result = await sync([
      item(1, { labels: [...labels, "user request"] }),
      item(2, { labels: ["priority: p2", "status: ready"], priority: "P2" }),
    ]);
    assert.deepEqual(result.writes.filter(write => write.operation !== "label"), []);
    assert.equal(result.warnings.length, warningCount);
    assert.ok(result.warnings.every(message => /#1 (Priority|Status):.*preserving/.test(message)));
  });
}

test("matching labels are idempotent", async () => {
  const result = await sync([item(1)]);
  assert.deepEqual(result.writes, []);
  assert.deepEqual(result.warnings, []);
});

test("explicit status label edits update fields and log old/new values", async () => {
  const result = await sync([item(1, { labels: ["priority: parked", "status: blocked"] })], {
    env: { STATUS_LABEL_ISSUE: "1", STATUS_LABEL: "status: blocked" },
  });
  assert.deepEqual(result.writes.map(({ field, value }) => ({ field, value })), [
    { field: "priority", value: { singleSelectOptionId: "Parked" } },
    { field: "status", value: { singleSelectOptionId: "Blocked" } },
  ]);
  assert.ok(result.logs.includes('#1 Priority: "P1" -> "Parked" (priority label).'));
  assert.ok(result.logs.includes('#1 Status: "Ready" -> "Blocked" (status label event).'));
});

for (const labels of [[], ["priority: p3"]]) {
  test(`closed issue preserves historical Priority with labels ${JSON.stringify(labels)}`, async () => {
    const result = await sync([item(1, { state: "CLOSED", labels })]);
    assert.deepEqual(result.writes.map(({ operation, field, value }) => ({ operation, field, value })), [
      { operation: "update", field: "status", value: { singleSelectOptionId: "Done" } },
      { operation: "clear", field: "order", value: undefined },
    ]);
    assert.ok(result.logs.includes('#1 Status: "Ready" -> "Done" (issue closed).'));
    assert.ok(result.logs.includes('#1 Order: 1 -> null (issue closed).'));
  });
}

test("unset fields remain unset without valid labels", async () => {
  const result = await sync([item(1, { labels: [], priority: null, status: null })]);
  assert.deepEqual(result.writes, []);
  assert.equal(result.warnings.length, 2);
});

test("valid labels fill unset fields and initiative defaults still apply", async () => {
  const result = await sync([item(1, { priority: null, status: null, initiative: null })]);
  assert.deepEqual(result.writes.map(({ field, value }) => ({ field, value })), [
    { field: "priority", value: { singleSelectOptionId: "P1" } },
    { field: "status", value: { singleSelectOptionId: "Ready" } },
    { field: "initiative", value: { text: "Unassigned" } },
  ]);
  assert.ok(result.logs.includes('#1 Initiative: null -> "Unassigned" (initiative default).'));
});

test("dependencies still override preserved priorities and log order changes", async () => {
  const result = await sync([
    item(1, { labels: [], priority: "P0", blockers: [2] }),
    item(2, { labels: [], priority: "P2" }),
  ]);
  assert.deepEqual(result.writes.filter(write => write.field === "order").map(({ item, value }) => ({ item, value })), [
    { item: "item-2", value: { number: 1 } },
    { item: "item-1", value: { number: 2 } },
  ]);
  assert.deepEqual(result.writes.filter(write => write.operation === "position").map(({ item }) => item), ["item-2", "item-1"]);
  assert.ok(result.logs.includes('#2 Order: 2 -> 1 (backlog ranking).'));
  assert.ok(result.logs.includes('#1 Order: 1 -> 2 (backlog ranking).'));
});

for (const status of ["Ready", "In Progress", "Blocked"]) {
  test(`routine reranking preserves manual ${status} over a stale Backlog label`, async () => {
    const entry = item(1, { status, labels: ["priority: p1", "status: backlog", "user request"] });
    const result = await sync([entry]);
    assert.deepEqual(result.writes, [
      { operation: "label", url: "https://api.github.com/repos/tembo/agent-studio/issues/1/labels", method: "POST", body: { labels: [`status: ${status.toLowerCase()}`] } },
      { operation: "label", url: "https://api.github.com/repos/tembo/agent-studio/issues/1/labels/status%3A%20backlog", method: "DELETE", body: undefined },
    ]);
    assert.deepEqual(entry.content.labels.nodes.map(label => label.name), ["priority: p1", "user request", `status: ${status.toLowerCase()}`]);
    assert.deepEqual((await sync([entry])).writes, []);
  });
}

test("a deliberate Backlog label edit applies only to its issue", async () => {
  const result = await sync([1, 2].map(number => item(number, { labels: ["priority: p1", "status: backlog"] })), {
    env: { STATUS_LABEL_ISSUE: "1", STATUS_LABEL: "status: backlog" },
  });
  assert.deepEqual(result.writes.filter(write => write.field === "status"), [
    { operation: "update", project: "project", item: "item-1", field: "status", value: { singleSelectOptionId: "Backlog" } },
  ]);
});

test("a superseded status event does not overwrite the project", async () => {
  const result = await sync([item(1)], { env: { STATUS_LABEL_ISSUE: "1", STATUS_LABEL: "status: backlog" } });
  assert.deepEqual(result.writes, []);
});

test("new project items initialize from their labels despite the project Backlog default", async () => {
  const result = await sync([item(1, { status: "Backlog" })], { newItems: [1] });
  assert.deepEqual(result.writes.filter(write => write.field === "status").map(write => write.value), [
    { singleSelectOptionId: "Ready" },
  ]);
});

for (const labels of [["priority: p1"], ["priority: p1", "status: ready"]]) {
  test(`reopened issues leave Done with labels ${JSON.stringify(labels)}`, async () => {
    const result = await sync([item(1, { status: "Done", labels })]);
    assert.deepEqual(result.writes.filter(write => write.field === "status").map(write => write.value), [
      { singleSelectOptionId: labels.includes("status: ready") ? "Ready" : "Backlog" },
    ]);
  });
}

test("open linked PRs still mark the project and label In Progress", async () => {
  const result = await sync([item(1)], { pullRequests: [{ title: "Implement fix", body: "Fixes #1" }] });
  assert.deepEqual(result.writes.filter(write => write.field === "status").map(write => write.value), [
    { singleSelectOptionId: "In Progress" },
  ]);
  assert.ok(result.writes.some(write => write.operation === "label" && write.body?.labels[0] === "status: in progress"));
});

for (const priority of ["P2", "P3", "Parked"]) {
  for (const status of ["In Progress", "Ready", "Blocked", "Backlog"]) {
    test(`P1 Backlog stays ahead of ${priority} ${status}`, async () => {
      const result = await sync([
        item(1, { priority, status, labels: [`priority: ${priority.toLowerCase()}`, `status: ${status.toLowerCase()}`] }),
        item(2, { status: "Backlog", labels: ["priority: p1", "status: backlog"] }),
      ]);
      assert.deepEqual(result.writes.filter(write => write.operation === "position").map(write => write.item), ["item-2", "item-1"]);
    });
  }
}

test("status orders work within the same priority", async () => {
  const statuses = ["Backlog", "Blocked", "Ready", "In Progress"];
  const result = await sync(statuses.map((status, index) => item(index + 1, {
    status, labels: ["priority: p1", `status: ${status.toLowerCase()}`],
  })));
  assert.deepEqual(result.writes.filter(write => write.operation === "position").map(write => write.item), ["item-4", "item-3", "item-2", "item-1"]);
});

test("a lower-priority dependency still precedes a P1 Backlog issue", async () => {
  const result = await sync([
    item(1, { status: "Backlog", labels: ["priority: p1", "status: backlog"], blockers: [2] }),
    item(2, { priority: "P3", labels: ["priority: p3", "status: ready"] }),
  ]);
  assert.deepEqual(result.writes.filter(write => write.operation === "position").map(write => write.item), ["item-2", "item-1"]);
});
