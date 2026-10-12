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

事件数据库顺序由自增 `id` 保证，前端必须按 `id` 排序。

## SSE 重连

订阅地址：`GET /api/v1/tasks/{taskId}/events`。

断线重连时优先发送 `Last-Event-ID` 请求头，也可以使用 `?after=42`。服务端只返回 `id > 42` 的事件，然后继续推送新事件；服务端每 15 秒发送一次注释心跳。

## Repository index Harness tools

`ToolCall.name` 支持 `index_repository`、`search_files`、`search_symbols`、`find_references`、`find_callers`、`find_callees` 和 `search_semantic`。

`index_repository` 使用哈希增量重建索引。AST 解析失败会记录索引问题并保留文件级回退片段。`search_semantic` 在存在兼容向量时返回 `vector`，否则返回 `lexical`，不会在没有 Embedding Provider 时发起模型请求。

## 错误码

| 错误码                | 含义                   |
| --------------------- | ---------------------- |
| `VALIDATION_ERROR`    | 请求参数或结构错误     |
| `NOT_FOUND`           | 项目、会话或任务不存在 |
| `CONFLICT`            | 状态或版本冲突         |
| `FORBIDDEN`           | 路径或权限不允许       |
| `WORKSPACE_ERROR`     | 工作区或命令执行失败   |
| `COMMAND_NOT_ALLOWED` | 命令不在白名单         |
| `INTERNAL_ERROR`      | 未分类服务端错误       |
