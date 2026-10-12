# 模型网关

角色四的交付实现位于 `backend/src/adapters` 和 `backend/src/model-gateway`，对 Harness 暴露统一的 `ModelGateway`：

- `decide`：把任务状态、上下文和可用工具发送给 DeepSeek，要求返回并校验结构化 `ModelDecision`。
- `summarize`：流式生成任务摘要。
- `embed`：通过可配置的 OpenAI-compatible `/embeddings` 路由调用 Embedding 模型；DeepSeek Chat 本身不提供 Embedding，因此未配置时返回明确的 `NOT_SUPPORTED` 模型错误。
- `rerank`：通过可选的 OpenAI-compatible `/rerank` 路由提供重排能力。

网关内置：

- API Key 环境变量或文件读取；错误、指标和日志不携带密钥或原始响应。
- 408/409/425/429/5xx 和网络故障的指数退避重试，并响应 `Retry-After`。
- 按 Chat、Summary、Embedding 分路由的熔断器。
- 请求超时、AbortSignal 取消、响应大小限制和响应结构校验。
- 流式 `TEXT_DELTA`、`STRUCTURED_DELTA`、`USAGE` 事件。
- 调用次数、成功/失败、重试次数、延迟、Token 和成本指标。
- `FallbackModelGateway`，可在供应商故障时切换到备用模型。

默认 Chat 模型为 `deepseek-v4-flash`，可通过 `DEEPSEEK_CHAT_MODEL` 和 `DEEPSEEK_SUMMARY_MODEL` 覆盖；不要依赖已下线或已迁移的旧模型别名。

## 本地运行

不要把密钥写进 `.env`、源码或测试文件。以用户提供的本地密钥文件为例：

```powershell
$env:DEEPSEEK_API_KEY_FILE = 'D:\企业实训\api'
$env:RUN_DEEPSEEK_LIVE = '1'
node --experimental-transform-types --test backend/test/deepseek.integration.test.ts
```

单元测试完全使用内存 Fake Fetch，不会访问外部网络：

```powershell
node --experimental-transform-types --test backend/test/*.test.ts
```

## 契约示例

```ts
const gateway = DeepSeekModelGateway.fromEnvironment();
const guarded = new GuardedModelGateway(gateway, 30_000);
const response = await guarded.decide(request, signal, (event) => {
  // 转发给 Harness 事件流
  console.log(event.type);
});
```

`DeepSeekModelGateway` 只负责模型适配与稳定性，工具权限、路径安全和任务状态机仍由 Harness 负责。
