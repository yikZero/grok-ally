# Grok Bridge

Talk to **Grok Build from Codex, Claude Code, or another local MCP client**, using your existing Grok login.

[中文](README.zh-CN.md) · [Architecture and source research](docs/architecture.md)

```text
Codex / Claude Code / MCP client
              │ MCP over stdio
        Grok Bridge (Node)
              │ ACP over stdio, persistent connection
        grok agent --no-leader stdio
```

One shared runtime. Native Grok conversations. Progress and cancellation. Workspace access is read-only by default; `write: true` explicitly enables workspace edits.

This is an independent integration, not an official xAI, OpenAI, or Anthropic product.

## Requirements

- Node.js **22+** on the host's PATH.
- [Grok Build](https://docs.x.ai/build/overview) installed and authenticated with `grok login`.
- macOS or Linux with a working Grok sandbox. Windows users should run the client and bridge inside WSL; native Windows is not validated.

The bridge reuses Grok Build authentication and account limits. It does not require a separate API key or read credential files. `GROK_BINARY` overrides the executable path; otherwise it checks PATH and `$GROK_HOME/bin/grok` (default `~/.grok/bin/grok`).

## Install

### Codex

```bash
codex plugin marketplace add yikZero/grok-bridge
codex plugin add grok-bridge@grok-bridge
```

Start a **new Codex task** after installation. Ask: “Use Grok Bridge to give me a second opinion on this design.”

### Claude Code

```bash
claude plugin marketplace add yikZero/grok-bridge
claude plugin install grok-bridge@grok-bridge
```

Or run `/plugin marketplace add yikZero/grok-bridge`, then `/plugin install grok-bridge@grok-bridge` inside Claude Code. Restart Claude Code after installation.

### Any local MCP client

Clone a release; the committed bundle needs **no npm install or build**:

```bash
git clone --branch v0.1.0 https://github.com/yikZero/grok-bridge.git
node grok-bridge/plugins/grok-bridge/dist/server.mjs --check
```

Register this stdio server in your MCP client, replacing the path:

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

Without plugins, the equivalent CLI registration is:

```bash
codex mcp add grok-bridge -- node /absolute/path/grok-bridge/plugins/grok-bridge/dist/server.mjs
claude mcp add --transport stdio grok-bridge -- node /absolute/path/grok-bridge/plugins/grok-bridge/dist/server.mjs
```

Use **either** the plugin or manual MCP registration in a host to avoid duplicate tools. Claude Desktop also supports the stdio configuration above; the Claude.ai website cannot directly start a local process.

## Conversation

First call:

```json
{
  "prompt": "What are the tradeoffs in this design?",
  "cwd": "/absolute/path/to/project"
}
```

Call `grok_chat` again with the returned `sessionId`:

```json
{
  "prompt": "Explore the second option further.",
  "cwd": "/absolute/path/to/project",
  "sessionId": "the-returned-session-id"
}
```

Always supply the real workspace path. Omitting `sessionId` starts an independent conversation. The bridge never guesses the most recent host task or imports Codex/Claude transcript files. Provide any desired context in the prompt.

| Tool | Purpose |
| --- | --- |
| `grok_chat` | Start or continue a turn; optional `write`, `model`, `effort`, `maxTurns`, `waitSeconds` |
| `grok_status` | Get a turn by `requestId`, optionally waiting up to 25 seconds |
| `grok_cancel` | Request cancellation; poll status to confirm it stopped |
| `grok_setup` | Check the executable and version; does not claim to verify login |

Calls wait up to 25 seconds by default. A slower turn returns `starting` or `running` plus a `requestId`. Keep calling `grok_status` with that ID until `completed`, `incomplete`, `failed`, or `cancelled`. Native MCP progress notifications are sent to clients that request them. MCP cancellation of a waiting `grok_chat` also cancels the ACP turn.

Only `completed` means Grok reached `end_turn`. Turn limits produce `incomplete`; partial text and the session ID remain available. Failed loads return an error and **never silently replace the conversation**. Cancellation does not undo existing edits.

`model` and `effort` are creation-only; omit them when continuing. Omit both initially for Grok's native defaults. A live session keeps the same `cwd`, `write`, and `maxTurns` (default 20). Start a separate conversation to change these settings immediately.

## Lifecycle and boundaries

- ACP processes stay alive between turns and are released after five idle minutes. Up to four sessions are resident; idle sessions are evicted as needed. Concurrent turns in the same resident session are rejected.
- Grok persists the conversation. After a bridge restart or idle eviction, continue with its `sessionId` and the same `cwd`. Never share the same session across two active host processes; disconnect the first client before handing the ID to another local client.
- Request results live only in the current MCP process, bounded to the latest 100 turns and 64,000 response characters each. `truncated: true` means output was clipped; ask Grok to summarize or inspect its native session. A lost `requestId` can be replaced by a new turn using the saved `sessionId`.
- Each turn has a one-hour ceiling. Cancel first uses ACP, then terminates the process if Grok does not stop within five seconds. Host shutdown closes its Grok processes.
- `read-only` restricts **workspace writes**, not all file reads: Grok can still read outside the workspace and write its own state and temporary files. Its native tools, hooks, MCP servers, network rules, and privacy settings remain Grok-managed. The bridge does not provide an additional security sandbox or weaken Grok's sandbox when startup fails.
- Both modes use Grok's `--always-approve` inside the selected OS sandbox. Use `write: true` only for authorized work. Unexpected ACP client permission requests are rejected. No client filesystem or terminal capabilities are advertised.
- No host credentials are copied, no host conversation is auto-exported, no web daemon is opened, and no Grok binary is redistributed. A process-local guard prevents recursive bridge launches through Grok's MCP discovery.

## Development

```bash
npm ci --ignore-scripts
npm run build
npm test
```

Edit `src/`, then rebuild. Never edit an installed plugin cache. The runtime uses the official MCP and ACP SDKs; their versions are locked. The build bundles dependencies and creates the Claude package from the same runtime and skill. Dependency licenses accompany both bundles. CI rebuilds and checks for stale generated files.

The six integration tests launch the packaged server with the **official MCP client** and a fake Grok ACP process. They cover schemas, isolation, process reuse, replay suppression, resume, progress/cancellation, overlapping turns, turn limits, error redaction, permissions, output bounds, and shutdown. [Validation notes](docs/validation.md) distinguish live Grok verification from mock protocol tests and host packaging checks.

## Migration from grok-in-codex-local

This is a separate, focused chat bridge. The older companion's planning, media, document, review, and background-job tools are not migrated. You can keep that plugin for those workflows; select Grok Bridge's namespaced tools for conversation. Existing native Grok session IDs can be explicitly loaded with their original workspace.

The older plugin and source are not modified by installation. The original [grok-in-codex](https://github.com/stdevMac/grok-in-codex) and its compatibility fork informed this project; see [NOTICE](NOTICE).

## License

Apache-2.0. Grok Build and provider services have their own licenses and terms.
