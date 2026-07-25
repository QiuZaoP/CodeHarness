# CodeHarness

CodeHarness 是一款基于自研 Agent Harness 的代码库智能助手，支持仓库导入、代码索引、仓库级问题定位、代码修改、测试生成和 Diff 预览。

## 快速开始

当前仓库已集成角色一前端工作台与角色二 Harness 后端。先复制环境配置并安装依赖：

```powershell
Copy-Item .env.example .env
npm install
```

分别启动后端和前端：

```powershell
npm run dev:backend
npm run dev:frontend
```

浏览器打开 `http://127.0.0.1:5173`。前端通过 `VITE_API_BASE_URL` 连接
`http://127.0.0.1:3000`；不配置该变量时才使用内置 Mock 数据。

常用检查：

```powershell
npm run lint
npm run test
npm run build
```

前端 API 与 SSE 适配位于 `src/services/api.ts`、`src/services/events.ts`，均消费
`/api/v1` 和 `1.0.0` 版本化事件信封。

## 已实现的前端能力

- 项目导入、项目切换、分支和索引状态展示
- 会话列表、新建任务、消息发送和任务状态展示
- 工具调用进度、暂停、继续和取消任务
- 仓库文件树、代码标签页、行号及代码搜索
- 多文件 Diff、逐文件或批量接受、拒绝及撤销决定
- 真实 HTTP/SSE 后端协议、结构化错误、事件去重和集中状态管理
- 项目/会话恢复、消息持久化、任务控制、版本化 Diff 审阅、安全应用与回滚
- 未设置后端地址时的 Mock 演示模式和可调整的电脑端三栏布局
- Vitest 与 Testing Library 前端测试

## 协作开始方式

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
- 角色二架构与实现边界：[docs/harness-runtime/README.md](docs/harness-runtime/README.md)
- 完整 HTTP、DTO、状态机与 SSE 格式：[docs/harness-runtime/API_REFERENCE.md](docs/harness-runtime/API_REFERENCE.md)
- 分支合并、适配器接入与验证清单：[docs/harness-runtime/MERGE_GUIDE.md](docs/harness-runtime/MERGE_GUIDE.md)
- JSON Schema：`schemas/domain.schema.json`

公开 API 的规范前缀为 `/api/v1`，当前契约版本为 `1.0.0`。事件携带显式的
`schemaVersion`；修改跨模块对象、枚举或事件时先运行 `npm run openapi:generate`，再更新
契约测试并运行完整检查。

在没有真实模型和解析器之前，后端使用确定性 Fake 模型、文本检索和隔离的任务工作区跑通多轮任务闭环。完整检查命令：

```powershell
npm run check
```

首期 API 流程是：创建项目 -> 创建会话与消息 -> 创建并异步运行任务 -> 查询验证与 Diff ->
审阅变更 -> 应用或回滚。项目创建接口的 `sourcePath` 必须是后端进程可访问的本地目录。
