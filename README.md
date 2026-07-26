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

## 角色 3：代码索引 MVP

代码解析与索引模块当前支持本地目录扫描、默认及自定义忽略规则、常见源文件语言识别，以及按相对路径或文本内容的确定性检索。二进制文件不会写入可检索内容；无法使用 UTF-8 解码的文件会保留元数据并出现在扫描问题中。

```python
from codeharness_indexer import RepositoryScanner

report = RepositoryScanner("./my-repository").scan()
for match in report.index.search_content("TODO"):
    print(match.path, match.line_number)
```

运行测试（未安装为包时）：

```powershell
$env:PYTHONPATH = "src"
python -m unittest discover -s tests -v
```
