# 模型与代码索引 Port

Harness 通过进程内 TypeScript 接口使用模型和代码索引。具体供应商 SDK、远程协议和解析器均由适配器封装，不进入 `HarnessRunner`。

## ModelGateway

接口位于 `backend/src/ports/model-gateway.ts`，包含：

- `decide`：接收版本化 `RunState`、带来源的上下文和可用工具定义，返回结构化 `ModelDecision`。
- `summarize`：根据目标、观察和变更文件生成摘要。
- `embed`：为输入文本生成向量。
- `decide` 和 `summarize` 可通过回调发送文本、结构化内容和用量增量。
- 所有操作都接收 `AbortSignal`。

应用组装层会用 `GuardedModelGateway` 包装注入的实现。该边界负责：

- 强制执行 `MAX_MODEL_TIMEOUT_MS`。
- 保留外部取消原因。
- 校验结构化决策、模型身份、用量、延迟和向量形状。
- 把超时、无效响应和供应商异常统一映射为带分类详情的 `MODEL_ERROR`。

`MOCK_MODE=true` 时默认使用确定性的 `FakeModelGateway`。关闭 Mock 模式后必须显式注入真实 `ModelGateway`，否则应用拒绝启动。供应商鉴权、限流和传输重试由真实适配器负责；任务预算和业务重试由 Harness 负责。

## CodeIndex

接口位于 `backend/src/ports/code-index.ts`，支持：

- 项目概览。
- 文件名和文本搜索。
- 符号与引用搜索。
- 调用层级和语义搜索。
- 一基行号的源码位置。
- `AbortSignal` 取消。

`TextCodeIndex` 是有界、确定性的本地降级实现：

- 跳过隐藏目录、符号链接、依赖目录和常见构建产物。
- 限制扫描文件数、单文件读取大小和结果数。
- 跳过二进制和非法 UTF-8 文件。
- 提供语言、入口文件、测试文件、构建命令、文件名和精确文本结果。
- 对符号、引用、调用层级和语义查询返回空结果，不伪造结构化信息。
- 项目概览始终标记 `degraded: true`。

注入角色三实现时，应用使用 `FallbackCodeIndex` 组合主索引与文本索引。主索引异常时自动尝试文本降级；两者均失败时返回 `INDEX_ERROR`。任务取消不会被降级逻辑吞掉。

## Harness 当前使用方式

规划阶段按以下顺序运行：

```text
ProjectOverview
→ 带来源引用的规划上下文
→ ModelGateway.decide
→ 校验 PLAN_UPDATE
→ 持久化计划并进入 EXECUTING
```

模型或索引错误不会被误报成普通工具失败。当前实现把任务转为 `WAITING_USER`，记录稳定停止原因和 `task.waiting_user` 事件，释放执行租约；后续阶段将补充用户输入后的恢复入口和更细粒度重试策略。

## 适配器接入清单

角色三或角色四提供真实适配器时，应满足：

1. 实现现有 Port，不修改 Harness 来适配供应商类型。
2. 接受并尽快响应 `AbortSignal`。
3. 源码位置使用一基行号，路径使用项目相对路径。
4. 返回完整的模型身份、用量、成本和延迟信息。
5. 不在事件、日志或错误详情中泄露密钥、完整源码或供应商原始敏感响应。
6. 通过 `backend/test/ports.test.ts` 的正常、异常、取消和降级边界测试。
7. 如需远程传输，只在适配器内部处理序列化、鉴权、限流和传输错误。
