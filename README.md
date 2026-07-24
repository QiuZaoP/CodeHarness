# CodeHarness

CodeHarness 是一款基于自研 Agent Harness 的代码库智能助手，支持仓库导入、代码索引、仓库级问题定位、代码修改、测试生成和 Diff 预览。

## 快速开始

1. 克隆仓库并进入项目目录。
2. 从 `develop` 创建个人工作分支。
3. 阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [项目方案设计.md](项目方案设计.md)。
4. 按所属模块选择分支前缀并开始开发。

```powershell
git clone https://github.com/QiuZaoP/CodeHarness.git
cd CodeHarness
git switch develop
git pull --ff-only origin develop
git switch -c feature/<your-name>-<short-description>
```

## 分支说明

- `main`：稳定、可发布代码，只接受 Pull Request。
- `develop`：日常集成分支，所有功能分支从这里创建并合并回这里。
- `feature/*`：新功能或模块开发。
- `fix/*`：缺陷修复。
- `test/*`：测试和基准数据建设。
- `docs/*`：文档修改。

当前模块分支建议：

- `feature/frontend-workbench`
- `feature/harness-runtime`
- `feature/code-indexer`
- `feature/model-gateway`
- `feature/quality-system`

详细职责、接口边界和并行开发规则见 [项目方案设计.md](项目方案设计.md)。

## 开发原则

- 不直接向 `main` 或 `develop` 推送代码。
- 跨模块接口先更新协议和契约测试，再修改实现。
- 所有代码变更都应附带测试结果和已知风险。
- 任何涉及文件修改或命令执行的智能体能力，都必须保留 Diff、审计记录和回滚能力。

## 后端开发

环境要求：Node.js 22+ 和 npm 10+。

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

服务启动后访问：

- 健康检查：`http://127.0.0.1:3000/api/health`
- OpenAPI：`http://127.0.0.1:3000/api/v1/openapi.json`
- API 与 SSE 契约：[docs/API_CONTRACT.md](docs/API_CONTRACT.md)
- SQLite 迁移与事务：[docs/PERSISTENCE.md](docs/PERSISTENCE.md)
- 任务工作区、快照与 Git：[docs/WORKSPACES.md](docs/WORKSPACES.md)
- 工具注册、安全策略与扩展接口：[docs/TOOLS.md](docs/TOOLS.md)
- 任务租约、后台执行与恢复：[docs/LIFECYCLE.md](docs/LIFECYCLE.md)
- 模型网关、代码索引与降级策略：[docs/PORTS.md](docs/PORTS.md)
- 上下文选择、历史摘要与持久化预算：[docs/CONTEXT_BUDGET.md](docs/CONTEXT_BUDGET.md)
- 多轮 Harness、Decision/Observation 与完成门禁：[docs/HARNESS_LOOP.md](docs/HARNESS_LOOP.md)
- 最终 Diff、文件审阅、安全应用与报告：[docs/CHANGES.md](docs/CHANGES.md)
- JSON Schema：`schemas/domain.schema.json`

公开 API 的规范前缀为 `/api/v1`，当前契约版本为 `1.0.0`。事件携带显式的 `schemaVersion`；修改跨模块对象、枚举或事件时必须同步 OpenAPI、JSON Schema 和契约测试。

在没有真实模型和解析器之前，后端使用确定性 Fake 模型、文本检索和隔离的任务工作区跑通多轮任务闭环。完整检查命令：

```powershell
npm run check
```

首期 API 流程是：创建项目 -> 创建会话 -> 创建任务 -> 运行任务。项目创建接口的 `sourcePath` 必须是后端进程可访问的本地目录。
