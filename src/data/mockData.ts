import type { WorkspaceSnapshot } from "../types";

const appSource = `import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/app.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing root element");
}

createRoot(root).render(<App />);
`;

const harnessSource = `export async function runTask(goal: string) {
  const plan = await planner.create(goal);
  const workspace = await snapshots.create();

  for (const step of plan.steps) {
    const observation = await tools.execute(step);
    await events.publish(observation);
  }

  return snapshots.diff(workspace);
}
`;

const loginSource = `import { getSession } from "../session";
import { json } from "../response";

export async function login(request: Request) {
  const body = await request.json();
  const session = await getSession(body.token);

  if (!session) {
    return json({ error: "Invalid session" }, 401);
  }

  return json({ user: session.user });
}
`;

export const initialSnapshot: WorkspaceSnapshot = {
  projects: [
    {
      id: "project-codeharness",
      name: "CodeHarness",
      path: "C:/Users/demo/projects/CodeHarness",
      branch: "feature/frontend-workbench",
      language: "TypeScript",
      indexedFiles: 148,
      lastOpened: "刚刚",
    },
    {
      id: "project-payments",
      name: "payments-service",
      path: "C:/Users/demo/projects/payments-service",
      branch: "main",
      language: "Python",
      indexedFiles: 92,
      lastOpened: "昨天",
    },
  ],
  activeProjectId: "project-codeharness",
  sessions: [
    {
      id: "session-login",
      title: "修复登录接口偶发 500",
      preview: "已定位会话校验中的空值问题，正在验证补丁。",
      updatedAt: "2 分钟前",
      status: "running",
      unread: true,
    },
    {
      id: "session-index",
      title: "梳理索引模块调用链",
      preview: "完成了 scanner 到 symbol store 的调用关系说明。",
      updatedAt: "昨天",
      status: "completed",
    },
    {
      id: "session-tests",
      title: "补充工作区回滚测试",
      preview: "新增 6 个场景，全部通过。",
      updatedAt: "周一",
      status: "completed",
    },
  ],
  activeSessionId: "session-login",
  messages: {
    "session-login": [
      {
        id: "m1",
        role: "user",
        content: "定位登录接口偶发 500 的原因并修复，补充相关测试。",
        createdAt: "10:24",
      },
      {
        id: "m2",
        role: "assistant",
        content:
          "我会先沿着登录入口检查会话读取与异常处理，再以最小改动修复并执行定向测试。目前已确认异常来自 session 为空时仍访问 user 字段。",
        createdAt: "10:25",
      },
    ],
    "session-index": [
      {
        id: "m3",
        role: "user",
        content: "帮我梳理索引构建流程。",
        createdAt: "昨天",
      },
      {
        id: "m4",
        role: "assistant",
        content:
          "索引从文件扫描开始，经过语言识别、符号提取和关系持久化，最后生成项目概览。",
        createdAt: "昨天",
      },
    ],
    "session-tests": [
      {
        id: "m5",
        role: "user",
        content: "给工作区快照增加回滚测试。",
        createdAt: "周一",
      },
      {
        id: "m6",
        role: "assistant",
        content: "已覆盖无变更、单文件、多文件、冲突、重复回滚和审计记录场景。",
        createdAt: "周一",
      },
    ],
  },
  fileTree: [
    {
      id: "folder-src",
      name: "src",
      path: "src",
      type: "folder",
      children: [
        {
          id: "folder-app",
          name: "app",
          path: "src/app",
          type: "folder",
          children: [
            {
              id: "file-app",
              name: "App.tsx",
              path: "src/app/App.tsx",
              type: "file",
              language: "typescript",
            },
            {
              id: "file-main",
              name: "main.tsx",
              path: "src/app/main.tsx",
              type: "file",
              language: "typescript",
            },
          ],
        },
        {
          id: "folder-api",
          name: "api",
          path: "src/api",
          type: "folder",
          children: [
            {
              id: "file-login",
              name: "login.ts",
              path: "src/api/login.ts",
              type: "file",
              language: "typescript",
              status: "modified",
            },
            {
              id: "file-session",
              name: "session.ts",
              path: "src/api/session.ts",
              type: "file",
              language: "typescript",
            },
          ],
        },
        {
          id: "folder-harness",
          name: "harness",
          path: "src/harness",
          type: "folder",
          children: [
            {
              id: "file-runner",
              name: "runner.ts",
              path: "src/harness/runner.ts",
              type: "file",
              language: "typescript",
            },
            {
              id: "file-tools",
              name: "tools.ts",
              path: "src/harness/tools.ts",
              type: "file",
              language: "typescript",
            },
          ],
        },
        {
          id: "file-types",
          name: "types.ts",
          path: "src/types.ts",
          type: "file",
          language: "typescript",
        },
      ],
    },
    {
      id: "folder-tests",
      name: "tests",
      path: "tests",
      type: "folder",
      children: [
        {
          id: "file-login-test",
          name: "login.test.ts",
          path: "tests/login.test.ts",
          type: "file",
          language: "typescript",
          status: "added",
        },
      ],
    },
    {
      id: "file-readme",
      name: "README.md",
      path: "README.md",
      type: "file",
      language: "markdown",
    },
    {
      id: "file-package",
      name: "package.json",
      path: "package.json",
      type: "file",
      language: "json",
    },
  ],
  files: {
    "src/app/App.tsx": {
      path: "src/app/App.tsx",
      language: "tsx",
      content:
        `import { Workbench } from "../components/Workbench";\n\nexport function App() {\n  return <Workbench />;\n}\n`,
    },
    "src/app/main.tsx": {
      path: "src/app/main.tsx",
      language: "tsx",
      content: appSource,
    },
    "src/api/login.ts": {
      path: "src/api/login.ts",
      language: "typescript",
      content: loginSource,
    },
    "src/api/session.ts": {
      path: "src/api/session.ts",
      language: "typescript",
      content:
        `export async function getSession(token: string) {\n  return store.sessions.find((item) => item.token === token);\n}\n`,
    },
    "src/harness/runner.ts": {
      path: "src/harness/runner.ts",
      language: "typescript",
      content: harnessSource,
    },
    "src/harness/tools.ts": {
      path: "src/harness/tools.ts",
      language: "typescript",
      content:
        `export const tools = {\n  execute: async (step: PlanStep) => registry.run(step.tool, step.arguments),\n};\n`,
    },
    "src/types.ts": {
      path: "src/types.ts",
      language: "typescript",
      content:
        `export type TaskStatus = "idle" | "running" | "waiting" | "completed";\n`,
    },
    "tests/login.test.ts": {
      path: "tests/login.test.ts",
      language: "typescript",
      content:
        `it("returns 401 when the session is missing", async () => {\n  const response = await login(requestWithToken("expired"));\n  expect(response.status).toBe(401);\n});\n`,
    },
    "README.md": {
      path: "README.md",
      language: "markdown",
      content:
        `# CodeHarness\n\nA controlled coding workspace powered by an Agent Harness.\n`,
    },
    "package.json": {
      path: "package.json",
      language: "json",
      content:
        `{\n  "name": "code-harness",\n  "scripts": {\n    "test": "vitest run"\n  }\n}\n`,
    },
  },
  activeFilePath: "src/api/login.ts",
  openFilePaths: ["src/api/login.ts", "src/harness/runner.ts"],
  task: {
    id: "run-0138",
    status: "VERIFYING",
    startedAt: "10:24",
    elapsed: "01:42",
    model: "Claude Sonnet 4",
    steps: [
      { id: "step-1", label: "检查登录入口和错误路径", status: "completed" },
      { id: "step-2", label: "定位会话空值访问", status: "completed" },
      { id: "step-3", label: "应用最小修复", status: "completed" },
      { id: "step-4", label: "执行定向测试", status: "active" },
      { id: "step-5", label: "整理变更与风险", status: "pending" },
    ],
    toolCalls: [
      {
        id: "tool-1",
        name: "search_text",
        summary: "搜索登录与 session 相关实现",
        detail: "在 8 个文件中找到 14 处匹配",
        duration: "0.3s",
        status: "completed",
      },
      {
        id: "tool-2",
        name: "read_file",
        summary: "读取 src/api/login.ts",
        detail: "读取第 1-16 行",
        duration: "0.1s",
        status: "completed",
      },
      {
        id: "tool-3",
        name: "apply_patch",
        summary: "增加空会话保护",
        detail: "修改 1 个文件，新增 4 行",
        duration: "0.2s",
        status: "completed",
      },
      {
        id: "tool-4",
        name: "run_command",
        summary: "运行登录接口定向测试",
        detail: "vitest tests/login.test.ts",
        status: "running",
      },
    ],
  },
  changes: [
    {
      id: "change-login",
      path: "src/api/login.ts",
      status: "modified",
      additions: 4,
      deletions: 1,
      decision: "pending",
      hunks: [
        {
          id: "hunk-login-1",
          header: "@@ -4,7 +4,10 @@ export async function login(request: Request) {",
          lines: [
            {
              kind: "context",
              oldNumber: 4,
              newNumber: 4,
              text: "  const body = await request.json();",
            },
            {
              kind: "context",
              oldNumber: 5,
              newNumber: 5,
              text: "  const session = await getSession(body.token);",
            },
            { kind: "context", oldNumber: 6, newNumber: 6, text: "" },
            {
              kind: "remove",
              oldNumber: 7,
              text: "  return json({ user: session.user });",
            },
            {
              kind: "add",
              newNumber: 7,
              text: "  if (!session) {",
            },
            {
              kind: "add",
              newNumber: 8,
              text: '    return json({ error: "Invalid session" }, 401);',
            },
            { kind: "add", newNumber: 9, text: "  }" },
            { kind: "add", newNumber: 10, text: "" },
            {
              kind: "add",
              newNumber: 11,
              text: "  return json({ user: session.user });",
            },
          ],
        },
      ],
    },
    {
      id: "change-test",
      path: "tests/login.test.ts",
      status: "added",
      additions: 4,
      deletions: 0,
      decision: "pending",
      hunks: [
        {
          id: "hunk-test-1",
          header: "@@ -0,0 +1,4 @@",
          lines: [
            {
              kind: "add",
              newNumber: 1,
              text: 'it("returns 401 when the session is missing", async () => {',
            },
            {
              kind: "add",
              newNumber: 2,
              text: '  const response = await login(requestWithToken("expired"));',
            },
            {
              kind: "add",
              newNumber: 3,
              text: "  expect(response.status).toBe(401);",
            },
            { kind: "add", newNumber: 4, text: "});" },
          ],
        },
      ],
    },
  ],
};
