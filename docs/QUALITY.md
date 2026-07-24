# 质量、安全与可观测性

## 自动化质量门禁

本地与 CI 使用同一组命令：

```powershell
npm run check
npm run build
```

`check` 串行执行格式、Lint、类型、JSON Schema/OpenAPI 一致性和全部 Vitest。CI 还单独执行
生产构建，避免只通过 `--noEmit` 类型检查却无法生成产物。

当前测试矩阵覆盖：

- 领域状态机、上下文选择和全部预算维度；
- 数据库从零迁移、旧库升级、事务回滚、乐观锁、损坏 JSON 与重启恢复；
- 路径逃逸、符号链接、文件数量/大小、命令策略、输出截断、超时和取消；
- 模型/索引 Port、降级、超时、无效响应和取消；
- Harness 多轮决策、租约恢复、暂停/恢复/取消、验证门禁、Diff 审阅和安全应用；
- API 最小闭环、OpenAPI 实际路由、结构化错误和请求 ID；
- SSE 历史回放、`Last-Event-ID`、重复 ID、心跳、背压和慢客户端断开；
- 工作区保留清理和日志凭据脱敏。

## 运行指标

`GET /api/v1/metrics` 从 SQLite 持久化事实即时计算，不依赖进程内累加器。响应包括：

- 各任务状态数量、成功/失败数量、成功率和平均完成耗时；
- 工具总数、失败/取消数和失败率；
- 验证总数、失败数和错误数；
- 已持久化模型输入/输出 Token 与成本。

成功任务定义为已经完成 Harness 且处于 `READY_FOR_REVIEW` 或 `APPLIED`；失败任务定义为
`FAILED`。用户取消不进入成功率分母。指标是当前数据库的进程安全快照，不是长期时序存储；
生产监控系统应定期抓取并自行保留时间序列。

## 日志与部署边界

- Fastify 和独立 logger 共用同一 Pino 配置。
- 请求日志携带 `reqId`；任务资源请求额外绑定 `taskId`。
- Authorization、Cookie、API Key、Access Token 和 Refresh Token 使用 Pino redact 输出为
  `[REDACTED]`。
- 显式提供但格式错误的数字/布尔配置会阻止启动，不能静默退回默认值。
- `NODE_ENV=production` 时禁止 Mock、通配 CORS 和非回环监听。在认证实现前，服务不能对不可信
  网络开放。

## 保留与清理

- `WORKSPACE_RETENTION_HOURS` 定义终态任务工作区保留时长，默认 168 小时。
- `WORKSPACE_PRUNE_INTERVAL_MS` 定义扫描周期，默认 1 小时；服务启动时也执行一次。
- `CREATED`、运行态、`READY_FOR_REVIEW`、`WAITING_USER` 和 `PAUSED` 始终受保护。
- 只有超过保留期的 `APPLIED`、`CANCELLED`、`FAILED` 任务目录可删除。
- 清理使用受管根目录验证，不跟随符号链接，不删除任务数据库事实。
- 任务、事件、审计、变更和验证目前与数据库同寿命，保证报告与 SSE 历史可恢复。数据库事实
  的归档/删除需要单独 ADR 和备份方案，不能与工作区缓存清理混用。

## 尚未解除的边界

- 命令允许策略不是操作系统安全沙箱；处理不可信仓库前仍需要容器或低权限隔离。
- 当前没有身份认证、授权、限流和长期指标存储，因此只支持本机可信开发。
- 外部 ModelGateway/CodeIndex Handler 必须真正响应 `AbortSignal`；注册表无法强制终止忽略
  取消的后台副作用。
