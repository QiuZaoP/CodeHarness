# 贡献指南

## 开始工作

```powershell
git fetch origin
git switch develop
git pull --ff-only origin develop
git switch -c feature/<your-name>-<short-description>
```

分支名使用小写英文和短横线，例如：

```text
feature/zhangsan-file-tree
fix/lisi-tool-timeout
test/wangwu-benchmark-repo
docs/chenqiang-api-protocol
```

## 提交规范

提交信息使用 Conventional Commits：

```text
feat: add repository file tree
fix: handle tool timeout
test: add harness loop regression case
docs: update branch workflow
refactor: simplify context selection
chore: update development tooling
```

每个提交应保持单一目的，避免将无关格式化、重命名或依赖升级混入功能提交。

## Pull Request 流程

1. 将功能分支更新到最新 `develop`。
2. 在本地运行与改动相关的测试和检查。
3. 推送个人分支并创建 Pull Request，目标分支为 `develop`。
4. 填写变更内容、验证方式、风险和接口影响。
5. 至少一名相关模块负责人审核；跨模块变更需要相关负责人共同确认。
6. CI 通过且审核完成后合并，优先使用 squash merge。

```powershell
git fetch origin
git rebase origin/develop
git push -u origin HEAD
```

## 模块负责人

- 前端工作台：前端交互负责人
- Harness 运行时：后端 Harness 核心负责人
- 代码解析与索引：代码解析与索引负责人
- 模型网关：模型网关负责人
- 测试与质量：测试统筹与质量负责人

模块负责人维护本模块接口、实现和单元测试。测试负责人负责跨模块回归和发布准入，但不替代模块负责人修复生产代码。

## 变更要求

- 不提交密钥、Token、本地路径、用户数据和构建产物。
- 不绕过工作区直接修改用户原始仓库。
- 工具命令必须有权限、超时和工作目录限制。
- 接口变更必须同步更新文档、Schema 和契约测试。
