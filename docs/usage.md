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

## Choose a backend

The four `grok_*` tool names remain compatible. Pass `provider: "cursor"` to `grok_chat` or `grok_setup` to use Cursor Agent; pass `"grok"` for Grok Build. For new sessions, an omitted provider uses `GROK_ALLY_PROVIDER` (`grok` by default). This variable belongs in the MCP server's environment, for example the `env` object beside `command` and `args` in a manual registration:

```json
{ "GROK_ALLY_PROVIDER": "cursor", "CURSOR_BINARY": "/absolute/path/to/cursor-agent" }
```

`CURSOR_BINARY` is optional when a known Cursor Agent installation can be found. `agent` may belong to Grok, and `cursor` may be the editor command, so discovery checks their resolved executable location. An unusual installation should set `CURSOR_BINARY` explicitly. Install and log into only the backend you use. `grok_setup` and `--check` inspect installation, not account access or remaining quota.

A Cursor request can be as small as:

```json
{ "provider": "cursor", "cwd": "/absolute/path/to/project", "prompt": "Review this change." }
```

Cursor defaults to **`cursor-grok-4.6-xhigh`**, resolved and verified over ACP as `grok-4.6[effort=xhigh,fast=false]`. It does not use Auto or follow a changing “latest” alias. Other new-session models use ACP base IDs with optional bracket parameters, for example `grok-4.6[effort=high,fast=true]`; other `cursor-*` CLI aliases are not translated. Availability is checked against the installed agent's ACP config options. Do not pass a separate `effort` for Cursor. An unavailable or ignored model/mode fails before the user prompt is sent.

**Cursor persists model choices in its own CLI/ACP configuration.** An Ally call can therefore change the last-selected model in other Cursor CLI use. Ally does not edit or copy those files. Returned Cursor handles include the selected model parameters; reloads restore them rather than inheriting a later selection.

Keep the entire returned `sessionId` unchanged. Cursor handles begin with `cursor:`; existing bare Grok IDs continue to select Grok even when the default backend is Cursor. A conflicting explicit provider is rejected. A new backend requires a new session and an explicit handoff prompt; conversation histories and quotas are separate. There is no priority list, quota scraping, retry on another backend, or mid-task failover.

Cursor usage follows the signed-in Cursor account and its [ACP billing rules](https://cursor.com/docs/integrations/jetbrains#pricing). Ally does not enforce a spending cap or change your account's on-demand billing settings.

### Cursor permissions

Cursor is launched with `--sandbox enabled`, and Ally sets and verifies ACP **Ask** mode for `write: false` or **Agent** mode for `write: true`. Ask mode disallows edits and command execution. This mode check is not the Grok OS read-only sandbox, and the CLI flag alone is not proof of an OS boundary in ACP. In the tested Cursor build, an authorized shell command could write a temporary file outside `cwd` despite this flag. Treat `write: true` as permission to use Cursor’s native editing and shell tools, not a confinement boundary. Native permissions, configured MCP servers, hooks, and team policies still apply.

During an active turn, Ally grants only one-time read/search/fetch permission requests; edit/execute requests additionally require `write: true`. It rejects requests after cancellation and unknown/MCP operation approvals, and never grants persistent approval or passes `--force`/`--approve-mcps`. Native tools already allowed by Cursor's own settings may not ask Ally. Interactive questions and plan-acceptance requests are skipped/rejected with an explanation, so the agent can return them to the host without waiting indefinitely or inventing an answer.

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
| `prompt` | Required | Message for the selected backend, up to 100,000 characters |
| `cwd` | Required | Absolute project directory |
| `provider` | `GROK_ALLY_PROVIDER` or `grok` | New-session backend: `grok` or `cursor`; saved IDs infer their backend |
| `sessionId` | New conversation | Complete handle returned by a previous call |
| `write` | `false` | `true` authorizes workspace edits |
| `model` | Native Grok default / fixed Cursor xhigh | New sessions only; see backend selection above |
| `effort` | Grok default | Grok new sessions only: `minimal`, `low`, `medium`, `high`, `xhigh` |
| `waitSeconds` | `25` | Return after 0–60 seconds; the turn can keep running. Use more than 25 only if the host's tool timeout allows it |
| `detail` | `compact` | `full` adds diagnostic metadata, tool history, and running text; also available on status and cancellation |

A live session keeps the same `cwd` and `write`. Omit `model` and `effort` when continuing. Start a separate conversation to change settings immediately.

Version 0.4.0 removes `maxTurns`: Grok's ACP mode did not enforce the CLI flag used by earlier versions. Remove this argument from manual calls. Use `grok_cancel` to stop a turn; the bridge's one-hour timeout still applies. Neither control is a token or spending budget.

For Grok Build, use an exact model ID from `grok models`. Available reasoning levels depend on that model and your Grok installation. Before sending a new session's prompt, the bridge checks that Grok selected the requested model and effort. If either value was ignored, changed, or cannot be confirmed, the call fails with the reported value instead of silently using a fallback. Omit the overrides to use native defaults.

## Results and cancellation

A slow call returns a `requestId` and `revision`. For ordinary tasks, call `grok_status` with that ID and omit `afterRevision`: it waits for completion or the deadline, without returning for every stream event. `waitSeconds` still defaults to 25 and is capped at 60. Passing `afterRevision` is an opt-in progress cursor: it wakes on observed progress (short bursts are still combined for up to 200 ms) and can increase polling. A large status-call count with that cursor does not prove transport slowness.

```json
{ "requestId": "<returned UUID>", "waitSeconds": 25 }
```

Version **0.6.0** defaults to `detail: "compact"` on chat, status, and cancellation. Running replies include tool counts, elapsed time, recent activity, output size, and up to three current tools. They omit assistant text and historical tools. Terminal replies include the answer preview, stop reason, and any error. Add `detail: "full"` if a manual integration needs the previous `cwd`, `write`, `createdAt`, `tools`, or running `text` fields. The retained result is the same in both modes.

When you need those early progress returns, pass the last revision from that request:

```json
{ "requestId": "<returned UUID>", "afterRevision": 12, "waitSeconds": 25 }
```

Use the returned `revision` for the next query. Short event bursts are combined for up to 200 ms; completion and cancellation still wake a progress wait immediately. `changed: false` means no state change. Compact unchanged replies contain IDs, backend (and verified Cursor model/mode), status, revision, the flag, and any terminal reason/error. In full mode, changed replies contain only retained tools updated since that revision, so merge them by tool ID. Use `detail: "full", waitSeconds: 0` without `afterRevision` to inspect the current diagnostic snapshot. Revisions are per request, not per conversation.

`finishedAt` records when the turn ended. `lastProgressAt` records the latest observed session initialization, assistant text, or tool event; polling and hidden reasoning do not advance it. Full tool records include first-observed `startedAt`, reported `finishedAt`, and `durationMs`. Titles and up to ten file locations are included, with common credential patterns redacted; thought streams and raw tool inputs/outputs are excluded.

The recent tool list retains all active calls and the most recently updated 100 completed/failed calls. `toolSummary` includes total, failed, dropped, active, unfinished, and unconfirmed counts, plus `state` and `historyRecords`. `dropped` is the number removed from that recent view, not missing execution; the complete sanitized history remains pageable. `state` is `active` if any observed tool is still running, otherwise `unconfirmed` if any lack a final reported outcome, otherwise `confirmed`. `confirmed` includes failed tools and does not mean tests passed or that the host accepted the work. An execute tool can report `completed` when a background command is launched, while that command is still running.

If the agent ends a turn without finishing a tool, that tool becomes `unconfirmed` and retains its `reportedStatus`; it is also kept in the recent list. Compact terminal replies include up to three `unconfirmedTools` (`id`, `title`, `reportedStatus`). Duration stops at the turn's finish time. This means the bridge did not receive a tool outcome; it neither proves success nor claims that a background process is still running. `status: completed` is the agent's `end_turn`. It is not `toolSummary.state`, and neither is independent validation.

When a tool reports `failed`, compact replies include `latestFailure` with `id`, `title`, `recovery`, and a short sanitized `reason` only when the agent provided text in that failure's `content`. Reasons are clipped to about 240 characters with control characters and known credential patterns removed; raw tool input/output and thoughts are not retained. The snapshot is kept even after the tool leaves the recent view. `recovery` stays `unknown` unless that same tool ID later reports `completed`. Another tool succeeding, or the turn reaching `end_turn`, is not treated as recovery. A historical failed attempt is not a turn `error`.

### Inspect current tool outcomes

To see each retained tool's latest status, request a full snapshot without `afterRevision` or paging parameters:

```json
{ "requestId": "<returned UUID>", "detail": "full", "waitSeconds": 0 }
```

The `tools` array is already merged by tool ID. For example, three tools with ten history events return three tool entries. While the turn runs these are current states; after it ends they are the latest reported outcomes, with missing outcomes marked `unconfirmed`. This uses the recent-list retention limits above. Read history only when you need earlier transitions or tools that have left that list.

### Read a complete answer

Terminal `text` is a recent preview of up to **16,000 UTF-8 bytes**, so long replies retain their ending. The retained text includes assistant updates from throughout the turn, not just its final conclusion. `truncated: true` means that this response contains only part of the retained text. Read earlier text when the question needs it; fetch every page when the full answer is required:

```json
{ "requestId": "<returned UUID>", "outputOffset": 0, "outputLimit": 16000 }
```

`outputLimit` without `outputOffset` starts at 0. Append each page's `text` and continue from its `output.nextOffset` while `output.hasMore` is true. Compact pages contain the answer and paging metadata without repeated tool history. Offsets are UTF-8 bytes, not JavaScript character counts. Returned offsets preserve character boundaries. Pages accept 4–64,000 bytes and return immediately when requested without `afterRevision`. After a turn is terminal, its text and offsets stay fixed until the result is evicted or the bridge exits.

The last page can report both `truncated: true` and `output.hasMore: false`: it omits earlier text, but there is nothing after this page. For a finished turn, stop paging on `output.hasMore: false`; do not wait for `truncated` to become false. Reading only the last page does not mean you have retrieved the earlier pages.

For incremental text while a turn runs, start at `outputOffset: 0`, then combine `afterRevision` with the last `output.nextOffset` as `outputOffset`. Already-buffered text can return without waiting for a new event; otherwise the call waits for new progress or completion. Retain your offset when no page is returned. `hasMore: false` means caught up with current output, not that the turn is finished. Running text without an explicit offset is available only in full mode.

### Read tool history

Sanitized tool-state snapshots (status and metadata changes, including final `unconfirmed` transitions) are stored privately with the request. Page them through the same `grok_status` tool. `toolOffset` is a stable append-only record cursor; `toolLimit` defaults to 20 and is capped at 100; `toolLimit` alone starts at 0. Each page also stops at **16,000 UTF-8 bytes** of `toolHistory` metadata and records:

```json
{ "requestId": "<returned UUID>", "toolOffset": 0, "toolLimit": 20 }
```

Continue from `toolHistory.nextOffset` while `toolHistory.hasMore` is true. A page may contain fewer than `toolLimit` records when the byte cap is reached; the cursor still advances. History pages return immediately and omit the answer and recent-tool list. Do not mix `outputOffset`/`outputLimit` with `toolOffset`/`toolLimit`. Records never include raw tool input/output or thoughts. A storage failure fails the turn instead of silently dropping history. Files are removed on result eviction or normal bridge shutdown.

### Recover a request

If you lose the request ID, call `grok_status` with `cwd` instead:

```json
{ "cwd": "/absolute/path/to/project" }
```

This immediately returns `active` and `recent` lists for that exact workspace in the current MCP process. All active requests and the 10 most recently finished requests are included, with recent results ordered by completion. Entries contain request/session IDs, provider, status, write mode, revision, and timestamps; message text and tool output are omitted. Use a returned `requestId` to read the result or cancel that request. Supply exactly one of `requestId` or `cwd`; revision, answer paging, and tool-history paging require a request ID. A bridge restart clears the lists.

| Status | Meaning |
| --- | --- |
| `starting`, `running`, `cancelling` | Still in progress |
| `completed` | The agent reached `end_turn` |
| `incomplete` | Stopped at a limit or another non-final reason; partial output remains available |
| `failed` | Error; inspect the returned message |
| `cancelled` | Stopped after cancellation; the resident agent process is retired after process cleanup |

`grok_cancel` requests cancellation. The turn stays `cancelling` until bounded process cleanup finishes, even if the agent immediately reports `cancelled`. Cancellation sends a bounded ACP `session/cancel`, then `session/close` when advertised, to reclaim native terminals and background tasks, then retires that agent process. A native `stopReason` of `cancelled` uses the same cleanup. A follow-up with the same `sessionId` loads into a new process. Partial output, tool history, and `sessionId` are retained. Cancellation does not undo existing edits.

Requests that enter cancellation include `cleanup` (also when an earlier error ends the request as `failed`), separate from `toolSummary.state`: `pending` while reaping, then `confirmed` or `unconfirmed` for observed local processes. `unconfirmed` may include leftover `pid` values and a reason when verification failed or processes remain. A completed or unconfirmed ACP tool is not an OS-process exit. Normal replies omit `cleanup`. A confirmed cleanup covers the local processes the bridge observed, not arbitrary external or unobserved processes. If cleanup is unconfirmed, inspect its reason and any remaining processes before starting overlapping commands. Terminal results do not retry cleanup when polled.

Poll `grok_status` until the turn is terminal, then check `cleanup.state` before taking over the work. Cancelling a waiting `grok_chat` MCP call cancels its agent turn. Cancelling a `grok_status` call only stops that wait. Clients that request MCP progress receive notifications during waits.

Each backend saves its own conversations. After a client restart or idle cleanup, continue with the saved `sessionId` and the same `cwd`. A failed load returns an error without creating a replacement conversation. Do not use the same session in two active host processes; disconnect the first before handing it to another client.

## Permissions and lifecycle

For Grok Build, the bridge uses Grok's sandbox: `read-only` by default, or `workspace` for `write: true`. Read-only restricts workspace writes; Grok can still read other files and write its own state and temporary files. Native tools, hooks, configured MCP servers, network rules, and privacy settings remain controlled by Grok.

Both Grok modes use `--always-approve` inside the selected OS sandbox. The bridge rejects unexpected ACP client permission requests and advertises no client filesystem or terminal capabilities. Sandbox startup failures are returned as errors. This is not an additional security sandbox.

Grok subagents are disabled in the bridge's child process with `GROK_SUBAGENTS=0`, the setting supported by ACP mode. This does not change your saved Grok configuration.

The bridge reuses Grok Build authentication and account limits, without reading credential files or requiring a separate API key. `GROK_BINARY` overrides the executable; otherwise discovery checks PATH and `$GROK_HOME/bin/grok` (default `~/.grok/bin/grok`). `grok_setup` checks the binary and version; a successful chat verifies account access.

- Up to four native agent processes stay available between turns. Idle sessions are released after five minutes or evicted to make room. Overlapping turns in the same resident session are rejected.
- The current MCP process keeps up to 100 request results, evicting the oldest finished results first and preserving active requests. Full assistant text and sanitized tool-state history are stored in OS temporary directories (mode `0700`, files `0600`) outside the workspace, and are removed on result eviction or normal bridge shutdown. An abrupt process kill may leave temporary files for OS cleanup. If saving output or history fails, the turn fails and requests cancellation instead of silently losing that data. After a restart, use the session ID to continue; old request IDs and pagination are no longer available.
- Each turn has a one-hour ceiling. Cancellation uses a bounded ACP `session/cancel`, then native `session/close` when advertised, then SIGTERM and a two-second SIGKILL only for process identities that still match immediately before each signal. The resident process is not reused after cancellation; the next prompt loads the same `sessionId` in a new process. A native cancelled stop also retires that process. Shutdown, idle eviction, and failed connections use the same owned-process cleanup. Windows does not claim process-tree cleanup. If local processes cannot be listed, `cleanup.state` is `unconfirmed` and cached PIDs/groups are not signalled.
- Host transcripts are not imported, credentials are not copied, and the bridge opens no network listener. Recursive bridge launches through native MCP discovery are blocked.

## Existing Grok plugins

This bridge focuses on conversation. The older `grok-in-codex-local` plugin's planning, media, document, review, and workflow tools remain separate. Installation does not modify the older plugin. Existing native Grok session IDs can be loaded explicitly with their original workspace.
