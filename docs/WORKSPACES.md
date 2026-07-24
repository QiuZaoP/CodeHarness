# 任务工作区、快照与 Git

## 隔离模型

CodeHarness 不在用户源目录内执行写操作，也不创建 Git worktree。项目导入只读取源目录并保存
元数据；创建任务时进行受控复制，并在任务副本内初始化独立 Git 仓库。这个策略同时支持
非 Git 目录、dirty 仓库和 Windows，且不会修改或锁定原仓库的 `.git`。

```text
WORKSPACE_ROOT/
  projects/{projectId}/source-metadata/
    source.json
    manifest.json
  tasks/{taskId}/
    worktree/
    snapshots/{snapshotId}/
      tree/
      manifest.json
      snapshot.json
    artifacts/
    git-hooks-disabled/
```

同一项目的不同任务使用不同的 `worktree`，不能共享可写目录。数据库仅保存内部绝对路径；
项目和任务公共响应不会暴露这些路径。

## 导入与复制策略

导入会验证源目录存在、可读、不是符号链接，并拒绝源目录与 `WORKSPACE_ROOT` 相互包含。
遍历使用 `lstat`，遇到符号链接、junction 或其他特殊文件时拒绝导入。

默认不复制以下目录：

```text
.git .data .next .venv __pycache__ build coverage dist
node_modules target venv
```

默认限制可通过环境变量调整：

| 变量                        | 默认值      | 说明               |
| --------------------------- | ----------- | ------------------ |
| `MAX_IMPORT_FILES`          | `20000`     | 最大导入文件数     |
| `MAX_IMPORT_BYTES`          | `536870912` | 导入文件总字节数   |
| `MAX_FILE_BYTES`            | `5242880`   | 单文件最大字节数   |
| `WORKSPACE_RETENTION_HOURS` | `168`       | 已结束任务保留时长 |

二进制文件允许复制，但会在 manifest 中标记，并受相同大小限制。manifest 记录目录以及
每个文件的相对路径、字节数、权限模式、SHA-256 和二进制标记；排序后的 manifest 生成
项目根哈希，因此空目录和权限变化也能被校验与恢复。

## 源 Git 元数据

导入时只执行只读 Git 查询，保存：

- 是否位于 Git 仓库；
- 仓库根目录；
- `HEAD` revision；
- 当前分支，detached HEAD 时为空；
- 包含 tracked 和 untracked 文件的 dirty 状态。

任务副本不携带源仓库 `.git`。基线快照完成后，副本会初始化独立仓库并创建
`CodeHarness baseline` 提交。Git hooks 被指向任务内的空目录，提交签名关闭，Git 相关
环境变量会被清理，所有 Git 操作都限制在任务副本中。

## 路径安全

工具路径必须是相对于任务工作区的路径。解析流程同时执行：

1. 拒绝绝对路径、NUL 和词法 `..` 越界；
2. 确认工作区本身位于受管 `tasks` 根目录；
3. 对已存在的每一级路径执行 `lstat`，拒绝符号链接和特殊文件；
4. 对新文件验证最近存在父目录的 canonical realpath；
5. 确认最终路径仍位于任务工作区。

只做 `path.resolve` 不构成安全检查。新增文件或目录也必须通过同一解析器。

## Diff、快照与回滚

- `git_status` 返回任务独立仓库的 porcelain 状态。
- `git_diff` 使用临时 Git index 暂存视图，因此包含 tracked、untracked 和删除文件，
  但不改变任务仓库的真实 index。
- `BASELINE` 在任务创建时生成，文件系统快照、`task.created`、审计和快照元数据采用
  补偿操作与数据库事务组合，失败时清理未提交的任务目录。
- `CHECKPOINT`/`FINAL` 快照不会覆盖已有目录；未变化文件优先硬链接到上一快照，
  变化文件才复制。硬链接不可用时安全回退为普通复制。
- 回滚先用数据库中的可信根哈希验证基线，再复制到 recovery 目录并二次验证。替换
  worktree 失败时恢复备份；成功后重新创建独立 Git 基线。任何情况下都不删除基线快照。

过期清理是显式操作。调用方必须把仍活跃或需要保留的 task ID 传入保护列表；系统不会
在任务执行路径中自动删除工作区。

## 当前边界

任务完成时创建 `FINAL` 快照并持久化结构化 Diff。文件级审阅、源文件并发校验、补偿式
应用和报告见 [CHANGES.md](CHANGES.md)。区块级审阅仍需后续契约扩展。
