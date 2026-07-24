import { PanelGroup, Panel, PanelResizeHandle } from "react-resizable-panels";
import { useWorkspace } from "../state/WorkspaceContext";
import { ConversationPane } from "./ConversationPane";
import { LeftSidebar } from "./LeftSidebar";
import { SearchPalette } from "./SearchPalette";
import { WorkspacePane } from "./WorkspacePane";

export function Workbench() {
  const { loading, error } = useWorkspace();

  if (loading) {
    return (
      <div className="app-loading">
        <span className="app-mark">C</span>
        <span>正在打开工作区</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="app-error">
        <strong>无法打开工作区</strong>
        <span>{error}</span>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="desktop-layout">
        <PanelGroup direction="horizontal">
          <Panel defaultSize={19} minSize={15} maxSize={27}>
            <LeftSidebar />
          </Panel>
          <PanelResizeHandle className="resize-handle" />
          <Panel defaultSize={40} minSize={28}>
            <ConversationPane />
          </Panel>
          <PanelResizeHandle className="resize-handle" />
          <Panel defaultSize={41} minSize={28}>
            <WorkspacePane />
          </Panel>
        </PanelGroup>
      </div>
      <SearchPalette />
    </div>
  );
}
