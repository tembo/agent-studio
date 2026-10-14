// Generate the Changelog + Roadmap doc pages from the canonical root files
// (CHANGELOG.md / ROADMAP.md) so the published site stays in sync with them.
// Runs as the docs `prebuild` and as part of `pnpm --dir web gen:docs`.
// The in-app viewer ships the generated web/src/lib/docs-content.ts bundle;
// regenerate both copies after editing CHANGELOG.md / ROADMAP.md.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const OUT = join(here, "src/content/docs");

const pages = [
  {
    slug: "changelog",
    file: "CHANGELOG.md",
    title: "Changelog",
    description: "Every notable change to Tembo Agent Studio, by release.",
    // Only release (H2) headings in the right-side TOC — the per-release
    // Added/Changed/Fixed (H3) would otherwise repeat for every version.
    tocMaxLevel: 2,
    // Tidy the release headers for display: drop the Keep-a-Changelog brackets
    // and the "— shipped <date>" suffix. The canonical CHANGELOG.md keeps both
    // (the brackets are its compare-link convention); this only affects the
    // rendered docs page.
    transform: (s) =>
      s
        .replace(/^(##[ \t]+.*?)[ \t]*—[ \t]*shipped[ \t].*$/gim, "$1")
        .replace(/^(##[ \t]+)\[([^\]]+)\]/gim, "$1$2"),
  },
  {
    slug: "roadmap",
    file: "ROADMAP.md",
    title: "Roadmap",
    description: "Where Tembo Agent Studio is headed.",
  },
];

for (const p of pages) {
  const raw = readFileSync(join(ROOT, p.file), "utf8");
  // Drop the leading "# Title" — Starlight renders its own page title.
  const m = raw.match(/^\s*#\s+.+\n([\s\S]*)$/);
  let body = (m ? m[1] : raw).trim();
  if (p.transform) body = p.transform(body);
  const toc = p.tocMaxLevel
    ? `tableOfContents:\n  maxHeadingLevel: ${p.tocMaxLevel}\n`
    : "";
  const frontmatter = `---\ntitle: ${p.title}\ndescription: ${p.description}\n${toc}---\n\n`;
  writeFileSync(join(OUT, `${p.slug}.md`), `${frontmatter}${body}\n`);
  console.log(`gen-project-pages: wrote ${p.slug}.md`);
}
