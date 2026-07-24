# CodeHarness

CodeHarness 是一款基于自研 Agent Harness 的代码库智能助手，支持仓库导入、代码索引、仓库级问题定位、代码修改、测试生成和 Diff 预览。

## 快速开始

当前仓库包含角色一负责的前端工作台实现。未配置 `VITE_API_BASE_URL` 时会自动使用内置 Mock 数据，可以独立体验全部交互。

```powershell
npm install
npm run dev
```

浏览器打开 `http://127.0.0.1:4173`。

常用检查：

```powershell
npm run lint
npm run test
npm run build
```

接入后端时复制 `.env.example` 为 `.env.local`，设置 `VITE_API_BASE_URL`。前端 API 封装位于 `src/services/api.ts`。

## 已实现的前端能力

- 项目导入、项目切换、分支和索引状态展示
- 会话列表、新建任务、消息发送和任务状态展示
- 工具调用进度、暂停、继续和取消任务
- 仓库文件树、代码标签页、行号及代码搜索
- 多文件 Diff、逐文件或批量接受、拒绝及撤销决定
- Mock 后端协议、集中状态管理和可调整的电脑端三栏布局
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
