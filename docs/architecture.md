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
| MCP → per-call Node companion → per-turn ACP | Existing local fork proves functionality, but adds a process hop, Codex task mapping, and a large unrelated job surface. Its chat cancellation did not reach ACP. |
| **MCP → persistent ACP child** | Selected. One portable host-facing contract with native Grok session semantics. |
| WebSocket daemon | Requires another server lifecycle, authentication, and reconnect policy. Defer until a real remote-client requirement exists. |

## Implementation choices

The official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) and [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) own protocol parsing, negotiation, request correlation, and framing. Both stdio transports use newline-delimited JSON. A second-opinion review incorrectly suggested Claude needed Content-Length framing; inspection of the MCP SDK and the official-client integration test refuted it. No custom dual-framing layer was added.

Explicit `sessionId` replaces host-thread environment variables. [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup) defines loading and replay. Only fresh prompt updates enter a result. A failed load is visible to the caller.

Bounded request handles solve host tool deadlines without a daemon or a job database. Prompts are not retried after ambiguous failures. Grok owns conversation persistence; the bridge keeps only active connections and bounded result summaries in memory. Same-session exclusion is currently within one MCP process, so multi-host use requires an explicit handoff after disconnecting the original client.

Codex and Claude package the same generated runtime with their own marketplace/manifest paths. [Codex packaging](https://developers.openai.com/plugins/build/plugins) uses a plugin-relative working directory; [Claude plugin configuration](https://code.claude.com/docs/en/plugins-reference) uses `${CLAUDE_PLUGIN_ROOT}`. Separate generated host packages avoid ambiguous default/custom MCP config merging. Installed plugins need no dependency installation.

Version 0.1 focuses on text conversation. Planning, media, document generation, transcript import, workflow orchestration, and remote service hosting remain outside the bridge. The existing local plugin remains available for those workflows.
