# Grok Bridge

Talk to **Grok Build from Codex, Claude Code, or any local MCP client**, using your existing Grok login. Keep context across messages, resume conversations, and cancel a turn when needed.

[中文](README.zh-CN.md) · [Usage reference](docs/usage.md) · [Changelog](CHANGELOG.md)

```text
Codex / Claude → MCP → Grok Bridge → ACP → Grok Build
```

## Install

You need **Node.js 22+** and [Grok Build](https://docs.x.ai/build/overview), authenticated with `grok login`. Use macOS or Linux with a working Grok sandbox; on Windows, run the client and bridge inside WSL.

### Codex

```bash
codex plugin marketplace add yikZero/grok-bridge
codex plugin add grok-bridge@grok-bridge
```

Start a new Codex task after installation.

### Claude Code

```bash
claude plugin marketplace add yikZero/grok-bridge
claude plugin install grok-bridge@grok-bridge
```

Restart Claude Code after installation. The same commands are available through `/plugin` in its interactive UI.

For other local clients, use the [standard MCP configuration](docs/usage.md#manual-mcp-installation). All packages include the runtime; **no npm install or build is needed**.

## Use it

Ask your agent: **“Use Grok Bridge to give me a second opinion on this design.”** Then ask a follow-up in the same Grok conversation.

| Tool | Purpose |
| --- | --- |
| `grok_chat` | Start or continue a conversation |
| `grok_status` | Check or wait for a running turn |
| `grok_cancel` | Stop a turn |
| `grok_setup` | Check the local Grok installation |

The agent supplies your project path and keeps the returned session ID for follow-ups. Share the context you want Grok to see in the prompt; host chat history is not imported automatically.

Workspace writes are disabled by default. Set `write: true` only for authorized edits. Grok can still read outside the workspace and use its own tools, hooks, and network settings. See [permissions and lifecycle](docs/usage.md#permissions-and-lifecycle) for details.

## Development

```bash
npm ci --ignore-scripts
npm run build
npm test
```

Edit `src/`, rebuild, then reinstall. Both plugins share the same runtime; avoid editing generated bundles or installed caches.

[Architecture](docs/architecture.md) · [Validation](docs/validation.md) · [Release guide](docs/releasing.md)

Independent integration; not affiliated with xAI, OpenAI, or Anthropic. [Apache-2.0](LICENSE) · [Attributions](NOTICE).
