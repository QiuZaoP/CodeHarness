# API 与事件契约

## 版本与权威来源

- HTTP API 的规范前缀是 `/api/v1`；`/api/health` 是无版本健康检查。
- 当前契约版本为 `1.0.0`。事件通过 `schemaVersion` 显式携带该版本。
- OpenAPI：`GET /api/v1/openapi.json`，源文件为 `schemas/openapi.json`。
- 领域对象：`schemas/domain.schema.json`。
- 任务事件：`schemas/event.schema.json`。
- TypeScript 枚举权威来源：`backend/src/contract-values.ts`。

修改枚举或公开对象时，必须同步上述契约并运行 `npm run schema:check`。`1.x` 只允许向后兼容变更；删除字段、收紧已有字段或改变语义时必须升级主版本。

## 当前已实现接口

| 方法   | 路径                              | 用途           |
| ------ | --------------------------------- | -------------- |
| `GET`  | `/api/health`                     | 健康检查       |
| `GET`  | `/api/v1/openapi.json`            | 获取 OpenAPI   |
| `POST` | `/api/v1/projects`                | 导入本地项目   |
| `GET`  | `/api/v1/projects/{projectId}`    | 获取项目       |
| `POST` | `/api/v1/sessions`                | 创建会话       |
| `POST` | `/api/v1/tasks`                   | 创建任务       |
| `GET`  | `/api/v1/tasks/{taskId}`          | 获取任务       |
| `POST` | `/api/v1/tasks/{taskId}/run`      | 运行任务       |
| `GET`  | `/api/v1/tasks/{taskId}/events`   | 订阅任务事件   |
| `POST` | `/api/v1/tasks/{taskId}/pause`    | 暂停任务       |
| `POST` | `/api/v1/tasks/{taskId}/resume`   | 恢复任务       |
| `POST` | `/api/v1/tasks/{taskId}/cancel`   | 取消任务       |
| `POST` | `/api/v1/tasks/{taskId}/apply`    | 确认应用       |
| `POST` | `/api/v1/tasks/{taskId}/rollback` | 回滚任务工作区 |

消息、搜索、文件级变更审批及验证资源已经在领域 Schema 中预留 DTO，但在对应持久化、
索引、工具和安全阶段完成前不发布空实现路由。前端旧的 `/api/*` 调用需要迁移到这里列出
的 `/api/v1/*` 路径。

`sourcePath` 和 `workspacePath` 是后端内部路径。创建项目时允许提交 `sourcePath`，但项目和任务响应不会回传这两个字段。

当前版本只面向本机开发：默认绑定 `127.0.0.1`，尚未提供身份认证，且 CORS 仍为开发配置。不得将服务暴露到不可信网络；认证、来源白名单和部署安全配置完成前不属于可部署版本。

控制接口的当前语义：

- `run` 只接受 `CREATED`，原子获取租约后返回 `202 Accepted`；任务在后台执行，重复或
  冲突调用返回 `409 CONFLICT`。
- `pause` 只接受已经获得租约的运行任务；它取消当前操作、进入 `PAUSED` 并持久化恢复
  目标。
- `resume` 接受带恢复目标的 `PAUSED` 或 `WAITING_USER`，获取新租约后返回 `202 Accepted`。
- `cancel` 将允许的非终态任务转为终态 `CANCELLED`；重复取消返回 `409 CONFLICT`。
- `apply` 要求所有文件变更已审阅，只把 `ACCEPTED` 文件安全写入项目源目录；源文件偏离
  任务基线或任务工作区 Diff 偏离审阅版本时返回 `409 CONFLICT`。
- `rollback` 使用数据库中的基线快照哈希验证并恢复当前任务的独立工作区，成功后将任务转为
  `CANCELLED`；不会修改项目源目录或删除基线快照。

租约、协作式控制、恢复目标和服务重启规则见 [LIFECYCLE.md](LIFECYCLE.md)。

## 任务状态与事件

典型成功流程：

```text
CREATED -> PRECHECKING -> PLANNING -> EXECUTING
        -> VERIFYING -> READY_FOR_REVIEW
```

允许的状态后继：

| 当前状态                         | 允许的后继状态                                                            |
| -------------------------------- | ------------------------------------------------------------------------- |
| `CREATED`                        | `PRECHECKING`、`PAUSED`、`CANCELLED`                                      |
| `PRECHECKING`                    | `PLANNING`、`WAITING_USER`、`PAUSED`、`FAILED`、`CANCELLED`               |
| `PLANNING`                       | `EXECUTING`、`WAITING_USER`、`PAUSED`、`FAILED`、`CANCELLED`              |
| `EXECUTING`                      | `EXECUTING`、`VERIFYING`、`WAITING_USER`、`PAUSED`、`FAILED`、`CANCELLED` |
| `VERIFYING`                      | `EXECUTING`、`READY_FOR_REVIEW`、`PAUSED`、`FAILED`、`CANCELLED`          |
| `READY_FOR_REVIEW`               | `APPLIED`、`EXECUTING`、`CANCELLED`                                       |
| `WAITING_USER`                   | `PLANNING`、`EXECUTING`、`VERIFYING`、`PAUSED`、`FAILED`、`CANCELLED`     |
| `PAUSED`                         | `PLANNING`、`EXECUTING`、`VERIFYING`、`CANCELLED`                         |
| `APPLIED`、`CANCELLED`、`FAILED` | 无（终态）                                                                |

对应事件至少为：

```text
task.created
task.state_changed
task.plan.updated
task.state_changed
tool.started / tool.completed  (可重复)
task.state_changed
tool.started / tool.completed  (可重复)
verification.completed
task.state_changed
task.completed
```

事件数据库顺序由单调递增的 `id` 保证。消费者必须按 `id` 排序和去重，不能只依赖网络到达顺序。公开事件类型包括：

- 任务：`task.created`、`task.state_changed`、`task.plan.updated`、`task.completed`、`task.failed`、`task.waiting_user`、`task.paused`、`task.resumed`、`task.cancelled`、`task.applied`
- 工具：`tool.started`、`tool.completed`
- 验证与变更：`verification.completed`、`change.updated`
- Harness：`harness.decision`（模型决策已持久化后发布，不表示工具已经执行）

每种事件的 payload 约束以 `schemas/event.schema.json` 为准。

## SSE 重连

订阅地址：

```text
GET /api/v1/tasks/{taskId}/events
```

首次连接不传游标。断线重连时优先发送标准请求头：

```text
Last-Event-ID: 42
```

也可以使用查询参数 `?after=42`。游标必须是非负整数。服务端只返回 `id > 42` 的事件，然后继续推送新事件，并每 15 秒发送一次注释心跳。

SSE 的 `id` 和 `event` 分别对应事件信封的 `id`、`type`；`data` 是完整、版本化的事件信封：

```text
id: 43
event: tool.completed
data: {"schemaVersion":"1.0.0","id":43,"taskId":"...","type":"tool.completed","timestamp":"...","payload":{"toolName":"list_files","result":{"count":8}}}
```

客户端重连后需要忽略已处理的 `id`，遇到不支持的 `schemaVersion` 时应停止解释 payload 并给出升级提示。

## 模型、索引与工具边界

- 模型决策仅允许 `TOOL_CALL`、`PLAN_UPDATE`、`ASK_USER`、`VERIFY`、`COMPLETE`。
- Harness 只依赖 `ModelGateway` 和 `CodeIndex` 端口；供应商 SDK 与具体解析器不能泄漏进 Harness。
- `ModelGateway` 必须支持结构化决策、流式增量、摘要、Embedding，以及 Token、成本和延迟统计。
- `CodeIndex` 必须支持项目概览、文件/文本/符号/引用、调用链和语义检索；所有源码定位使用一基行号。
- 工具名和结果信封以领域 Schema 为准。所有可变更仓库或执行命令的工具必须受路径、命令、预算、审计与取消策略约束。
- 所有端口调用均接收 `AbortSignal`，实现必须在取消后尽快终止。
- 规划阶段先读取项目概览，再请求结构化 `PLAN_UPDATE`；模型或索引错误会使任务进入
  `WAITING_USER` 并释放执行租约。
- 注入主代码索引后，主索引异常会降级到有界文件扫描与文本搜索；结构化查询不会伪造结果。
- 每个模型请求携带持久化 `RunState`。新增预算字段保持 `1.0.0` 向后兼容：旧适配器可以
  忽略，新 Harness 会始终发送完整的 Token、成本、读取字节和验证预算。

内置工具、命令允许策略、角色三注册入口和资源配额见
[TOOLS.md](TOOLS.md)。工具开始事件只公开脱敏后的参数摘要；文件内容和补丁正文不进入
SSE payload。

模型和索引适配器的错误分类、降级能力与接入清单见 [PORTS.md](PORTS.md)。
上下文来源、摘要游标、运行检查点和 `BUDGET_EXCEEDED` 语义见
[CONTEXT_BUDGET.md](CONTEXT_BUDGET.md)。

## 错误码

| 错误码                | 含义                               |
| --------------------- | ---------------------------------- |
| `VALIDATION_ERROR`    | 请求参数缺失或格式错误             |
| `NOT_FOUND`           | 项目、会话、任务或资源不存在       |
| `CONFLICT`            | 状态转移或版本冲突                 |
| `FORBIDDEN`           | 路径越界或权限不足                 |
| `WORKSPACE_ERROR`     | 工作区、命令或验证执行失败         |
| `COMMAND_NOT_ALLOWED` | 命令不在白名单或包含禁止操作       |
| `MODEL_ERROR`         | 模型提供方调用失败                 |
| `INDEX_ERROR`         | 代码索引或查询失败                 |
| `BUDGET_EXCEEDED`     | 迭代、工具调用、时间或成本预算耗尽 |
| `TASK_CANCELLED`      | 任务已取消                         |
| `INTERNAL_ERROR`      | 未分类服务端错误                   |

统一错误响应：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": {}
  }
}
```
