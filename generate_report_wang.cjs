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

const outputPath =
  "C:\\Users\\Lenovo\\Desktop\\实训项目最终提交物_学生端\\实训项目最终提交物（线下）说明-南大软件_AI2班\\11_差点没队组\\04.实训报告\\24118xx_王苑婷_中软国际_企业实训报告.docx";

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

function createCenterText(text, options = {}) {
  return new Paragraph({
    children: [new TextRun({ text, font: "仿宋", size: 24, ...options })],
    alignment: AlignmentType.CENTER,
    spacing: { after: 120, line: 360 },
  });
}

function createCoverLine(label, value) {
  return new Paragraph({
    children: [
      new TextRun({ text: label, font: "仿宋", size: 24 }),
      new TextRun({ text: value, font: "仿宋", size: 24 }),
    ],
    spacing: { after: 200, line: 360 },
  });
}

async function main() {
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
        children: [
          // 封面
          new Paragraph({ spacing: { before: 1200 } }),
          new Paragraph({
            children: [new TextRun({ text: "南开大学本科实习报告", bold: true, font: "黑体", size: 44 })],
            alignment: AlignmentType.CENTER,
            spacing: { after: 600 },
          }),
          new Paragraph({ spacing: { before: 800 } }),
          createCoverLine("学　号：", "24118xx"),
          createCoverLine("姓　名：", "王苑婷"),
          createCoverLine("年　级：", "2024级"),
          createCoverLine("专　业：", "软件工程"),
          createCoverLine("所属院（系）：", "软件学院"),
          createCoverLine("实习课程名称：", "基于 RAG 的智能代码库助手"),
          createCoverLine("指导教师：", "李伟"),
          new Paragraph({ spacing: { before: 800 } }),
          createCenterText("2026年7月30日", { size: 24 }),
          new Paragraph({ children: [], pageBreakBefore: true }),

          // 说明页
          new Paragraph({
            children: [new TextRun({ text: "说　明", bold: true, font: "黑体", size: 28 })],
            alignment: AlignmentType.CENTER,
            spacing: { after: 300 },
          }),
          new Paragraph({
            children: [new TextRun({ text: "一、《实习报告》内容提纲", bold: true, font: "黑体", size: 24 })],
            spacing: { after: 120, line: 360 },
          }),
          createParagraph("1. 实习目的和要求"),
          createParagraph("2. 实习时间、地点"),
          createParagraph("3. 实习单位和部门"),
          createParagraph("4. 实习内容：要求字数不低于3000字"),
          createParagraph("5. 实习总结：收获、体会以及实习建议等"),
          new Paragraph({ spacing: { before: 200 } }),
          new Paragraph({
            children: [new TextRun({ text: "二、书写要求", bold: true, font: "黑体", size: 24 })],
            spacing: { after: 120, line: 360 },
          }),
          createParagraph("字体为仿宋，小四号，标题加黑，1.5倍行距。"),
          new Paragraph({ spacing: { before: 200 } }),
          new Paragraph({
            children: [new TextRun({ text: "三、材料规格", bold: true, font: "黑体", size: 24 })],
            spacing: { after: 120, line: 360 },
          }),
          createParagraph("用A4纸双面打印，左侧装订。"),
          new Paragraph({ children: [], pageBreakBefore: true }),

          // 正文标题
          new Paragraph({
            children: [new TextRun({ text: "企业实训报告", bold: true, font: "黑体", size: 36 })],
            alignment: AlignmentType.CENTER,
            spacing: { after: 300 },
          }),
          new Paragraph({
            children: [new TextRun({ text: "基于 RAG 的智能代码库助手", bold: true, font: "黑体", size: 32 })],
            alignment: AlignmentType.CENTER,
            spacing: { after: 400 },
          }),

          // 一、实习目的和要求
          createHeading("一、实习目的和要求", HeadingLevel.HEADING_1),
          createSubHeading("（一）实习目的"),
          createParagraph(`本次企业实训以人工智能应用工程为主线，围绕"基于 RAG 的智能代码库助手（CodeSeek）"开展项目实践。实训的主要目的，是把课堂中学习的软件工程、数据处理、大语言模型应用、检索增强生成（RAG）和团队协作知识，转化为可以运行、可以验证、可以持续改进的工程方案。通过将代码 Diff 预览、变更验证、版本回滚等核心功能组织为可靠的工程模块，我希望深入理解智能体调度框架中的变更管理、状态同步和安全交付机制。`),
          createParagraph(`代码智能体的价值不仅在于生成代码，更在于确保每一次变更都是可审阅、可验证、可回滚的。真正可靠的代码修改能力需要回答"改了什么、改得对不对、能不能撤销、如何确认"等问题。因此，本次实训还要求我建立变更意识和质量意识：一方面通过结构化 Diff 清晰展示每次修改的差异，另一方面通过自动化验证确保变更的正确性，同时提供便捷的回滚机制保障代码安全。`),
          createParagraph(`本次实训的目标包括：独立完成代码 Diff 预览模块的前端交互与后端协议设计，实现多文件变更的可视化展示与批量操作；设计变更验证与回滚机制，确保智能体生成的代码修改经过自动测试与安全检查；参与团队协作，明确模块边界与接口契约，从"完成代码"转向"交付可验证的功能"。`),

          createSubHeading("（二）实习要求"),
          createParagraph("实训过程中需要遵守中软国际教育科技股份有限公司 AI 开发中心的项目规范，按阶段完成需求梳理、方案设计、模块实现、测试验证、文档沉淀和成果汇报。具体要求包括：理解代码 Diff 的生成协议与展示规范，确保 Diff 信息准确、完整、易读；建立变更的版本追踪与状态管理机制，支持接受、拒绝、撤销等操作；对变更结果进行自动化验证，包括语法检查、单元测试和集成测试；采用快照机制支持任意时间点的回滚操作；使用版本管理工具记录变更，并在团队协作中及时同步接口和风险。"),

          // 二、实习时间、地点
          createHeading("二、实习时间、地点", HeadingLevel.HEADING_1),
          createParagraph("本次实训时间为 2026 年 7 月 6 日至 2026 年 7 月 31 日，实训地点为综合实验楼 A315 教室。实训期间按照项目计划推进开发任务，结合阶段性目标开展需求理解、设计实现、测试验证和总结复盘。前两周主要完成项目整体架构设计、技术选型和基础环境搭建；第三周围绕代码 Diff 预览与验证回滚模块进行核心功能开发；第四周重点进行联调测试、问题修正、文档整理和成果汇报。报告整理时间为 2026 年 7 月 30 日，重点记录已完成的模块设计、核心实现、测试场景和协作流程。"),

          // 三、实习单位和部门
          createHeading("三、实习单位和部门", HeadingLevel.HEADING_1),
          createParagraph(`实习单位为中软国际教育科技股份有限公司，实习部门为 AI 开发中心。中软国际教育科技集团长期开展软件工程、人工智能应用和企业级项目实训，本次实训采用企业项目化方式组织，由指导人员提出业务主题、交付要求和阶段节点，学生围绕实际软件开发流程完成任务。AI 开发中心的训练重点不仅包括模型调用，还强调需求边界、数据质量、接口契约、异常处理、测试覆盖、文档规范和团队协作，使我能够从"完成一段代码"进一步转向"交付一个可验证的功能模块"。`),

          // 四、实习内容
          createHeading("四、实习内容", HeadingLevel.HEADING_1),

          createSubHeading("（一）项目背景与总体架构"),
          createParagraph("CodeSeek（寻码）是一款对标 Claude Code 的代码库智能助手，基于自研 Agent Harness 智能体调度框架，为开发者提供仓库级代码理解、问题定位、代码修改和验证能力。产品支持导入完整 Git 代码仓库或本地源码目录，建立可检索的代码知识索引；用户通过类似 Claude 的对话界面提出任务，智能体可以跨文件阅读和修改代码，并将所有变更以 Diff 形式展示给用户。"),
          createParagraph("系统采用前后端分离架构。前端为 React 单页应用，负责项目导入、会话管理、文件树浏览、Diff 展示等交互；后端为 Node.js 服务，通过 Harness 状态机驱动智能体执行循环，管理任务生命周期、上下文、工具权限和预算控制。后端内部划分为四个能力模块：Harness 核心负责状态机与任务循环，代码解析与索引负责 AST 解析与符号检索，模型网关负责大模型调用与流式输出，工具执行层负责文件读写、搜索、命令执行等受控操作。"),

          createSubHeading("（二）我的分工与负责模块"),
          createParagraph("在本次项目中，我负责两个核心模块：代码 Diff 预览（FR-005）和验证与回滚（FR-008）。这两个模块共同构成了智能体变更交付的最后一公里——当智能体完成代码修改后，Diff 模块负责将变更以清晰、安全的方式呈现给用户，验证回滚模块负责确保变更的正确性并提供撤销能力。"),
          createParagraph(`代码 Diff 预览模块的核心目标是让用户能够清晰看到智能体做了哪些修改，并方便地进行接受、拒绝或部分采纳操作。验证与回滚模块的核心目标是确保每次变更都经过自动化验证，且在发现问题时能够快速恢复到之前的状态。这两个模块的设计理念是"安全第一、透明可追溯、操作便捷"。`),

          createSubHeading("（三）代码 Diff 预览模块设计与实现"),
          createParagraph("代码 Diff 预览模块需要解决的核心问题包括：如何清晰展示多文件变更、如何支持逐文件/逐块操作、如何高效生成 Diff 数据、如何处理大文件和大量变更。通过调研主流 Diff 展示方案（如 Monaco Diff、React Diff Viewer 等），我确定了模块的整体设计方案。"),
          createParagraph("在后端协议层，我设计了结构化的 Diff 数据格式。每次变更记录包含文件路径、变更类型（新增/修改/删除）、Diff 内容（基于行的标准 Diff 格式）、变更统计（增加行数、删除行数、修改行数）和变更元数据（修改时间、操作来源、关联任务 ID）。Diff 采用统一的 UDiff 协议格式生成，确保前端和后端使用一致的差异表示方式。"),
          createParagraph("在前端展示层，我设计了三栏 Diff 视图：左侧显示原始文件内容（标记删除行），右侧显示修改后文件内容（标记新增行），中间用颜色区分变更类型（绿色新增、红色删除、蓝色修改）。支持的交互操作包括：逐文件接受变更、逐文件拒绝变更、批量接受所有变更、批量拒绝所有变更、单行级别的接受/拒绝、变更统计查看。对于大量文件变更，支持按变更类型过滤（仅查看新增、仅查看修改、仅查看删除）和按文件路径搜索。"),
          createParagraph("在实现过程中，我使用了 React Diff Viewer 组件作为基础，封装了项目特定的交互逻辑。Diff 数据通过 SSE 事件流从后端实时推送到前端，当智能体生成新的变更时，前端无需刷新即可更新 Diff 视图。对于大型 Diff 的渲染性能问题，采用了虚拟滚动和分段渲染策略，确保在数千行变更时仍保持流畅的交互体验。"),

          createSubHeading("（四）验证与回滚模块设计与实现"),
          createParagraph("验证与回滚模块是代码安全交付的保障机制。当智能体完成代码修改后，系统会自动触发验证流程，检查变更的正确性和安全性。验证流程包括语法检查、单元测试执行、依赖分析和变更影响评估。"),
          createParagraph(`在语法检查方面，系统针对不同语言使用对应的解析器（JavaScript/TypeScript 使用 @babel/parser，Python 使用 ast.parse 等）对修改后的文件进行语法验证。如果语法检查失败，系统会在 Diff 视图中标记该文件为"验证失败"，并显示具体的错误信息。`),
          createParagraph("在单元测试执行方面，系统支持根据项目配置自动运行相关测试。对于前端项目，可执行 npm test 或 vitest 命令；对于后端项目，可执行对应的测试框架命令。测试结果以结构化形式返回，包括通过的测试数、失败的测试数和错误详情。如果测试失败，系统会提供查看失败详情的入口。"),
          createParagraph("在快照与回滚机制方面，我设计了三级快照体系：基线快照（项目初始状态）、检查点快照（每次验证通过后的状态）和最终快照（用户接受变更后的状态）。每个快照保存了所有已修改文件的完整内容和索引。当用户需要回滚时，可以选择回滚到任意快照点，系统会自动恢复对应版本的文件内容。回滚操作本身也会生成新的快照，确保回滚的可追溯性。"),
          createParagraph("在文件写入的安全性方面，系统实现了乐观锁机制。每次写入文件前，系统会读取文件的当前哈希值，写入时验证哈希是否匹配。如果哈希不匹配（说明文件在此期间被其他操作修改），系统会拒绝写入并通知用户，防止并发修改导致的数据丢失。"),

          createSubHeading("（五）开发过程与协作实践"),
          createParagraph(`实训第一阶段主要完成业务理解和需求拆解。我阅读 Claude Code 的 Diff 展示方案，分析现有代码 Diff 工具的优缺点，梳理代码变更交付的完整流程，并将笼统的"展示代码修改"需求拆分为可验证的功能点。该阶段重点确定 Diff 数据格式、变更状态机、操作流程和异常场景，同时明确哪些操作是原子性的（如单文件接受），哪些操作需要事务性保障（如批量回滚）。`),
          createParagraph("第二阶段完成 Diff 协议设计和核心组件开发。我与后端负责人宗子路协商 Diff 数据结构和事件推送协议，确保前后端使用一致的格式。我设计了变更状态机（待确认→已接受/已拒绝→已应用），定义了各状态间的转换条件和触发事件。同时，我开始开发 Diff 前端组件，包括 Diff 视图渲染、交互操作处理和状态管理。"),
          createParagraph("第三阶段围绕验证回滚机制进行深入开发。我实现了语法检查适配器，支持多种编程语言的语法验证；设计了快照管理器，实现三级快照的创建、查询和回滚功能；开发了文件写入的乐观锁机制，防止并发冲突。同时，我开始编写自动化测试用例，覆盖正常路径、异常路径和边界条件。"),
          createParagraph("第四阶段重点完善联调测试、文档和演示准备。截至报告整理日，已经完成 Diff 预览模块的核心功能开发、验证回滚模块的快照机制和语法检查、以及前后端协议联调。后续收尾工作包括完善单元测试覆盖、优化大 Diff 渲染性能、补充文档和准备演示数据。"),

          createSubHeading("（六）遇到的问题及解决方法"),
          createParagraph("第一个问题是 Diff 数据格式的统一性。不同 Diff 生成工具产生的格式不一致，有的是基于行的，有的是基于字符的。解决思路是定义项目级的 Diff 协议规范，统一采用基于行的 UDiff 格式，并在后端提供 Diff 生成的统一入口。这样，无论底层使用什么 Diff 算法，前端都能以一致的方式渲染和交互。"),
          createParagraph("第二个问题是大 Diff 的渲染性能。当变更文件数超过 20 个或单个文件变更行数超过 500 行时，Diff 视图渲染明显卡顿。解决思路是采用虚拟滚动渲染只可见区域的 Diff 行，对大型 Diff 进行分段加载，并在 Diff 统计信息可用时优先展示摘要而非完整 Diff。此外，对 Diff 操作采用防抖处理，避免频繁的状态更新导致的重渲染。"),
          createParagraph("第三个问题是验证流程的自动化与可靠性。不同项目的测试命令、依赖和环境配置各不相同，统一的验证框架难以覆盖所有场景。解决思路是设计可配置的验证管线，允许每个项目通过配置文件指定语言类型、构建命令、测试命令和语法检查方式。同时，将验证过程拆分为多个可独立执行的步骤，某一步骤失败不影响其他步骤的执行。"),
          createParagraph("第四个问题是回滚操作的安全性。批量回滚涉及多文件操作，如果中途失败可能导致部分文件被回滚、部分未回滚的不一致状态。解决思路是实现事务性回滚：所有文件的回滚操作要么全部成功，要么全部回退。系统在执行回滚前会预检查所有目标文件的可写性和快照完整性，确保回滚操作的原子性。"),

          createSubHeading("（七）质量保障与安全考虑"),
          createParagraph("代码 Diff 预览与验证回滚模块直接关系到代码安全交付，因此质量保障尤为重要。我采用了以下质量保障措施：一是在模块边界处进行输入校验，确保 Diff 数据格式正确、变更状态合法；二是对关键操作（批量接受、批量回滚）进行二次确认，防止误操作；三是实现完整的操作审计日志，记录每次变更的操作人、操作时间、操作类型和操作结果，便于问题追溯和责任界定。"),
          createParagraph("在安全方面，所有代码修改都在隔离的任务工作区中进行，原始代码仓库保持只读访问。文件写入使用乐观锁机制，防止并发修改冲突。命令执行采用白名单控制，只允许预定义的安全命令。敏感信息（如 API 密钥）不记录到日志中。导出的变更报告保留数据时间戳和来源说明，防止旧变更被误当作新状态。"),

          // 五、实习总结
          createHeading("五、实习总结", HeadingLevel.HEADING_1),

          createSubHeading("（一）主要收获与体会"),
          createParagraph(`通过本次实训，我对代码智能体的安全交付形成了更完整的认识。智能体的代码生成能力只是系统的一部分，真正决定产品可靠性的还有变更的可视化呈现、自动化验证、版本回滚和安全机制。Diff 预览不仅仅是"展示差异"，更是让用户理解智能体行为、建立信任感的关键环节。验证回滚不仅仅是"测试代码"，更是保障代码质量、控制交付风险的核心机制。`),
          createParagraph(`我在接口设计、状态管理和用户体验方面获得了明显提升。过去做前端开发时容易关注界面样式和交互流畅度，本次实训让我更加重视数据协议的一致性、状态机的完备性和操作的可逆性。通过定义 Diff 协议、变更状态机和快照机制，我体会到"先定义接口再编码"的工程方法的重要性。通过编写测试用例和处理异常场景，我认识到边界条件和错误处理不是事后补充，而是系统设计的一部分。`),
          createParagraph("团队协作方面，我进一步掌握了模块划分、接口同步和版本管理的方法。与后端负责人协商 Diff 协议时，我学会了如何用结构化文档表达接口约定；与前端负责人协作时，我体会到统一组件库和状态管理方案的重要性。遇到环境、权限或分支问题时，我学会了先定位问题范围、再选择解决方案的思路。及时记录问题和处理结果，既有利于自己复盘，也能帮助团队成员避免重复踩坑。"),

          createSubHeading("（二）不足与改进方向"),
          createParagraph("当前 Diff 预览模块仍有不足。首先，对于非常复杂的 Diff（如重构导致的大量行变更），展示效果仍有待优化，可能需要引入更智能的 Diff 折叠和分组策略；其次，Diff 的字符级高亮还需要进一步优化，目前主要是基于行的 Diff，对于细微变更的定位还不够精确；再次，Diff 与验证结果的联动还可以更紧密，理想状态是用户在 Diff 视图中就能看到每个文件的验证状态。"),
          createParagraph("验证回滚模块的改进方向包括：支持更多语言的语法检查和静态分析，目前主要覆盖 JavaScript/TypeScript 和 Python；增加增量回滚能力，允许用户只回滚部分变更；引入更丰富的验证策略，如代码规范检查、依赖一致性检查和安全漏洞扫描。此外，快照的存储空间管理也需要优化，目前每个快照保存完整文件副本，对于大项目可能占用较多空间，后续可以考虑增量快照。"),
          createParagraph("对实训组织的建议是，在项目开始阶段提供更明确的接口契约和验收标准示例，减少模块间的沟通成本；中期可以增加跨模块联调的时间，让不同模块的负责人尽早集成；结项时除展示最终效果外，也建议评价问题记录、测试覆盖和协作过程，鼓励形成完整的工程意识。"),

          createSubHeading("（三）后续计划"),
          createParagraph("在实训剩余时间内，我将按计划完成最终联调、问题修正、文档归档和成果汇报。实训结束后，希望继续完善 Diff 预览的交互体验，引入更智能的 Diff 折叠和高亮策略；增强验证模块的自动化能力，支持更多语言和框架的验证；优化快照存储效率，支持增量快照和压缩存储。通过持续实践，进一步提高代码智能体的安全交付能力，为后续课程学习和项目开发打下基础。"),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
  console.log(`文档已生成: ${outputPath}`);
}

main().catch(console.error);