import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("one generation command refreshes root project pages and the bundled in-app manual", (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "tas-docs-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  for (const path of ["docs/gen-project-pages.mjs", "web/scripts/gen-docs.mjs"]) {
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    copyFileSync(join(root, path), join(fixture, path));
  }
  mkdirSync(join(fixture, "docs/src/content/docs"), { recursive: true });
  mkdirSync(join(fixture, "web/src/lib"), { recursive: true });
  const write = (path, value) => writeFileSync(join(fixture, path), value);
  const read = (path) => readFileSync(join(fixture, path), "utf8");
  const generate = () => execFileSync(process.execPath, [join(fixture, "web/scripts/gen-docs.mjs")]);
  const bundle = () => JSON.parse(read("web/src/lib/docs-content.ts").split("export const DOCS: Record<string, DocPage> = ")[1].trim().slice(0, -1));
  write("CHANGELOG.md", "# Changelog\n\n## [v2026.10.11] — shipped 2026-10-09\n\n- Run cost fix.\n");
  write("ROADMAP.md", "# Roadmap\n\nNext milestone.\n");
  write("docs/src/content/docs/running-agents.md", "---\ntitle: Running agents\n---\n\nRun instructions.\n");
  write("docs/src/content/docs/changelog.md", "Stale published changelog.");
  write("web/src/lib/docs-content.ts", "Stale in-app changelog.");
  generate();
  assert.match(read("docs/src/content/docs/changelog.md"), /## v2026\.10\.11\n\n- Run cost fix\./);
  assert.doesNotMatch(read("docs/src/content/docs/changelog.md"), /Stale|shipped/);
  assert.match(bundle().changelog.body, /Run cost fix/);
  assert.equal(bundle().roadmap.body, "Next milestone.");
  assert.equal(bundle()["running-agents"].body, "Run instructions.");
  const initial = read("web/src/lib/docs-content.ts");
  generate();
  assert.equal(read("web/src/lib/docs-content.ts"), initial);
  write("CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n- A newly merged feature.\n");
  write("ROADMAP.md", "# Roadmap\n\nUpdated milestone.\n");
  generate();
  assert.match(read("docs/src/content/docs/changelog.md"), /newly merged feature/);
  assert.match(bundle().changelog.body, /newly merged feature/);
  assert.equal(bundle().roadmap.body, "Updated milestone.");
});
