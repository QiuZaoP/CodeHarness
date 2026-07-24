# Harness 多轮执行循环

## 执行边界

任务依次经过前检查、规划和多轮执行。前检查验证任务工作区可读写、隔离 Git 仓库存在、
初始状态干净、基线快照与导入时源版本一致。规划只接受结构合法、步骤 ID 唯一且最多包含
一个运行中步骤的 `PLAN_UPDATE`。

执行阶段的每轮顺序固定为：

```text
构造受预算限制的上下文
→ 调用并校验 ModelGateway Decision
→ 持久化 Decision、RunState、harness.decision 事件和审计
→ 执行对应动作
→ 持久化 Observation、预算和审计
→ 继续、验证、等待用户或完成
```

`RunState.activeTurn` 保存当前或最近一轮的 Decision、Observation、序号和预分配的工具调用
ID。历史轮次由 `harness_turn` 审计记录、工具调用、验证结果和任务事件共同追溯。工具调用在
执行前写入 `RUNNING` 记录；恢复时会复用已经完成的确定结果，不会重放结果不确定的
`RUNNING` 副作用。

## Decision 处理

| Decision      | Harness 行为                                         |
| ------------- | ---------------------------------------------------- |
| `TOOL_CALL`   | 校验注册、参数、权限与预算，执行单个工具并归一化结果 |
| `PLAN_UPDATE` | 校验并事务性替换计划和步骤                           |
| `ASK_USER`    | 保存问题并进入可恢复的 `WAITING_USER`                |
| `VERIFY`      | 只接受无 shell 的简单命令，逐条记录验证结果          |
| `COMPLETE`    | 仅当所有步骤完成且至少有一次成功验证时进入审阅       |

失败工具结果会作为 Observation 返回下一轮模型判断。连续失败达到
`MAX_CONSECUTIVE_HARNESS_FAILURES` 后任务进入 `WAITING_USER`，避免无界重试。路径、工具参数、
权限、命令和预算仍由工具运行时及 `BudgetManager` 最终裁决，模型不能绕过。

`ASK_USER` 与模型/索引故障都保存恢复目标。调用现有 `resume` 控制后从该目标继续；会话消息
写入 API 在后续 API 集成阶段提供，当前适配器或测试可通过持久化消息接口补充用户回答。

## 计划与完成

第一个未完成步骤在执行开始时标记为 `RUNNING`，工具调用记录对应 `stepId`。成功完成
`VERIFY` 后本轮计划步骤标记为 `DONE`。模型的 `COMPLETE` 只是请求：Harness 仍会检查计划、
最近一轮验证是否全部通过、预算和持久状态，条件不足时产生失败 Observation，而不会发布
`task.completed`。后续失败验证会覆盖更早的成功结论。

当前公开 Decision 契约一次只包含一个 `TOOL_CALL`，因此工具按轮串行执行。只读批量并发需要
先增加版本化批量 Decision 并与模型、前端和契约测试协同升级，本实现不会用私有格式绕过
`1.0.0` 契约。

## Fake 闭环

默认 Fake ModelGateway 确定性地产生：

1. 规划；
2. `list_files`；
3. `read_file`；
4. `git_status`；
5. `VERIFY node --version`；
6. `COMPLETE`。

这条路径用于证明至少三轮真实工具调用、逐轮持久化、验证门禁和最终完成条件。
