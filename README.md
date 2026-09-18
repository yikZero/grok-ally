# Grok Ally

Use **Grok Build or Cursor Agent from Codex, Claude Code, or any local MCP client**, with the selected service’s existing login. Keep context across messages, resume conversations, and cancel a turn when needed.

[中文](README.zh-CN.md) · [Usage reference](docs/usage.md) · [Changelog](CHANGELOG.md)

Previously Grok Bridge. Upgrading from 0.2.x or earlier? Follow the [migration steps](docs/usage.md#upgrade-from-grok-bridge).

```text
Codex / Claude → MCP → Grok Ally → ACP → Grok Build / Cursor Agent
```

## Install

You need **Node.js 22+** and either [Grok Build](https://docs.x.ai/build/overview) (`grok login`) or [Cursor Agent](https://cursor.com/docs/cli/installation) (`agent login`). Only the selected backend needs to be installed. Use macOS or Linux; on Windows, run the client and bridge inside WSL.

### Codex

```bash
codex plugin marketplace add yikZero/grok-ally
codex plugin add grok-ally@grok-ally
```

Start a new Codex task after installation.

### Claude Code

```bash
claude plugin marketplace add yikZero/grok-ally
claude plugin install grok-ally@grok-ally
```

Restart Claude Code after installation. The same commands are available through `/plugin` in its interactive UI.

For other local clients, use the [standard MCP configuration](docs/usage.md#manual-mcp-installation). All packages include the runtime; **no npm install or build is needed**.

## Use it

Ask your agent: **“Use Grok Ally to give me a second opinion on this design.”** Then ask a follow-up in the same Grok conversation.

For code review, ask **“Use Grok to review my uncommitted changes.”** The `grok-review` skill keeps the review read-only and asks for evidence, file locations, and any verification limits.

| Tool | Purpose |
| --- | --- |
| `grok_chat` | Start or continue a conversation |
| `grok_status` | Follow progress, read complete answers, or find recent requests |
| `grok_cancel` | Stop a turn |
| `grok_setup` | Check the selected backend installation |

To use Cursor, ask **“Use Grok Ally through Cursor to implement this change.”** The agent passes `provider: "cursor"`; its default model is **`cursor-grok-4.6-xhigh`**. Omit `provider` to keep using Grok Build, or set `GROK_ALLY_PROVIDER=cursor` in the MCP server environment to make Cursor the default. Existing sessions keep their original backend. There is no automatic quota fallback. See [backend selection](docs/usage.md#choose-a-backend).

The agent supplies your project path and keeps the returned session ID for follow-ups. Share the context you want Grok to see in the prompt; host chat history is not imported automatically.

Long tasks return compact progress by default, then the answer when finished. Turn `completed` is the selected agent ending the turn, not confirmed tool outcomes or independent validation. Detailed tool history and full text remain available on demand. See [results and cancellation](docs/usage.md#results-and-cancellation) and [efficiency measurements](docs/efficiency.md).

Read-only operation is the default. Set `write: true` only for authorized edits. Grok uses its OS sandbox; Cursor uses verified Ask/Agent modes and native policies, which are not the same OS-level write restriction. Both backends retain their own tools, hooks, and network settings. See [permissions and lifecycle](docs/usage.md#permissions-and-lifecycle) for details.

## Development

```bash
npm ci --ignore-scripts
npm run build
npm test
```

Edit `src/`, rebuild, then reinstall. Both plugins share the same runtime; avoid editing generated bundles or installed caches.

[Architecture](docs/architecture.md) · [Validation](docs/validation.md) · [Release guide](docs/releasing.md)

Independent integration; not affiliated with xAI, Cursor, OpenAI, or Anthropic. [Apache-2.0](LICENSE) · [Attributions](NOTICE).
