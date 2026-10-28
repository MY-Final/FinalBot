# FinalBot Plugin SDK v1

FinalBot 插件是运行在独立 Worker 中的本地扩展。插件可以注册 Agent 工具、订阅运行事件，并通过
Web 控制台启停和设置工具策略。

这不是 AstrBot Python 插件 API 的兼容层。v1 只提供 FinalBot 自己的 TypeScript/JavaScript 契约。

## 目录

插件放在 FinalBot 数据目录下：

```text
<dataDir>/plugins/<plugin-id>/
  metadata.json
  index.js
```

插件自己的持久数据放在：

```text
<dataDir>/plugin-data/<plugin-id>/
```

Linux Docker 默认对应：

```text
/opt/finalbot/data/plugins/<plugin-id>/
/opt/finalbot/data/plugin-data/<plugin-id>/
```

首次发现的插件默认禁用。启用状态、工具策略和最近状态保存在 SQLite。

## metadata.json

```json
{
  "apiVersion": 1,
  "id": "hello-world",
  "name": "Hello World",
  "version": "1.0.0",
  "description": "A minimal FinalBot plugin.",
  "author": "FinalBot",
  "entry": "index.js",
  "permissions": ["tools", "events"],
  "tools": ["greet"]
}
```

- `id` 必须与目录名一致，只允许小写字母、数字、`-` 和 `_`。
- `entry` 必须位于插件目录内。
- `tools` 中的每个工具都必须在激活时注册。
- 注册工具需要 `tools` 权限，订阅事件需要 `events` 权限。

## 最小插件

```js
let observedRuns = 0;

export default {
  activate(context) {
    context.registerTool({
      name: "greet",
      description: "Return a greeting.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      run(input, invocation) {
        return {
          message: `Hello ${input.name}`,
          botId: invocation.botId,
          runId: invocation.runId,
        };
      },
    });

    context.registerEvent("run.updated", (event) => {
      observedRuns += 1;
      context.log("debug", "observed run update", { observedRuns });
    });
  },

  deactivate() {
    observedRuns = 0;
  },
};
```

完整示例见 `examples/plugins/hello-world/`。

## 工具调用上下文

`run(input, context)` 会收到：

```ts
interface PluginToolInvocationContext {
  runId: string;
  conversationId: string;
  botId: string;
  ownerId: string | null;
  toolSnapshotHash?: string;
  invokedAt: string;
}
```

工具返回值和异常都会进入 Tool Call 审计。返回值必须是可 JSON 序列化的数据。

## 事件

v1 支持：

- `run.updated`
- `run.delta`
- `approval.requested`
- `approval.resolved`
- `system`

同一事件类型最多注册 16 个 handler。事件 handler 应快速完成；默认执行超时为 10 秒。

## 工具策略和快照

插件工具命名空间固定为 `plugin.<plugin-id>`。Web 控制台支持三种策略：

- `auto`：Agent 可直接调用。
- `ask`：调用前进入 ApprovalBroker 审批。
- `deny`：调用直接拒绝。

默认策略是 `ask`。插件启停、重载或策略变化会产生新的 ToolSnapshot，只影响之后创建的
Run；执行中的 Run 继续使用旧快照。

## 生命周期和限制

- 激活默认 10 秒超时，工具调用默认 30 秒超时。
- 主进程与 Worker 单条消息默认上限 512 KiB。
- Worker 崩溃、激活失败或超时会把插件标记为 `error`，并立即摘除其工具。
- 重载会先停用旧 Worker，再重新发现和激活。
- Worker 不继承服务端环境变量，只保留 `TZ`、`LANG`、`LC_ALL`、`TMP`、`TEMP`、`TMPDIR`。
- 常用全局网络入口 `fetch`、`WebSocket`、`EventSource`、`XMLHttpRequest` 会被移除。

## 安全边界

Worker 提供的是故障隔离和生命周期隔离，不是恶意代码沙箱。Node/Bun 内建模块仍可能被插件访问。
只启用你信任并审查过的插件。v1 暂不提供远程安装、签名验证、权限市场和 Python sidecar。

## 开发流程

1. 在 `<dataDir>/plugins/` 创建插件目录。
2. 写入 `metadata.json` 和入口文件。
3. 打开 Web 的“插件”页面，点击“重新发现”。
4. 审查代码后启用插件。
5. 为工具选择 `auto`、`ask` 或 `deny`。
6. 新建 Run；已有 Run 不会获得新工具。

开发阶段可在 TypeScript 包中直接复用导出的类型：

```ts
import { definePlugin, type PluginContext } from "@finalbot/plugin-sdk";
```
