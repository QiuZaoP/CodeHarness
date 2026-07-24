import { Workbench } from "./components/Workbench";
import { WorkspaceProvider } from "./state/WorkspaceContext";

export function App() {
  return (
    <WorkspaceProvider>
      <Workbench />
    </WorkspaceProvider>
  );
}
