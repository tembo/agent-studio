# Tembo Agent Studio — user manual

The product user manual, built with [Astro Starlight](https://starlight.astro.build/)
and published to GitHub Pages at **https://tembo.github.io/agent-studio/**.

This is a self-contained Astro project (its own `package.json` / lockfile) — it
does not share the `web/` workspace.

## Run locally

```bash
cd docs
pnpm install
pnpm dev      # http://localhost:4321/agent-studio/
```

`pnpm build` writes the static site to `docs/dist/`; `pnpm preview` serves that
build.

## Authoring

Pages are Markdown / MDX under `src/content/docs/`. Each file needs a frontmatter
`title:` (and ideally a `description:`). The left sidebar order is defined
explicitly in `astro.config.mjs` — add a new page there after creating the file.
Full-text search (Pagefind) and the "Edit page" links are automatic.

## Changelog and in-app docs

`CHANGELOG.md` and `ROADMAP.md` at the repository root are canonical. Do not edit
`src/content/docs/changelog.md`, `src/content/docs/roadmap.md`, or
`web/src/lib/docs-content.ts` by hand. After changing the root files or any
manual page, run from the repository root:

```bash
pnpm --dir web gen:docs
```

This generates the public project pages and bundles the manual for the in-app
`/<workspace>/docs` viewer. Commit all generated changes: web Docker builds use
only the `web/` build context and ship that committed bundle. CI regenerates the
files and fails if the committed copies differ, before internal deployment.

Product PRs must add an entry under `[Unreleased]` in `CHANGELOG.md`. An internal
change with no user-visible impact may instead include a visible PR-body line
`Changelog: not needed — <specific reason>`. The `changelog` check audits PRs,
merged PR events, and each merged PR in main pushes; unrelated manual edits do
not satisfy it. Direct product pushes must include a changelog update. Move
unreleased entries to a dated version section when releasing; GitHub release
notes are supplementary, not a replacement for the canonical file.

## Publishing

A push to `main` that touches `docs/**`, `CHANGELOG.md`, or `ROADMAP.md` triggers
`.github/workflows/deploy-docs.yml`, which builds the site and deploys it to
GitHub Pages. You can also run that workflow manually (`workflow_dispatch`).

**One-time setup:** in the repo's **Settings → Pages → Build and deployment**,
set **Source = "GitHub Actions"**. Until that's done the deploy job has no Pages
site to publish to.

## Moving to a custom domain later

In `astro.config.mjs` set `site` to the domain and `base` to `"/"`, add a
`public/CNAME` file containing the domain, and point a DNS `CNAME` at
`tembo.github.io`. No content changes needed.
