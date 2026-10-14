const { execFileSync } = require("node:child_process");

function isProductFile(path) {
  if (path === "web/src/lib/docs-content.ts") return false;
  if (/(^|\/)(__tests__|__fixtures__|tests)\/|(^|\/)(test_[^/]+\.py|tests\.rs)$|\.(test|spec)\.[^/]+$/.test(path)) return false;
  return /^(web\/(src|public|patches)\/|api\/(src|scripts|migrations)\/)/.test(path)
    || /^(web\/(package\.json|pnpm-lock\.yaml|Dockerfile)|api\/(Cargo\.(toml|lock)|Dockerfile)|compose[^/]*\.ya?ml|docker-compose\.ya?ml)$/.test(path);
}

function checkChange(files, body = "") {
  if (!files.some((file) => isProductFile(file.filename)
    || (file.previous_filename && isProductFile(file.previous_filename)))) {
    return "No product changes requiring a changelog entry.";
  }
  if (files.some((file) => file.filename === "CHANGELOG.md"
    && file.status !== "removed" && file.additions > 0)) {
    return "CHANGELOG.md updated.";
  }
  // Inspect non-comment segments separately: removing comments could join text
  // into an exemption that was never written. Unclosed comments hide the rest.
  const exemption = (body || "")
    .split(/<!--[\s\S]*?(?:-->|$)/)
    .map((segment) => segment.match(/^Changelog: not needed — (\S[^\r\n]*)$/m)?.[1]?.trim())
    .find(Boolean);
  if (exemption) return `Changelog exemption: ${exemption}`;
  throw new Error("Product changes need an entry in CHANGELOG.md under Unreleased. "
    + "For changes with no user-visible impact, explain why in the PR body: "
    + "Changelog: not needed — <reason>. Then run pnpm --dir web gen:docs.");
}

async function checkPullRequest({ github, context, core }, pr) {
  const files = await github.paginate(github.rest.pulls.listFiles, {
    ...context.repo, pull_number: pr.number, per_page: 100,
  });
  // GitHub caps this endpoint at 3,000 files. Never silently check a partial diff.
  if (files.length !== pr.changed_files) {
    throw new Error(`PR #${pr.number}: incomplete file list; cannot verify changelog coverage.`);
  }
  core.info(`PR #${pr.number}: ${checkChange(files, pr.body)}`);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

async function run(args, readGit = git) {
  const { github, context, core } = args;
  if (context.payload.pull_request) {
    await checkPullRequest(args, context.payload.pull_request);
    return;
  }
  // The reusable checks workflow runs here on main pushes, before deployment.
  // Audit every merged PR in a batch, including squash, merge and rebase merges.
  const before = context.payload.before;
  if (!before || /^0+$/.test(before)) {
    throw new Error("Missing push base; cannot verify changelog coverage.");
  }
  const commits = readGit("rev-list", "--first-parent", `${before}..${context.sha}`)
    .split("\n").filter(Boolean);
  const prs = new Map();
  const directCommits = [];
  for (const sha of commits) {
    const associated = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, {
      ...context.repo, commit_sha: sha, per_page: 100,
    });
    const merged = associated.filter((pr) => pr.merged_at
      && pr.base.ref === "main" && commits.includes(pr.merge_commit_sha));
    for (const pr of merged) prs.set(pr.number, pr);
    if (!merged.length) directCommits.push(sha);
  }
  for (const number of prs.keys()) {
    const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
    await checkPullRequest(args, pr);
  }
  if (directCommits.length) {
    // Direct pushes have no PR body exemption. Check their complete pushed diff,
    // allowing a follow-up changelog commit within the same push.
    const files = readGit("diff", "--numstat", "--no-renames", before, context.sha)
      .split("\n").filter(Boolean).map((line) => {
        const [additions, , filename] = line.split("\t");
        return { filename, additions: Number(additions) };
      });
    core.info(`Push: ${checkChange(files)}`);
  }
}

module.exports = { isProductFile, checkChange, run };
