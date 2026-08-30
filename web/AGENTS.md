<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project conventions

## Render dates with `<LocalTime>`, never raw `toLocaleString` in server code

The web container runs in UTC, so any server-side `new Date(...).toLocaleString()` (in a server component, page, or layout) emits **UTC** text — not the user's local time. Always render dates through `@/components/local-time`:

```tsx
import { LocalTime } from "@/components/local-time";

<LocalTime iso={someIsoString} />
```

`LocalTime` is a small client component that waits until mount and then formats with `Intl.DateTimeFormat` using the browser's tz. Render nothing inline-of-server before mount to avoid a flash of UTC.

Helper functions that compute *relative* time (e.g. `"13ms after queued"`) or *durations* (e.g. `"1.7s"`) are tz-agnostic and can stay inline — they take two ISO strings and return a difference. Only the absolute display of a wall-clock instant needs `LocalTime`.

## Big grown-by-accretion modules: carve out, don't pile on

Several modules have accreted into broad multi-domain grab-bags
([#311](https://github.com/tembo/agent-studio/issues/311) tracks the current
list — e.g. `lib/api-v1/actions.ts`, `lib/runs-db.ts`, `lib/workspace.ts`,
`app/[workspace]/settings/actions.ts`, `app/[workspace]/agents-inventory.tsx`).
The convention for paying this down is **boy-scout, not big-bang**: no
dedicated refactor PRs; instead, when a feature touches one of these modules,
**extract the domain you're touching into its own module as part of that
change** rather than adding to the pile.

- `settings/actions.ts` → per-domain action files (e.g.
  `settings/members-actions.ts`, `settings/oauth-actions.ts`), re-exporting
  from the original if needed for import stability.
- `runs-db.ts` / `workspace.ts` → split along query-subject lines when your
  change concentrates in one subject.
- Large client components (`agents-inventory.tsx`) → extract the
  self-contained sub-tree (filter bar, table body, row actions) you're
  modifying.

Keep each extraction a **mechanical move + import update in the same PR** as
the feature that motivated it, so review cost stays near zero and the feature's
own testing covers the move. Don't bundle behavior changes into the move
commit.

Two boundaries so this rule doesn't over-trigger:

- **Data-heavy files are exempt.** `mcp-providers.ts` is ~2k lines but ~95%
  flat catalog data — length is not its risk. This convention is about files
  with many unrelated *logic* domains, not long ones.
- **~1,500 lines of logic is the escalation point.** If a module crosses that
  despite boy-scouting, raise it (on #311) for a scheduled split instead of
  ever-larger opportunistic moves.
