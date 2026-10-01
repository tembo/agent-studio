---
name: release-agent-studio
description: Release Agent Studio, publish its GitHub release and container images, and verify customer update readiness. Use for release requests or recovery of an incomplete release.
---

# Release Agent Studio

A release is complete when the intended commit is tagged, both images are
published and signed, the compose defaults are current, and the GitHub release
is published. A successful tag push or a green image job alone is insufficient.

## Establish the release inputs

- Read root `AGENTS.md`, `.github/workflows/release.yml`, and
  `compose.release.yaml`. Fetch `origin/main` and tags; inspect the latest
  GitHub release and the commits since it. Do not release a stale local branch.
- Use the existing CalVer convention: `vYYYY.M.N`, where N is the release
  counter within the month, not the day. Check remote tags and releases before
  choosing the next unused number. Honor an explicit user-selected version.
- Pin the intended release commit. Include all changes it introduces in the
  release notes, including migrations and upgrade ordering. Check its relevant
  CI results; let CI run the full suite rather than running it locally.
- A release request authorizes publishing that release. It does not authorize
  deployments into customer accounts or bypassing branch protections.

## Prepare the immutable release contents

Before tagging, update both compose defaults to the version being released.
Otherwise an updater reading the tagged compose file deploys the previous
version even though the GitHub release advertises the new one.

Prepare and land the version change through the repository's normal PR/check
process, within the user's authorization. Use the required commit and PR tools
from the current environment. Do not tag before a required preparation merge
has landed. Verify the chosen commit contains both intended defaults with:

```bash
git show "$RELEASE_SHA:compose.release.yaml" | rg 'image:.*tas-'
```

Update release documentation as appropriate. If editing the user manual under
`docs/src/content/docs/`, run `pnpm --dir web gen:docs` and include the generated
bundle. Keep applied migrations unchanged.

## Build first, announce second

1. Create the version tag at the pinned release commit and push it. This
   triggers **Release images**. Never move an already-published tag.
2. Find the run for that exact tag; monitor both `tas-api` and `tas-web`, plus
   `bump-compose`. Report progress while waiting. Investigate failed jobs rather
   than treating image publication as proof the entire release succeeded.
3. Verify the versioned images exist in GHCR and were signed. The workflow
   builds `linux/amd64` images with provenance/SBOM attestations. For a latest
   stable release, verify each `:latest` digest matches its versioned image:

   ```bash
   docker buildx imagetools inspect "ghcr.io/tembo/tas-api:$VERSION"
   docker buildx imagetools inspect ghcr.io/tembo/tas-api:latest
   docker buildx imagetools inspect "ghcr.io/tembo/tas-web:$VERSION"
   docker buildx imagetools inspect ghcr.io/tembo/tas-web:latest
   ```

   `VERSION` excludes the leading `v`. Do not change latest for an intentional
   prerelease or older maintenance release without user intent.
4. Ensure compose defaults on main match the release. With the preparation
   above, `bump-compose` should report that they are already current. If it
   instead opens a version PR, inspect its diff and complete the normal merge
   process within authorization. An open PR does not update customer defaults.
5. Only after the images and compose defaults are ready, publish the GitHub
   release. Customer automation may trigger immediately on `release.published`.
   A draft may be prepared earlier. Use an exact notes file and verify the tag:

   ```bash
   gh release create "$TAG" --verify-tag --title "$TITLE" --notes-file "$NOTES_FILE"
   ```

   Select latest/prerelease status intentionally. Notes must cover changes
   since the previous release, image tags, migrations, and any operational
   follow-up. Do not claim live customer deployment or testing that did not run.

## Recover incomplete releases

- Inspect existing tags, releases, image digests, workflow runs, and version PRs
  before retrying. Resume the failed stage; do not create another version just
  because a workflow is still running.
- The workflow's manual dispatch can rebuild an existing tag, but intentionally
  skips `bump-compose`. Rerun a failed original push job to retry that job, or
  prepare a version PR separately. Repeated permission failures need a setting
  change, not repeated release tags.
- GitHub's **Allow GitHub Actions to create and approve pull requests** must be
  allowed by enterprise, organization, and repository policy. Paths:
  enterprise **Policies → Actions**; organization **Settings → Actions →
  General**; repository **Settings → Actions → General**. Job-level
  `pull-requests: write` cannot override this policy. If access is denied,
  identify the setting and admin action needed; do not claim it was changed.
- Older workflow revisions swallowed all PR-creation errors as “PR already
  exists.” Inspect logs and confirm an actual open/merged PR or the correct
  main defaults; a green run from such a revision is not sufficient evidence.
- If a tag already contains an outdated compose default, do not move it.
  Updating main will not repair that immutable tag. Document the discrepancy
  and explicit `TAS_VERSION` override. A corrected tag requires a new release
  within the user's authorization.

## Completion message

Notify the user when fully complete with the version, GitHub release link,
image publication result, and compose-default status. Include a version PR link
if one was needed. If a required step is blocked, say exactly which step remains;
do not describe the release as fully complete. GitHub publication does not prove
that a customer's updater ran or that their ECS service deployed successfully.
