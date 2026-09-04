# Why MCP outside, ACP inside

Research date: 2026-09-05. Grok Build public source: [`72a61251fcffb464bcc687aeb5a998e5a98ec0c9`](https://github.com/xai-org/grok-build/tree/72a61251fcffb464bcc687aeb5a998e5a98ec0c9), whose `SOURCE_REV` is `a549186d9d39311f2d3ee4208db62af8c65aa476`. The installed binary used for live checks is 1.0.13; the public source snapshot is not claimed to be that exact binary.

## Evidence from Grok's source

| Question | Source and finding |
| --- | --- |
| Native integration entry point? | [Agent-mode guide](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md): ACP agent mode is long-lived; headless `-p` is the one-shot interface. |
| A Grok-specific Node agent SDK? | The same guide directs integrations to the standard ACP SDKs. No separate public Grok-specific Node agent SDK was identified in the audited tree. |
| Session capabilities? | [`acp_agent.rs`](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs#L496) advertises load capability. The bridge checks negotiation instead of assuming every version supports it. |
| Loading vs prompting? | [`session_setup.rs`](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_setup.rs#L747) routes loads through attachment and replay. The bridge ignores replay until the new prompt begins. |
| Cancellation? | [`acp_agent.rs`](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs#L2166) implements the ACP cancel notification. Normal cancellation does not require killing the agent. |
| Why no shared leader? | The agent-mode guide rejects leader mode with an active OS sandbox. Each resident conversation gets its own `--no-leader` child and workspace. |
| Meaning of read-only? | [Sandbox implementation guide](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-pager/docs/user-guide/18-sandbox.md): OS-enforced write restrictions still permit Grok state and temporary files; reads are broader. Network behavior differs by OS. |

## Alternatives

| Architecture | Decision |
| --- | --- |
| xAI HTTP model API | Useful for API-key applications, but does not preserve Grok Build's CLI login, agent runtime, or native local sessions. |
| `grok -p` for every message | Smallest one-shot implementation. For an ongoing conversation it repeats process startup and session reload and has less direct lifecycle control. |
| MCP → per-call Node companion → per-turn ACP | Adds a process hop and repeats connection setup. A persistent child provides a direct cancellation path. |
| **MCP → persistent ACP child** | Selected. One portable host-facing contract with native Grok session semantics. |
| WebSocket daemon | Requires another server lifecycle, authentication, and reconnect policy. Defer until a real remote-client requirement exists. |

## Implementation choices

The official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) and [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) own protocol parsing, negotiation, request correlation, and framing. Both stdio transports use newline-delimited JSON.

Explicit `sessionId` replaces host-thread environment variables. [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup) defines loading and replay. Only fresh prompt updates enter a result. A failed load is visible to the caller.

Bounded request handles solve host tool deadlines without a daemon or a job database. Prompts are not retried after ambiguous failures. Grok owns conversation persistence; the bridge keeps only active connections and bounded result summaries in memory. Same-session exclusion is currently within one MCP process, so multi-host use requires an explicit handoff after disconnecting the original client.

Codex and Claude package the same generated runtime with their own marketplace/manifest paths. [Codex packaging](https://developers.openai.com/plugins/build/plugins) uses a plugin-relative working directory; [Claude plugin configuration](https://code.claude.com/docs/en/plugins-reference) uses `${CLAUDE_PLUGIN_ROOT}`. Separate generated host packages avoid ambiguous default/custom MCP config merging. Installed plugins need no dependency installation.

The bridge focuses on text conversation and review. Planning, media, document generation, transcript import, workflow orchestration, and remote service hosting remain outside the bridge.

## Lessons from codex-plugin-cc

Reviewed OpenAI's [codex-plugin-cc](https://github.com/openai/codex-plugin-cc/tree/db52e28f4d9ded852ab3942cea316258ae4ef346) at commit `db52e28` on 2026-09-05. It exposes Claude commands, an agent, and hooks over Codex app-server. Its command count is not an MCP tool count.

| Design | Application here |
| --- | --- |
| [Status with or without a job ID](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/scripts/codex-companion.mjs#L883) | `grok_status` accepts an ID or an exact workspace path. It reuses the existing in-memory job map and returns bounded metadata. |
| [Review as a focused workflow](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/commands/review.md) | The `grok-review` skill sets a review target and read-only mode over `grok_chat`; no separate review transport or tool is needed. Untracked changes count as reviewable work. |
| [Preserve evidence and uncertainty in results](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/skills/codex-result-handling/SKILL.md) | Both skills distinguish Grok's assessment from host verification and preserve incomplete/failure status. Existing user authorization still controls follow-up edits. |
| [Native runtime protocol](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/scripts/lib/app-server.mjs#L190) | The same principle supports our MCP-to-ACP choice: reuse native sessions, configuration, and cancellation. |

Its disk-backed jobs and session broker coordinate separate companion processes. Our MCP process already owns its active connections and results, so no additional broker or job store is needed for the current scope. Host transcript transfer and the optional stop-time review loop are separate workflows and are not enabled by this bridge. The four MCP tools cover chat/resume, status/results/discovery, cancellation, and setup; skills provide task-specific guidance.
