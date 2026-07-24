import { Braces, GitCompareArrows, Search } from "lucide-react";
import { useWorkspace } from "../state/WorkspaceContext";
import { CodeViewer } from "./CodeViewer";
import { DiffViewer } from "./DiffViewer";
import { IconButton } from "./IconButton";

export function WorkspacePane() {
  const { activePanel, setActivePanel, setSearchOpen, snapshot } =
    useWorkspace();

  if (!snapshot) {
    return null;
  }

  const pendingCount = snapshot.changes.filter(
    (change) => change.decision === "pending",
  ).length;

  return (
    <section className="workspace-pane">
      <header className="workspace-header">
        <div className="workspace-tabs" role="tablist">
          <button
            className={`workspace-tab ${
              activePanel === "code" ? "workspace-tab--active" : ""
            }`}
            onClick={() => setActivePanel("code")}
            role="tab"
            aria-selected={activePanel === "code"}
          >
            <Braces size={15} />
            代码
          </button>
          <button
            className={`workspace-tab ${
              activePanel === "changes" ? "workspace-tab--active" : ""
            }`}
            onClick={() => setActivePanel("changes")}
            role="tab"
            aria-selected={activePanel === "changes"}
          >
            <GitCompareArrows size={15} />
            变更
            {pendingCount ? (
              <span className="workspace-tab__badge">{pendingCount}</span>
            ) : null}
          </button>
        </div>
        <IconButton label="搜索代码" onClick={() => setSearchOpen(true)}>
          <Search size={16} />
        </IconButton>
      </header>
      <div className="workspace-content">
        {activePanel === "code" ? <CodeViewer /> : <DiffViewer />}
      </div>
    </section>
  );
}
