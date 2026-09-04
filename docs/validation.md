# Validation

Validation date: 2026-09-05. Local machine: macOS arm64, Node 22.14.0. Grok Build: `1.0.13 (5e9a58528b76)`.

## Version 0.1.1 review

The review reproduced and fixed two lifecycle issues: descendants surviving Grok exit, and aborted status waits continuing until their deadline. Regression checks fail against 0.1.0 and pass with the fixes. Runtime and host manifest versions now come from `package.json`; release notes come from `CHANGELOG.md`.

## Automated checks

All nine automated checks pass: eight use the official MCP client against the **bundled server**, with an independent fake ACP executable; one checks cancellation of a status wait directly. Run them with `npm test`. Coverage includes:

- Schema errors, absolute workspace paths (including spaces/symlinks), separate conversations, explicit write mode, and one process/handshake for follow-up turns.
- MCP restart and native session load, replay filtering, honest load failure, and reconnection after an idle child exits.
- Background handles, same-session turn exclusion, ACP cancellation, and continuation after cancellation.
- MCP progress notifications and host cancellation propagation.
- Turn-limit reporting, child exit, error redaction, unexpected permission requests, and bounded output.
- Child shutdown when the MCP client disconnects.
- Cleanup of descendants that ignore SIGTERM, on both disconnect and unexpected Grok exit.
- Immediate cancellation of a status wait without cancelling its Grok turn; matching runtime and host manifest versions.

## Live Grok (0.1.1)

A real MCP client drove the bundled bridge against the installed Grok binary in an isolated workspace. No credentials or existing host transcripts were read or exported.

| Check | Observed result |
| --- | --- |
| New conversation | Returned the requested acknowledgement, `end_turn`; 6.302 seconds |
| Follow-up through the same connection | Recalled a non-secret test marker; 1.574 seconds |
| Disconnect, restart MCP, load the same ID | Recalled the same marker; 5.175 seconds |
| Cancel an active turn | Grok returned `stopReason: cancelled`; bridge reported `cancelled` |

These timings are individual smoke-test observations, not comparative benchmarks. The token-bearing session records stay local and are not included in this repository.

## Distribution checks

- Codex plugin validator passed; the local marketplace installed successfully and reports the plugin enabled.
- The installed Codex bundle, source distribution bundle, and generated Claude bundle have identical SHA-256 hashes.
- The installed bundle runs `--check` without a dependency installation and identifies the real Grok binary.
- Claude Code **2.1.261** validates both its plugin manifest and marketplace using its native validation command, isolated from the user's Claude configuration.
- `npm audit` reported zero known advisories at validation time, including development/bundled dependencies.
- Release packaging includes the standalone bundles, host manifests, skills, documentation, and licenses. It excludes development dependencies, scratch data, credentials, and live session records.

## Limits of this verification

Claude Code's authenticated model/tool-selection loop and Claude Desktop UI were not exercised. Claude validation and the official MCP client establish packaging/protocol evidence, not an end-to-end UI claim. Native Windows is not validated; use WSL.

The repository's [GitHub Actions workflow](https://github.com/yikZero/grok-bridge/actions) runs the mock integration checks and bundle-rebuild comparison on both Ubuntu and macOS. Real provider smoke tests are intentionally not run in public CI.
