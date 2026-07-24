import { render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("CodeHarness workbench", () => {
  it("loads the active project, conversation and code viewer", async () => {
    render(<App />);

    expect(screen.getByText("正在打开工作区")).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "修复登录接口偶发 500" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("CodeHarness").length).toBeGreaterThan(0);
    expect(screen.getByText("src / api / login.ts")).toBeInTheDocument();
  });

  it("switches to changes and accepts a file change", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "修复登录接口偶发 500" });
    await user.click(screen.getByRole("tab", { name: /变更/ }));
    expect(screen.getByText("2 个文件已更改")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "接受 src/api/login.ts" }),
    );
    await waitFor(() =>
      expect(screen.getByText("已接受")).toBeInTheDocument(),
    );
  });

  it("confirms before cancelling the active task", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "修复登录接口偶发 500" });
    await user.click(screen.getByRole("button", { name: "取消任务" }));

    expect(
      screen.getByRole("dialog", { name: "取消当前任务" }),
    ).toBeInTheDocument();
    const cancelButtons = screen.getAllByRole("button", { name: "取消任务" });
    await user.click(
      cancelButtons.find((button) => !button.hasAttribute("aria-label")) ??
        cancelButtons[0],
    );
    expect(await screen.findByText("已取消")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "停止当前任务" }),
    ).not.toBeInTheDocument();
  });

  it("opens the selected search result at its matching line", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "修复登录接口偶发 500" });
    await user.click(screen.getByRole("button", { name: "搜索代码" }));

    const searchInput = screen.getByPlaceholderText("搜索文件、符号或代码");
    await user.type(searchInput, "runTask");
    await waitFor(() =>
      expect(screen.getByText("src/harness/runner.ts")).toBeInTheDocument(),
    );
    await user.keyboard("{Enter}");

    expect(screen.getByText("src / harness / runner.ts")).toBeInTheDocument();
    expect(document.querySelector(".code-row--highlighted")).not.toBeNull();
  });

  it("creates a new task and sends a message", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "修复登录接口偶发 500" });
    await user.click(screen.getByRole("button", { name: "新建任务" }));
    expect(
      await screen.findByRole("heading", { name: "新任务" }),
    ).toBeInTheDocument();

    const input = screen.getByRole("textbox", { name: "任务消息" });
    fireEvent.change(input, { target: { value: "检查支付模块的重试逻辑" } });
    expect(input).toHaveValue("检查支付模块的重试逻辑");
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(
      await screen.findByRole("heading", {
        name: "检查支付模块的重试逻辑",
      }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/已把目标加入当前任务/),
    ).toBeInTheDocument();
  });
});
