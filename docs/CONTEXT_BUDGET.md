# 上下文与预算管理

## 上下文选择

`ContextManager` 接收带来源、类型和优先级的候选内容，输出 `ModelGateway` 可直接消费的有界上下文。

当前规划上下文按以下优先级组成：

1. 用户目标。
2. 项目概览。
3. 仓库规则文件：`AGENTS.md`、`CLAUDE.md`、`.github/copilot-instructions.md`、`CONTRIBUTING.md`。
4. 会话历史摘要。
5. 最近会话消息。
6. 最近工具结果。

选择器执行以下规则：

- 按优先级稳定排序。
- 对相同引用和相同内容去重。
- 使用 SHA-256 生成 `contentHash`，并将引用保存到任务运行检查点。
- 分别限制条目数量、单条 UTF-8 字节数和请求总字节数。
- 截断时保持有效 UTF-8，并添加明确标记。
- 空内容和超出总预算的低优先级内容不进入模型请求。

规则文件只从任务隔离工作区读取。读取前执行工作区边界与符号链接检查；缺失、二进制或非法 UTF-8 文件会被忽略。

## 历史摘要

每次规划保留最近 `MAX_CONTEXT_HISTORY_MESSAGES` 条原始消息。更早的消息通过 `ModelGateway.summarize` 压缩：

- 摘要和已覆盖消息数量保存在 `task_run_checkpoints`。
- 新消息出现时只汇总尚未覆盖的旧消息，并把已有摘要作为输入。
- 摘要请求同样受上下文字节、模型 Token、成本、超时和取消约束。
- 当前消息 API 尚未发布；仓储接口和摘要流程已经可供后续会话 API 使用。

## 持久化运行检查点

数据库 schema v5 新增 `task_run_checkpoints`。每个任务最多一个运行检查点，包含：

- 稳定的 `runId` 和版本化 `RunState`。
- 当前阶段、计划、上下文引用、工具调用、快照、变更文件和验证结果引用。
- 全部限制和累计用量。
- 历史摘要、已摘要消息数量、开始时间和更新时间。
- 乐观版本号。

模型或工具等外部操作不会放进数据库事务。操作前预留次数预算，操作完成后立即写入实际用量；任务状态转换后同步运行阶段和引用。

## 预算维度

当前预算包括：

| 维度                 | 配置                      |
| -------------------- | ------------------------- |
| 模型决策步数         | `MAX_TASK_STEPS`          |
| 工具调用次数         | `MAX_TASK_TOOL_CALLS`     |
| 任务总时长           | `MAX_TASK_DURATION_MS`    |
| 变更文件数           | `MAX_TASK_CHANGED_FILES`  |
| 输入 Token           | `MAX_MODEL_INPUT_TOKENS`  |
| 输出 Token           | `MAX_MODEL_OUTPUT_TOKENS` |
| 模型成本             | `MAX_MODEL_COST`          |
| 上下文与读取结果字节 | `MAX_CONTEXT_READ_BYTES`  |
| 验证次数             | `MAX_VERIFICATION_RUNS`   |

上下文形状还受 `MAX_CONTEXT_BYTES`、`MAX_CONTEXT_ENTRY_BYTES` 和 `MAX_CONTEXT_ENTRIES` 限制。

次数预算在操作开始前预留，因此达到上限后不会再启动新操作。只能在响应后获知的 Token、成本、读取字节和变更文件用量会先持久化，再检查是否超限。

## 停止语义

预算错误统一使用：

```json
{
  "code": "BUDGET_EXCEEDED",
  "details": {
    "category": "MAX_TOOL_CALLS",
    "limit": 1,
    "used": 1
  }
}
```

活动任务触发预算限制后进入 `PAUSED`，保存原阶段作为 `resumeStatus`，记录稳定的 `stopReason` 和 `task.paused` 事件，并释放任务租约。当前恢复会继续沿用原预算；预算调整 API 属于后续产品集成范围。
