# Response efficiency

Reviewed on 2026-09-05. Version 0.6.0 reduces the context needed to follow a Grok task while retaining the full answer and diagnostic history.

## Designs reviewed

| Source | Finding and decision |
| --- | --- |
| [GitHub MCP search](https://github.com/github/github-mcp-server/blob/9205304fedf10540c33ae41fcf6352fa97dcc9be/pkg/github/search.go#L40) and [minimal types](https://github.com/github/github-mcp-server/blob/9205304fedf10540c33ae41fcf6352fa97dcc9be/pkg/github/minimal_types.go#L16) | Defaults to minimal results and supports field selection. Grok Ally now defaults to compact status, with `detail: "full"` for diagnostics. |
| [codex-plugin-cc wait](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/scripts/codex-companion.mjs#L318) and [result rendering](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/scripts/lib/render.mjs#L377) | Keeps waiting inside the tool and separates status from stored output. Our skills now use completion waits by default; progress-triggered returns remain opt-in. |
| [acpx quiet formatter](https://github.com/openclaw/acpx/blob/9ace84727fc219fd15ccec84963af14536efd275/src/cli/output/output.ts#L1128) | Collects assistant text until the prompt ends. We keep running text out of compact responses and return the answer when terminal. |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp#tools) | Supports saving larger results outside inline responses. Grok Ally already retains full text outside the host context; compact pages now avoid repeating tool history. |
| [MCP structured results](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#structured-content) | Recommends a serialized text fallback alongside structured content. Both remain equivalent; shrinking the underlying result preserves compatibility. |

No additional model call summarizes or rewrites Grok's answer. Model, reasoning effort, session context, and native privacy settings are unchanged. Resource links and experimental task protocols were not required for this local four-tool interface.

## Grok Build source findings

The public source is pinned to [`72a61251`](https://github.com/xai-org/grok-build/tree/72a61251fcffb464bcc687aeb5a998e5a98ec0c9); the remote HEAD still matched on the review date. It is a partial public snapshot, not asserted to be the exact source of the tested `1.0.13` binary.

- [ACP initialization](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs#L206) accepts `_meta.bufferingSettings`.
- [ReplayBuffer](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-shell/src/agent/update_chunk_merge.rs#L6) can merge text chunks before sending them. Grok Ally requests batching thresholds of 100 chunks, 16 KiB, or 200 ms. The bridge still handles ordinary unbuffered ACP events.
- [Replay events](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-shell/src/session/replay_events.rs#L25) distinguish streaming text from discrete events and provide explicit flushing. Tool updates and terminal output must remain observable.
- [Prompt metadata](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-shell/src/agent/mvp_agent/mod.rs#L482) distinguishes whole-prompt `usage` from last-model-call token fields. Neither is a measure of the host's MCP-context cost; this release does not infer subscription savings from them.

A real paired check requested the same 30-line Chinese answer from `grok-4.6` / `xhigh`. Both replies were exactly 1,109 UTF-8 bytes. Assistant text events decreased from **329 to 20** with native buffering. This measures event delivery, not reduced model inference or guaranteed latency improvement.

## Response-size comparison

The deterministic fixture emits 120 tool calls and commentary, then a conclusion. It compares 0.5.0 and 0.6.0 over identical events: 12 incremental running queries, 12 unchanged queries, and 12 pages containing the entire answer. Both runs reconstruct all **184,025 answer bytes** exactly.

| Scenario | 0.5.0 text bytes | 0.6.0 text bytes | Estimated tokens, before → after | Reduction |
| --- | ---: | ---: | ---: | ---: |
| Running queries | 217,797 | 3,764 | 55,062 → 1,224 | 97.8% |
| Unchanged queries | 5,268 | 1,608 | 1,860 → 480 | 74.2% |
| Complete answer pagination | 389,735 | 187,583 | 121,614 → 44,514 | 63.4% |

Token estimates use `tiktoken`'s `o200k_base` on **one serialized text result per call**. They exclude schemas, call arguments, host wrappers, subsequent reasoning, and provider billing. Clients may handle the text and structured copies differently; we do not count them twice or claim an equal percentage reduction in subscription usage. Byte counts are directly measured; timestamps can cause minor token-count variation between runs.

Run the fixture with Node 22 and the development dependencies installed in each checkout:

```bash
node scripts/measure-responses.mjs > current.json
node scripts/measure-responses.mjs /path/to/v0.5.0/src/bridge.mjs > baseline.json
```

Each JSON file contains call counts, measured UTF-8 bytes, and serialized replies for an independent tokenizer comparison. The fixture makes no model requests. Full-mode diagnostics intentionally retain the larger payload; the savings come from requesting them only when needed.
