# Focus Pet 智能体任务完成通知

Focus Pet 的主可执行文件可以作为 Codex CLI `notify` 命令或 Claude Code Hook 的接收器。接收到事件后，运行中的 App 会在约 1.5 秒内读取事件，让桌宠切换到“任务完成”动作并显示摘要，同时尝试发送本机通知。

## 接收命令

安装版命令：

```text
/Applications/Focus Pet.app/Contents/MacOS/focus-pet --agent-notify <provider>
```

`provider` 推荐使用 `codex` 或 `claude`。命令既支持最后一个参数传入 JSON，也支持从 stdin 读取 JSON；事件只写入 Focus Pet 的本地 Application Support 目录，不上传内容。

## Codex CLI

在 `~/.codex/config.toml` 中设置：

```toml
notify = ["/Applications/Focus Pet.app/Contents/MacOS/focus-pet", "--agent-notify", "codex"]
```

如果当前已有 `notify` 命令，不要直接覆盖；使用一个自己的 fan-out 包装器同时调用原命令与 Focus Pet。Codex Desktop 的 app-server 生命周期事件是更可靠的桌面集成入口；目前的 Focus Pet 接收器覆盖会执行 `notify` 的 Codex CLI 流程。

## Claude Code

在 `~/.claude/settings.json` 的 `hooks` 中，为 `Stop`、`TaskCompleted` 和 `StopFailure` 配置 command hook：

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "'/Applications/Focus Pet.app/Contents/MacOS/focus-pet' --agent-notify claude"
      }]
    }],
    "TaskCompleted": [{
      "hooks": [{
        "type": "command",
        "command": "'/Applications/Focus Pet.app/Contents/MacOS/focus-pet' --agent-notify claude"
      }]
    }],
    "StopFailure": [{
      "hooks": [{
        "type": "command",
        "command": "'/Applications/Focus Pet.app/Contents/MacOS/focus-pet' --agent-notify claude"
      }]
    }]
  }
}
```

Claude Code 会把 Hook JSON 通过 stdin 交给命令。Focus Pet 会优先读取任务主题、任务描述或最后一条助手消息，并限制桌宠气泡长度。

## 其他智能体

任何能在任务结束时执行命令的工具都可以复用同一入口：

```sh
printf '%s' '{"status":"completed","message":"索引构建完成"}' | \
  '/Applications/Focus Pet.app/Contents/MacOS/focus-pet' --agent-notify agent
```

没有确认到名为 “DeepSync/Cleed” 的统一编码智能体协议，因此没有为未知产品写死专有适配。通用 JSON/stdin 接口可作为这类工具的适配层。

## 隐私与覆盖范围

- 默认只保留完成事件的短摘要，Focus Pet 读取后即清空事件收件箱。
- 不记录 prompt、输入内容或完整会话。
- Focus Pet 不会自动修改 `~/.codex` 或 `~/.claude`；配置变更应由用户确认后执行。
- 桌宠被隐藏时仍会尝试发送系统通知；重新显示桌宠不会回放已消费事件。
