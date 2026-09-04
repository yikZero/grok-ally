# Usage reference

## Manual MCP installation

Plugin users can skip this section. Use either the plugin or a manual MCP registration in each host to avoid duplicate tools.

Clone the repository, or download and extract an archive from [Releases](https://github.com/yikZero/grok-bridge/releases). The runtime is prebuilt:

```bash
git clone https://github.com/yikZero/grok-bridge.git
node grok-bridge/plugins/grok-bridge/dist/server.mjs --check
```

Register this stdio server in your client, replacing the absolute path:

```json
{
  "mcpServers": {
    "grok-bridge": {
      "command": "node",
      "args": ["/absolute/path/grok-bridge/plugins/grok-bridge/dist/server.mjs"]
    }
  }
}
```

For the `.tgz` release asset, the extracted root is `package/`; use its `plugins/grok-bridge/dist/server.mjs`. The equivalent CLI registrations are:

```bash
codex mcp add grok-bridge -- node /absolute/path/grok-bridge/plugins/grok-bridge/dist/server.mjs
claude mcp add --transport stdio grok-bridge -- node /absolute/path/grok-bridge/plugins/grok-bridge/dist/server.mjs
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
| `maxTurns` | `20` | Grok agent turn limit, from 1 to 100 |
| `model` | Grok default | New sessions only |
| `effort` | Grok default | New sessions only: `minimal`, `low`, `medium`, `high`, `xhigh` |
| `waitSeconds` | `25` | Return after 0–25 seconds; the turn can keep running |

A live session keeps the same `cwd`, `write`, and `maxTurns`. Omit `model` and `effort` when continuing. Start a separate conversation to change settings immediately.

## Results and cancellation

A slow call returns a `requestId`. Call `grok_status` with that ID until the turn finishes; it also accepts `waitSeconds` from 0 to 25.

If you lose the request ID, call `grok_status` with `cwd` instead:

```json
{ "cwd": "/absolute/path/to/project" }
```

This immediately returns `active` and `recent` lists for that exact workspace in the current MCP process. All active requests and the 10 most recently finished requests are included, with recent results ordered by completion. Entries contain request/session IDs, status, write mode, and `createdAt`; message text and tool output are omitted. Use a returned `requestId` to read the result or cancel that request. Supply exactly one of `requestId` or `cwd`; `waitSeconds` only applies to individual requests. A bridge restart clears the lists.

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

The bridge reuses Grok Build authentication and account limits, without reading credential files or requiring a separate API key. `GROK_BINARY` overrides the executable; otherwise discovery checks PATH and `$GROK_HOME/bin/grok` (default `~/.grok/bin/grok`). `grok_setup` checks the binary and version; a successful chat verifies account access.

- Up to four Grok processes stay available between turns. Idle sessions are released after five minutes or evicted to make room. Overlapping turns in the same resident session are rejected.
- The current MCP process keeps the latest 100 turn results, with at most 64,000 response characters each. `truncated: true` means the answer was clipped. After a restart, use the session ID to continue; old request IDs are no longer available.
- Each turn has a one-hour ceiling. Cancellation uses ACP first, then terminates the process if it has not stopped within five seconds. Shutdown also cleans up descendants in Grok's process group, with a two-second grace period before forceful termination.
- Host transcripts are not imported, credentials are not copied, and the bridge opens no network listener. Recursive bridge launches through Grok's MCP discovery are blocked.

## Existing Grok plugins

This bridge focuses on conversation. The older `grok-in-codex-local` plugin's planning, media, document, review, and workflow tools remain separate. Installation does not modify the older plugin. Existing native Grok session IDs can be loaded explicitly with their original workspace.
