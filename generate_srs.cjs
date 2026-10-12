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
  LevelFormat,
  convertInchesToTwip,
} = require("docx");
const fs = require("fs");

const outputPath =
  "C:\\Users\\Lenovo\\Desktop\\实训项目最终提交物_学生端\\实训项目最终提交物（线下）说明-南大软件_AI2班\\11_差点没队组\\06.项目需求说明书\\CodeSeek项目需求说明书.docx";

const borderStyle = { style: BorderStyle.SINGLE, size: 1 };

function createTable(headers, rows) {
  const headerRow = new TableRow({
    children: headers.map(
      (h) =>
        new TableCell({
          children: [
            new Paragraph({
              children: [new TextRun({ text: h, bold: true, size: 22 })],
              alignment: AlignmentType.CENTER,
            }),
          ],
          shading: { fill: "4472C4" },
          width: { size: 100 / headers.length, type: WidthType.PERCENTAGE },
        })
    ),
  });

  const dataRows = rows.map(
    (row) =>
      new TableRow({
        children: row.map(
          (cell) =>
            new TableCell({
              children: [
                new Paragraph({
                  children: [new TextRun({ text: String(cell), size: 22 })],
                  alignment: AlignmentType.CENTER,
                }),
              ],
              width: { size: 100 / headers.length, type: WidthType.PERCENTAGE },
            })
        ),
      })
  );

  return new Table({
    rows: [headerRow, ...dataRows],
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

function createHeading(text, level) {
  return new Paragraph({
    heading: level,
    children: [new TextRun({ text, bold: true })],
    spacing: { before: 240, after: 120 },
  });
}

function createParagraph(text, options = {}) {
  return new Paragraph({
    children: [new TextRun({ text, size: 22, ...options })],
    spacing: { after: 120 },
  });
}

function createBoldParagraph(label, value) {
  return new Paragraph({
    children: [
      new TextRun({ text: label, bold: true, size: 22 }),
      new TextRun({ text: value, size: 22 }),
    ],
    spacing: { after: 120 },
  });
}

async function main() {
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: "宋体", size: 24 },
        },
      },
    },
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
                    text: "CodeSeek（寻码）——基于 RAG 的智能代码库助手 需求规格说明书",
                    size: 20,
                  }),
                ],
                alignment: AlignmentType.CENTER,
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: "第 ", size: 20 }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 20 }),
                  new TextRun({ text: " 页", size: 20 }),
                ],
                alignment: AlignmentType.CENTER,
              }),
            ],
          }),
        },
        children: [
          // 封面
          new Paragraph({ spacing: { before: 2400 } }),
          new Paragraph({
            children: [
              new TextRun({
                text: "CodeSeek（寻码）",
                bold: true,
                size: 44,
              }),
            ],
            alignment: AlignmentType.CENTER,
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: "基于 RAG 的智能代码库助手",
                bold: true,
                size: 36,
              }),
            ],
            alignment: AlignmentType.CENTER,
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: "需 求 规 格 说 明 书",
                bold: true,
                size: 40,
              }),
            ],
            alignment: AlignmentType.CENTER,
            spacing: { after: 600 },
          }),
          new Paragraph({ spacing: { before: 600 } }),
          createBoldParagraph("项目名称：", "CodeSeek（寻码）——基于 RAG 的智能代码库助手"),
          createBoldParagraph("小组名称：", "差点没队组"),
          createBoldParagraph("培训师：", "李伟"),
          createBoldParagraph("方　　向：", "AI 软件工程 / 智能体开发"),
          createBoldParagraph("组　　员：", "孟炜杰、蔡字杰、张楚浛、宗子路、王苑婷"),
          createBoldParagraph("日　　期：", "2026年7月"),
          new Paragraph({ children: [], spacing: { before: 1200 } }),

          // 目录页
          new Paragraph({
            children: [new TextRun({ text: "目 录", bold: true, size: 36 })],
            alignment: AlignmentType.CENTER,
            pageBreakBefore: true,
          }),
          new Paragraph({ children: [new TextRun({ text: "1 引言", size: 22 })], tabStops: [{ type: "right", position: 9000 }] }),
          new Paragraph({ children: [new TextRun({ text: "1.1 目的", size: 22 })] }),
          new Paragraph({ children: [new TextRun({ text: "1.2 定义", size: 22 })] }),
          new Paragraph({ children: [new TextRun({ text: "1.3 参考资料", size: 22 })] }),
          new Paragraph({ children: [new TextRun({ text: "2 软件总体概述", size: 22 })] }),
          new Paragraph({ children: [new TextRun({ text: "2.1 软件标识", size: 22 })] }),
          new Paragraph({ children: [new TextRun({ text: "2.2 软件描述", size: 22 })] }),
          new Paragraph({ children: [new TextRun({ text: "2.3 用户的特点", size: 22 })] }),
          new Paragraph({ children: [new TextRun({ text: "2.4 限制与约束", size: 22 })] }),
          new Paragraph({ children: [new TextRun({ text: "3 具体需求", size: 22 })] }),
          new Paragraph({ children: [new TextRun({ text: "3.1 功能需求", size: 22 })] }),
          new Paragraph({ children: [new TextRun({ text: "3.2 性能需求", size: 22 })] }),
          new Paragraph({ children: [new TextRun({ text: "3.3 数据库需求", size: 22 })] }),
          new Paragraph({ children: [new TextRun({ text: "3.4 设计约束", size: 22 })] }),
          new Paragraph({ children: [new TextRun({ text: "3.5 属性", size: 22 })] }),
          new Paragraph({ children: [new TextRun({ text: "3.6 外部接口需求", size: 22 })] }),
          new Paragraph({ children: [new TextRun({ text: "4 数据字典", size: 22 })] }),
          new Paragraph({ children: [new TextRun({ text: "5 附录", size: 22 })] }),

          // 第1章 引言
          createHeading("1 引言", HeadingLevel.HEADING_1),
          createHeading("1.1 目的", HeadingLevel.HEADING_2),
          createParagraph(
            "本需求规格说明书（SRS）旨在定义 CodeSeek（寻码）智能代码库助手软件的总体需求，作为用户与软件开发人员之间相互了解的基础。本文档将提供系统的功能需求、性能需求、接口需求、数据需求以及设计约束等详细信息，作为软件设计、编码、测试和验收的依据。"
          ),
          createParagraph(
            "本文档的目标包括：定义软件的总体要求，明确系统的功能边界；提供性能要求、初步设计和对用户影响的信息，为软件人员进行结构设计和编码提供指导；作为软件测试和最终验收的基准。"
          ),

          createHeading("1.2 定义", HeadingLevel.HEADING_2),
          createParagraph("RAG：Retrieval-Augmented Generation，检索增强生成。一种结合信息检索与文本生成的范式，利用外部知识库增强大语言模型的生成能力。"),
          createParagraph("Harness：本项目自研的智能体调度框架，负责管理任务生命周期、状态机驱动、工具调度和预算控制。"),
          createParagraph("AST：Abstract Syntax Tree，抽象语法树。源代码的抽象语法结构的树状表现形式。"),
          createParagraph("SSE：Server-Sent Events，服务器推送事件。一种基于 HTTP 的单向实时通信技术。"),
          createParagraph("Diff：差异比较。展示两个文件之间的变更内容。"),
          createParagraph("Git：分布式版本控制系统，用于代码版本管理。"),

          createHeading("1.3 参考资料", HeadingLevel.HEADING_2),
          createParagraph("[1] CodeSeek 项目方案设计说明书，差点没队组，2026年7月"),
          createParagraph("[2] Claude Code 官方文档，https://docs.anthropic.com/claude"),
          createParagraph("[3] Tree-sitter 官方文档，https://tree-sitter.github.io/tree-sitter/"),
          createParagraph("[4] SQLite 官方文档，https://www.sqlite.org/docs.html"),

          // 第2章 软件总体概述
          createHeading("2 软件总体概述", HeadingLevel.HEADING_1),
          createHeading("2.1 软件标识", HeadingLevel.HEADING_2),
          createBoldParagraph("软件全称：", "CodeSeek（寻码）——基于 RAG 的智能代码库助手"),
          createBoldParagraph("软件缩称：", "CodeSeek"),
          createBoldParagraph("版本号：", "V1.0"),
          createBoldParagraph("开发小组：", "差点没队组"),

          createHeading("2.2 软件描述", HeadingLevel.HEADING_2),
          createHeading("2.2.1 系统属性", HeadingLevel.HEADING_3),
          createParagraph(
            "CodeSeek 是一款独立的 Web 应用系统，对标 Claude Code，为开发者提供仓库级代码理解、问题定位、代码修改和验证能力。系统采用前后端分离架构，前端为 React 单页应用，后端为 Node.js 服务，两者通过 REST API 和 SSE 事件流进行通信。"
          ),

          createHeading("2.2.2 开发背景", HeadingLevel.HEADING_3),
          createParagraph(
            "随着 AI 时代的到来，开发者对智能化编码辅助工具的需求日益增长。传统的代码编辑器和 IDE 难以应对大规模代码仓库的复杂理解和修改任务。本项目旨在打造一款基于 RAG 技术的智能代码库助手，通过自研 Agent Harness 调度框架，结合大模型的代码理解能力和工具执行能力，帮助开发者高效完成代码分析、问题定位、修改和验证工作。"
          ),

          createHeading("2.2.3 软件功能", HeadingLevel.HEADING_3),
          createParagraph(
            "CodeSeek 提供以下核心功能模块，各功能模块及其优先级如下表所示："
          ),
          createTable(
            ["序号", "功能名称", "功能需求标识", "优先级", "简要描述"],
            [
              [
                "1",
                "项目导入与索引",
                "FR-001",
                "高",
                "支持 Git 仓库/本地目录导入，自动识别语言、建立代码符号索引",
              ],
              [
                "2",
                "对话工作台",
                "FR-002",
                "高",
                "类 Claude Code 三栏布局，支持多会话切换、消息持久化",
              ],
              [
                "3",
                "仓库文件树浏览",
                "FR-003",
                "高",
                "展示导入项目文件结构，支持代码阅读、搜索与定位",
              ],
              [
                "4",
                "智能体任务执行",
                "FR-004",
                "高",
                "Harness 状态机驱动，规划→执行→验证→交付全流程",
              ],
              [
                "5",
                "代码 Diff 预览",
                "FR-005",
                "高",
                "多文件变更 Diff 展示，支持逐文件接受/拒绝/回滚",
              ],
              [
                "6",
                "代码检索与理解",
                "FR-006",
                "中",
                "基于 AST 的符号索引+语义检索，仓库级问题定位",
              ],
              [
                "7",
                "工具调用与沙箱",
                "FR-007",
                "中",
                "文件读写、搜索、命令执行等受控工具，隔离安全沙箱",
              ],
              [
                "8",
                "验证与回滚",
                "FR-008",
                "中",
                "变更后自动验证，失败可一键回滚到任意快照",
              ],
            ]
          ),
          createParagraph("优先级说明：高——必须实现；中——应该实现；低——尽量实现。"),

          createHeading("2.3 用户的特点", HeadingLevel.HEADING_2),
          createParagraph(
            "本系统的目标用户为软件开发工程师、代码审查人员和技术团队负责人。用户应具备以下特点：具有一定的编程经验，熟悉至少一种编程语言；能够使用 Git 等版本控制工具；对 AI 辅助编程有兴趣或有需求；具备基本的计算机操作能力。"
          ),

          createHeading("2.4 限制与约束", HeadingLevel.HEADING_2),
          createParagraph(
            "本系统的开发受以下约束：开发期限受实训项目周期限制，需在规定时间内完成核心功能；系统需支持 Windows、macOS、Linux 主流操作系统；开发语言限定为 TypeScript/JavaScript；需遵守项目组制定的代码规范和版本管理流程；大模型 API 调用受限于服务提供商的配额和稳定性。"
          ),

          // 第3章 具体需求
          createHeading("3 具体需求", HeadingLevel.HEADING_1),
          createHeading("3.1 功能需求", HeadingLevel.HEADING_2),
          createParagraph(
            "本节详细描述各功能模块的输入、处理和输出需求。"
          ),

          // FR-001
          createHeading("3.1.1 项目导入与索引（FR-001）", HeadingLevel.HEADING_3),
          createBoldParagraph("需求编号：", "FR-001"),
          createBoldParagraph("功能名称：", "项目导入与索引"),
          createParagraph("输入：用户提供 Git 仓库 URL 或本地源码目录路径；系统接收导入请求，校验路径有效性和访问权限。"),
          createParagraph("处理：(1) 校验源码路径、Git 信息、文件权限和项目大小；(2) 复制或挂载源码到项目工作区，生成基础快照；(3) 文件扫描器遍历项目目录，过滤 .git、构建产物、依赖缓存、二进制文件；(4) 解析模块识别文件语言，提取文件元数据、导入关系、类、函数、变量、调用关系；(5) 建立文件索引、符号索引和关系语义索引。"),
          createParagraph("输出：项目记录（含 project_id）、索引进度反馈、项目概览（技术栈、入口文件、测试目录、构建命令、高频模块）、异常文件列表。"),

          // FR-002
          createHeading("3.1.2 对话工作台（FR-002）", HeadingLevel.HEADING_3),
          createBoldParagraph("需求编号：", "FR-002"),
          createBoldParagraph("功能名称：", "对话工作台"),
          createParagraph('输入：用户输入任务描述文本，如"定位登录接口偶发 500 的原因并修复，补充单元测试"。'),
          createParagraph("处理：(1) 创建会话，加载项目概览、规则文件和会话历史摘要；(2) 用户消息以命令形式提交，后端创建 task_run；(3) Harness 进行任务前检查：工作区可写性、Git 状态、未提交变更检测；(4) 支持多会话切换和消息持久化。"),
          createParagraph("输出：会话列表、消息历史、任务状态、智能体执行过程展示。"),

          // FR-003
          createHeading("3.1.3 仓库文件树浏览（FR-003）", HeadingLevel.HEADING_3),
          createBoldParagraph("需求编号：", "FR-003"),
          createBoldParagraph("功能名称：", "仓库文件树浏览"),
          createParagraph("输入：用户点击文件树节点、搜索关键词。"),
          createParagraph("处理：(1) 展示导入项目的完整文件结构；(2) 支持代码阅读，显示行号和语法高亮；(3) 支持全文搜索和符号搜索；(4) 支持文件定位和跳转。"),
          createParagraph("输出：文件树视图、文件内容视图、搜索结果列表。"),

          // FR-004
          createHeading("3.1.4 智能体任务执行（FR-004）", HeadingLevel.HEADING_3),
          createBoldParagraph("需求编号：", "FR-004"),
          createBoldParagraph("功能名称：", "智能体任务执行"),
          createParagraph("输入：用户任务目标、项目上下文、可用工具说明。"),
          createParagraph("处理：(1) Harness 构造规划上下文，模型输出结构化执行计划（目标、假设、待调查模块、拟调用工具、修改范围、验证方式）；(2) Harness 校验计划格式、工具权限、文件范围和预算；(3) 将计划拆分为可追踪步骤；(4) 执行循环：理解→行动→观察→决策；(5) 多维度预算控制（步骤数、工具调用数、Token、时间、成本、文件数）。"),
          createParagraph("输出：执行计划、当前步骤、工具调用日志、状态变更事件流。"),

          // FR-005
          createHeading("3.1.5 代码 Diff 预览（FR-005）", HeadingLevel.HEADING_3),
          createBoldParagraph("需求编号：", "FR-005"),
          createBoldParagraph("功能名称：", "代码 Diff 预览"),
          createParagraph("输入：智能体生成的文件变更列表。"),
          createParagraph("处理：(1) 多文件变更 Diff 展示，支持逐文件查看；(2) 支持接受变更、拒绝变更、撤销决定；(3) 支持批量操作；(4) 显示文件变更统计（增删改行数）。"),
          createParagraph("输出：Diff 视图、变更统计、操作确认对话框。"),

          // FR-006
          createHeading("3.1.6 代码检索与理解（FR-006）", HeadingLevel.HEADING_3),
          createBoldParagraph("需求编号：", "FR-006"),
          createBoldParagraph("功能名称：", "代码检索与理解"),
          createParagraph("输入：自然语言查询、代码符号名、关键词。"),
          createParagraph("处理：(1) 基于 Tree-sitter 的 AST 解析，提取类、函数、方法、接口、变量；(2) 建立符号索引，支持定义位置查询；(3) 追踪调用关系和引用关系；(4) 支持文本搜索和语义搜索。"),
          createParagraph("输出：符号定义位置、调用链、引用列表、搜索结果排名。"),

          // FR-007
          createHeading("3.1.7 工具调用与沙箱（FR-007）", HeadingLevel.HEADING_3),
          createBoldParagraph("需求编号：", "FR-007"),
          createBoldParagraph("功能名称：", "工具调用与沙箱"),
          createParagraph("输入：工具调用请求（含工具类型、参数）。"),
          createParagraph("处理：(1) 将文件、搜索、AST、命令和测试能力封装成受控工具；(2) 8 个核心工具：list_files、read_file、write_file、apply_patch、search_text、git_status、git_diff、run_command；(3) 所有修改在隔离的任务工作区进行，原始目录只读；(4) 文件写入使用哈希验证防止并发冲突；(5) 命令执行采用白名单控制。"),
          createParagraph("输出：工具执行结果、操作日志、错误信息。"),

          // FR-008
          createHeading("3.1.8 验证与回滚（FR-008）", HeadingLevel.HEADING_3),
          createBoldParagraph("需求编号：", "FR-008"),
          createBoldParagraph("功能名称：", "验证与回滚"),
          createParagraph("输入：用户的验证/回滚请求。"),
          createParagraph("处理：(1) 变更完成后自动运行验证（如单元测试、语法检查）；(2) 快照机制：基线、检查点、最终快照；(3) 支持任意时间点回滚；(4) 变更应用与回滚操作。"),
          createParagraph("输出：验证结果、快照列表、回滚确认。"),

          createHeading("3.2 性能需求", HeadingLevel.HEADING_2),
          createParagraph(
            "系统应满足以下性能要求：支持单个项目索引不少于 5000 个源文件；代码索引完成时间不超过 30 秒（5000 文件规模）；对话响应时间（首 Token）不超过 3 秒；文件搜索响应时间不超过 1 秒；Diff 生成时间不超过 2 秒（单文件）；支持至少 5 个并发会话。"
          ),

          createHeading("3.3 数据库需求", HeadingLevel.HEADING_2),
          createParagraph(
            "系统使用 SQLite 嵌入式数据库存储结构化数据，文件系统存储工作区文件和快照。主要数据实体包括：项目（projects）、会话（sessions）、消息（messages）、任务（tasks）、任务运行（task_runs）、任务步骤（task_steps）、工具调用（tool_calls）、文件变更（file_changes）、验证记录（verifications）、快照（snapshots）、代码文件（code_files）、代码符号（code_symbols）等。"
          ),

          createHeading("3.4 设计约束", HeadingLevel.HEADING_2),
          createHeading("3.4.1 标准约束", HeadingLevel.HEADING_3),
          createParagraph(
            "系统需遵守以下标准和规范：RESTful API 设计规范；JSON 数据交换格式规范；代码提交规范（Git Flow）；TypeScript 编码规范（ESLint）；组件化开发规范。"
          ),
          createHeading("3.4.2 硬件约束", HeadingLevel.HEADING_3),
          createParagraph(
            "开发环境：CPU Intel i5 及以上，内存 16GB+，硬盘 256GB SSD。运行环境：CPU Intel i3 及以上，内存 8GB+，硬盘 100GB+。"
          ),

          createHeading("3.5 属性", HeadingLevel.HEADING_2),
          createHeading("3.5.1 可用性", HeadingLevel.HEADING_3),
          createParagraph("系统应保证 99% 的可用率；支持断点恢复，任务中断后可继续执行；提供清晰的错误提示和恢复引导。"),
          createHeading("3.5.2 可靠性", HeadingLevel.HEADING_3),
          createParagraph("系统应在规定条件下稳定运行；工具失败自动重试（最多 3 次）；连续失败自动暂停任务并通知用户；所有操作有审计日志。"),
          createHeading("3.5.3 效率", HeadingLevel.HEADING_3),
          createParagraph("系统应高效利用 CPU 和内存资源；索引过程采用增量处理避免重复计算；响应式设计适配不同性能的设备。"),
          createHeading("3.5.4 安全性", HeadingLevel.HEADING_3),
          createParagraph("所有文件修改在隔离沙箱中进行；文件写入使用乐观锁防止并发冲突；命令执行采用白名单控制；完整审计追踪记录所有操作；敏感信息不记录到日志中。"),
          createHeading("3.5.5 可维护性", HeadingLevel.HEADING_3),
          createParagraph("代码遵循模块化设计原则；单元测试覆盖率不低于 80%；提供完整的 API 文档和架构文档；支持通过配置文件调整系统行为。"),
          createHeading("3.5.6 可移植性", HeadingLevel.HEADING_3),
          createParagraph("支持 Windows 10+、macOS 12+、Linux（主流发行版）；支持 Chrome、Edge、Firefox 等主流浏览器；数据持久化采用标准 SQLite 格式。"),

          createHeading("3.6 外部接口需求", HeadingLevel.HEADING_2),
          createHeading("3.6.1 用户接口", HeadingLevel.HEADING_3),
          createParagraph("系统提供基于 Web 的图形用户界面：三栏布局工作台（文件树、对话、工作区）；支持键盘快捷键操作；响应式设计适配不同分辨率；深色/浅色主题支持。"),
          createHeading("3.6.2 硬件接口", HeadingLevel.HEADING_3),
          createParagraph("系统无特殊硬件接口需求，仅需标准网络连接（用于调用大模型 API）。"),
          createHeading("3.6.3 软件接口", HeadingLevel.HEADING_3),
          createParagraph("Node.js 22+ 运行时；React 18+ 前端框架；Fastify 后端框架；SQLite 数据库；Tree-sitter 解析器；大模型 API（DeepSeek 等）。"),
          createHeading("3.6.4 通信接口", HeadingLevel.HEADING_3),
          createParagraph("前后端通信：HTTP REST API（/api/v1/*）；实时事件推送：Server-Sent Events（/api/v1/tasks/:id/events）；大模型通信：HTTPS API 调用。"),

          // 第4章 数据字典
          createHeading("4 数据字典", HeadingLevel.HEADING_1),
          createTable(
            ["数据实体", "数据项", "类型", "说明"],
            [
              ["projects", "id", "string", "项目唯一标识，UUID"],
              ["projects", "name", "string", "项目名称"],
              ["projects", "source_path", "string", "源码路径"],
              ["projects", "language", "string", "主要编程语言"],
              ["sessions", "id", "string", "会话唯一标识，UUID"],
              ["sessions", "project_id", "string", "关联项目 ID"],
              ["sessions", "title", "string", "会话标题"],
              ["messages", "id", "string", "消息唯一标识，UUID"],
              ["messages", "session_id", "string", "关联会话 ID"],
              ["messages", "role", "string", "角色（user/assistant/system）"],
              ["messages", "content", "text", "消息内容"],
              ["tasks", "id", "string", "任务唯一标识，UUID"],
              ["tasks", "session_id", "string", "关联会话 ID"],
              ["tasks", "goal", "text", "任务目标描述"],
              ["tasks", "status", "string", "状态（CREATED/PLANNING/EXECUTING/...）"],
              ["task_steps", "id", "string", "步骤唯一标识，UUID"],
              ["task_steps", "task_id", "string", "关联任务 ID"],
              ["task_steps", "description", "text", "步骤描述"],
              ["file_changes", "id", "string", "变更唯一标识，UUID"],
              ["file_changes", "file_path", "string", "变更文件路径"],
              ["file_changes", "diff", "text", "Diff 内容"],
              ["snapshots", "id", "string", "快照唯一标识，UUID"],
              ["snapshots", "task_id", "string", "关联任务 ID"],
              ["snapshots", "type", "string", "类型（BASELINE/CHECKPOINT/FINAL）"],
              ["code_symbols", "id", "string", "符号唯一标识，UUID"],
              ["code_symbols", "file_path", "string", "定义文件路径"],
              ["code_symbols", "name", "string", "符号名称"],
              ["code_symbols", "kind", "string", "类型（class/function/method/variable）"],
            ]
          ),

          // 第5章 附录
          createHeading("5 附录", HeadingLevel.HEADING_1),
          createHeading("附录 A 功能模块与负责人", HeadingLevel.HEADING_2),
          createTable(
            ["功能模块", "负责人", "说明"],
            [
              ["项目导入与索引", "孟炜杰", "FR-001 项目导入、FR-006 代码检索"],
              ["对话工作台", "蔡字杰", "FR-002 前端三栏布局、会话管理"],
              ["仓库文件树浏览", "张楚浛", "FR-003 文件树、FR-007 工具沙箱"],
              ["智能体任务执行", "宗子路", "FR-004 Harness 核心、状态机调度"],
              ["代码 Diff 预览", "王苑婷", "FR-005 Diff 预览、FR-008 验证回滚"],
            ]
          ),
          createHeading("附录 B 技术栈", HeadingLevel.HEADING_2),
          createTable(
            ["分类", "技术名称", "版本", "用途"],
            [
              ["前端框架", "React", "18.x", "用户界面开发"],
              ["前端构建", "Vite", "5.x", "项目构建与热更新"],
              ["状态管理", "Zustand", "4.x", "前端状态管理"],
              ["后端框架", "Fastify", "4.x", "API 服务框架"],
              ["数据库", "SQLite", "3.x", "嵌入式数据存储"],
              ["AST 解析", "Tree-sitter", "0.20.x", "代码语法解析"],
              ["语言运行时", "Node.js", "22.x", "后端运行环境"],
              ["开发语言", "TypeScript", "5.x", "全栈开发语言"],
              ["包管理", "npm", "10.x", "依赖管理"],
              ["版本控制", "Git", "2.x", "代码版本管理"],
            ]
          ),
          createHeading("附录 C 术语表", HeadingLevel.HEADING_2),
          createTable(
            ["术语", "全称", "说明"],
            [
              ["RAG", "Retrieval-Augmented Generation", "检索增强生成"],
              ["Harness", "Agent Harness", "智能体调度框架"],
              ["AST", "Abstract Syntax Tree", "抽象语法树"],
              ["SSE", "Server-Sent Events", "服务器推送事件"],
              ["Diff", "Difference", "差异比较"],
              ["API", "Application Programming Interface", "应用程序接口"],
              ["SPA", "Single Page Application", "单页应用"],
              ["REST", "Representational State Transfer", "表述性状态转移"],
            ]
          ),
          createHeading("附录 D 需求规格说明书确认协议", HeadingLevel.HEADING_2),
          createParagraph(
            "在培训师的大力配合与支持下，差点没队组制作了该《需求规格说明书》。培训师对该《需求规格说明书》经过详细审核，已确认该《需求规格说明书》中的各项内容翔实全面。经过双方友好协商，达成如下协议："
          ),
          createParagraph("1. 该《需求规格说明书》是实训项目的指导文件，与实训要求具有同等的指导意义；"),
          createParagraph("2. 该《需求规格说明书》是项目最终验收的唯一标准；"),
          createParagraph("3. 在项目验收前可提出对该《需求规格说明书》中的内容进行变更（包括增加、修改、删除），双方应就此签署补充确认；"),
          createParagraph("4. 项目组同意根据该《需求规格说明书》进行系统开发；"),
          createParagraph("5. 本协议自双方确认之日起生效。"),
          createParagraph(""),
          createParagraph("培训师（签字）：_______________________　　日期：______________"),
          createParagraph("项目组长（签字）：_____________________　　日期：______________"),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
  console.log(`文档已生成: ${outputPath}`);
}

main().catch(console.error);