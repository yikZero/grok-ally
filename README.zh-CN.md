# Grok Bridge

在 **Codex、Claude Code 或其他本地 MCP 客户端**里与 Grok Build 交流，复用已有的 Grok 登录。支持多轮对话、恢复会话和取消请求。

[English](README.md) · [使用参考](docs/usage.md) · [更新记录](CHANGELOG.md)

```text
Codex / Claude → MCP → Grok Bridge → ACP → Grok Build
```

## 安装

需要 **Node.js 22+** 和已通过 `grok login` 登录的 [Grok Build](https://docs.x.ai/build/overview)。使用 macOS 或 Linux，并确保 Grok sandbox 可用；Windows 请在 WSL 中运行客户端和桥接服务。

### Codex

```bash
codex plugin marketplace add yikZero/grok-bridge
codex plugin add grok-bridge@grok-bridge
```

安装后新建一个 Codex 任务。

### Claude Code

```bash
claude plugin marketplace add yikZero/grok-bridge
claude plugin install grok-bridge@grok-bridge
```

安装后重启 Claude Code，也可以在交互界面中使用 `/plugin` 命令。

其他本地客户端使用[标准 MCP 配置](docs/usage.md#manual-mcp-installation)。安装包已包含运行代码，**不需要安装 npm 依赖或构建**。

## 使用

直接对当前助手说：**“用 Grok Bridge 帮我分析这个设计。”** 然后继续追问即可。

审查代码时，可以说：**“用 Grok 审查我尚未提交的改动。”** `grok-review` skill 会以只读方式审查，并要求给出证据、代码位置和验证范围。

| 工具 | 用途 |
| --- | --- |
| `grok_chat` | 开始或继续对话 |
| `grok_status` | 查询结果，或列出项目中运行和最近结束的请求 |
| `grok_cancel` | 取消当前请求 |
| `grok_setup` | 检查本地 Grok 安装 |

助手会传入项目路径，并保留会话 ID 用于追问。需要分享给 Grok 的上下文放在提示词中；插件不会自动导入 Codex 或 Claude 的聊天记录。

默认禁止修改项目，明确授权编辑时才设置 `write: true`。Grok 仍可读取项目外的文件，使用自己的工具、钩子和网络配置。更多参数与权限说明见[使用参考](docs/usage.md#permissions-and-lifecycle)。

## 开发

```bash
npm ci --ignore-scripts
npm run build
npm test
```

修改 `src/` 后重新构建和安装。两个插件共用同一份运行代码，不要直接改生成文件或安装缓存。

[架构与源码调研](docs/architecture.md) · [验证记录](docs/validation.md) · [发布规范](docs/releasing.md)

独立开源项目，与 xAI、OpenAI、Anthropic 无隶属关系。[Apache-2.0](LICENSE) · [致谢](NOTICE)。
