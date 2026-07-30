# 分支合并与适配器接入指南

Model gateway configuration variables: `DEEPSEEK_BASE_URL`, `DEEPSEEK_CHAT_MODEL`, `DEEPSEEK_SUMMARY_MODEL`, `MODEL_MAX_RETRIES`, `MODEL_RETRY_BASE_DELAY_MS`, `MODEL_CIRCUIT_FAILURE_THRESHOLD`, `MODEL_CIRCUIT_COOLDOWN_MS`, `MODEL_MAX_RESPONSE_BYTES`, `MODEL_MAX_OUTPUT_TOKENS`, `DEEPSEEK_INPUT_PRICE_PER_MILLION`, `DEEPSEEK_OUTPUT_PRICE_PER_MILLION`.

Repository index tools included in the integration contract: `index_repository`, `search_files`, `search_symbols`, `find_references`, `find_callers`, `find_callees`, `search_semantic`.

本文用于把 `feature/harness-runtime` 合并到集成分支，以及后续接入角色三代码索引、角色四
模型网关和角色五质量门禁。

## 1. 合并范围

角色二交付包含：

- 版本化领域、事件和 OpenAPI 契约；
- SQLite 迁移、Repository、事务、事件与审计；
- 项目导入、任务工作区、快照、Diff、安全应用和回滚；
- 工具注册、文件/Git/命令工具及策略；
- 任务状态机、租约调度、暂停/恢复/取消和重启恢复；
- 上下文、历史摘要、预算和多轮 Harness；
- HTTP API、SSE、日志、指标和保留清理；
- 角色一前端工作台的真实 HTTP/SSE 契约适配。

不应在本次合并中误判为角色二实现：

- 真实模型供应商适配器；
- AST、符号、引用、调用链和语义索引；
- 身份认证、授权、限流和 OS 级执行沙箱；
- 远程 CI 和最终版本验收结论。

## 2. 合并前检查

```powershell
git fetch --prune origin
git switch feature/harness-runtime
git status --short
git log --oneline --decorate -15
npm ci
npm run check
npm run build
git diff --check
```

要求：

- 工作区无未说明修改。
- Node.js 22+。
- `Mydocs/`、`.data/`、`dist/`、`node_modules/` 和测试报告不进入提交。
- 所有数据库变化只能通过新迁移实现。
- OpenAPI 与 Schema 一致性检查通过。

## 3. 高冲突文件

合并时优先人工审查：

| 文件                                | 必须保留的角色二内容                                 |
| ----------------------------------- | ---------------------------------------------------- |
| `package.json`、`package-lock.json` | 前后端分离的 dev/test/typecheck 和统一 build/check   |
| `tsconfig.json`                     | 后端 NodeNext 编译；前端使用独立 `tsconfig.app.json` |
| `vite.config.ts`                    | 仅包含 `src/**/*.test.{ts,tsx}` 的 JSDOM 测试        |
| `vitest.backend.config.ts`          | 仅包含 `backend/test/**/*.test.ts` 的 Node 测试      |
| `eslint.config.js`                  | 后端类型感知规则与前端 React 规则                    |
| `.env.example`                      | 后端全部限制、CORS 与 `VITE_API_BASE_URL`            |
| `backend/src/app.ts`                | Schema 路由、依赖注入、SSE、请求 ID 和 CORS          |
| `backend/src/types.ts`              | 内部类型与公共枚举的单向引用                         |
| `schemas/*`                         | 当前 `1.0.0` 契约和生成 OpenAPI                      |
| `README.md`                         | 双进程启动、统一验证和交接包入口                     |

不要用前端视图模型覆盖公共 DTO，也不要把数据库内部 `workspacePath/sourcePath/version` 随意
暴露到公开响应。

## 4. 本地启动

```powershell
Copy-Item .env.example .env
npm ci
```

两个终端分别运行：

```powershell
npm run dev:backend
```

```powershell
npm run dev:frontend
```

- 后端：`http://127.0.0.1:3000`
- 前端：`http://127.0.0.1:5173`
- OpenAPI：`http://127.0.0.1:3000/api/v1/openapi.json`
- 健康检查：`http://127.0.0.1:3000/api/health`

前端未配置 `VITE_API_BASE_URL` 时进入演示 Mock；该模式不能作为真实联调证据。

## 5. 配置分组

完整默认值在 `.env.example` 和 `backend/src/config.ts`。

| 分组      | 变量                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 服务      | `NODE_ENV`、`HOST`、`PORT`、`LOG_LEVEL`                                                                                         |
| 存储      | `DATABASE_PATH`、`WORKSPACE_ROOT`                                                                                               |
| 单次工具  | `MAX_COMMAND_TIMEOUT_MS`、`MAX_COMMAND_OUTPUT_BYTES`、`MAX_READ_FILE_BYTES`、`MAX_TOOL_ARGUMENT_BYTES`、`MAX_TOOL_OUTPUT_BYTES` |
| 调度      | `TASK_LEASE_TTL_MS`、`TASK_CONTROL_POLL_MS`                                                                                     |
| 端口超时  | `MAX_MODEL_TIMEOUT_MS`、`MAX_INDEX_TIMEOUT_MS`                                                                                  |
| 任务预算  | `MAX_TASK_STEPS`、`MAX_TASK_DURATION_MS`、`MAX_TASK_TOOL_CALLS`、`MAX_TASK_CHANGED_FILES`                                       |
| 模型预算  | `MAX_MODEL_INPUT_TOKENS`、`MAX_MODEL_OUTPUT_TOKENS`、`MAX_MODEL_COST`                                                           |
| 上下文    | `MAX_CONTEXT_BYTES`、`MAX_CONTEXT_ENTRY_BYTES`、`MAX_CONTEXT_ENTRIES`、`MAX_CONTEXT_HISTORY_MESSAGES`、`MAX_CONTEXT_READ_BYTES` |
| 验证/失败 | `MAX_VERIFICATION_RUNS`、`MAX_CONSECUTIVE_HARNESS_FAILURES`                                                                     |
| 导入      | `MAX_IMPORT_FILES`、`MAX_IMPORT_BYTES`、`MAX_FILE_BYTES`                                                                        |
| 保留      | `WORKSPACE_RETENTION_HOURS`、`WORKSPACE_PRUNE_INTERVAL_MS`                                                                      |
| HTTP/SSE  | `CORS_ORIGINS`、`SSE_REPLAY_INTERVAL_MS`、`SSE_MAX_PENDING_EVENTS`                                                              |
| 模式      | `MOCK_MODE`、`VITE_API_BASE_URL`                                                                                                |

显式无效的数值或布尔值会阻止启动。`NODE_ENV=production` 时：

- `MOCK_MODE` 必须为 `false`；
- `HOST` 必须保持 loopback；
- `CORS_ORIGINS` 不能包含 `*`。

这些限制在认证实现前防止服务误暴露，不应在合并时删除。

## 6. 角色四：ModelGateway 接入

权威接口：`backend/src/ports/model-gateway.ts`。

```ts
interface ModelGateway {
  decide(
    request: DecisionRequest,
    signal: AbortSignal,
    onStreamEvent?: ModelStreamHandler
  ): Promise<DecisionResponse>;

  summarize(
    request: SummaryRequest,
    signal: AbortSignal,
    onStreamEvent?: ModelStreamHandler
  ): Promise<SummaryResponse>;

  embed(request: EmbeddingRequest, signal: AbortSignal): Promise<EmbeddingResponse>;
}

interface DecisionResponse {
  decision: ModelDecision;
  model: string;
  provider: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cost?: number;
  };
  durationMs: number;
}
```

`ModelDecision` 只能是：

```ts
type ModelDecision =
  | { type: 'TOOL_CALL'; reason: string; expectedObservation?: string; tool: ToolCall }
  | { type: 'PLAN_UPDATE'; reason: string; expectedObservation?: string; plan: Plan }
  | { type: 'ASK_USER'; reason: string; expectedObservation?: string; question: string }
  | { type: 'VERIFY'; reason: string; expectedObservation?: string; commands: string[] }
  | { type: 'COMPLETE'; reason: string; expectedObservation?: string; summary: string };
```

接入规则：

1. 供应商 SDK、鉴权、限流和传输重试留在适配器。
2. 必须响应 `AbortSignal`。
3. 返回真实 provider、model、Token、成本和延迟。
4. 不能在日志、事件或错误中泄露密钥和原始敏感响应。
5. Harness 会再校验 Decision；适配器不能绕过权限和工具策略。
6. `GuardedModelGateway` 统一处理超时、取消、无效响应和 `MODEL_ERROR`。

应用装配：

```ts
const app = buildApp({
  modelGateway,
  codeIndex,
  toolExecutor
});
```

`MOCK_MODE=false` 且未注入 `modelGateway` 时 `buildApp` 必须继续拒绝启动。

## 7. 角色三：CodeIndex 接入

权威接口：`backend/src/ports/code-index.ts`。

```ts
interface CodeIndex {
  getProjectOverview(projectId: string, signal: AbortSignal): Promise<ProjectOverview>;
  searchFiles(projectId: string, query: string, signal: AbortSignal): Promise<FileSearchResult[]>;
  searchText(projectId: string, query: string, signal: AbortSignal): Promise<TextSearchResult[]>;
  searchSymbols(
    projectId: string,
    query: string,
    signal: AbortSignal
  ): Promise<SymbolSearchResult[]>;
  findReferences(
    projectId: string,
    symbol: string,
    signal: AbortSignal
  ): Promise<ReferenceResult[]>;
  findCallHierarchy(
    projectId: string,
    symbol: string,
    maxDepth: number,
    signal: AbortSignal
  ): Promise<CallHierarchyResult[]>;
  searchSemantic(
    projectId: string,
    query: string,
    limit: number,
    signal: AbortSignal
  ): Promise<SemanticSearchResult[]>;
}
```

共同格式：

```ts
interface SourceLocation {
  path: string; // 项目相对路径
  line: number; // 一基
}

interface ProjectOverview {
  projectId: string;
  languages: string[];
  entryFiles: string[];
  testFiles: string[];
  buildCommands: string[];
  indexedFiles: number;
  degraded: boolean;
}
```

接入后应用自动用 `FallbackCodeIndex(primary, textFallback)` 组合。主索引异常时文本查询和项目
概览可降级；符号、引用、调用链和语义能力在降级实现中返回空结果，不伪造结构化信息。
`TASK_CANCELLED` 不得被 fallback 吞掉。

角色三还可通过 `ToolRegistrationPort` 注册 `search_symbol`、`read_ast`：

```ts
interface ToolDefinition {
  name: ToolName;
  version: string;
  description: string;
  permission: ToolPermission;
  sideEffect: boolean;
  defaultTimeoutMs: number;
  inputSchema: object;
  outputSchema: object;
}

type ToolHandler = (
  arguments_: Record<string, unknown>,
  context: {
    workspacePath: string;
    permissions: readonly ToolPermission[];
    signal?: AbortSignal;
  }
) => Promise<{ output: unknown; affectedFiles?: string[] }>;
```

扩展工具必须经过同一注册、Schema、超时、取消、大小、审计和结果归一化管线。

## 8. 数据库迁移

当前迁移链：

1. `initial-project-session-task-events`
2. `runtime-persistence-and-optimistic-locking`
3. `project-source-metadata`
4. `resumable-task-lifecycle`
5. `task-run-checkpoints-and-budgets`
6. `file-change-traceability`

规则：

- 已应用迁移文件和 checksum 不得修改。
- 新结构只能追加 `007-*` 及更高版本。
- 同步更新 `backend/src/database/migrations/index.ts`。
- 测试从空库、旧库升级、checksum 篡改和重启读取。
- 不直接在 API 或 Harness 拼 SQL，使用 Repository。
- 外部调用不得放入数据库事务。

## 9. 前端集成要点

前端防腐层：

- `src/services/api.ts`：公开 DTO 到工作台视图模型的转换。
- `src/services/events.ts`：完整 SSE 信封、版本校验、ID 去重和重连。
- `src/state/WorkspaceContext.tsx`：持久资源恢复和事件投影。

必须保持：

1. Project/Task 响应不读取内部绝对路径。
2. 发送任务前先持久化用户 Message。
3. `resume` 调用真正的 `/resume`，不能复用 `/run`。
4. 文件决定携带 `taskId + changeId + expectedVersion`。
5. 公开契约不支持把决定恢复为 `PENDING`。
6. `apply` 只在等待审阅且全部文件已有决定时启用，并要求用户确认。
7. SSE `payload` 保持嵌套，完成和变更事件后重新拉取持久资源。

最小流程和完整 DTO 见 [API_REFERENCE.md](API_REFERENCE.md)。

## 10. 质量门禁

提交或合并前必须全部通过：

```powershell
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run schema:check
npm test
npm run build
git diff --check
```

当前测试配置：

- `vitest.backend.config.ts`：Node 环境，仅后端测试。
- `vite.config.ts`：JSDOM 环境，仅前端测试。

关键证据应覆盖：

- 状态转移、计划和完成门禁；
- 事务、乐观锁、迁移与损坏数据；
- 路径越界、符号链接、命令策略、超时和取消；
- 暂停/恢复/取消、租约和进程重启；
- 模型/索引超时、无效响应、取消和降级；
- 多轮工具、预算、验证失败和 `ASK_USER`；
- Diff 追踪、审阅、源目录并发冲突、应用补偿和回滚；
- API、OpenAPI、结构化错误、请求 ID；
- SSE 回放、游标、去重、心跳和背压；
- 日志脱敏、指标与工作区清理；
- 前端 HTTP/SSE 路由和主要交互。

## 11. 合并验收清单

- [ ] 当前分支、目标分支和共同基线已经确认。
- [ ] 共享配置冲突基于双方实际用途解决。
- [ ] `schemas/openapi.json` 与实际路由一致。
- [ ] 事件版本仍为 `1.0.0`，或已执行正式版本升级。
- [ ] 角色三/四实现通过现有 Port 注入，没有侵入 Harness。
- [ ] `MOCK_MODE=false` 的启动路径有真实 ModelGateway。
- [ ] 前端使用 `/api/v1` 并消费完整 SSE 信封。
- [ ] 迁移只追加，旧数据库升级测试通过。
- [ ] 完整质量命令和构建通过。
- [ ] 未提交 `.env`、数据库、工作区、日志、构建物和 `Mydocs/`。
- [ ] PR 描述记录契约、迁移、验证、风险和回滚方式。

## 12. 回滚策略

代码合并回滚优先使用普通 Git revert，不改写共享分支历史。数据库迁移默认只向前：

- 代码回滚必须仍能读取已升级数据库，或附带经过评审的数据迁移方案。
- 不删除 `schema_migrations` 或手工降低 `user_version`。
- 任务工作区故障使用任务 `rollback`，不把 Git 分支回滚与运行时工作区回滚混用。
- 已应用到用户源目录的文件由任务报告、FileChange patch 和 Git 流程恢复。

如果真实模型或索引适配器导致故障，可在可信开发环境退回 Fake/文本降级验证；生产模式不得
重新启用 Mock。
