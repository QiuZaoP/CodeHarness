const {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  AlignmentType,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  PageNumber,
  Header,
  Footer,
  convertInchesToTwip,
} = require("docx");
const fs = require("fs");
const path = require("path");

const outputPath =
  "C:\\Users\\Lenovo\\Desktop\\实训项目最终提交物_学生端\\实训项目最终提交物（线下）说明-南大软件_AI2班\\11_差点没队组\\01.源码及数据库文件\\VibeCoding list\\VibeCoding_List_CodeHarness.docx";

const commitsData = JSON.parse(
  fs.readFileSync(path.join(__dirname, "gitee_commits.json"), "utf8")
);

const borderStyle = { style: BorderStyle.SINGLE, size: 1 };

function createHeading(text, level) {
  return new Paragraph({
    heading: level,
    children: [new TextRun({ text, bold: true, font: "黑体", size: 24 })],
    spacing: { before: 240, after: 120, line: 360 },
  });
}

function createSubHeading(text) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, font: "黑体", size: 24 })],
    spacing: { before: 200, after: 100, line: 360 },
  });
}

function createParagraph(text) {
  return new Paragraph({
    children: [new TextRun({ text, font: "仿宋", size: 24 })],
    spacing: { after: 120, line: 360 },
    indent: { firstLine: 480 },
  });
}

function createCodeBlock(text) {
  // 将整段代码作为多行 TextRun 输出，保持原内容
  const lines = text.split(/\r?\n/);
  return lines.map(
    (line) =>
      new Paragraph({
        children: [new TextRun({ text: line || " ", font: "Consolas", size: 20 })],
        spacing: { after: 0, line: 280 },
      })
  );
}

function createBullet(text) {
  return new Paragraph({
    children: [new TextRun({ text, font: "仿宋", size: 24 })],
    bullet: { level: 0 },
    spacing: { after: 80, line: 360 },
  });
}

function createCenterText(text, options = {}) {
  return new Paragraph({
    children: [new TextRun({ text, font: "仿宋", size: 24, ...options })],
    alignment: AlignmentType.CENTER,
    spacing: { after: 120, line: 360 },
  });
}

// 表格单元格构造
function tCell(text, opts = {}) {
  return new TableCell({
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text,
            font: "仿宋",
            size: 20,
            bold: !!opts.bold,
          }),
        ],
        spacing: { after: 40, line: 280 },
      }),
    ],
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
  });
}

// 提交历史表格：分支 -> commits
function buildCommitTable(commits) {
  const rows = [
    new TableRow({
      tableHeader: true,
      children: [
        tCell("序号", { bold: true }),
        tCell("Commit SHA", { bold: true }),
        tCell("提交时间", { bold: true }),
        tCell("提交信息", { bold: true }),
        tCell("作者", { bold: true }),
      ],
    }),
  ];
  commits.forEach((c, idx) => {
    rows.push(
      new TableRow({
        children: [
          tCell(String(idx + 1)),
          tCell(c.sha),
          tCell(c.date.replace("T", " ").replace("Z", " UTC")),
          tCell(c.message),
          tCell(c.author),
        ],
      })
    );
  });
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: borderStyle,
      bottom: borderStyle,
      left: borderStyle,
      right: borderStyle,
      insideHorizontal: borderStyle,
      insideVertical: borderStyle,
    },
  });
}

// 仓库地址与分支概览表格
function buildBranchSummaryTable() {
  const branchDesc = {
    main: "稳定、可发布代码，只接受 Pull Request",
    develop: "日常集成分支，所有功能分支从这里创建并合并回这里",
    "feature/frontend-workbench": "前端工作台开发分支（角色一：蔡字杰）",
    "feature/harness-runtime": "Harness 核心运行时开发分支（角色二：宗子路）",
    "feature/code-indexer": "代码解析与索引开发分支（角色三：孟炜杰）",
    "feature/model-gateway": "模型网关开发分支（角色四：王苑婷）",
    "integrate/all-modules-v2": "全模块集成联调分支",
  };
  const rows = [
    new TableRow({
      tableHeader: true,
      children: [
        tCell("分支名称", { bold: true }),
        tCell("提交数量", { bold: true }),
        tCell("说明", { bold: true }),
      ],
    }),
  ];
  Object.keys(commitsData).forEach((b) => {
    rows.push(
      new TableRow({
        children: [
          tCell(b),
          tCell(String(commitsData[b].length)),
          tCell(branchDesc[b] || ""),
        ],
      })
    );
  });
  const total = Object.values(commitsData).reduce((s, a) => s + a.length, 0);
  rows.push(
    new TableRow({
      children: [tCell("合计", { bold: true }), tCell(String(total), { bold: true }), tCell("")],
    })
  );
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: borderStyle,
      bottom: borderStyle,
      left: borderStyle,
      right: borderStyle,
      insideHorizontal: borderStyle,
      insideVertical: borderStyle,
    },
  });
}

// 角色与 Prompt History 文件映射
function buildRoleTable() {
  const rows = [
    new TableRow({
      tableHeader: true,
      children: [
        tCell("角色", { bold: true }),
        tCell("负责人", { bold: true }),
        tCell("负责模块", { bold: true }),
        tCell("Prompt History 文件", { bold: true }),
      ],
    }),
    new TableRow({
      children: [
        tCell("角色一"),
        tCell("蔡字杰"),
        tCell("对话工作台（前端）"),
        tCell("VibeCoding_Tool_工作流程_History.md"),
      ],
    }),
    new TableRow({
      children: [
        tCell("角色二"),
        tCell("宗子路"),
        tCell("Harness 核心运行时"),
        tCell("AI工作流程history.md"),
      ],
    }),
    new TableRow({
      children: [
        tCell("角色三"),
        tCell("孟炜杰"),
        tCell("代码解析与索引"),
        tCell("会话总结_角色3代码解析与索引.md"),
      ],
    }),
    new TableRow({
      children: [
        tCell("角色四"),
        tCell("王苑婷"),
        tCell("模型网关"),
        tCell("CodeHarness_角色四_VibeCoding_使用历史.md"),
      ],
    }),
  ];
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: borderStyle,
      bottom: borderStyle,
      left: borderStyle,
      right: borderStyle,
      insideHorizontal: borderStyle,
      insideVertical: borderStyle,
    },
  });
}

async function main() {
  const children = [];

  // 封面
  children.push(new Paragraph({ spacing: { before: 1200 } }));
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: "CodeHarness / CodeSeek 项目",
          bold: true,
          font: "黑体",
          size: 36,
        }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
    })
  );
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: "VibeCoding Tool 使用历史清单",
          bold: true,
          font: "黑体",
          size: 44,
        }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 600 },
    })
  );
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: "Prompt History + Git Commit History + 仓库地址链接",
          font: "仿宋",
          size: 24,
        }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 800 },
    })
  );
  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "小组：11_差点没队组", font: "仿宋", size: 24 }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
    })
  );
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: "项目名称：CodeHarness（CodeSeek 寻码）",
          font: "仿宋",
          size: 24,
        }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
    })
  );
  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "整理日期：2026 年 7 月 30 日", font: "仿宋", size: 24 }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
    })
  );
  children.push(new Paragraph({ children: [], pageBreakBefore: true }));

  // 一、说明
  children.push(createHeading("一、文档说明", HeadingLevel.HEADING_1));
  children.push(
    createParagraph(
      "本文档汇总 11_差点没队组在 CodeHarness / CodeSeek 项目实训期间使用 VibeCoding Tool（含 Claude Code、Codex、Trae 等 AI 编程助手）的完整 Prompt History、Git Commit History 以及远程仓库地址链接，作为实训交付物之一提交。"
    )
  );
  children.push(
    createParagraph(
      "依据《01.源码及数据库文件/说明.txt》要求，VibeCoding list 包含：使用 VibeCoding Tool 所有的 Prompt History + Git Commit History + Gitee|Github 中仓库的地址链接。"
    )
  );
  children.push(
    createParagraph(
      "项目按角色分工并行开发，各角色独立维护功能分支并最终合并到 develop 与 integrate/all-modules-v2。所有提交均可通过远程仓库链接追溯。"
    )
  );

  // 二、仓库地址链接
  children.push(createHeading("二、仓库地址链接", HeadingLevel.HEADING_1));
  children.push(createSubHeading("（一）Gitee 仓库（主仓库）"));
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: "https://gitee.com/QiuZaoOP/CodeHarness",
          font: "Consolas",
          size: 24,
          color: "0563C1",
          underline: {},
        }),
      ],
      spacing: { after: 120, line: 360 },
    })
  );
  children.push(createSubHeading("（二）GitHub 仓库（镜像）"));
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: "https://github.com/QiuZaoP/CodeHarness",
          font: "Consolas",
          size: 24,
          color: "0563C1",
          underline: {},
        }),
      ],
      spacing: { after: 120, line: 360 },
    })
  );
  children.push(createSubHeading("（三）远程仓库 Clone 地址"));
  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "Gitee: ", font: "仿宋", size: 24, bold: true }),
        new TextRun({
          text: "https://gitee.com/QiuZaoOP/CodeHarness.git",
          font: "Consolas",
          size: 24,
        }),
      ],
      spacing: { after: 80, line: 360 },
    })
  );
  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "GitHub: ", font: "仿宋", size: 24, bold: true }),
        new TextRun({
          text: "https://github.com/QiuZaoP/CodeHarness.git",
          font: "Consolas",
          size: 24,
        }),
      ],
      spacing: { after: 120, line: 360 },
    })
  );

  // 三、角色与 Prompt History 文件清单
  children.push(
    createHeading("三、角色与 Prompt History 文件清单", HeadingLevel.HEADING_1)
  );
  children.push(
    createParagraph(
      "本项目按 4 个角色并行开发，每个角色独立记录使用 VibeCoding Tool 的 Prompt History，并以 Markdown 文件形式保存在 VibeCoding list 目录下。"
    )
  );
  children.push(buildRoleTable());
  children.push(new Paragraph({ spacing: { before: 200 } }));
  children.push(
    createParagraph(
      "下文将分别摘录各角色 Prompt History 文件的核心内容（阶段划分与代表性 Prompt），完整原文见同目录下对应的 .md 文件。"
    )
  );

  // 四、角色一 Prompt History 摘要
  children.push(
    createHeading(
      "四、角色一 Prompt History 摘要（蔡字杰 - 对话工作台）",
      HeadingLevel.HEADING_1
    )
  );
  children.push(
    createParagraph(
      "来源文件：VibeCoding_Tool_工作流程_History.md。截至 2026 年 7 月 29 日，本地历史共记录 97 条 Prompt，分布在 19 个历史分组。整体使用路径由“先确认工具和任务边界”逐步发展为“让工具直接执行、持续验证、形成交付物并复盘 Prompt 方法”，已从零散问答升级为阶段化协作。"
    )
  );
  const role1Stages = [
    ["阶段 0：建立工具使用基线", "确认 VibeCoding Tool 能力边界、统一中文交互、排查外围环境（Google、PyCharm Copilot、API、Conda）。"],
    ["阶段 1：明确项目、角色与任务范围", "围绕 louyumwj/lanchat.git 与 QiuZaoP/CodeHarness.git 接入项目；选择最擅长且不易出错的角色一；冻结桌面端边界，目标分支 feature/frontend-workbench。"],
    ["阶段 2：推进 lanchat 项目开发与交付", "执行既定计划、补齐 README、清理无用文件、生成项目压缩包，形成完整交付。"],
    ["阶段 3：完成 CodeHarness 角色一前端工作台", "实现项目导入、项目切换、分支及索引状态展示；完善会话与任务交互、文件树、代码浏览与变更审阅；对齐 develop 并交付到 feature/frontend-workbench。"],
    ["阶段 4：掌握 Git、PR、分支与回退流程", "理解 Git 作用、提交模块一相关内容、完成 PR 操作、安全回退与恢复，建立协作边界意识。"],
    ["阶段 5：验证实现并准备答辩说明", "总结角色一已完成功能、解释关键对象与方法（snapshot.projects、snapshot.files、openFile）、建立代码位置映射、输出答辩 DOCX。"],
    ["阶段 6：形成工作日志与过程记录", "从 Prompt History 提炼日志内容，统一格式与命名（2411814_孟炜杰_工作日志），补齐指定周期记录。"],
    ["阶段 7：产出实训报告与答辩 PPT", "补齐个人与实训信息，输出 Word 和 PDF 两版报告；以附件模板生成答辩 PPT，按项目方案角色分别介绍。"],
    ["阶段 8：处理调研、浏览器与通用任务", "调研主流大语言模型上下文窗口限制（输出 Word）；模拟 Gemini/Claude/DeepSeek/Qwen/豆包 MBTI；完成浏览器界面作业与写作优化。"],
    ["阶段 9：沉淀 Prompt 资产与标准工作流", "汇总 97 条 Prompt、识别高频交互模式、形成通用 Prompt 模板与可复用闭环。"],
  ];
  role1Stages.forEach(([title, desc]) => {
    children.push(createSubHeading(title));
    children.push(createParagraph(desc));
  });

  children.push(createSubHeading("通用 Prompt 模板"));
  children.push(
    ...createCodeBlock(
      "基于【项目/仓库路径】，只完成【角色/模块】；参考【develop/指定提交】，\n目标分支为【分支名】；仅考虑【桌面端/指定端】。请直接执行并输出\n【代码/Word/PPT/压缩包】，完成后检查【构建、测试、Git 状态与交付路径】，\n不要修改范围外内容。"
    )
  );

  children.push(createSubHeading("高频 Prompt 模式识别"));
  children.push(createBullet("目标型：如“帮我完成角色一任务”“生成 Word/PPT/压缩包”。"));
  children.push(createBullet("迭代型：如“继续任务”“继续优化”“更加详细一点”“现在可以了吗”。"));
  children.push(createBullet("边界型：如“只做角色一”“只考虑电脑端”“不要影响 main”。"));
  children.push(createBullet("解释型：如“这是什么”“怎么实现”“代码在哪里”。"));

  children.push(createSubHeading("代表性 Prompt 摘录"));
  const role1Prompts = [
    "你能直接操作 pycharm 上的文件吗",
    "C:\\Users\\17267\\PycharmProjects\\CodeHarness 在这个仓库中让你完成哪个角色最容易，不会出错",
    "帮我完成角色一的任务吧",
    "不需要手机端的设计 / 只需要考虑电脑端就可以",
    "结合 develop 的改动，对我本地角色一的任务进行完善",
    "把新增分支 feature/frontend-workbench-codex 删除，推送到 feature/frontend-workbench",
    "对于角色一的任务成功完成的功能进行总结，并说明每个部分是如何实现的，按照答辩要求准备",
    "snapshot.projects 是什么 / snapshot.files 在哪 / openFile 是啥",
    "帮我把答辩说明生成一个 docx 文档 / 帮我在文档中标注每个东西在项目中出现的位置",
    "帮我总结使用 VibeCoding Tool 所有的 Prompt History，并输出到 word 文档中",
  ];
  role1Prompts.forEach((p) => children.push(createBullet(p)));

  // 五、角色二 Prompt History 摘要
  children.push(
    createHeading(
      "五、角色二 Prompt History 摘要（宗子路 - Harness 核心运行时）",
      HeadingLevel.HEADING_1
    )
  );
  children.push(
    createParagraph(
      "来源文件：AI工作流程history.md。角色二负责 Agent Harness 后端开发——涵盖持久化、任务工作区、工具安全运行时、生命周期调度、模型与索引 Port 集成、Harness 执行循环、变更交付、API/SSE 接入以及全链路质量保障。开发按 12 个阶段推进，每阶段有明确领域目标、交付物和完成门槛。"
    )
  );
  const role2Stages = [
    ["阶段 0：建立可信基线", "从 develop 拉取 feature/harness-runtime 分支；npm ci → npm run check → npm run build；将开发命令、ESM/TypeScript strict/100 列/kebab-case 约束写入 CLAUDE.md。"],
    ["阶段 1：冻结领域模型与契约", "收敛 Decision、ToolDefinition、ToolCallRecord、RunState 等 Schema；统一 /api/v1 前缀；补齐 OpenAPI；定义角色三/四 Port Mock 契约。"],
    ["阶段 2：持久化与事务", "引入迁移目录与执行器；建立 12 张业务表（projects、sessions、tasks、tool_calls 等）；事务提交后才发布事件到 Broker；乐观版本控制。"],
    ["阶段 3：任务级工作区、快照与 Git", "tasks/{taskId}/worktree 隔离布局；不可变基线快照 + 增量硬链接快照；可验证回滚；retention 清理策略。"],
    ["阶段 4：工具注册与安全运行时", "ToolRegistry + ToolExecutor；8 个基础工具（list_files、search_text、read_file、write_file、apply_patch、git_status、git_diff、run_command）；路径越界与命令注入防护。"],
    ["阶段 5：任务生命周期与调度", "TaskStateMachine 领域服务；HTTP 提交任务返回 202；task_leases 租约；pause/resume/cancel/apply/rollback 控制语义；服务恢复策略。"],
    ["阶段 6：模型网关与索引 Port", "ModelGateway Port（结构化 Decision、流式、Token/成本）；CodeIndex Port（文件/文本/符号/引用/调用链）；FakeModelGateway 与 TextCodeIndex 降级实现。"],
    ["阶段 7：上下文与预算管理", "ContextManager 按优先级与哈希去重；历史摘要增量压缩；BudgetManager 覆盖步数/工具/时长/变更/Token/成本。"],
    ["阶段 8：真实 Harness 执行循环", "加载 RunState → 构造上下文 → 调用模型 → 验证 Decision → 权限与预算检查 → 执行工具 → 归一化 Observation → 更新计划与检查点。"],
    ["阶段 9：变更、验证与结果交付", "FINAL 快照汇总新增/修改/删除；file_changes 文件级审阅与乐观锁决定；安全应用与多文件补偿恢复；任务报告。"],
    ["阶段 10：API 与 SSE 完整接入", "项目/会话/消息/任务列表与查询；持久化 SSE 事件流，Last-Event-ID 重连；15 秒心跳；CORS 白名单。"],
    ["阶段 11：质量、安全与可观测性", "11 个测试文件 50 项测试；Pino 日志与敏感字段脱敏；/api/v1/metrics 指标端点；生产模式禁用 Mock。"],
    ["阶段 12：跨角色集成", "对接真实模型与索引或 Fake + 文本降级；对接前端工作台；导入真实小型仓库完成全链路验收（14 个文件 60 项测试）。"],
  ];
  role2Stages.forEach(([title, desc]) => {
    children.push(createSubHeading(title));
    children.push(createParagraph(desc));
  });

  // 六、角色三 Prompt History 摘要
  children.push(
    createHeading(
      "六、角色三 Prompt History 摘要（孟炜杰 - 代码解析与索引）",
      HeadingLevel.HEADING_1
    )
  );
  children.push(
    createParagraph(
      "来源文件：会话总结_角色3代码解析与索引.md。角色三以 TDD（红-绿-重构）方式推进，使用现有 origin/feature/code-indexer 分支，最终完成原生 Tree-sitter AST 解析、SQLite 关系持久化、增量索引与向量检索能力。"
    )
  );
  const role3Sections = [
    ["一、任务启动与需求边界", "明确角色 3 职责：递归扫描、忽略规则、语言识别、稳定文件索引、路径/文本检索、降级处理。首期不含模型调用、前端、Harness 主循环、AST/符号/调用链/向量索引。建议创建 feature/code-indexer 隔离分支。"],
    ["二、计划文档与初始实现", "改用已有 origin/feature/code-indexer 分支；建立 task_plan.md、progress.md、findings.md 与 docs/superpowers/plans/2026-07-26-code-indexer-mvp.md；按 TDD 搭建 Python src/ 与 tests/。"],
    ["三、MVP 验收与远程发布", "完成不可变 FileRecord、RepositoryIndex、扩展名语言识别、目录递归、默认忽略规则、二进制降级、稳定排序、行号从 1 开始；7 项单元测试通过；提交 8dae4cb 推送到 feature/code-indexer。"],
    ["四、从 MVP 扩展到完整角色 3 能力", "因 web-tree-sitter 与 tree-sitter-wasms 兼容性问题改用原生 Node Tree-sitter 绑定；规划 AST、SQLite、增量、EmbeddingProvider、向量持久化、Harness 工具、Schema/OpenAPI。"],
    ["五、TypeScript 后端接入", "CodeIndexService 接入 SQLite、项目创建自动索引、注入 ToolExecutor、扩展 ToolCall、新增 Vitest 测试；首版支持 index_repository、search_symbols、find_callers、search_semantic。"],
    ["六、问题修复与完整实现", "修复 Tree-sitter 类型兼容（使用 Parser.setLanguage 参数类型推导）；完成 AST 遍历、关系索引、向量检索、工具契约、Schema 与完整测试。"],
    ["七、最终需求复核与提交状态", "代码索引需求满足；修正 workspace 失败使用 WORKSPACE_ERROR、parser 失败保留文件级 fallback chunk；推送 400ea0b；lint、typecheck、Schema 校验通过，全量 Vitest 14 项通过。"],
  ];
  role3Sections.forEach(([title, desc]) => {
    children.push(createSubHeading(`（${title}）`));
    children.push(createParagraph(desc));
  });

  // 七、角色四 Prompt History 摘要
  children.push(
    createHeading(
      "七、角色四 Prompt History 摘要（王苑婷 - 模型网关）",
      HeadingLevel.HEADING_1
    )
  );
  children.push(
    createParagraph(
      "来源文件：CodeHarness_角色四_VibeCoding_使用历史.md。角色四主责实现模型调用统一层和模型服务稳定性，包括对接第三方大模型、统一 Chat/流式/结构化输出/Embedding 协议、模型路由与限流、Prompt 模板与输出校验、Token/成本/延迟指标、故障降级与熔断。"
    )
  );
  const role4Sections = [
    ["2026-07-26 启动角色四开发", "“请依据 README、项目方案设计.md 及角色四职责划分，完成模型网关模块开发，并编写覆盖核心功能、异常场景和可用性的测试。真实 API 调用统一从 D:\\企业实训\\api 读取 DeepSeek 配置。”"],
    ["2026-07-26 测试、修复与回归", "“请对当前模型网关模块执行系统化测试”“请针对测试发现的主要问题进行定向修复，并在修复后执行回归测试”“请再次检查当前模块，确认上一轮修复后的功能、边界条件和稳定性表现”“请优先解决当前代码范围内可以闭环处理的问题”。形成测试—问题—修复—回归闭环。"],
    ["2026-07-26 提交和推送角色四代码", "“请检查当前角色四分支的工作区、提交内容和远程配置，在确认变更范围正确后提交并推送到 GitHub”“请将角色四成果放入独立分支，并完成远程分支推送”。最终提交 b5b3559 feat: implement role four model gateway 推送到 feature/model-gateway。"],
    ["2026-07-26 整理工作日志", "“请依据所给模板，将角色四本周的开发、测试、问题修复和交付过程整理为工作日志”。"],
    ["2026-07-28 总结实际工作", "“请基于角色四的实际代码、测试和交付记录，系统总结我负责的工作”“请逐项核对上述职责与当前实现，区分已完成/部分完成/尚未完成”。明确保留后续项：主动限流器、真实 Embedding/Rerank 端到端验证、完整模型质量评分体系。"],
    ["2026-07-29 项目更新后转入答辩准备", "“请将项目同步到当前可获取的最新版本，并在更新后检查角色四代码是否仍与项目接口和依赖保持兼容”“暂缓进一步验证，先基于已确认的实现和测试结果，详细梳理我的角色四分工、已完成功能、技术难点、验证结论和后续边界，用于准备技术答辩”。"],
  ];
  role4Sections.forEach(([title, desc]) => {
    children.push(createSubHeading(title));
    children.push(createParagraph(desc));
  });

  children.push(createSubHeading("角色四已完成工作（依据代码与报告）"));
  const role4Done = [
    "设计统一 ModelGateway，提供 decide、summarize、embed 和 rerank 能力。",
    "完成 DeepSeek OpenAI-compatible Chat 适配，支持结构化 ModelDecision 解析与校验。",
    "支持流式事件：文本增量、结构化增量、Token 使用量事件。",
    "API Key 通过环境变量/文件读取，不写入代码、日志与仓库。",
    "超时、取消、有限重试、Retry-After、响应大小限制、熔断与备用网关。",
    "调用次数、成功/失败、重试、延迟、Token 与成本指标。",
    "可配置 OpenAI-compatible Embedding 与 /rerank 路由；未配置时返回 NOT_SUPPORTED。",
    "通过 Fake Fetch 离线测试与真实 DeepSeek Chat/Summary 冒烟测试。",
  ];
  role4Done.forEach((p) => children.push(createBullet(p)));

  children.push(createSubHeading("角色四明确保留的边界"));
  children.push(
    createBullet("主动限流器仍是后续增强项，当前主要处理服务端 429/Retry-After。")
  );
  children.push(
    createBullet("Embedding 与 Rerank 提供可配置路由与 Mock 验证，真实端到端验证仍依赖外部服务。")
  );
  children.push(
    createBullet("已有基础调用指标与评测数据，完整模型质量评分体系仍需继续建设。")
  );
  children.push(
    createBullet("Harness 状态机、代码搜索与前端交互不属于角色四主责。")
  );

  // 八、Git Commit History
  children.push(
    createHeading("八、Git Commit History（来自 Gitee 仓库）", HeadingLevel.HEADING_1)
  );
  children.push(
    createParagraph(
      "以下提交历史通过 Gitee API 获取自 https://gitee.com/QiuZaoOP/CodeHarness 仓库，按分支分组展示。仓库共 7 条分支，合计 118 次提交。"
    )
  );
  children.push(createSubHeading("（一）分支与提交数量概览"));
  children.push(buildBranchSummaryTable());
  children.push(new Paragraph({ spacing: { before: 200 } }));

  // 各分支提交详表
  const branchOrder = [
    "main",
    "develop",
    "feature/frontend-workbench",
    "feature/harness-runtime",
    "feature/code-indexer",
    "feature/model-gateway",
    "integrate/all-modules-v2",
  ];
  const branchTitles = {
    main: "（二）main 分支提交历史",
    develop: "（三）develop 分支提交历史",
    "feature/frontend-workbench": "（四）feature/frontend-workbench 分支提交历史",
    "feature/harness-runtime": "（五）feature/harness-runtime 分支提交历史",
    "feature/code-indexer": "（六）feature/code-indexer 分支提交历史",
    "feature/model-gateway": "（七）feature/model-gateway 分支提交历史",
    "integrate/all-modules-v2": "（八）integrate/all-modules-v2 分支提交历史",
  };
  branchOrder.forEach((b, idx) => {
    children.push(createSubHeading(branchTitles[b]));
    children.push(
      createParagraph(
        `共 ${commitsData[b].length} 次提交，按时间倒序排列。`
      )
    );
    children.push(buildCommitTable(commitsData[b]));
    if (idx < branchOrder.length - 1) {
      children.push(new Paragraph({ spacing: { before: 200 } }));
    }
  });

  // 九、附录
  children.push(
    new Paragraph({ children: [], pageBreakBefore: true })
  );
  children.push(createHeading("九、附录：源文件清单", HeadingLevel.HEADING_1));
  children.push(
    createParagraph(
      "本清单附带的 Prompt History 原始 Markdown 文件位于同目录下，可作为本文档的补充材料："
    )
  );
  children.push(
    createBullet("AI工作流程history.md（角色二：宗子路 - Harness 核心运行时）")
  );
  children.push(
    createBullet("CodeHarness_角色四_VibeCoding_使用历史.md（角色四：王苑婷 - 模型网关）")
  );
  children.push(
    createBullet("VibeCoding_Tool_工作流程_History.md（角色一：蔡字杰 - 对话工作台）")
  );
  children.push(
    createBullet("会话总结_角色3代码解析与索引.md（角色三：孟炜杰 - 代码解析与索引）")
  );
  children.push(new Paragraph({ spacing: { before: 200 } }));
  children.push(
    createParagraph(
      "远程仓库地址：Gitee https://gitee.com/QiuZaoOP/CodeHarness ；GitHub https://github.com/QiuZaoP/CodeHarness 。"
    )
  );

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1.2),
              right: convertInchesToTwip(1.2),
            },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: "CodeHarness VibeCoding List",
                    font: "仿宋",
                    size: 18,
                  }),
                ],
                alignment: AlignmentType.RIGHT,
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    children: ["第 ", PageNumber.CURRENT, " 页 / 共 ", PageNumber.TOTAL_PAGES, " 页"],
                    font: "仿宋",
                    size: 18,
                  }),
                ],
                alignment: AlignmentType.CENTER,
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
  console.log(`文档已生成: ${outputPath}`);
  const totalCommits = Object.values(commitsData).reduce(
    (s, a) => s + a.length,
    0
  );
  console.log(`分支数: ${Object.keys(commitsData).length}`);
  console.log(`提交总数: ${totalCommits}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
