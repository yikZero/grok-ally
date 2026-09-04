---
name: grok-chat
description: Use when the user asks to talk to Grok, ask Grok for a second opinion, or continue a Grok conversation from Codex or Claude Code.
---

Use this plugin's `grok_chat` tool. Always pass the user's absolute project directory as `cwd`; never use the plugin install/cache directory.

- Start a conversation by omitting `sessionId`. Keep the returned `sessionId` in this conversation and pass it for follow-ups. Do not borrow an ID from an unrelated conversation or silently start over when loading fails.
- Only send the user's requested prompt and relevant context. Do not read or export host transcript files, hidden reasoning, system/developer instructions, or credentials. Ask before sharing unrelated private context.
- Leave `write=false` for discussion, research, and review. Use `write=true` only when the user has authorized Grok to modify the workspace. This enables Grok's workspace sandbox and automatic tool approval; remote tools remain governed by Grok's configuration.
- `starting`, `running`, and `cancelling` are not finished. Poll `grok_status` with the returned `requestId` and `waitSeconds=25` until terminal. Show partial text as partial.
- If the request ID is missing, call `grok_status` with the exact workspace `cwd` instead. It lists active and recent requests in this MCP process. Select the relevant ID before reading or cancelling; do not guess another conversation's ID. A restart clears this list.
- `incomplete` (including turn limits), `failed`, and `cancelled` are not successful completion. Preserve partial output and the session ID, and report the actual status.
- Attribute Grok's answer to Grok. Preserve its evidence, uncertainty, file locations, and proposed next steps; distinguish any host verification or conclusions from Grok's report. Do not substitute a host-generated answer for a failed Grok call.
- To stop, call `grok_cancel`, then confirm with `grok_status`. Cancellation does not undo edits.
- Omit `model` and `effort` to use Grok's native settings. They are creation-only options. Keep `cwd` and `write` consistent for a live session. Do not pass `maxTurns`; Grok's ACP mode does not enforce that CLI option.
- When sharing an ID with another local MCP client, finish the active turn first. Do not prompt the same Grok session from two host processes concurrently.
- `grok_setup` checks installation, not login. If chat reports an authentication error, tell the user to run `grok login` in their terminal.
