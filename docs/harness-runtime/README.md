# Harness Runtime 合并交接

Repository index tool names: `index_repository`, `search_files`, `search_symbols`, `find_references`, `find_callers`, `find_callees`, `search_semantic`.

本目录是角色二后端 Harness 的正式合并交接包，面向负责 `develop`、跨角色集成和代码审阅的
协作者。原先分散的生命周期、持久化、工具、工作区、上下文、变更和质量文档已合并为三份：

| 文档                                 | 用途                                                    |
| ------------------------------------ | ------------------------------------------------------- |
| 本文                                 | 架构、技术栈、运行流程、模块职责和安全边界              |
| [API_REFERENCE.md](API_REFERENCE.md) | HTTP、DTO、状态机、SSE、错误码和事件 payload 的准确格式 |
| [MERGE_GUIDE.md](MERGE_GUIDE.md)     | 分支合并、适配器接入、配置、迁移、验证和回滚清单        |

## 1. 权威来源

文档用于阅读和交接，出现差异时按以下顺序判断：

1. `schemas/domain.schema.json`：公开 HTTP DTO、枚举和内部跨模块结构。
2. `schemas/event.schema.json`：SSE 事件信封及逐事件 payload。
3. `schemas/openapi.json`：已经注册的 HTTP 路径、状态码和请求/响应 Schema。
4. `backend/src/contract-values.ts`：TypeScript 公共枚举值。
5. `backend/src/ports/`：角色三、四与 Harness 的进程内 Port。
6. 本交接包。

修改公开契约后必须运行：

```powershell
npm run openapi:generate
npm run schema:check
```

当前 HTTP 前缀为 `/api/v1`，事件契约版本为 `1.0.0`，数据库迁移版本为 `6`。

## 2. 系统边界

```text
React/Vite 工作台
    │ HTTP / SSE
    ▼
Fastify API ── 请求校验、错误映射、请求 ID、CORS
    │
    ├── TaskScheduler ── 后台运行、租约、暂停/恢复/取消、关闭清理
    │       │
    │       ▼
    │   HarnessRunner ── 前检查、计划、Decision/Observation、完成门禁
    │       ├── ModelGateway Port ── 角色四真实模型或开发 Fake
    │       ├── CodeIndex Port ── 角色三结构化索引或文本降级
    │       └── ToolRegistrationPort ── 文件、Git、命令和角色三扩展工具
    │
    ├── AppDatabase ── SQLite 事务、事件、审计、检查点和报告事实
    └── WorkspaceManager ── 项目导入、任务隔离、快照、Diff、应用和回滚
```

Harness 不依赖模型供应商 SDK、AST 解析器或前端类型。角色三、四应实现现有 Port，不在
`HarnessRunner` 中加入供应商或解析器分支。

## 3. 技术栈

| 层       | 技术                                                    |
| -------- | ------------------------------------------------------- |
| 运行时   | Node.js 22+、TypeScript 5.7、ESM                        |
| HTTP/SSE | Fastify 5、`@fastify/cors`                              |
| 数据库   | SQLite、`better-sqlite3`、WAL、顺序 TypeScript 迁移     |
| Schema   | JSON Schema 2020-12、Ajv、生成式 OpenAPI 3.1            |
| 日志     | Pino，凭据字段集中脱敏                                  |
| 前端     | React 18、Vite 6                                        |
| 测试     | Vitest；后端 Node 环境、前端 JSDOM 环境分离             |
| 质量     | ESLint、Prettier、TypeScript、Schema/OpenAPI 一致性检查 |

## 4. 任务运行流程

### 4.1 创建与异步运行

1. 导入项目，保存源目录 manifest 和只读 Git 元数据。
2. 创建会话并写入用户消息。
3. 创建任务；系统复制任务工作区并创建不可变 `BASELINE` 快照。
4. `POST /tasks/{taskId}/run` 原子获取 SQLite 租约，立即返回 `202`。
5. 客户端使用任务查询和 SSE 获取后续状态。

### 4.2 Harness 循环

```text
PRECHECKING
  → 验证隔离工作区、Git 基线、规则文件和初始状态
PLANNING
  → 选择有界上下文并要求 ModelGateway 返回 PLAN_UPDATE
EXECUTING
  → Decision 持久化
  → 校验工具、权限、参数、路径和预算
  → 执行工具并持久化 Observation
  → 下一轮 Decision
VERIFYING
  → 执行受控验证命令并记录结果与失败归类
READY_FOR_REVIEW
  → 生成 FINAL 快照、结构化 Diff 和报告
APPLIED / CANCELLED / FAILED
```

模型只能请求 `TOOL_CALL`、`PLAN_UPDATE`、`ASK_USER`、`VERIFY` 或 `COMPLETE`。Harness
负责最终裁决；模型返回 `COMPLETE` 不会绕过计划、验证、预算和 Diff 追踪门禁。

### 4.3 暂停、恢复与崩溃恢复

- `task_leases` 保证同一任务同一时间只有一个 Runner。
- 暂停/取消先写持久控制请求，再中止本地操作；其他实例通过轮询观察。
- `RunState.activeTurn` 保存稳定轮次、Decision、Observation 和预分配工具调用 ID。
- 已完成的确定结果可复用；中断时仍为 `RUNNING` 的副作用工具不会自动重放。
- 进程重启后，丢失或过期租约的运行任务进入可恢复 `PAUSED`。
- `WAITING_USER` 在补充用户消息后通过显式 `resume` 恢复。

## 5. 工作区与文件安全

CodeHarness 不在 Harness 执行期间直接修改用户源目录，也不使用源仓库 worktree。每个任务拥有
独立复制目录和独立 Git 基线：

```text
WORKSPACE_ROOT/
  projects/{projectId}/source-metadata/
  tasks/{taskId}/
    worktree/
    snapshots/{snapshotId}/
    artifacts/
    git-hooks-disabled/
```

关键约束：

- 拒绝源目录与受管工作区相互包含。
- 拒绝绝对路径、`..` 越界、符号链接、junction 和特殊文件。
- 导入受文件数、总字节数和单文件大小限制。
- 文本工具拒绝 NUL、非法 UTF-8、二进制和超限输入。
- 写入现有文件必须携带匹配的 `expectedHash`。
- `apply_patch` 使用一基行号、非重叠编辑和原子替换。
- `git_diff` 使用临时 index，包含新增、修改和删除，但不改变任务仓库 index。

`apply` 前会重新计算工作区 Diff，并逐文件检查用户源目录仍与任务基线一致。只写回
`ACCEPTED` 文件；多文件应用任一步失败时使用备份补偿恢复。`rollback` 只恢复任务工作区，
不会修改用户源目录。

## 6. 工具运行时

内置工具：

| 工具          | 权限      | 副作用 | 说明                 |
| ------------- | --------- | ------ | -------------------- |
| `list_files`  | `READ`    | 否     | 有界目录列表         |
| `search_text` | `READ`    | 否     | 跳过二进制和超限文件 |
| `read_file`   | `READ`    | 否     | 返回文本和 SHA-256   |
| `write_file`  | `WRITE`   | 是     | 哈希检查、原子写入   |
| `apply_patch` | `WRITE`   | 是     | 结构化行编辑         |
| `git_status`  | `READ`    | 否     | 独立任务仓库状态     |
| `git_diff`    | `READ`    | 否     | 完整工作区 Diff      |
| `run_command` | `COMMAND` | 是     | 无 shell 的允许命令  |

`search_symbol` 和 `read_ast` 已冻结在公共工具枚举中，由角色三通过
`ToolRegistrationPort.register()` 注册。所有工具统一经过：

```text
注册定义 → 权限 → 输入大小/Schema → 工作区锁 → 超时/取消
→ 输出大小/Schema → ToolResult → 事件与审计
```

命令参数使用 `{ executable, args, timeoutMs? }`，不拼接 shell 字符串。当前仅允许受限的
Node、npm 和只读 Git 命令。该策略不是操作系统沙箱。

## 7. 持久化与事务

主要事实表：

| 表                                    | 内容                           |
| ------------------------------------- | ------------------------------ |
| `projects`、`sessions`、`messages`    | 项目与会话                     |
| `tasks`、`task_steps`                 | 状态、计划和乐观版本           |
| `task_run_checkpoints`                | RunState、上下文摘要和累计预算 |
| `task_leases`                         | Runner 所有权与过期恢复        |
| `tool_calls`、`verification_results`  | 工具和验证事实                 |
| `workspace_snapshots`、`file_changes` | 快照、补丁、审阅决定           |
| `task_events`、`audit_records`        | 对外事件和内部审计             |
| `schema_migrations`                   | 迁移版本、名称和 checksum      |

状态/计划、相关事件和审计在同一 SQLite 事务内提交。文件、命令、模型和网络操作不放入
数据库事务。事务提交后才通知内存 Broker；SSE 仍从持久化事件按游标补齐。

已应用迁移不得修改，只能追加更高版本。SQLite 启用外键、WAL 和 5 秒 busy timeout。

## 8. 上下文与预算

上下文优先级为用户目标、项目概览、仓库规则、历史摘要、最近消息、最近工具结果。选择器进行
稳定排序、引用/内容去重、UTF-8 安全截断并把哈希引用写入检查点。

持久预算覆盖：

- Decision 步数、工具调用次数和任务总时长；
- 变更文件数和验证次数；
- 模型输入/输出 Token 与成本；
- 上下文、工具结果和读取字节。

达到硬限制后不会启动下一次操作。预算停止使用 `BUDGET_EXCEEDED`，活动任务进入可检查的
`PAUSED` 并保留恢复目标。

## 9. 可观测性与清理

- 每个 HTTP 响应包含 `x-request-id`，任务请求日志额外包含 `taskId`。
- Authorization、Cookie、API Key 和 Token 字段输出为 `[REDACTED]`。
- `/api/v1/metrics` 从 SQLite 事实计算任务、工具、验证和模型使用指标。
- 终态任务工作区默认保留 168 小时；运行中、待审阅、等待和暂停任务永不自动清理。
- 清理只删除缓存目录，不删除任务、事件、审计、变更或验证事实。

## 10. 当前完成范围与限制

已完成角色二可信本机 MVP：状态机、运行循环、持久化、工作区、工具、控制、预算、
Diff/审阅/应用/回滚、API、SSE、日志、指标和前端契约适配。

仍需其他角色或部署层完成：

- 角色三：真实 AST、符号、引用、调用链和语义索引；当前文本索引明确标记降级。
- 角色四：真实 ModelGateway；`MOCK_MODE=false` 且未注入实现时服务拒绝启动。
- 角色五：远程 CI、全链路验收、性能/稳定性基准和发布结论。
- 部署层：身份认证、授权、限流、容器或低权限命令隔离、长期指标存储。

因此当前服务只允许处理本机可信仓库，不得暴露到不可信网络。
