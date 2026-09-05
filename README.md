# Grok Ally

Talk to **Grok Build from Codex, Claude Code, or any local MCP client**, using your existing Grok login. Keep context across messages, resume conversations, and cancel a turn when needed.

[中文](README.zh-CN.md) · [Usage reference](docs/usage.md) · [Changelog](CHANGELOG.md)

Previously Grok Bridge. Upgrading from 0.2.x or earlier? Follow the [migration steps](docs/usage.md#upgrade-from-grok-bridge).

```text
Codex / Claude → MCP → Grok Ally → ACP → Grok Build
```

## Install

You need **Node.js 22+** and [Grok Build](https://docs.x.ai/build/overview), authenticated with `grok login`. Use macOS or Linux with a working Grok sandbox; on Windows, run the client and bridge inside WSL.

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
| `grok_setup` | Check the local Grok installation |

The agent supplies your project path and keeps the returned session ID for follow-ups. Share the context you want Grok to see in the prompt; host chat history is not imported automatically.

Long tasks return compact progress by default, then the answer when finished. Detailed tool history and full text remain available on demand. See [results and cancellation](docs/usage.md#results-and-cancellation) and [efficiency measurements](docs/efficiency.md).

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
