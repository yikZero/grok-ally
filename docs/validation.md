# Validation

Validation date: 2026-09-05. Local machine: macOS arm64, Node 22.14.0. Grok Build: `1.0.13 (5e9a58528b76)`.

## Version 0.5.0 long-task results

Reproduced both 0.4.0 truncation defects locally: 105 tool calls retained only IDs 0–99, and a conclusion appended after 64,000 characters disappeared. The new bundled-server checks retain the newest calls out of 132, preserve active tools, count failed and dropped records, and mark missing terminal events as unconfirmed. A Unicode answer over 240 KB is reconstructed exactly through multiple MCP pages, including its final conclusion.

Incremental checks cover progress-triggered returns, unchanged replies, tool-only updates, event-burst batching, terminal returns, cancellation, and draining unread output while a turn is still active. Temporary output permissions, eviction/shutdown cleanup, and failure on an injected storage error are verified separately.

Real `grok-4.6` / `xhigh` completed two implementation turns in an isolated workspace with Chinese characters and spaces in its path: a JSONL status summarizer, then last-valid-record deduplication. Eleven independent acceptance checks passed across the two stages. A restarted MCP client loaded the same session and recalled a marker supplied only in conversation. Each answer was retrieved in 97-byte pages without lost or duplicated bytes. This live run also revealed overly frequent returns for tiny text chunks; the bridge now combines short bursts for up to 200 ms.

The final bundled runtime was checked again against real Grok after batching was added. Context recall, incremental status, cancellation during tool activity, continuation after cancellation, and immediate unchanged terminal status all passed. Cancellation left one tool without a final native outcome; the bridge reported it as unconfirmed with zero active tools.

## Version 0.4.0 live-task review

The real Grok runtime silently accepted a nonexistent model ID and answered with its default model. An explicit `minimal` effort request also selected `xhigh` on this installation. The bridge now checks Grok's session settings before sending the prompt. Both cases fail explicitly; `grok-4.6` with `xhigh` is accepted. Checks use the runtime's reported values, without hardcoded model lists.

Tool-using replies also joined commentary and final answers without a separator. The new regression check preserves ordinary streamed chunks while separating text across tool calls. Both regression checks fail against 0.3.0 and pass with the fixes.

A real task used `grok-4.6` with `xhigh` in a disposable workspace whose path contained Chinese characters and spaces. Through the installed Codex MCP tools, Grok repaired a Markdown checkbox counter, then added fenced-code exclusion in the same conversation. Seventeen independent acceptance cases passed, and the follow-up recalled a project codename supplied only in conversation. A separate read-only write attempt failed at the native sandbox; the target file remained unchanged.

After the original Grok process exited during idle cleanup, a fresh MCP client loaded that conversation and asked Grok to add a CLI. Four more independent cases passed: normal output, missing arguments, extra arguments, and an unreadable file. Grok corrected a verification command after using zsh's reserved `status` variable. Closing and restarting the MCP client retained the project codename and requirements; ACP cancellation completed, and the next prompt continued the same session.

The live limit check found that `maxTurns: 1` still allowed three sequential file reads and a final answer. Source inspection confirmed that the global CLI flag is not wired into ACP agent configuration. Version 0.4.0 removes the ineffective argument; it does not claim a replacement turn or token budget. Subagents now use the documented `GROK_SUBAGENTS=0` setting instead of the ignored global CLI flag.

The final installed **0.4.0** configuration was tested with the official MCP client: four tools, rejection of `maxTurns`, explicit model/effort errors, an actual file read, MCP restart with context recall, cancellation, and continuation after cancellation all passed. Grok reported its subagent tool unavailable. Source, Claude, and installed Codex runtime bundles have identical SHA-256 hashes. No live prompts, session records, or credentials are packaged.

## Version 0.3.0 rename

All ten automated checks pass with the renamed bundles. The MCP handshake identifies `grok-ally` at `0.3.0`; Codex and Claude plugin/marketplace validators pass, and packaging produces `grok-ally-0.3.0.tgz` directly.

The local Codex installation was migrated from `grok-bridge@grok-bridge` to `grok-ally@grok-ally` and reports enabled. An official MCP client launched its installed configuration and received `ALLY_OK` from the real Grok runtime in 5.574 seconds. The installed bundle matches the source bundle, and a recursive launch with `GROK_ALLY_ACTIVE=1` exits before starting a session.

## Version 0.2.0 review workflow

A real MCP client started a read-only review in a fresh Git workspace containing two untracked fixture files. It recovered the request through `grok_status({ cwd })`, polled the returned ID, and found the completed request in the recent list. Grok identified the missing quantity multiplication at `cart.mjs:2`, with a concrete failing example and verification limits. Both fixture files retained their original hashes. The run completed in 117.358 seconds.

This checks the review prompt and native Grok behavior through MCP. Automatic skill selection by a Codex or Claude model was not exercised. Both skills pass the skill validator; both host plugin packages pass their manifest validators.

## Version 0.1.1 review

The review reproduced and fixed two lifecycle issues: descendants surviving Grok exit, and aborted status waits continuing until their deadline. Regression checks fail against 0.1.0 and pass with the fixes. Runtime and host manifest versions now come from `package.json`; release notes come from `CHANGELOG.md`.

## Automated checks

All eighteen automated checks pass: thirteen use the official MCP client against the **bundled server**, with an independent fake ACP executable; five check bridge state and output lifecycle directly. Run them with `npm test`. Coverage includes:

- Schema errors, absolute workspace paths (including spaces/symlinks), separate conversations, explicit write mode, and one process/handshake for follow-up turns.
- MCP restart and native session load, replay filtering, honest load failure, and reconnection after an idle child exits.
- Background handles, same-session turn exclusion, ACP cancellation, and continuation after cancellation.
- MCP progress notifications and host cancellation propagation.
- Turn-limit reporting, child exit, error redaction, unexpected permission requests, and bounded output.
- Child shutdown when the MCP client disconnects.
- Cleanup of descendants that ignore SIGTERM, on both disconnect and unexpected Grok exit.
- Immediate cancellation of a status wait without cancelling its Grok turn; matching runtime and host manifest versions.
- Workspace-scoped request discovery, metadata-only listings, retention of every active request, a ten-item finished list, and cancellation through a recovered ID.
- Explicit model/effort validation before prompting, for native model metadata and standard ACP configuration options.
- Paragraph separation around tool calls, without splitting ordinary text chunks or losing the boundary on an empty chunk.
- Rejection of the removed `maxTurns` argument and forced child-process subagent disabling even when the parent environment enables it.
- Recent-tool retention beyond 100 calls, active/unconfirmed tool state, counts, timestamps, and stable durations after completion.
- Exact Unicode output pagination, preserved final conclusions, incremental waits and burst batching, private temporary-file cleanup, and honest storage failures.

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

The repository's [GitHub Actions workflow](https://github.com/yikZero/grok-ally/actions) runs the mock integration checks and bundle-rebuild comparison on both Ubuntu and macOS. Real provider smoke tests are intentionally not run in public CI.
