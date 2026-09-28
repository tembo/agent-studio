import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { filterSkillsByOwner, SkillsTable, type SkillRow } from "./skills-table";

const rows: SkillRow[] = [
  { name: "writing", description: "Writing", href: "/acme/skills/writing", owner: { userId: "user-1", name: "Alex" } },
  { name: "review", description: null, href: "/acme/skills/review", owner: { userId: "user-2", name: "Alex" } },
  { name: "editing", description: null, href: "/acme/skills/editing", owner: { userId: "user-1", name: "Alex" } },
  { name: "legacy", description: null, href: "/acme/skills/legacy", owner: null },
];

describe("skill owner filtering", () => {
  it("shows all skills by default", () => {
    expect(filterSkillsByOwner(rows, "all")).toEqual(rows);
  });

  it("filters by user ID rather than display name", () => {
    expect(filterSkillsByOwner(rows, "user:user-1").map((row) => row.name)).toEqual(["writing", "editing"]);
  });

  it("includes only unowned skills for Unassigned", () => {
    expect(filterSkillsByOwner(rows, "unassigned").map((row) => row.name)).toEqual(["legacy"]);
  });

  it("returns no matches for an unknown owner", () => {
    expect(filterSkillsByOwner(rows, "user:unknown")).toEqual([]);
  });

  it("renders the owner column and one option per owner", () => {
    const markup = renderToStaticMarkup(<SkillsTable rows={rows} />);
    expect(markup).toContain('for="skill-owner-filter"');
    expect(markup).toContain("All owners");
    expect(markup).toContain("Unassigned");
    expect(markup.match(/value="user:user-1"/g)).toHaveLength(1);
    expect(markup).toContain('value="user:user-2"');
    expect(markup).toMatch(/<th[^>]*>Owner<\/th>/);
  });
});
