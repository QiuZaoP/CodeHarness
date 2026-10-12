# 角色四实施报告

## 交付范围

- 统一 `ModelGateway` 契约：`decide`、`summarize`、`embed` 和流式事件。
- DeepSeek OpenAI-compatible Chat 适配器，默认模型为 `deepseek-v4-flash`。
- 结构化 `ModelDecision` 解析与校验，兼容模型返回的可选字段 `null`。
- API Key 文件/环境变量读取、超时、取消、重试、`Retry-After`、熔断和备用网关。
- 调用指标：成功率、失败率、重试、延迟、Token 和可配置成本。
- 可选 OpenAI-compatible Embedding 与 `/rerank` 路由；未配置 Embedding 时返回明确的 `NOT_SUPPORTED`。

## 验证结果

离线测试：15 个通过，1 个真实 API 测试按默认配置跳过。

真实 DeepSeek Chat + Summary 冒烟：通过。测试通过 `DEEPSEEK_API_KEY_FILE` 读取 `D:\企业实训\api`，未将密钥写入仓库或日志。

## 本轮问题修复

- 重试等待现在响应超时和取消信号。
- 流式响应受 `MODEL_MAX_RESPONSE_BYTES` 限制。
- 结构化决策解析成功后才计入成功指标。
- 不可重试的模型响应错误不会触发熔断。
- 主模型已经产生流式内容后不再切换备用模型，避免重复输出。
- `test:live` 改为强制执行；缺少密钥时明确失败而不是跳过。

## 已知边界

- Embedding 和 rerank 服务的请求协议由环境变量指定；DeepSeek Chat 端点本身不提供 Embedding。
- 生产接入 Harness 时，应使用 `GuardedModelGateway`，并由 Harness 继续负责工具权限、路径安全和预算限制。
- Node 原生 TypeScript 测试需要 Node 22+ 的 `--experimental-transform-types`。

## 回滚

本次角色四代码均为新增文件，删除 `backend/`、`docs/model-gateway/`、`.env.example` 和 `package.json` 中本次新增内容即可回滚；`.gitignore` 新增的 `*.key`、`*.pem` 规则可保留。
