# API 与事件契约

## 版本

HTTP API 当前版本为 `/api/v1`。OpenAPI 文档地址：`GET /api/v1/openapi.json`。领域对象的 JSON Schema 位于 `schemas/domain.schema.json`。

## 任务事件顺序

一次正常任务至少按以下顺序产生事件：

```text
task.created
task.state_changed: CREATED -> PRECHECKING
task.state_changed: PRECHECKING -> PLANNING
task.plan.updated
task.state_changed: PLANNING -> EXECUTING
tool.started / tool.completed  (可重复)
task.state_changed: EXECUTING -> VERIFYING
tool.started / tool.completed  (可重复)
task.state_changed: VERIFYING -> READY_FOR_REVIEW
task.completed
```

异常分支以 `task.failed` 结束；用户暂停、取消或需要确认时，分别产生 `task.paused`、`task.state_changed` 或 `task.waiting_user`。

事件数据库顺序由自增 `id` 保证。前端必须按 `id` 排序，不能只依赖网络到达顺序。

## SSE 重连

订阅地址：

```text
GET /api/v1/tasks/{taskId}/events
```

首次连接不传游标。断线重连时优先发送标准请求头：

```text
Last-Event-ID: 42
```

也可以使用查询参数 `?after=42`。服务端只返回 `id > 42` 的事件，然后继续推送新事件。服务端每 15 秒发送一次注释心跳，前端应在连接关闭后按递增间隔重连。

每条消息包含：

```text
id: 43
event: tool.completed
data: {"taskId":"...","timestamp":"...","toolName":"list_files"}
```

## 错误码

| 错误码                | 含义                              |
| --------------------- | --------------------------------- |
| `VALIDATION_ERROR`    | 请求参数缺失或格式错误            |
| `NOT_FOUND`           | 项目、会话或任务不存在            |
| `CONFLICT`            | 状态转移或版本冲突                |
| `FORBIDDEN`           | 路径越界或权限不足                |
| `WORKSPACE_ERROR`     | 工作区、命令或验证执行失败        |
| `COMMAND_NOT_ALLOWED` | 命令不在白名单或包含 Shell 操作符 |
| `INTERNAL_ERROR`      | 未分类服务端错误                  |

统一响应格式：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "projectId is required",
    "details": {}
  }
}
```
