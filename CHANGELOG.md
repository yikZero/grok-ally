# Changelog

Notable changes for users. Each release uses the notes below.

## [0.4.0] - 2026-09-05

Fix model settings and execution controls in ACP mode.

### Changed

- **Breaking:** Remove `maxTurns` from manual `grok_chat` calls. Grok's ACP mode did not enforce this CLI flag. Cancellation and the one-hour timeout remain available.

### Fixed

- Reject model or reasoning-effort overrides that Grok did not apply, before sending the prompt.
- Disable Grok subagents through the setting supported by ACP mode.
- Separate messages around tool calls so progress text and final answers do not run together.

## [0.3.0] - 2026-09-05

Grok Bridge is now Grok Ally.

### Changed

- Plugin, marketplace, MCP server, and command names are now `grok-ally`.
- The package name is now `grok-ally`, without an npm scope. Release archives use `grok-ally-<version>.tgz`.

### Upgrade

- Replace the old plugin with `grok-ally@grok-ally`; see the [migration steps](https://github.com/yikZero/grok-ally/blob/v0.3.0/docs/usage.md#upgrade-from-grok-bridge).
- Existing Grok session IDs and the four `grok_*` tools continue to work.

## [0.2.0] - 2026-09-05

Find recent Grok requests and run focused code reviews.

### Added

- Look up active and recent requests by project with `grok_status`, even when the request ID is missing.
- A `grok-review` skill for read-only code and design reviews, with evidence and file locations.

### Changed

- Conversation guidance now keeps Grok's findings and uncertainty distinct from the host's conclusions.

## [0.1.1] - 2026-09-05

Reliability fixes for shutdown and cancellation.

### Fixed

- Clean up Grok subprocesses on disconnect or unexpected exit, including processes that ignore graceful shutdown.
- Stop cancelled status queries immediately while the Grok conversation continues.

### Changed

- Shorter English and Chinese setup guides, with advanced options in a separate reference.

## [0.1.0] - 2026-09-05

Talk to Grok Build from Codex, Claude Code, or any local MCP client using your existing Grok login.

### Added

- Conversations that keep context and resume after a client restart.
- Progress updates, cancellation, and read-only workspace access by default.
- Codex and Claude Code plugins with a prebuilt runtime. Requires Node.js 22+ and Grok Build.
