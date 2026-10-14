const assert = require("node:assert/strict");
const { test } = require("node:test");
const { checkChange, isProductFile, run } = require("./check-changelog.cjs");

const product = { filename: "web/src/lib/runner.ts", additions: 1 };
const changelog = { filename: "CHANGELOG.md", additions: 1 };
const reason = "Changelog: not needed — Internal refactor preserving existing behavior.";

test("runtime, migrations, providers, assets, dependencies and deploy defaults need entries", () => {
  for (const path of ["web/src/app/page.tsx", "web/src/lib/auth.ts", "api/src/run.rs",
    "api/scripts/run_pydantic.py", "api/migrations/0101_update.sql", "web/public/logo.svg",
    "web/package.json", "web/pnpm-lock.yaml", "api/Cargo.lock", "api/Dockerfile",
    "compose.release.yaml", "docker-compose.yml"]) {
    assert.equal(isProductFile(path), true, path);
    assert.throws(() => checkChange([{ filename: path }]), /need an entry/);
  }
});

test("docs, tests and tooling alone do not need product changelog entries", () => {
  for (const path of ["docs/README.md", "web/src/lib/docs-content.ts", "api/tests/test_run.py",
    "web/src/lib/auth.test.ts", "api/src/tests.rs", "api/src/runs/tests/runner.rs", "web/src/lib/__fixtures__/run.ts", ".github/workflows/checks.yml"]) {
    assert.equal(isProductFile(path), false, path);
  }
  assert.match(checkChange([{ filename: "docs/README.md" }]), /No product changes/);
});

test("canonical changelog additions pass; generated docs or deletion alone do not", () => {
  assert.match(checkChange([product, changelog]), /updated/);
  for (const entry of [
    { filename: "docs/src/content/docs/changelog.md", additions: 10 },
    { filename: "web/src/lib/docs-content.ts", additions: 10 },
    { ...changelog, additions: 0 },
    { ...changelog, status: "removed" },
  ]) assert.throws(() => checkChange([product, entry]), /need an entry/);
});

test("renaming product code outside runtime paths still needs an entry", () => {
  assert.throws(() => checkChange([{
    filename: "scripts/old-runner.ts", previous_filename: product.filename,
  }]), /need an entry/);
});

test("exemptions require a visible, nonempty explanation", () => {
  assert.match(checkChange([product], reason), /Internal refactor/);
  for (const body of [null, "", "Changelog: not needed — ", `<!-- ${reason} -->`,
    "Changelog: not needed", "<!--\nChangelog: not needed — <reason>\n-->"]) {
    assert.throws(() => checkChange([product], body), /need an entry/);
  }
});

test("comments cannot assemble an exemption or expose an unterminated example", () => {
  for (const body of [
    "Changelog: not <!-- template -->needed — Internal refactor.",
    `<!-- Unfinished template\n${reason}`,
    `<!-- Closed example: ${reason} -->\n<!--\n${reason}`,
  ]) {
    assert.throws(() => checkChange([product], body), /need an entry/);
  }
  assert.match(checkChange([product], `<!-- Template -->\n${reason}\n<!-- Notes -->`), /Internal refactor/);
});

function fixture(prs, files) {
  const messages = [];
  const checked = [];
  const listFiles = Symbol("files");
  const associated = Symbol("associated");
  return {
    checked,
    messages,
    context: { repo: { owner: "tembo", repo: "agent-studio" }, payload: {} },
    core: { info: (message) => messages.push(message) },
    github: {
      rest: {
        pulls: { listFiles, get: async ({ pull_number }) => ({ data: prs[pull_number] }) },
        repos: { listPullRequestsAssociatedWithCommit: associated },
      },
      paginate: async (method, params) => {
        assert.equal(params.per_page, 100);
        if (method === listFiles) {
          checked.push(params.pull_number);
          return files[params.pull_number];
        }
        assert.equal(method, associated);
        return Object.values(prs);
      },
    },
  };
}

test("PR and merged-PR events enforce the same policy", async () => {
  for (const merged of [false, true]) {
    const pr = { number: 1, merged, changed_files: 1, body: "" };
    const args = fixture({ 1: pr }, { 1: [product] });
    args.context.payload.pull_request = pr;
    await assert.rejects(run(args), /need an entry/);
    pr.body = reason;
    await run(args);
    assert.match(args.messages[0], /exemption/);
  }
});

test("incomplete file lists fail closed", async () => {
  const pr = { number: 1, changed_files: 3001 };
  const args = fixture({ 1: pr }, { 1: [product, changelog] });
  args.context.payload.pull_request = pr;
  await assert.rejects(run(args), /incomplete file list/);
});

test("main push audits each merged PR instead of allowing one entry to cover a batch", async () => {
  const sha = "new-merge";
  const before = "base";
  const previous = "earlier-merge";
  const readGit = (...args) => {
    assert.deepEqual(args, ["rev-list", "--first-parent", `${before}..${sha}`]);
    return `${sha}\n${previous}`;
  };
  const prs = {
    1: { number: 1, changed_files: 2, merged_at: "2026-10-14", base: { ref: "main" }, merge_commit_sha: previous },
    2: { number: 2, changed_files: 1, merged_at: "2026-10-14", base: { ref: "main" }, merge_commit_sha: sha },
  };
  const args = fixture(prs, { 1: [product, changelog], 2: [product] });
  args.context.payload.before = before;
  args.context.sha = sha;
  await assert.rejects(run(args, readGit), /need an entry/);
  assert.deepEqual(args.checked, [1, 2]);
  prs[2].body = reason;
  await run(args, readGit);
});

test("missing push bases are errors, not silent skips", async () => {
  const args = fixture({}, {});
  await assert.rejects(run(args), /Missing push base/);
  args.context.payload.before = "0".repeat(40);
  await assert.rejects(run(args), /Missing push base/);
});


test("direct product pushes require an entry in the whole pushed diff", async () => {
  const args = fixture({}, {});
  args.context.payload.before = "base";
  args.context.sha = "head";
  let diff = "1\t0\tweb/src/lib/runner.ts";
  const readGit = (...command) => {
    if (command[0] === "rev-list") return "head\nfollow-up";
    assert.deepEqual(command, ["diff", "--numstat", "--no-renames", "base", "head"]);
    return diff;
  };
  await assert.rejects(run(args, readGit), /need an entry/);
  diff += "\n3\t0\tCHANGELOG.md";
  await run(args, readGit);
  assert.match(args.messages[0], /updated/);
});

test("a rebased PR associated with multiple pushed commits is checked once", async () => {
  const pr = { number: 1, changed_files: 2, merged_at: "2026-10-14",
    base: { ref: "main" }, merge_commit_sha: "last-rebased-commit" };
  const args = fixture({ 1: pr }, { 1: [product, changelog] });
  args.context.payload.before = "base";
  args.context.sha = "last-rebased-commit";
  await run(args, () => "last-rebased-commit\nfirst-rebased-commit");
  assert.deepEqual(args.checked, [1]);
});
