# SQLite 持久化与迁移

## 当前版本

- 数据库 schema version：`3`
- 迁移记录：`schema_migrations`
- SQLite `PRAGMA user_version` 与最新迁移版本保持一致
- 启动设置：`foreign_keys = ON`、WAL、`busy_timeout = 5000`

迁移使用 TypeScript 文件，位于 `backend/src/database/migrations/`，会随服务代码一同编译，不依赖运行目录中的额外 SQL 资产。已经应用的迁移不得修改；结构变化必须追加更高版本迁移并更新 checksum。

当前迁移链：

1. `initial-project-session-task-events`
2. `runtime-persistence-and-optimistic-locking`
3. `project-source-metadata`

没有 `schema_migrations` 的阶段 1 数据库会先登记兼容的初始迁移，再增加版本列和运行记录表；项目、会话、任务及历史事件会保留。

## 表

| 表                     | 责任                             |
| ---------------------- | -------------------------------- |
| `projects`             | 导入项目和内部路径               |
| `sessions`             | 项目会话                         |
| `messages`             | 会话消息                         |
| `tasks`                | 任务状态、计划、工作区和乐观版本 |
| `task_steps`           | 排序后的计划步骤                 |
| `tool_calls`           | 工具参数、状态、耗时和结果       |
| `task_events`          | 版本化、单调递增的任务事件       |
| `workspace_snapshots`  | 不可变工作区快照元数据           |
| `file_changes`         | 文件 Diff、审阅决定和版本        |
| `verification_results` | 验证命令与归因结果               |
| `audit_records`        | 资源变更前后摘要                 |
| `task_leases`          | 后续调度阶段使用的任务执行租约   |
| `schema_migrations`    | 已应用迁移、名称和 checksum      |

数据库访问通过 `backend/src/database/repositories/` 封装。API 和 Harness 不直接拼装 SQL。

## 原子事务

当前原子边界：

- 创建任务 + 基线快照元数据 + `task.created` + 审计。
- 任务状态/计划/步骤更新 + 相关事件 + 审计。
- 工具调用开始记录 + `tool.started`。
- 工具调用完成结果 + `tool.completed`。
- 验证结果 + `verification.completed`。

事务提交后才向内存 SSE Broker 发布事件。模型、命令、文件和网络操作不能放入 SQLite 事务。

任务使用从 `1` 开始的整数 `version`。更新 SQL 必须同时匹配任务 ID 和调用方持有的 expected version；过期更新返回 `409 CONFLICT`，不会写入事件或审计。

## JSON 与损坏处理

计划、工具参数/结果、事件 payload 和审计前后值存为 JSON。读取时必须捕获 JSON 语法错误；具备领域 Schema 的对象还要执行运行时校验。损坏或不兼容数据返回可诊断的 `INTERNAL_ERROR`，不能静默转换为空对象。

## 当前边界

- `task_leases` 已建表，但租约获取、续期和恢复属于任务生命周期阶段。
- 项目记录包含源目录 manifest 摘要和 Git 元数据；完整 manifest 保存在受管项目目录。
- 工作区已经按任务隔离，快照元数据持久化；文件布局、校验和回滚规则见
  [WORKSPACES.md](WORKSPACES.md)。
- `file_changes` 的审批/应用和完整验证编排将在后续阶段接入。
