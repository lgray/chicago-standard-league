---
name: release
description: Cut a versioned release of the league site so CI publishes a tagged container image that the Helm chart's default values point at. Use when asked to release, tag, bump the version or publish an image.
---

# Release

The chart's default image tag is its `appVersion`, so a release is: bump the chart, tag the commit, let CI publish.

1. On an up-to-date `main` with green CI, set both `version` and `appVersion` in `chart/Chart.yaml` to the new
   version (semver: patch for fixes, minor for features, major for anything that needs a manual data step).
2. Commit as `chore(release): v<version>` and push.
3. Tag and push — pushing a tag publishes, so confirm with the user first:

   ```sh
   git tag -a v<version> -m v<version> && git push origin v<version>
   ```

4. Watch it: `gh run watch $(gh run list --branch v<version> --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status`.

CI's `image` job fails if the tag and `appVersion` differ. On success it pushes
`ghcr.io/lgray/chicago-standard-league:<version>` and `:latest` for amd64 and arm64. Pushes to `main` publish
`:main` and `:sha-<short>` without a release.

Releasing does not deploy anything. To roll a cluster forward, use the `deploy` skill.
