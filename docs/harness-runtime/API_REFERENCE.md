# HTTP、DTO 与事件参考

本文给合并方和前端/适配器开发者提供可直接对照的接口格式。完整机器可读定义仍以
`schemas/openapi.json`、`schemas/domain.schema.json` 和 `schemas/event.schema.json` 为准。

## 1. 通用约定

- HTTP 基址：`http://127.0.0.1:3000`
- 健康检查：`/api/health`
- 公开 API：`/api/v1`
- JSON：`Content-Type: application/json`
- ID：UUID 字符串
- 时间：UTC ISO 8601 字符串
- 源码位置：一基行号
- 路径：项目或任务工作区相对路径，除项目导入请求的 `sourcePath`
- 每个响应返回 `x-request-id`
- 公共 Project/Task 响应不会泄露 `sourcePath` 或 `workspacePath`

客户端可发送最多 128 个安全字符的 `x-request-id`：

```text
[A-Za-z0-9._:-]+
```

非法或缺失时服务端生成 UUID。

## 2. 路由总表

| 方法    | 路径                                        | 成功  | 请求/查询                   | 响应                   |
| ------- | ------------------------------------------- | ----- | --------------------------- | ---------------------- |
| `GET`   | `/api/health`                               | `200` | 无                          | `Health`               |
| `GET`   | `/api/v1/openapi.json`                      | `200` | 无                          | OpenAPI JSON           |
| `GET`   | `/api/v1/metrics`                           | `200` | 无                          | `RuntimeMetrics`       |
| `GET`   | `/api/v1/projects`                          | `200` | 无                          | `Project[]`            |
| `POST`  | `/api/v1/projects`                          | `201` | `ProjectCreate`             | `Project`              |
| `GET`   | `/api/v1/projects/{projectId}`              | `200` | UUID path                   | `Project`              |
| `GET`   | `/api/v1/projects/{projectId}/search`       | `200` | `q`、`limit?`               | `SearchResult[]`       |
| `GET`   | `/api/v1/sessions`                          | `200` | `projectId?`                | `Session[]`            |
| `POST`  | `/api/v1/sessions`                          | `201` | `SessionCreate`             | `Session`              |
| `GET`   | `/api/v1/sessions/{sessionId}`              | `200` | UUID path                   | `Session`              |
| `GET`   | `/api/v1/sessions/{sessionId}/messages`     | `200` | 无                          | `Message[]`            |
| `POST`  | `/api/v1/sessions/{sessionId}/messages`     | `201` | `MessageCreate`             | `Message`              |
| `GET`   | `/api/v1/tasks`                             | `200` | `projectId?`、`sessionId?`  | `Task[]`               |
| `POST`  | `/api/v1/tasks`                             | `201` | `TaskCreate`                | `Task`                 |
| `GET`   | `/api/v1/tasks/{taskId}`                    | `200` | UUID path                   | `Task`                 |
| `GET`   | `/api/v1/tasks/{taskId}/changes`            | `200` | 无                          | `FileChange[]`         |
| `PATCH` | `/api/v1/tasks/{taskId}/changes/{changeId}` | `200` | `ChangeDecisionUpdate`      | `FileChange`           |
| `GET`   | `/api/v1/tasks/{taskId}/verifications`      | `200` | 无                          | `VerificationResult[]` |
| `GET`   | `/api/v1/tasks/{taskId}/report`             | `200` | 无                          | `TaskReport`           |
| `POST`  | `/api/v1/tasks/{taskId}/run`                | `202` | 无                          | `Task`                 |
| `POST`  | `/api/v1/tasks/{taskId}/pause`              | `200` | 无                          | `Task`                 |
| `POST`  | `/api/v1/tasks/{taskId}/resume`             | `202` | 无                          | `Task`                 |
| `POST`  | `/api/v1/tasks/{taskId}/cancel`             | `200` | 无                          | `Task`                 |
| `POST`  | `/api/v1/tasks/{taskId}/apply`              | `200` | 无                          | `Task`                 |
| `POST`  | `/api/v1/tasks/{taskId}/rollback`           | `200` | 无                          | `Task`                 |
| `GET`   | `/api/v1/tasks/{taskId}/events`             | `200` | `after?` 或 `Last-Event-ID` | SSE                    |

可能的错误状态码由 OpenAPI 固定：

- 查询接口：通常为 `400`、`404`、`500`。
- 创建项目：`400`、`403`、`409`、`500`。
- 创建任务和控制/审阅：在上述基础上可能有 `409`。

## 3. 公共枚举

```ts
type TaskStatus =
  | 'CREATED'
  | 'PRECHECKING'
  | 'PLANNING'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'READY_FOR_REVIEW'
  | 'APPLIED'
  | 'WAITING_USER'
  | 'PAUSED'
  | 'CANCELLED'
  | 'FAILED';

type PlanStepStatus = 'PENDING' | 'RUNNING' | 'DONE';
type MessageRole = 'USER' | 'ASSISTANT' | 'SYSTEM';
type FileChangeStatus = 'ADDED' | 'MODIFIED' | 'DELETED' | 'RENAMED';
type ChangeDecision = 'PENDING' | 'ACCEPTED' | 'REJECTED';
type VerificationStatus = 'PASSED' | 'FAILED' | 'ERROR' | 'SKIPPED';
type VerificationFailureCategory = 'CODE' | 'TEST' | 'ENVIRONMENT' | 'BASELINE';
type ToolCallStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
```

## 4. DTO 格式

以下 TypeScript 仅用于准确表达 JSON 形状；所有对象都禁止未声明字段。

### 4.1 项目、会话和消息

```ts
interface ProjectCreate {
  name: string; // 1..120
  sourcePath: string; // 后端进程可访问的本地绝对或有效目录路径
}

interface Project {
  id: string;
  name: string;
  createdAt: string;
}

interface SessionCreate {
  projectId: string;
  title?: string; // 1..200，缺省为 "New session"
}

interface Session {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
}

interface MessageCreate {
  content: string; // 1..65536
}

interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}
```

公开消息创建接口固定写入 `USER`。`ASSISTANT` 和 `SYSTEM` 是持久化/契约允许的角色，但当前
Harness 不会自动创建助手消息；前端显示的任务创建确认语不是后端 Message 事实。

项目导入示例：

```http
POST /api/v1/projects
Content-Type: application/json

{
  "name": "sample-repository",
  "sourcePath": "C:/projects/sample-repository"
}
```

```json
{
  "id": "02efbc5b-3dc7-4237-8ac9-b36e78844d48",
  "name": "sample-repository",
  "createdAt": "2026-07-25T03:00:00.000Z"
}
```

项目搜索：

```http
GET /api/v1/projects/{projectId}/search?q=login&limit=12
```

`q` 长度为 `1..500`，`limit` 为 `1..100`，默认 `50`。

```ts
interface SearchResult {
  path: string;
  line: number; // >= 1
  preview: string;
}
```

### 4.2 任务和计划

```ts
interface TaskCreate {
  projectId: string;
  sessionId: string;
  goal: string;
}

interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
}

interface Plan {
  goal: string;
  assumptions: string[];
  steps: PlanStep[];
  verification: string[];
}

interface Task {
  id: string;
  sessionId: string;
  projectId: string;
  goal: string;
  status: TaskStatus;
  plan?: Plan;
  createdAt: string;
  updatedAt: string;
  stopReason?: string;
}
```

创建并异步运行任务：

```http
POST /api/v1/tasks
Content-Type: application/json

{
  "projectId": "02efbc5b-3dc7-4237-8ac9-b36e78844d48",
  "sessionId": "e9bf535d-c8ea-4674-915f-3a3bcb406858",
  "goal": "修复登录接口并补充回归测试"
}
```

创建成功返回 `201` 和状态为 `CREATED` 的 `Task`。随后：

```http
POST /api/v1/tasks/{taskId}/run
```

成功返回 `202`；该响应只表示租约已获取并已调度，不表示任务完成。

任务列表支持：

```text
GET /api/v1/tasks
GET /api/v1/tasks?projectId={projectId}
GET /api/v1/tasks?sessionId={sessionId}
GET /api/v1/tasks?projectId={projectId}&sessionId={sessionId}
```

### 4.3 文件变更

```ts
interface FileChange {
  id: string;
  taskId: string;
  path: string;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  patch: string; // unified diff
  decision: ChangeDecision;
  toolCallId?: string;
  stepId?: string;
  version?: number; // 当前服务返回；Schema 为兼容旧数据保留可选
}

interface ChangeDecisionUpdate {
  decision: 'ACCEPTED' | 'REJECTED';
  expectedVersion: number; // >= 1
}
```

审阅示例：

```http
PATCH /api/v1/tasks/{taskId}/changes/{changeId}
Content-Type: application/json

{
  "decision": "ACCEPTED",
  "expectedVersion": 1
}
```

成功响应中的 `version` 增加。陈旧版本返回 `409 CONFLICT`，客户端必须重新获取
`GET /tasks/{taskId}/changes`。公开更新接口不支持把决定改回 `PENDING`；可使用新版本在
`ACCEPTED` 和 `REJECTED` 之间切换。

`apply` 的前提：

1. 任务为 `READY_FOR_REVIEW`。
2. 所有变更不再是 `PENDING`。
3. 当前工作区 Diff 与已审阅记录完全一致。
4. 源文件仍与任务基线一致。

只写回 `ACCEPTED` 文件。`rollback` 只恢复任务工作区并把任务转为 `CANCELLED`。

### 4.4 验证与报告

```ts
interface VerificationResult {
  id: string;
  taskId: string;
  command: string;
  status: VerificationStatus;
  exitCode?: number;
  outputSummary: string;
  failureCategory?: VerificationFailureCategory;
  createdAt: string;
}

interface TaskReport {
  taskId: string;
  status: TaskStatus;
  summary: string;
  plan?: Plan;
  changes: FileChange[];
  verifications: VerificationResult[];
  toolCalls: Array<{
    id: string;
    stepId?: string;
    name:
      | 'list_files'
      | 'search_text'
      | 'search_symbol'
      | 'read_file'
      | 'read_ast'
      | 'apply_patch'
      | 'write_file'
      | 'run_command'
      | 'git_diff'
      | 'git_status';
    status: ToolCallStatus;
  }>;
  risks: string[];
  generatedAt: string;
}
```

报告是持久事实的即时投影，不是独立可漂移的结果表。

### 4.5 指标

```ts
interface RuntimeMetrics {
  generatedAt: string;
  tasks: {
    total: number;
    byStatus: Record<TaskStatus, number>;
    successful: number;
    failed: number;
    successRate: number; // 0..1
    averageDurationMs: number;
  };
  tools: {
    total: number;
    failed: number;
    cancelled: number;
    failureRate: number; // 0..1
  };
  verifications: {
    total: number;
    failed: number;
    errors: number;
  };
  modelUsage: {
    inputTokens: number;
    outputTokens: number;
    cost: number;
  };
}
```

`READY_FOR_REVIEW` 和 `APPLIED` 计为成功，`FAILED` 计为失败，用户取消不进入成功率分母。

## 5. 状态机和控制语义

| 当前状态                         | 允许后继                                                                  |
| -------------------------------- | ------------------------------------------------------------------------- |
| `CREATED`                        | `PRECHECKING`、`PAUSED`、`CANCELLED`                                      |
| `PRECHECKING`                    | `PLANNING`、`WAITING_USER`、`PAUSED`、`FAILED`、`CANCELLED`               |
| `PLANNING`                       | `EXECUTING`、`WAITING_USER`、`PAUSED`、`FAILED`、`CANCELLED`              |
| `EXECUTING`                      | `EXECUTING`、`VERIFYING`、`WAITING_USER`、`PAUSED`、`FAILED`、`CANCELLED` |
| `VERIFYING`                      | `EXECUTING`、`READY_FOR_REVIEW`、`PAUSED`、`FAILED`、`CANCELLED`          |
| `READY_FOR_REVIEW`               | `APPLIED`、`EXECUTING`、`CANCELLED`                                       |
| `WAITING_USER`                   | `PLANNING`、`EXECUTING`、`VERIFYING`、`PAUSED`、`FAILED`、`CANCELLED`     |
| `PAUSED`                         | `PLANNING`、`EXECUTING`、`VERIFYING`、`CANCELLED`                         |
| `APPLIED`、`CANCELLED`、`FAILED` | 无                                                                        |

| 操作       | 前提                                | 结果                                      |
| ---------- | ----------------------------------- | ----------------------------------------- |
| `run`      | `CREATED`                           | `202`，后台开始执行                       |
| `pause`    | 已获得租约的运行态                  | 取消当前操作，保存恢复目标，进入 `PAUSED` |
| `resume`   | 有恢复目标的 `PAUSED/WAITING_USER`  | `202`，获取新租约并恢复                   |
| `cancel`   | 可取消的非终态                      | 进入 `CANCELLED`                          |
| `apply`    | `READY_FOR_REVIEW` 且所有文件已审阅 | 写回接受文件，进入 `APPLIED`              |
| `rollback` | 非运行态且允许取消                  | 恢复任务基线，进入 `CANCELLED`            |

控制冲突统一返回 `409 CONFLICT`，控制接口具有明确状态前提，不应由客户端猜测或重复重试。

## 6. SSE 格式

订阅：

```http
GET /api/v1/tasks/{taskId}/events
Accept: text/event-stream
```

断线重连优先使用：

```http
Last-Event-ID: 42
```

也支持 `?after=42`；两者都必须是非负整数。服务端只发送 `id > 42` 的事件，每 15 秒发送注释
心跳。慢客户端超过 `SSE_MAX_PENDING_EVENTS` 时会被断开，应使用最后成功处理的 ID 重连。

每个 SSE frame：

```text
id: 43
event: task.state_changed
data: {"schemaVersion":"1.0.0","id":43,"taskId":"...","type":"task.state_changed","timestamp":"2026-07-25T03:00:01.000Z","payload":{"from":"PLANNING","to":"EXECUTING"}}
```

完整信封：

```ts
interface TaskEvent<TPayload = Record<string, unknown>> {
  schemaVersion: '1.0.0';
  id: number; // >= 1，数据库全局单调 ID
  taskId: string;
  type: EventType;
  timestamp: string;
  payload: TPayload;
}
```

客户端规则：

1. 解析 `data` 的完整信封，不能把信封剩余字段当作 payload。
2. 只处理 `schemaVersion === "1.0.0"`。
3. 按 `id` 排序和去重。
4. 记录最后已成功应用的 ID，用于重连。
5. 完成、变更等事件后重新读取持久资源，不把 SSE 当唯一事实存储。

## 7. 事件类型与 payload

| `type`                   | payload                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `task.created`           | `{ goal: string }`                                                         |
| `task.state_changed`     | `{ from: TaskStatus, to: TaskStatus }`                                     |
| `task.plan.updated`      | `{ plan: Plan }`                                                           |
| `tool.started`           | `{ toolName: ToolName, arguments?: object }`                               |
| `tool.completed`         | `{ toolName: ToolName, result: unknown }` 或 `{ toolName, error: string }` |
| `task.completed`         | `{ verification: { command: string, code: number } }`                      |
| `task.failed`            | `{ message: string }`                                                      |
| `task.waiting_user`      | `{ message: string }`                                                      |
| `task.paused`            | `{ status: "PAUSED" }`                                                     |
| `task.resumed`           | `{ status: "PLANNING" \| "EXECUTING" \| "VERIFYING" }`                     |
| `task.cancelled`         | `{ reason: string }`                                                       |
| `task.applied`           | `{ changeCount: number }`                                                  |
| `verification.completed` | `{ verification: VerificationResult }`                                     |
| `change.updated`         | `{ changeId: string, decision: ChangeDecision }`                           |
| `harness.decision`       | `{ sequence: number, decisionType: DecisionType, reason: string }`         |

`tool.started.arguments` 是脱敏摘要；文件内容和补丁正文不进入公开事件。完整参数只保存在内部
工具调用记录。

## 8. 错误格式

```ts
type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'WORKSPACE_ERROR'
  | 'COMMAND_NOT_ALLOWED'
  | 'MODEL_ERROR'
  | 'INDEX_ERROR'
  | 'BUDGET_EXCEEDED'
  | 'TASK_CANCELLED'
  | 'INTERNAL_ERROR';

interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    retryable?: boolean;
  };
}
```

示例：

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "File change was modified by another operation",
    "details": {
      "changeId": "c10fa370-1aef-4ed5-a8de-4ed334fd3103"
    },
    "retryable": false
  }
}
```

客户端不能只显示 HTTP status；应保留稳定 `code`、用户可读 `message` 和可诊断 `details`。

## 9. 前端最小闭环

```text
POST projects
→ POST sessions
→ POST sessions/{id}/messages
→ POST tasks
→ 连接 tasks/{id}/events
→ POST tasks/{id}/run
→ GET tasks/{id}/changes
→ PATCH 每个 change（携带 expectedVersion）
→ POST tasks/{id}/apply 或 rollback
→ GET tasks/{id}/report
```

在 `WAITING_USER` 时先写入新用户消息，再显式 `resume`。消息写入不会隐式启动或恢复任务。
