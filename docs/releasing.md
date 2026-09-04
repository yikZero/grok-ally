# Releasing

`CHANGELOG.md` is the source for GitHub release notes. `package.json` is the source for the runtime and plugin versions; the build updates both host manifests.

Use `v<version>` for release titles and `grok-ally-<version>.tgz` for archive names, without an account or npm scope prefix. The checksum file is always `SHA256SUMS` and lists the published archive name.

## Write the notes

Use one short opening sentence, then **Added**, **Changed**, or **Fixed** where needed. Keep each bullet about a visible behavior. Omit empty sections, commit inventories, and test transcripts. Call out breaking changes and migration steps only when they exist.

This follows the scannable feature/fix grouping in [Playwright MCP releases](https://github.com/microsoft/playwright-mcp/releases) and the user-facing highlights in [GitHub MCP releases](https://github.com/github/github-mcp-server/releases), scaled down for this project.

## Prepare and publish

1. Choose a SemVer version: patch for compatible fixes, minor for new functionality, major for breaking changes. During `0.x`, use a minor bump for breaking changes and document migration.
2. Run `npm version patch --no-git-tag-version` (or the chosen version), then add the matching dated entry at the top of `CHANGELOG.md`.
3. Run `npm run build`, `npm test`, and `git diff --check`. Commit the source, lockfile, notes, and generated packages together. Push and wait for both CI jobs to pass.
4. Run `npm run --silent release:notes > /tmp/grok-ally-release.md`. Review this file; it becomes the release body unchanged.
5. Run `npm pack --ignore-scripts --pack-destination <release-directory>`. The unscoped package name produces `grok-ally-<version>.tgz` directly. In that directory, run `shasum -a 256 grok-ally-<version>.tgz > SHA256SUMS`.
6. Create and push the `v<version>` tag at the tested commit. From the release directory, publish with `gh release create v<version> grok-ally-<version>.tgz SHA256SUMS --repo yikZero/grok-ally --verify-tag --title "v<version>" --notes-file /tmp/grok-ally-release.md`.
7. Download the published assets and verify their checksums. Reinstall from source or the marketplace to check the distributed plugin.

Use `npm run --silent release:notes -- 0.1.0` to render an older release. Notes can be clarified with `gh release edit --notes-file`; never move a published tag or replace its artifacts to ship a code fix. Publish a new version instead.

Versions before 0.3.0 were published as Grok Bridge. Keep their original tags and archive names so existing downloads and checksums remain valid.

The release archive includes the standalone runtime and documentation; no npm dependency installation is needed to use it. This project publishes on GitHub, not the npm registry. Record detailed verification in [validation.md](validation.md).
