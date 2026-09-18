# Grok Ally

在 **Codex、Claude Code 或其他本地 MCP 客户端**里调用 Grok Build 或 Cursor Agent，使用对应服务已有的登录。支持多轮对话、恢复会话和取消请求。

[English](README.md) · [使用参考](docs/usage.md) · [更新记录](CHANGELOG.md)

原名 Grok Bridge。从 0.2.x 或更早版本升级，请按[迁移步骤](docs/usage.md#upgrade-from-grok-bridge)重新安装。

```text
Codex / Claude → MCP → Grok Ally → ACP → Grok Build / Cursor Agent
```

## 安装

需要 **Node.js 22+**，以及已登录的 [Grok Build](https://docs.x.ai/build/overview)（`grok login`）或 [Cursor Agent](https://cursor.com/docs/cli/installation)（`agent login`）。只需安装实际使用的后端。支持 macOS、Linux；Windows 请在 WSL 中运行客户端和桥接服务。

### Codex

```bash
codex plugin marketplace add yikZero/grok-ally
codex plugin add grok-ally@grok-ally
```

安装后新建一个 Codex 任务。

### Claude Code

```bash
claude plugin marketplace add yikZero/grok-ally
claude plugin install grok-ally@grok-ally
```

安装后重启 Claude Code，也可以在交互界面中使用 `/plugin` 命令。

其他本地客户端使用[标准 MCP 配置](docs/usage.md#manual-mcp-installation)。安装包已包含运行代码，**不需要安装 npm 依赖或构建**。

## 使用

直接对当前助手说：**“用 Grok Ally 帮我分析这个设计。”** 然后继续追问即可。

审查代码时，可以说：**“用 Grok 审查我尚未提交的改动。”** `grok-review` skill 会以只读方式审查，并要求给出证据、代码位置和验证范围。

| 工具 | 用途 |
| --- | --- |
| `grok_chat` | 开始或继续对话 |
| `grok_status` | 跟进进度、读取完整结果，或查找最近的请求 |
| `grok_cancel` | 取消当前请求 |
| `grok_setup` | 检查所选后端的安装 |

使用 Cursor 时，可以说：**“通过 Cursor 调用 Grok Ally 来实现这个需求。”** 助手传入 `provider: "cursor"`，默认模型固定为 **`cursor-grok-4.6-xhigh`**。不传 `provider` 仍使用 Grok Build；也可在 MCP 服务环境中设置 `GROK_ALLY_PROVIDER=cursor`。旧会话保持原来的后端，不会因额度不足自动切换。详见[后端选择](docs/usage.md#choose-a-backend)。

助手会传入项目路径，并保留会话 ID 用于追问。需要分享给 Grok 的上下文放在提示词中；插件不会自动导入 Codex 或 Claude 的聊天记录。

长任务默认返回精简进度，结束后再给回答，减少轮询占用的上下文。`completed` 表示所选代理结束了这一轮，不等于工具结果已确认或已通过独立验收。详细工具记录与全文仍可按需读取，详见[结果与取消](docs/usage.md#results-and-cancellation)及[效率测量](docs/efficiency.md)。

默认只读，明确授权编辑时才设置 `write: true`。Grok 使用 OS 沙箱；Cursor 使用经核验的 Ask / Agent 模式及原生权限规则，两者不具有相同的 OS 写入限制。各自的工具、钩子和网络配置仍然生效。更多参数与权限说明见[使用参考](docs/usage.md#permissions-and-lifecycle)。

## 开发

```bash
npm ci --ignore-scripts
npm run build
npm test
```

修改 `src/` 后重新构建和安装。两个插件共用同一份运行代码，不要直接改生成文件或安装缓存。

[架构与源码调研](docs/architecture.md) · [验证记录](docs/validation.md) · [发布规范](docs/releasing.md)

独立开源项目，与 xAI、Cursor、OpenAI、Anthropic 无隶属关系。[Apache-2.0](LICENSE) · [致谢](NOTICE)。
