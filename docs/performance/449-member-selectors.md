# Issue #449: bounded member selectors

The agent header previously loaded every member on every layout execution to
label one owner and populate an admin Run as select. Schedule create/edit routes
also loaded all members before rendering their forms.

The header now resolves one owner by the existing workspace-member primary key.
Its payload contains one owner label and the current session user's default Run
as identity. Schedule creation uses the session identity; editing resolves only
the configured owner. These routes no longer call `listWorkspaceMembers`.

Run as choices are fetched by an operator-authorized action when the user presses
Search. SQL reads at most 26 rows; the response exposes at most 25 choices and a
`hasMore` flag prompting a narrower search. Name/email matching escapes SQL LIKE
wildcards. Exact user ID also works; email and ID allow choosing a member outside
the first 25 matches. Names include email for disambiguation without a full member
count. Search never changes the selected identity automatically. Existing run
submission and schedule-save authorization/membership policies are unchanged.

## Verification

From `web/`, run targeted checks against a disposable PostgreSQL database:

```sh
RUN_NAVIGATION_TEST_DATABASE_URL=postgres://postgres:local-test@127.0.0.1:55449/postgres \
pnpm exec vitest run src/lib/workspace-member-search.integration.test.ts \
  src/components/member-search-actions.test.ts \
  'src/app/[workspace]/agents/[agent]/layout.test.tsx' \
  'src/app/[workspace]/agents/[agent]/run-now-button.test.ts' \
  'src/app/[workspace]/automations/actions.test.ts'
```

The integration test creates/drops its own schema and seeds 10,001 workspace
members plus an outsider. It verifies the 25-choice bound, exact lookup beyond
the first batch, duplicate names, literal wildcard input, workspace isolation,
and removal. Action tests cover authorization and input size; the layout test
rejects any attempt to enumerate members. Without the database URL, the
integration file is skipped. This is functional/query-bound evidence, not
end-to-end navigation timing.

## Remaining scope

Shared workspace layout inventory scans, agent lists in automation forms,
automation-list pagination, agent ownership settings and other member pickers,
run relationships, and full route timing remain under #449. Search bounds rows
returned, not necessarily rows scanned: substring matching over a very large
workspace may need further plan-guided tuning. No index is added speculatively.
