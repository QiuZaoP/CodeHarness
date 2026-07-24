import { FileSearch, GitBranch, Search } from "lucide-react";
import { useWorkspace } from "../state/WorkspaceContext";
import { FileTree } from "./FileTree";
import { IconButton } from "./IconButton";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { SessionList } from "./SessionList";

export function LeftSidebar() {
  const { snapshot, setSearchOpen } = useWorkspace();
  if (!snapshot) {
    return null;
  }

  const activeProject = snapshot.projects.find(
    (project) => project.id === snapshot.activeProjectId,
  );

  return (
    <aside className="left-sidebar">
      <div className="left-sidebar__top">
        <ProjectSwitcher />
        <div className="sidebar-toolbar">
          <button
            className="sidebar-search"
            onClick={() => setSearchOpen(true)}
          >
            <Search size={15} />
            <span>搜索代码</span>
            <kbd>Ctrl K</kbd>
          </button>
          <IconButton label="查找文件" size="small" onClick={() => setSearchOpen(true)}>
            <FileSearch size={16} />
          </IconButton>
        </div>
      </div>
      <SessionList />
      <FileTree />
      <div className="sidebar-footer">
        <GitBranch size={14} />
        <span>{activeProject?.branch}</span>
        <span className="sidebar-footer__spacer" />
        <span>{activeProject?.indexedFiles || 0} 文件已索引</span>
      </div>
    </aside>
  );
}
