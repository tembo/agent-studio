import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(readFileSync(
  new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8",
));
const script: string = workflow.jobs["bump-compose"].steps[0].run;
const prScript = script.slice(script.indexOf("# Only an existing open PR"));

function runPrStep(mode: string) {
  return spawnSync("bash", ["-c", `
    set -euo pipefail
    gh() {
      case "$1 $2" in
        "pr list")
          case "$TEST_MODE" in
            existing) echo https://github.com/tembo/agent-studio/pull/123 ;;
            list-failure) echo "API unavailable" >&2; return 1 ;;
          esac
          return 0 ;;
        "pr create")
          echo "CREATE_PR"
          if [ "$TEST_MODE" = create-failure ]; then
            echo "GitHub Actions is not permitted to create pull requests" >&2
            return 1
          fi ;;
        *) echo "Unexpected command" >&2; return 2 ;;
      esac
    }
    ${prScript}
  `], {
    encoding: "utf8",
    env: {
      ...process.env,
      TEST_MODE: mode,
      REPO: "tembo/agent-studio",
      BRANCH: "release/bump-compose-2026.10.3",
      TITLE: "Release version update",
      REF_NAME: "v2026.10.3",
    },
  });
}

describe("release compose PR handling", () => {
  it("has valid shell syntax", () => {
    expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
    expect(script).toContain("# Only an existing open PR");
  });

  it("creates a PR when none exists", () => {
    const result = runPrStep("new");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("CREATE_PR");
  });

  it("does not create a duplicate open PR", () => {
    const result = runPrStep("existing");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Updated existing release PR:");
    expect(result.stdout).not.toContain("CREATE_PR");
  });

  it("fails with an actionable error when PR creation is denied", () => {
    const result = runPrStep("create-failure");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("::error::");
    expect(result.stdout).toContain("Allow GitHub Actions to create and approve pull requests");
  });

  it("fails without creating a PR when the existing-PR lookup fails", () => {
    const result = runPrStep("list-failure");
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("CREATE_PR");
  });
});
