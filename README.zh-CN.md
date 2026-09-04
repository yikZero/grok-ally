# Grok Bridge

在 **Codex、Claude Code 或其他本地 MCP 客户端**里与 Grok Build 持续交流，复用已有的 `grok login` 登录。

```text
Codex / Claude → MCP → Grok Bridge → ACP → Grok Build
```

外层用标准 MCP，内层用 Grok 官方支持的 ACP。连接在多轮对话之间保留，支持恢复会话、进度和取消。

## 安装

需要 Node.js 22+、已安装并登录的 Grok Build，以及可用的 Grok sandbox。macOS、Linux 可用；Windows 请在 WSL 中运行，原生 Windows 尚未验证。

Codex：

```bash
codex plugin marketplace add yikZero/grok-bridge
codex plugin add grok-bridge@grok-bridge
```

安装后新建 Codex 任务。

Claude Code：

```bash
claude plugin marketplace add yikZero/grok-bridge
claude plugin install grok-bridge@grok-bridge
```

安装后重启 Claude Code，也可以在其交互界面使用 `/plugin` 命令。

其他客户端的 stdio 配置见 [英文 README](README.md#any-local-mcp-client)。发布仓库已包含构建产物，使用者不用安装 npm 依赖。Claude.ai 网页不能直接启动本地 MCP 进程。

## 使用

直接说：“用 Grok Bridge 帮我分析这个设计。”

- `grok_chat`：传 `prompt` 和真实项目绝对路径 `cwd`。首次省略 `sessionId`，后续传返回的 ID。
- `grok_status`：慢请求会返回 `requestId`，用它查询直到结束。
- `grok_cancel`：请求取消，再查询状态确认。取消不会撤销已经发生的修改。
- `grok_setup`：检查安装和版本；实际聊天成功才能证明账户可用。

默认 `write=false`，启用 Grok 的只读 sandbox；明确授权修改项目时才设 `write=true`。只读限制的是项目写入：Grok 仍可读项目外文件、写自身状态和临时目录，远程工具和网络仍由 Grok 的配置决定。

`model`、`effort` 只在新会话生效，省略就使用 Grok 默认值。`maxTurns` 默认 20，运行中的同一会话要保持 `cwd`、`write` 和 `maxTurns` 一致。

请求最多等待 25 秒，然后返回进度句柄；`starting/running/cancelling` 都不表示结束。只有 `completed` 表示正常结束，超轮数会返回 `incomplete`，保留部分答案和会话 ID。加载失败不会偷偷开启新会话。

连接空闲五分钟后释放，之后可凭原 ID 恢复；最多四个驻留会话。请勿让两个客户端进程同时使用同一个 Grok 会话，跨客户端交接前先断开原客户端。请求结果仅存在当前 MCP 进程内，最多保留 100 条、每条 64,000 字符；原生会话由 Grok 保存。

本项目不会自动读取或导出 Codex/Claude 聊天记录。需要共享的上下文直接写入提示词。不需要额外 API Key，也不会读取凭证文件。更详细的权限与生命周期说明见 [英文 README](README.md#lifecycle-and-boundaries)。

## 维护

```bash
npm ci --ignore-scripts
npm run build
npm test
```

修改 `src/` 后重新构建和安装，不要改插件缓存。Codex 与 Claude 两个安装包共用同一运行代码，由构建脚本生成。

旧版 grok-in-codex-local 的计划、图片、文档等专用工具保留在旧插件。本项目聚焦交流，不自动迁移或删除旧插件。

[源码调研与架构选择](docs/architecture.md) · [验证记录](docs/validation.md)

独立开源项目，与 xAI、OpenAI、Anthropic 无隶属关系。Apache-2.0。
