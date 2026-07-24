# 工具注册与受控运行时

## 运行管线

`ToolExecutor` 通过 `ToolRegistry` 暴露统一入口。内置工具和角色三扩展工具必须使用相同的
注册、校验和结果封装流程：

```text
查找注册定义
→ 检查权限与参数大小
→ 校验输入 JSON Schema
→ 按工作区串行执行有副作用的工具
→ 执行并响应 AbortSignal/超时
→ 检查输出大小与输出 JSON Schema
→ 返回统一 ToolResult
```

每个 `ToolDefinition` 必须声明名称、版本、描述、权限、是否有副作用、默认超时以及输入
和输出 JSON Schema。注册时会同时校验领域契约并编译 Schema；重复名称或无效 Schema
会立即失败。

角色三可以通过 `ToolRegistrationPort.register()` 注册已经冻结在公共契约中的
`search_symbol` 和 `read_ast`。适配器必须遵守传入的 `AbortSignal`，并返回可 JSON
序列化且符合声明 Schema 的结果。应用装配允许注入已经完成扩展注册的 `ToolExecutor`。

## 内置工具

| 工具          | 权限      | 副作用 | 关键语义                                      |
| ------------- | --------- | ------ | --------------------------------------------- |
| `list_files`  | `READ`    | 否     | 排序列出直接子项，忽略隐藏项和符号链接        |
| `search_text` | `READ`    | 否     | 有界文本扫描，跳过二进制和超大文件            |
| `read_file`   | `READ`    | 否     | 只读有界 UTF-8 文本，同时返回 SHA-256         |
| `write_file`  | `WRITE`   | 是     | 新建文件；覆盖时必须提供匹配的 `expectedHash` |
| `apply_patch` | `WRITE`   | 是     | 对匹配基线哈希的文件执行非重叠行编辑          |
| `git_status`  | `READ`    | 否     | 读取任务独立仓库状态                          |
| `git_diff`    | `READ`    | 否     | 返回含未跟踪文件的完整 Diff，不修改真实索引   |
| `run_command` | `COMMAND` | 是     | 使用可执行文件和参数数组执行受控命令          |

文件路径统一经过任务工作区解析器，拒绝绝对路径、路径越界、符号链接和特殊文件。文本读取
拒绝 NUL、无效 UTF-8 和超过限制的文件。写工具按工作区串行，先检查基线哈希，再写入同目录
临时文件、原子替换并复核结果哈希；现有文件不能盲写。

`apply_patch` 的 `startLine` 使用一基行号。编辑按原始文件定位，必须互不重叠且不超出文件
范围；调用方应先用 `read_file` 获取内容和 `expectedHash`。哈希过期返回
`CONFLICT`，不自动覆盖并发修改。

有副作用的处理器在超时或取消后必须先完成协作式清理，注册表才会释放当前工作区写锁。
无副作用处理器可以由注册表停止等待，但实现仍必须监听 `AbortSignal`，避免遗留后台工作。

## 命令策略

命令请求使用 `{ executable, args, timeoutMs? }`，不会拼接命令字符串，也不会启动 shell。
当前允许：

- `node --version`、`node -v`、`node --test`；
- `node --check <工作区内相对 JavaScript 路径>`；
- `npm --version`、`npm test`、`npm run <安全脚本名>`；
- `git status/diff/log/show/rev-parse` 的有限只读参数集合。

参数中的 shell 控制字符、换行和 NUL 会被拒绝。子进程固定在任务工作区，使用最小环境，
关闭 Git 交互提示，并限制执行时间和 stdout/stderr 的合计内存占用。统计字段保留实际
输出字节数；超过上限时只截断保存内容。超时或取消会终止进程树，Windows 使用
`taskkill /T /F`，POSIX 使用独立进程组。

这是一层命令策略和资源防护，不是操作系统沙箱。`npm test/run` 和 `node --test` 会执行
仓库代码，仍可能访问当前用户可访问的系统资源。服务目前只允许本机开发使用；在认证、
显式命令审批和容器/低权限进程隔离完成前，不得处理不可信仓库或暴露到不可信网络。

## 结果、错误与审计

所有工具返回统一 `ToolResult`：

- `status` 为 `SUCCEEDED`、`FAILED` 或 `CANCELLED`；
- `output` 仅在成功时存在；
- `error` 包含稳定错误码、详情和 `retryable`；
- `affectedFiles` 记录实际写入的工作区相对路径；
- `durationMs` 记录从校验到完成的耗时。

参数、权限和命令策略错误不可重试；超时以及分类为环境/瞬态的工作区错误可重试；主动
取消不可重试。工具返回不符合 Schema、不可序列化或超过输出上限时会作为受控失败处理。

Harness 在执行前完成校验，再创建 `tool_calls` 记录。已接受的调用会在独立事务中持久化
`tool.started` 和 `tool.completed` 事件，并分别写入 `tool.started`、`tool.completed`
审计记录。SSE 开始事件会省略文件内容和补丁正文，只保留字节数或编辑数量；完整参数仍
保存在内部工具调用记录中。

## 配额

| 环境变量                   | 默认值    | 说明                       |
| -------------------------- | --------- | -------------------------- |
| `MAX_COMMAND_TIMEOUT_MS`   | `30000`   | 单命令最大超时             |
| `MAX_COMMAND_OUTPUT_BYTES` | `1048576` | stdout/stderr 合计保留上限 |
| `MAX_READ_FILE_BYTES`      | `1048576` | 单次文本文件读取上限       |
| `MAX_TOOL_ARGUMENT_BYTES`  | `262144`  | 单次工具参数 JSON 上限     |
| `MAX_TOOL_OUTPUT_BYTES`    | `1048576` | 单次工具结果 JSON 上限     |

任务级工具次数、累计读取量、总耗时和成本预算属于后续上下文与预算阶段。
