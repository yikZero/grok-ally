# Usage reference

## Upgrade from Grok Bridge

Version 0.3.0 renames the plugin and marketplace to `grok-ally`. Finish any running turn, then use the commands for your host.

Codex:

```bash
codex plugin remove grok-bridge@grok-bridge
codex plugin marketplace remove grok-bridge
codex plugin marketplace add yikZero/grok-ally
codex plugin add grok-ally@grok-ally
```

Claude Code:

```bash
claude plugin uninstall grok-bridge@grok-bridge
claude plugin marketplace remove grok-bridge
claude plugin marketplace add yikZero/grok-ally
claude plugin install grok-ally@grok-ally
```

Start a new Codex task or restart Claude Code. Native Grok conversations remain available with their existing session IDs and original workspace paths; request IDs are local to the old MCP process. The four `grok_*` tools keep the same names and arguments.

For a manual MCP installation, replace the old registration with the configuration below and update the executable path. The package and command names are now `grok-ally`.

## Manual MCP installation

Plugin users can skip this section. Use either the plugin or a manual MCP registration in each host to avoid duplicate tools.

Clone the repository, or download and extract an archive from [Releases](https://github.com/yikZero/grok-ally/releases). The runtime is prebuilt:

```bash
git clone https://github.com/yikZero/grok-ally.git
node grok-ally/plugins/grok-ally/dist/server.mjs --check
```

Register this stdio server in your client, replacing the absolute path:

```json
{
  "mcpServers": {
    "grok-ally": {
      "command": "node",
      "args": ["/absolute/path/grok-ally/plugins/grok-ally/dist/server.mjs"]
    }
  }
}
```

For the `.tgz` release asset, the extracted root is `package/`; use its `plugins/grok-ally/dist/server.mjs`. The equivalent CLI registrations are:

```bash
codex mcp add grok-ally -- node /absolute/path/grok-ally/plugins/grok-ally/dist/server.mjs
claude mcp add --transport stdio grok-ally -- node /absolute/path/grok-ally/plugins/grok-ally/dist/server.mjs
```

Claude Desktop accepts local stdio MCP configuration. The Claude.ai website cannot directly start a local process. Native Windows has not been validated; use WSL.

## Conversation parameters

Start with `grok_chat`:

```json
{
  "prompt": "What are the tradeoffs in this design?",
  "cwd": "/absolute/path/to/project"
}
```

For a follow-up, add the returned `sessionId`. Omitting it starts an independent conversation. Always provide the real workspace path and include any desired context in the prompt.

| Parameter | Default | Notes |
| --- | --- | --- |
| `prompt` | Required | Message for Grok, up to 100,000 characters |
| `cwd` | Required | Absolute project directory |
| `sessionId` | New conversation | Native Grok ID returned by a previous call |
| `write` | `false` | `true` authorizes workspace edits |
| `model` | Grok default | New sessions only |
| `effort` | Grok default | New sessions only: `minimal`, `low`, `medium`, `high`, `xhigh` |
| `waitSeconds` | `25` | Return after 0–60 seconds; the turn can keep running. Use more than 25 only if the host's tool timeout allows it |
| `detail` | `compact` | `full` adds diagnostic metadata, tool history, and running text; also available on status and cancellation |

A live session keeps the same `cwd` and `write`. Omit `model` and `effort` when continuing. Start a separate conversation to change settings immediately.

Version 0.4.0 removes `maxTurns`: Grok's ACP mode did not enforce the CLI flag used by earlier versions. Remove this argument from manual calls. Use `grok_cancel` to stop a turn; the bridge's one-hour timeout still applies. Neither control is a token or spending budget.

Use an exact model ID from `grok models`. Available reasoning levels depend on that model and your Grok installation. Before sending a new session's prompt, the bridge checks that Grok selected the requested model and effort. If either value was ignored, changed, or cannot be confirmed, the call fails with the reported value instead of silently using a fallback. Omit the overrides to use native defaults.

## Results and cancellation

A slow call returns a `requestId` and `revision`. For ordinary tasks, call `grok_status` with that ID and omit `afterRevision`: it waits for completion or the deadline, without returning for every stream event.

```json
{ "requestId": "<returned UUID>", "waitSeconds": 25 }
```

Version **0.6.0** defaults to `detail: "compact"` on chat, status, and cancellation. Running replies include tool counts, elapsed time, recent activity, output size, and up to three current tools. They omit assistant text and historical tools. Terminal replies include the answer preview, stop reason, and any error. Add `detail: "full"` if a manual integration needs the previous `cwd`, `write`, `createdAt`, `tools`, or running `text` fields. The retained result is the same in both modes.

When you need progress-triggered returns, pass the last revision from that request:

```json
{ "requestId": "<returned UUID>", "afterRevision": 12, "waitSeconds": 25 }
```

Use the returned `revision` for the next query. Short event bursts are combined for up to 200 ms; completion and cancellation still wake a progress wait immediately. `changed: false` means no state change. Compact unchanged replies contain only IDs, status, revision, the flag, and any terminal reason/error. In full mode, changed replies contain only retained tools updated since that revision, so merge them by tool ID. Use `detail: "full", waitSeconds: 0` without `afterRevision` to inspect the current diagnostic snapshot. Revisions are per request, not per conversation.

`finishedAt` records when the turn ended. `lastProgressAt` records the latest observed session initialization, assistant text, or tool event; polling and hidden reasoning do not advance it. Full tool records include first-observed `startedAt`, reported `finishedAt`, and `durationMs`. Titles and up to ten file locations are included, with common credential patterns redacted; thought streams and raw tool inputs/outputs are excluded.

The tool list retains all active calls and the most recently updated 100 completed/failed calls. `toolSummary` includes total, failed, dropped, active, unfinished, and unconfirmed counts. If Grok ends a turn without finishing a tool, that tool becomes `unconfirmed` and retains its `reportedStatus`; it is also kept in the list. Its duration stops at the turn's finish time. This means the bridge did not receive a tool outcome; it neither proves success nor claims that a background process is still running. `completed` refers to Grok's turn, not independent acceptance of its work.

### Read a complete answer

Terminal `text` is a recent preview of up to **16,000 UTF-8 bytes**, so long replies retain their ending. `truncated: true` means that this response contains only part of the retained answer. Read earlier text when the question needs it; fetch every page when the full answer is required:

```json
{ "requestId": "<returned UUID>", "outputOffset": 0, "outputLimit": 16000 }
```

Append each page's `text` and continue from its `output.nextOffset` while `output.hasMore` is true. Compact pages contain the answer and paging metadata without repeated tool history. Offsets are UTF-8 bytes, not JavaScript character counts. Returned offsets preserve character boundaries. Pages accept 4–64,000 bytes and return immediately when requested without `afterRevision`. After a turn is terminal, its text and offsets stay fixed until the result is evicted or the bridge exits.

For incremental text while a turn runs, start at `outputOffset: 0`, then combine `afterRevision` with the last `output.nextOffset` as `outputOffset`. Already-buffered text can return without waiting for a new event; otherwise the call waits for new progress or completion. Retain your offset when no page is returned. `hasMore: false` means caught up with current output, not that the turn is finished. Running text without an explicit offset is available only in full mode.

### Recover a request

If you lose the request ID, call `grok_status` with `cwd` instead:

```json
{ "cwd": "/absolute/path/to/project" }
```

This immediately returns `active` and `recent` lists for that exact workspace in the current MCP process. All active requests and the 10 most recently finished requests are included, with recent results ordered by completion. Entries contain request/session IDs, status, write mode, revision, and timestamps; message text and tool output are omitted. Use a returned `requestId` to read the result or cancel that request. Supply exactly one of `requestId` or `cwd`; revision and paging options require a request ID. A bridge restart clears the lists.

| Status | Meaning |
| --- | --- |
| `starting`, `running`, `cancelling` | Still in progress |
| `completed` | Grok reached `end_turn` |
| `incomplete` | Stopped at a limit or another non-final reason; partial output remains available |
| `failed` | Error; inspect the returned message |
| `cancelled` | Stopped after cancellation |

`grok_cancel` requests cancellation. Poll `grok_status` to confirm; cancellation does not undo existing edits. Cancelling a waiting `grok_chat` MCP call cancels its Grok turn. Cancelling a `grok_status` call only stops that wait. Clients that request MCP progress receive notifications during waits.

Grok saves conversations. After a client restart or idle cleanup, continue with the saved `sessionId` and the same `cwd`. A failed load returns an error without creating a replacement conversation. Do not use the same session in two active host processes; disconnect the first before handing it to another client.

## Permissions and lifecycle

The bridge uses Grok's sandbox: `read-only` by default, or `workspace` for `write: true`. Read-only restricts workspace writes; Grok can still read other files and write its own state and temporary files. Native tools, hooks, configured MCP servers, network rules, and privacy settings remain controlled by Grok.

Both modes use `--always-approve` inside the selected OS sandbox. The bridge rejects unexpected ACP client permission requests and advertises no client filesystem or terminal capabilities. Sandbox startup failures are returned as errors. This is not an additional security sandbox.

Grok subagents are disabled in the bridge's child process with `GROK_SUBAGENTS=0`, the setting supported by ACP mode. This does not change your saved Grok configuration.

The bridge reuses Grok Build authentication and account limits, without reading credential files or requiring a separate API key. `GROK_BINARY` overrides the executable; otherwise discovery checks PATH and `$GROK_HOME/bin/grok` (default `~/.grok/bin/grok`). `grok_setup` checks the binary and version; a successful chat verifies account access.

- Up to four Grok processes stay available between turns. Idle sessions are released after five minutes or evicted to make room. Overlapping turns in the same resident session are rejected.
- The current MCP process keeps up to 100 request results, evicting the oldest finished results first and preserving active requests. Full assistant text is stored in OS temporary directories (mode `0700`, files `0600`) outside the workspace, and is removed on result eviction or normal bridge shutdown. An abrupt process kill may leave temporary files for OS cleanup. If saving output fails, the turn fails and requests cancellation instead of silently losing its ending. After a restart, use the session ID to continue; old request IDs and pagination are no longer available.
- Each turn has a one-hour ceiling. Cancellation uses ACP first, then terminates the process if it has not stopped within five seconds. Shutdown also cleans up descendants in Grok's process group, with a two-second grace period before forceful termination.
- Host transcripts are not imported, credentials are not copied, and the bridge opens no network listener. Recursive bridge launches through Grok's MCP discovery are blocked.

## Existing Grok plugins

This bridge focuses on conversation. The older `grok-in-codex-local` plugin's planning, media, document, review, and workflow tools remain separate. Installation does not modify the older plugin. Existing native Grok session IDs can be loaded explicitly with their original workspace.
